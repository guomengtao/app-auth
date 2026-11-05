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
var background = require("../lib/background");
var ipWarmup = require("../lib/ip-warmup");
var tracking = require("../lib/tracking");
// 零操作激活通道（2026-11-05 追加）：只在带 deviceId 的购买点击上生成随机会话 sid
var deviceKey = require("../lib/device-key");

// 从渠道参数里取设备 ID（购买页链接上的 deviceId）
function paramDeviceId(params) {
  if (!params) return "";
  return String(params.deviceId || params.d || "");
}
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
  var url = String(req.url || "").split("?")[0];
  var m = url.match(/^\/?(?:api\/go|go)\/([a-z0-9-]+)\/?$/i);
  if (m) return m[1].toLowerCase();
  return "";
}

// ⚠️ 渠道参数留存：/go/ev-timetable?deviceId=666 这类链接的 query string 以前被整条丢掉
//    （path 硬编码成 "/go/"+slug，表里也没有字段承载）。这里把完整 query 与解析后的
//    参数对象单独留下来，path 仍保持 "/go/"+slug，保证「热门页面」聚合不被参数分裂。
function pickQuery(req) {
  var url = String(req.url || "");
  var raw = "";
  var i = url.indexOf("?");
  if (i >= 0) {
    raw = url.slice(i + 1);
  } else {
    var q = (req.query && typeof req.query === "object" && req.query) || {};
    raw = Object.keys(q).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(String(q[k]));
    }).join("&");
  }
  if (!raw) return "";
  // 去掉 Vercel rewrite 自己塞进来的 slug（/go/:slug → /api/go?slug=...），只留业务渠道参数
  return raw.split("&").filter(function (pair) {
    return pair.split("=")[0] !== "slug";
  }).join("&");
}

function queryToParams(query) {
  var out = {};
  String(query || "").split("&").forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf("=");
    var k = i >= 0 ? pair.slice(0, i) : pair;
    var v = i >= 0 ? pair.slice(i + 1) : "";
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch (e) {}
  });
  return Object.keys(out).length ? out : null;
}

// --- 配置读取：三层降级（内存新鲜 → 内存陈旧 → Redis）------------------------
//
// 为什么需要：302 之前唯一的同步 IO 就是这一次 hget。函数实例在美东 iad1，
// 中国用户每次点「购买」都要等这一趟跨洋往返（实测热态 0.58–0.75s 里的大头）。
// 而 go:mapping 是低频变更配置（换价格/换链接才动），完全没必要每次点击都回源。
//
// 降级链（任何一层能给出 target_url 都必须跳过去，绝不让用户看到 500）：
//   1. 内存新鲜（60s 内）      → 零网络，直接 302
//   2. Redis 正常              → 回填内存
//   3. Redis 超时/报错         → 用内存里的陈旧值（6h 内）
//   4. 仍无值                  → 静态兜底表 GO_FALLBACK_MAP（环境变量 JSON）
//   5. 全都没有                → 才 404（此时确实无从得知该跳哪）
var CFG_FRESH_MS = 60 * 1000;           // 新鲜期：命中即零网络
var CFG_STALE_MS = 6 * 60 * 60 * 1000;  // 陈旧兜底窗口：Redis 挂了也要跳
var CFG_TIMEOUT_MS = 2500;              // hget 上限：绝不拖住跳转（原来最坏 20s 超时）
// ⚠️ 2026-11-03 事故：生产 redis 实际走 **Postgres proxy**（kv_hashes 表，Supabase 美东），
//    不是 Upstash。当天把 region 迁到 hkg1 后，hget 变成「香港→美东跨洋查 pg」，
//    超过 1.5s 上限被判读失败，又没有静态兜底 → 全部短链变 404（12:22 还正常，12:55 部署后挂）。
//    已回滚 region 到 iad1。**在确认 redis 真正走 Upstash（东京）之前，不要迁 hkg1。**
var CFG_MAX_ENTRIES = 500;              // 缓存条目上限，防异常增长
var cfgCache = new Map();               // slug -> { entry, ts }

function cfgGet(slug, maxAge) {
  var hit = cfgCache.get(slug);
  if (!hit) return null;
  if (Date.now() - hit.ts > maxAge) return null;
  return hit.entry;
}

function cfgSet(slug, entry) {
  if (cfgCache.size > CFG_MAX_ENTRIES && !cfgCache.has(slug)) cfgCache.clear();
  cfgCache.set(slug, { entry: entry, ts: Date.now() });
}

var CFG_TIMEOUT = Symbol("cfg-timeout");

function hgetWithTimeout(slug) {
  return Promise.race([
    redis.hget("go:mapping", slug),
    new Promise(function (resolve) {
      setTimeout(function () { resolve(CFG_TIMEOUT); }, CFG_TIMEOUT_MS);
    }),
  ]);
}

