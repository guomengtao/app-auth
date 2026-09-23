// api/go.js — jump download link (click stats + transparent redirect to afdian)
//
// Usage:
//   1) Short link: /api/go?slug=ev-timetable        (dev mode)
//   2) Short link: /go/ev-timetable                 (prod via vercel rewrite)
//
// Data storage:
//   HASH  go:mapping    slug -> JSON {target_url, enabled, name_zh, name_en, note}
//   KEY   stats:go:<today>              daily total click count (incr)
//   KEY   stats:go:<today>:<slug>       daily per-slug click count (incr)
//   LIST  stats:go:recent               last 100 click details (lpush + ltrim)
//
//   Also writes to shared visitor stats:
//   KEY   stats:pv:<today>              INCR (shared with website visitors)
//   ZSET  stats:pages:<today>           ZINCRBY (shared with website visitors)
//   LIST  stats:recent                  LPUSH visitor-format record (shared)
//
// Error response:
//   400 invalid slug
//   404 slug not found
//   410 slug disabled
//   500 redis error
//   200 OK (302 redirect)

var redis = require("../lib/redis");
var rateLimit = require("../lib/rate-limit");
var geoZh = require("../lib/geo-zh");
var geoDistrict = require("../lib/geo-district");
var visitorLog = require("../lib/visitor-log");
var md = null;
try { md = require("../lib/message-delivery"); } catch(e) { console.log("[go] message-delivery not available"); }

// --- helpers ---------------------------------------------------------------

var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/; // RFC 1123 label-ish
var VISITOR_TTL = 30 * 24 * 60 * 60; // 30 天（仅用于点击明细里附带的访客 hash）

// 与 api/activate.js 统一：北京时间（UTC+8）分桶，复用 lib/rate-limit.js 的唯一实现
function todayKey(ts) {
  return rateLimit.beijingDateKey(ts);
}

