// api/go.js — 跳转下载链接（点击统计 + 透明跳转到爱发电）
//
// 用法：
//   1) 短链：/api/go?slug=ev-timetable        （开发态直接调用）
//   2) 短链：/go/ev-timetable                  （生产态通过 vercel rewrite 转发）
//
// 数据存储：
//   HASH  go:mapping    slug -> JSON {target_url, enabled, name_zh, name_en, note}
//   KEY   stats:go:<today>             当日总点击数（incr）
//   KEY   stats:go:<today>:<slug>       当日单 slug 点击数（incr）
//   LIST  stats:go:recent              最近 100 条点击明细（lpush + ltrim）
//
// 错误响应：
//   400 invalid slug
//   404 slug not found
//   410 slug disabled
//   500 redis error
//   200 OK（302 跳转）

var redis = require("../lib/redis");

// --- helpers ---------------------------------------------------------------

var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/; // RFC 1123 label-ish
var VISITOR_TTL = 30 * 24 * 60 * 60; // 30 天（仅用于点击明细里附带的访客 hash）

function todayKey(ts) {
  var d = new Date(ts || Date.now());
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, "0");
  var day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
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
    // 不 await —— 即使统计失败也立刻跳
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