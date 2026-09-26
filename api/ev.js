// api/ev.js
//
// EvNotifier 桌面客户端的「设备授权登录」端点。
//
// 本项目约定把 Vercel 函数文件数量收敛（见 api/admin/health.js 顶部注释），
// 所以这里用单文件 + `?action=` 分发，不拆成 5 个文件。
//
// 流程（详见 tools/ev-notifier/后台登录鉴权改造方案.md §4）：
//   ① 客户端 POST ?action=device-start            → { challenge, user_code, verify_url }
//   ② 客户端打开浏览器 verify_url（= /ev-login?c=<challenge>）
//        未登录后台 → 先走 /api/oauth（带 next 回到本页）
//        已登录     → 页面点「授权此设备」
//   ③ 浏览器 POST ?action=device-approve           （需后台登录态 / CRON_SECRET）
//   ④ 客户端 POST ?action=device-poll              → 拿到长期 device_token（只返回一次）
//   ⑤ 客户端把 device_token 存进 macOS Keychain，之后所有请求带 x-ev-device-token
//
// 为什么不让客户端直接读浏览器 cookie：后台 session 是 HttpOnly + Secure 的 cookie，
// 连页面 JS 都读不到，客户端更拿不到 → 必须用这种"设备码"交接。

var redis = require("../lib/redis");
var deviceToken = require("../lib/device-token");
var { requireAuth } = require("../lib/auth");

var CHALLENGE_TTL = 600;            // 10 分钟
var POLL_INTERVAL = 2;              // 建议客户端轮询间隔（秒）
var START_RATE_LIMIT = 10;          // 同 IP 每分钟最多发起几次
var MAX_LABEL_LEN = 64;

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function clientIp(req) {
  try {
    var xff = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
    return String(xff).split(",")[0].trim().slice(0, 60);
  } catch (e) { return ""; }
}

/** challenge：随机、一次性、10 分钟过期的交接凭据 */
function newChallenge() {
  return require("crypto").randomBytes(24).toString("base64url");
}

/** user_code：给人核对用，排除易混字符 0/O/1/I */
function newUserCode() {
  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var bytes = require("crypto").randomBytes(6);
  var s = "";
  for (var i = 0; i < 6; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 3) + "-" + s.slice(3);
}

function challengeKey(challenge) {
  return "ev:device:challenge:" + String(challenge);
}

/** 允许「后台登录态」或「CRON_SECRET」访问（后者用于应急/脚本化，见设计文档） */
function authorizeAdmin(req) {
  var auth = requireAuth(req);
  if (auth.authorized) return { ok: true, email: auth.username || "", via: "cookie" };
  var h = (req.headers && req.headers.authorization) || "";
  var cron = process.env.CRON_SECRET;
  if (cron && h === "Bearer " + cron) return { ok: true, email: process.env.ADMIN_EMAIL || "", via: "cron" };
  return { ok: false, status: auth.status || 401, error: auth.error || "Not authenticated" };
}

async function readChallenge(challenge) {
  if (!challenge) return null;
  var raw = await redis.get(challengeKey(challenge));
  if (!raw) return null;
  try {
    var obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return (obj && typeof obj === "object") ? obj : null;
  } catch (e) {
    return null;
  }
}

async function writeChallenge(challenge, obj) {
  await redis.set(challengeKey(challenge), JSON.stringify(obj), { ex: CHALLENGE_TTL });
}

async function handleStart(req, res) {
  var ip = clientIp(req);
  // 这个端点是**公开**的（客户端此时还没凭据），所以要限流，避免被刷 Redis
  if (ip) {
    var rlKey = "ev:device:start:" + ip;
    try {
      var n = await redis.incr(rlKey);
      if (n === 1) await redis.expire(rlKey, 60);
      if (parseInt(n, 10) > START_RATE_LIMIT) {
        return json(res, 429, { success: false, error: "too_many_requests" });
      }
    } catch (e) { /* 限流失败不阻断流程 */ }
  }

  var body = req.body || {};
  var challenge = newChallenge();
  var userCode = newUserCode();
  var label = String(body.label || "unknown-device").slice(0, MAX_LABEL_LEN);
  var appVersion = String(body.app_version || "").slice(0, 32);

  await writeChallenge(challenge, {
    user_code: userCode,
    status: "pending",
    label: label,
    app_version: appVersion,
    created_at: Math.floor(Date.now() / 1000),
  });

  return json(res, 200, {
    success: true,
    challenge: challenge,
    user_code: userCode,
    verify_url: "https://app-auth.gudq.com/ev-login?c=" + encodeURIComponent(challenge),
    expires_in: CHALLENGE_TTL,
    interval: POLL_INTERVAL,
  });
}