// 静态兜底：GO_FALLBACK_MAP='{"ev-timetable":"https://..."}' 或
//            '{"ev-timetable":{"target_url":"https://...","enabled":true}}'
// 用途：冷启动 + Redis 全挂时，已在外面流通的二维码/安装包短链仍可送达。
function staticFallback(slug) {
  var raw = process.env.GO_FALLBACK_MAP || "";
  if (!raw) return null;
  try {
    var m = JSON.parse(raw);
    var e = m && Object.prototype.hasOwnProperty.call(m, slug) ? m[slug] : null;
    if (!e) return null;
    return typeof e === "string" ? { target_url: e, enabled: true } : e;
  } catch (err) {
    return null;
  }
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
  var msgSeq = null;
  if (md) {
    try {
      var _rec = await md.createMessageDelivery({
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
      msgId = (_rec && (_rec.messageId || _rec)) || null;
      msgSeq = (_rec && _rec.seq) || null;
    } catch (e) {
      console.error("[go] createMessageDelivery failed:", e.message);
    }
  }
  var msg = {
    ts: Math.floor(ts / 1000),
    type: "purchase_click",
    messageId: (typeof msgId === "string" ? msgId : "") || "",
    seq: msgSeq || 0,
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

  // ── P5：/dl/:file APK 下载重定向 + 计数（vercel.json rewrite → /api/go?dl=:file）──
  // 兼容铁律（§6.1）：/ev/*.apk 静态直链原样保留，/dl/ 只是新增入口，不是替换。
  var dlFile = String((req.query && req.query.dl) || "").trim();
  if (dlFile) {
    // 文件名白名单：只放行本站 APK 命名，防开放重定向
    var mDl = /^(EVSyncProbe-v\d+\.\d+\.\d+\.apk)$/.exec(dlFile);
    if (!mDl) {
      return res.status(404).json({ success: false, error: "Unknown file" });
    }
    var dlName = mDl[1];
    var dlVer = (dlName.match(/v(\d+\.\d+\.\d+)\.apk$/) || [])[1] || "unknown";
    var dlTs = Date.now();
    var dlDate = todayKey(dlTs);

    // 下载事件进 tracking_events（best-effort，绝不阻塞跳转）
    try {
      var trackingLib = require("../lib/tracking");
      var dlIp = getClientIp(req).slice(0, 45);
      trackingLib
        .record({
          kind: "download",
          ip: dlIp,
          visitorHash: visitorHashKey(dlIp + "|" + String(req.headers["user-agent"] || "")).slice(0, 12),
          ts: dlTs,
          payload: {
            file: dlName,
            version: dlVer,
            from: String((req.query && req.query.from) || "").slice(0, 32),
            ref: String(req.headers["referer"] || "").slice(0, 200),
          },
        })
        .catch(function () {});
    } catch (e) {}

    // kv 日计数（beijing 日键；预聚合表 app_daily_stats 留待后续 cron）
    return Promise.all([
      redis.incr("stats:dl:" + dlDate).catch(function () { return null; }),
      redis.incr("stats:dl:" + dlDate + ":v" + dlVer).catch(function () { return null; }),
      redis.pexpire("stats:dl:" + dlDate, VISITOR_TTL * 1000).catch(function () {}),
      redis.pexpire("stats:dl:" + dlDate + ":v" + dlVer, VISITOR_TTL * 1000).catch(function () {}),
    ])
      .catch(function () {})
      .then(function () {
        res.setHeader("Location", "/ev/" + dlName);
        res.status(302);
        res.end();
      });
  }

  try {
    var slug = pickSlug(req);
    if (!slug) {
      return res.status(400).json({ success: false, error: "Missing slug" });
    }
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ success: false, error: "Invalid slug format" });
    }

    // 1) 查配置 —— 内存优先；Redis 失败/超时也不影响跳转（见 cfgGet 注释）
    var entry = cfgGet(slug, CFG_FRESH_MS);
    if (!entry) {
      var raw = null;
      var readFailed = false;
      try {
        raw = await hgetWithTimeout(slug);
        if (raw === CFG_TIMEOUT) { readFailed = true; raw = null; }
      } catch (e) {
        readFailed = true;
        raw = null;
        console.error("[go] hget failed:", e && e.message ? e.message : e);
      }
      if (raw) {
        try {
          entry = JSON.parse(raw);
          cfgSet(slug, entry);
        } catch (e) {
          return notFound(res, "链接配置已损坏，请联系管理员。");
        }
      } else if (readFailed) {
        // 读失败 ≠ 不存在：先用陈旧缓存，再退到静态兜底表，都空才认输
        entry = cfgGet(slug, CFG_STALE_MS) || staticFallback(slug);
        if (entry) console.warn("[go] degraded redirect via stale/static fallback:", slug);
      }
    }
    if (!entry) {
      return notFound(res, "没有找到对应的下载链接。");
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
    // ⚠️ Vercel 的 x-vercel-ip-city 对非 ASCII 城市名是 percent-encoded（Maghār → Magh%C4%81r），
    //    以前原样入库、原样展示，后台出现 `Z · Magh%C4%81r`。这里统一解码。
    var country = String(req.headers["x-vercel-ip-country"] || "").slice(0, 8);
    var region = String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16);
    var city = geoZh.decodeGeoValue(String(req.headers["x-vercel-ip-city"] || "")).slice(0, 40);
    var vHash = visitorHashKey(ip + "|" + ua).slice(0, 12);
    var fullQuery = pickQuery(req).slice(0, 500);
    var queryParams = queryToParams(fullQuery);

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
      q: fullQuery,
      params: queryParams || {},
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
      q: fullQuery,
      source: "go-link", slug: slug
    };
    tasks.push(redis.lpush("stats:recent", JSON.stringify(visitorRecord)).catch(function () { return null; }));
    // 永久日志（业务表）：不影响 302，但必须走 waitUntil（见下方 background.run）
    tasks.push(
      visitorLog.logVisit({
        ts: ts, ip: ip, path: "/go/" + slug, ua: ua, ref: ref,
        country: country, region: region, city: city, hash: vHash, source: "go-link",
        query: fullQuery, params: queryParams,
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
    // ⚠️ 2026-11-03 改：原来是 await Promise.race([推送到此完成, 5s 上限])。
    //    实测 /go/ev-timetable 首字节 1.79s / 5.12s / 20s 超时（TFFB = 总耗时，延迟全在服务端），
    //    因为 pushPurchaseClick 串了腾讯 IP 定位 + 两次 Redis + 写库 + Pub/Sub。
    //    移动端用户点「购买」后转圈 2–5 秒，以为没反应就退出了 —— 这是 W39 起
    //    转化率 39%→16% 的根因（引入提交 4af5186，2026-09-23）。
    //    改为 background.run() 注册到 waitUntil：既不阻塞 302，也不会像裸 fire-and-forget 那样
    //    被平台冻结掐断（那才是 4af5186 当初要解决的问题）。同文件其余三处后台任务本就如此。
    background.run(pushTask, "go-purchase-push");
    // ⚠️ 这里原来是裸 fire-and-forget：Vercel 在 res.end() 后会冻结函数实例，
    //    visitor_logs 的 INSERT 有被中途掐断的风险（整条访问记录丢失）。
    //    改成 background.run() 注册到 waitUntil，由平台保证跑完。
    background.run(Promise.all(tasks), "go-stats");

    // 中文归属地自动补齐：ip_lookups 此前只有「腾讯成功」才会写，境外 IP 永远落不进去，
    //    只能显示 Vercel 原始头部（IL / 06 / Z）。这里在响应之后补一次（不占用跳转时间）。
    background.run(ipWarmup.warmup(ip), "ip-warmup");

    // 统一事件流：购买点击（漏斗的「访问 → 支付」这一步的关键节点）
    background.run(tracking.record({
      ts: ts,
      kind: "purchase_click",
      ip: ip,
      visitorHash: vHash,
      deviceId: paramDeviceId(queryParams),
      client: "web",
      channel: String((queryParams && queryParams.c) || req.query.utm_source || ""),
      payload: {
        slug: slug, target_url: entry.target_url || "",
        query: fullQuery, params: queryParams || {}, ua: ua, ref: ref,
        country: country, region: region, city: city,
      },
      dedupeKey: null,
    }), "tracking");

    // 3) 302 跳转
    // ── 零操作通道 B8（2026-11-05 追加，只加不改）────────────────────────
    // APK 购买入口本来就把 deviceId 带在 URL 上（FastActivateActivity.java:616-625），
    // pickQuery() 也已解析。这里把 CSPRNG 随机会话 sid 拼进真实商品页，付款后 webhook
    // 从 remark 拿回 sid 即可完成「订单 ↔ 设备」归因。
    // 无 deviceId / 总开关关闭 / 任何异常 → 原样跳 entry.target_url，行为逐字节不变。
    var finalTarget = entry.target_url;
    try {
      var goDid = paramDeviceId(queryParams);
      if (process.env.EV_ZERO_ACTIVATE !== "0" && goDid) {
        var goSid = deviceKey.newSid();
        // 会话写入不阻塞 302：付款在数十秒之后，异步写早已落库
        background.run(deviceKey.saveSession(goSid, {
          sid: goSid, deviceKey: "", nodeId: "",
          deviceId: deviceKey.normalizeDeviceId(goDid),
          status: "waiting", createdAt: Date.now(), origin: "go302"
        }), "zero-session");
        var sep = String(finalTarget).indexOf("?") >= 0 ? "&" : "?";
        finalTarget = finalTarget + sep +
          "remark=EV-" + encodeURIComponent(goSid) +
          "&custom_order_id=" + encodeURIComponent(goSid);
      }
    } catch (ge) {
      console.error("[go] zero-session non-blocking error:", ge && ge.message);
      finalTarget = entry.target_url;
    }
    res.setHeader("Location", finalTarget);
    return res.status(302).end();
  } catch (e) {
    console.error("[go] handler error:", e && e.message ? e.message : e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
};