function visitorHashKey(str) {
  if (!str) return "unknown";
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function getClientIp(req) {
  // 与 lib/rate-limit.js 风格一致
  var xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  return (req.headers["x-real-ip"] || req.socket?.remoteAddress || "").trim();
}

function pickSlug(req) {
  // 优先 query，其次路径最后一段（用于 vercel rewrite 后的 path-info 形式）
  var q = req.query && req.query.slug ? String(req.query.slug).trim().toLowerCase() : "";
  if (q) return q;
  var url = req.url || "";
  var m = url.match(/^\/?(?:api\/go|go)\/([a-z0-9-]+)\/?$/i);
  if (m) return m[1].toLowerCase();
  return "";
}

function notFound(res, msg) {
  // 用户面向的简单 HTML（避免暴露技术细节）
  var safe = String(msg || "Not found").replace(/[<>&"']/g, function (c) {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c];
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(404).send(
    "<!doctype html><meta charset=utf-8>" +
      "<title>链接不存在</title>" +
      "<div style=\"font-family:system-ui;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#475569\">" +
      "<h2 style=\"color:#1e293b;margin:0 0 8px\">链接不存在</h2>" +
      "<p>" + safe + "</p>" +
      "</div>"
  );
}

function notEnabled(res, slug) {
  var safe = String(slug).replace(/[<>&"']/g, function (c) {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c];
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(410).send(
    "<!doctype html><meta charset=utf-8>" +
      "<title>链接已下线</title>" +
      "<div style=\"font-family:system-ui;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#475569\">" +
      "<h2 style=\"color:#1e293b;margin:0 0 8px\">链接已下线</h2>" +
      "<p>短链接 <code>" + safe + "</code> 已被管理员停用。</p>" +
      "</div>"
  );
}

// --- stream notification push (purchase_click → ev-notifier) --------

async function pushPurchaseClick(entry, record, ts, dateKey) {
  var upstashUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var upstashToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!upstashUrl || !upstashToken) {
    console.log("[go:stream] no Upstash config, skip purchase_click push");
    return;
  }
  // 中文省市优先取 ip_lookups（ip-api lang=zh-CN），Vercel 头部仅兜底
  var storedGeo = await geoDistrict.getStoredGeo(record.ip);
  var district = (await geoDistrict.getDistrict(record.ip)) || (storedGeo && storedGeo.district) || "";
  var geoFull = geoZh.resolveZhLocationFull({
    country: record.c,
    region: record.rg,
    city: record.ci,
    zh_region: storedGeo && storedGeo.region,
    zh_city: storedGeo && storedGeo.city,
    district: district,
  });
  var msgId = null;
  if (md) {
    try {
      msgId = await md.createMessageDelivery({
        messageType: "purchase_click",
        payload: {
          slug: record.slug,
          name_zh: entry.name_zh || "",
          name_en: entry.name_en || "",
          target_url: entry.target_url || "",
          ip: record.ip,
          country: record.c,
          region: record.rg,
          city: record.ci,
          location_zh: geoFull.location_zh,
          district_zh: geoFull.district_zh,
          location_full_zh: geoFull.location_full_zh,
          referrer: record.r,
          user_agent: record.u,
          utm_source: record.utm_source,
          utm_medium: record.utm_medium,
          utm_campaign: record.utm_campaign,
          visitor_hash: record.v,
          date: dateKey
        },
        source: "go-link",
        channel: "auth:push_channel"
      });
    } catch (e) {
      console.error("[go] createMessageDelivery failed:", e.message);
    }
  }
  var msg = {
    ts: Math.floor(ts / 1000),
    type: "purchase_click",
    messageId: msgId || "",
    payload: {
      slug: record.slug,
      name_zh: entry.name_zh || "",
      name_en: entry.name_en || "",
      target_url: entry.target_url || "",
      ip: record.ip,
      country: record.c,
      region: record.rg,
      city: record.ci,
      location_zh: geoFull.location_zh,
      district_zh: geoFull.district_zh,
      location_full_zh: geoFull.location_full_zh,
      referrer: record.r,
      user_agent: record.u,
      utm_source: record.utm_source,
      utm_medium: record.utm_medium,
      utm_campaign: record.utm_campaign,
      visitor_hash: record.v,
      date: dateKey
    }
  };
  var dataStr = JSON.stringify(msg);
  var baseUrl = upstashUrl.replace(/\/$/, "");
  try {
    var xaddUrl = baseUrl + "/xadd/auth:notifications:stream/*/data/" + encodeURIComponent(dataStr);
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 5000);
    var r = await fetch(xaddUrl, {
      method: "POST",
      headers: { "Authorization": "Bearer " + upstashToken },
      signal: controller.signal,
    });
    clearTimeout(timer);
    console.log("[go:stream] XADD:", r.status);
    if (r.ok && msgId && md) {
      try { await md.markPublished(msgId); } catch(e) { console.error("[go] markPublished failed:", e.message); }
    }
    var pubUrl = baseUrl + "/publish/auth:push_channel/" + encodeURIComponent(dataStr);
    var controller2 = new AbortController();
    var timer2 = setTimeout(function() { controller2.abort(); }, 3000);
    var pubR = await fetch(pubUrl, {
      method: "POST",
      headers: { "Authorization": "Bearer " + upstashToken },
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    console.log("[go:stream] PUBLISH:", pubR.status);
  } catch (err) {
    console.error("[go:stream] push error:", err.message);
  }
}

// --- handler ---------------------------------------------------------------

module.exports = async (req, res) => {
  // 简单 CORS（如未来需要在管理后台用 fetch 预检）
  res.setHeader("Cache-Control", "no-store");

  try {
    var slug = pickSlug(req);
    if (!slug) {
      return res.status(400).json({ success: false, error: "Missing slug" });
    }
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ success: false, error: "Invalid slug format" });
    }

    // 1) 查配置
    var raw = await redis.hget("go:mapping", slug);
    if (!raw) {
      return notFound(res, "没有找到对应的下载链接。");
    }
    var entry;
    try {
      entry = JSON.parse(raw);
    } catch (e) {
      return notFound(res, "链接配置已损坏，请联系管理员。");
    }
    if (!entry.target_url) {
      return notFound(res, "链接未配置目标地址。");
    }
    if (entry.enabled === false) {
      return notEnabled(res, slug);
    }

    // 2) 记录点击（错误不影响跳转）
    var ts = Date.now();
    var ua = String(req.headers["user-agent"] || "unknown").slice(0, 200);
    var ip = getClientIp(req).slice(0, 45);
    var ref = String(req.headers["referer"] || "").slice(0, 200);
    var country = String(req.headers["x-vercel-ip-country"] || "").slice(0, 8);
    var region = String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16);
    var city = String(req.headers["x-vercel-ip-city"] || "").slice(0, 40);
    var vHash = visitorHashKey(ip + "|" + ua).slice(0, 12);

    var dateKey = todayKey(ts);
    var record = {
      slug: slug,
      t: ts,
      ip: ip,
      c: country,
      rg: region,
      ci: city,
      u: ua,
      r: ref,
      v: vHash,
      utm_source: String(req.query.utm_source || "").slice(0, 40),
      utm_medium: String(req.query.utm_medium || "").slice(0, 40),
      utm_campaign: String(req.query.utm_campaign || "").slice(0, 40),
    };

    var tasks = [
      redis.incr("stats:go:" + dateKey).catch(function () { return null; }),
      redis.incr("stats:go:" + dateKey + ":" + slug).catch(function () { return null; }),
      redis.pexpire("stats:go:" + dateKey, VISITOR_TTL * 1000).catch(function () {}),
      redis.pexpire("stats:go:" + dateKey + ":" + slug, VISITOR_TTL * 1000).catch(function () {}),
      redis.lpush("stats:go:recent", JSON.stringify(record)).catch(function () { return null; }),
      redis.ltrim("stats:go:recent", 0, 99).catch(function () { return null; }),
      redis.pexpire("stats:go:recent", VISITOR_TTL * 1000).catch(function () {}),
    ];
    // Also write to shared visitor stats (PV + pages + recent)
    tasks.push(redis.incr("stats:pv:" + dateKey).catch(function () { return null; }));
    tasks.push(redis.pexpire("stats:pv:" + dateKey, VISITOR_TTL * 1000).catch(function () {}));
    tasks.push(redis.zincrby("stats:pages:" + dateKey, 1, "/go/" + slug).catch(function () { return null; }));
    tasks.push(redis.pexpire("stats:pages:" + dateKey, VISITOR_TTL * 1000).catch(function () {}));
    // Write to shared recent visitors list (visitor-format record)
    var visitorRecord = {
      h: vHash, p: "/go/" + slug, u: ua, r: ref,
      t: ts, c: country, rg: region, ci: city, ip: ip,
      source: "go-link", slug: slug
    };
    tasks.push(redis.lpush("stats:recent", JSON.stringify(visitorRecord)).catch(function () { return null; }));
    // 永久日志（业务表）：与通知一样都是 fire-and-forget，不影响 302
    tasks.push(
      visitorLog.logVisit({
        ts: ts, ip: ip, path: "/go/" + slug, ua: ua, ref: ref,
        country: country, region: region, city: city, hash: vHash, source: "go-link",
      }).catch(function () { return null; })
    );
    tasks.push(redis.ltrim("stats:recent", 0, 99).catch(function () { return null; }));
    tasks.push(redis.pexpire("stats:recent", VISITOR_TTL * 1000).catch(function () {}));
    // Push purchase_click notification to ev-notifier stream
    // ⚠️ Vercel 在 res.end() 后会冻结函数：之前这里是纯 fire-and-forget，推送链被拦腰截断，
    //    结果是投递记录停在 pending（通知根本没发出去）——「丢通知」。所以这里 await，
    //    但加 5s 上限，避免腾讯 IP 定位 / Upstash 异常时把跳转拖死。
    var pushTask = pushPurchaseClick(entry, record, ts, dateKey).catch(function (e) {
      console.error("[go] pushPurchaseClick failed:", e && e.message ? e.message : e);
    });
    try {
      await Promise.race([
        pushTask,
        new Promise(function (resolve) {
          setTimeout(function () {
            console.warn("[go] purchase_click push 超过 5s，转为后台执行");
            resolve();
          }, 5000);
        }),
      ]);
    } catch (pushErr) {
      console.error("[go] purchase_click push error:", pushErr && pushErr.message ? pushErr.message : pushErr);
    }
    // fire-and-forget: stats failure never blocks redirect
    Promise.all(tasks).catch(function (e) {
      console.error("[go] stats write failed:", e && e.message ? e.message : e);
    });

    // 3) 302 跳转
    res.setHeader("Location", entry.target_url);
    return res.status(302).end();
  } catch (e) {
    console.error("[go] handler error:", e && e.message ? e.message : e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
};