async function handlePoll(req, res) {
  var body = req.body || {};
  var challenge = String(body.challenge || (req.query && req.query.challenge) || "");
  var obj = await readChallenge(challenge);
  if (!obj) {
    return json(res, 404, { success: false, error: "challenge_expired" });
  }

  if (obj.status !== "approved" || !obj.token) {
    return json(res, 202, { success: true, status: "pending", interval: POLL_INTERVAL });
  }

  // 一次性：取走即作废，避免 challenge 泄漏后被二次换取
  try { await redis.del(challengeKey(challenge)); } catch (e) {}

  return json(res, 200, {
    success: true,
    status: "approved",
    device_token: obj.token,
    email: obj.email || "",
    label: obj.label || "",
  });
}

async function handleApprove(req, res) {
  var admin = authorizeAdmin(req);
  if (!admin.ok) {
    return json(res, admin.status || 401, { success: false, error: admin.error });
  }

  var body = req.body || {};
  var challenge = String(body.challenge || (req.query && req.query.challenge) || "");
  var obj = await readChallenge(challenge);
  if (!obj) {
    return json(res, 404, { success: false, error: "challenge_expired" });
  }
  // 幂等：重复点「授权」不重复发令牌
  if (obj.status === "approved") {
    return json(res, 200, { success: true, already: true, user_code: obj.user_code });
  }

  var label = String(body.label || obj.label || "unknown-device").slice(0, MAX_LABEL_LEN);
  var created = await deviceToken.createDeviceToken({
    label: label,
    email: admin.email || "",
    appVersion: obj.app_version || "",
  });
  if (!created || !created.token) {
    return json(res, 500, { success: false, error: "token_create_failed" });
  }

  obj.status = "approved";
  obj.token = created.token;
  obj.email = admin.email || "";
  obj.label = label;
  obj.approved_at = Math.floor(Date.now() / 1000);
  obj.approved_via = admin.via;
  await writeChallenge(challenge, obj);

  console.log("[ev:device-approve] device authorized id=" + created.id + " label=" + label + " via=" + admin.via);
  return json(res, 200, { success: true, user_code: obj.user_code, device_id: created.id });
}

async function handleRevoke(req, res) {
  var admin = authorizeAdmin(req);
  if (!admin.ok) {
    return json(res, admin.status || 401, { success: false, error: admin.error });
  }
  var body = req.body || {};
  var id = body.id || (req.query && req.query.id);
  var n;
  if (String(body.all || "") === "1" || String((req.query && req.query.all) || "") === "1") {
    n = await deviceToken.revokeAllDevices();
  } else if (id) {
    n = await deviceToken.revokeDeviceToken(id);
  } else {
    return json(res, 400, { success: false, error: "Missing id (or all=1)" });
  }
  return json(res, 200, { success: true, revoked: n });
}

async function handleDevices(req, res) {
  var admin = authorizeAdmin(req);
  if (!admin.ok) {
    return json(res, admin.status || 401, { success: false, error: admin.error });
  }
  var rows = await deviceToken.listDevices();
  return json(res, 200, { success: true, devices: rows });
}

/**
 * 本机账号信息（EvNotifier 面板左下角账号区用）：邮箱 / 设备名 / 授权时间 / 最后活跃。
 * 认证方式 = **设备令牌本身**（`x-ev-device-token`），不要求后台 cookie —— 客户端只有令牌。
 * 顺带：verifyDeviceToken 会（节流地）刷新 last_seen_at，所以"最后活跃"是真实的。
 */
async function handleDeviceMe(req, res) {
  var tok = String((req.headers && (req.headers["x-ev-device-token"] || req.headers["X-Ev-Device-Token"])) || "");
  if (!tok) {
    return json(res, 401, { success: false, error: "Missing x-ev-device-token" });
  }
  var row = await deviceToken.verifyDeviceToken(tok, clientIp(req));
  if (!row) {
    return json(res, 401, { success: false, error: "Invalid or revoked device token" });
  }
  var full = await deviceToken.getById(row.id);
  return json(res, 200, {
    success: true,
    email: (full && full.email) || row.email || "",
    label: (full && full.label) || row.label || "",
    app_version: (full && full.app_version) || "",
    created_at: (full && full.created_at) || null,
    last_seen_at: (full && full.last_seen_at) || null,
  });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  var action = (req.query && req.query.action) || "";

  try {
    switch (action) {
      case "device-start":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleStart(req, res);
      case "device-poll":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handlePoll(req, res);
      case "device-approve":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleApprove(req, res);
      case "device-revoke":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleRevoke(req, res);
      case "devices":
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleDevices(req, res);
      case "device-me":
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleDeviceMe(req, res);
      default:
        return json(res, 400, { success: false, error: "Unknown action" });
    }
  } catch (e) {
    console.error("[ev] error:", e && e.message ? e.message : e);
    return json(res, 500, { success: false, error: (e && e.message) || "Internal error" });
  }
};
