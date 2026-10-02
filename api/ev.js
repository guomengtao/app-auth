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
var messageDelivery = require("../lib/message-delivery");
var { requireAuth } = require("../lib/auth");
var fs = require("fs");
var path = require("path");

var CHALLENGE_TTL = 600;            // 10 分钟
var POLL_INTERVAL = 2;              // 建议客户端轮询间隔（秒）
var START_RATE_LIMIT = 10;          // 同 IP 每分钟最多发起几次
var MAX_LABEL_LEN = 64;

var BEAT_KEY = "ev:beat:";
var BEAT_DEVICES = "ev:beat:devices";
var BEAT_HIST = "ev:beat:hist:";     // 每台设备心跳历史（zset，score=member=ts 毫秒）
var ONLINE_HASH = "ev:online";       // 部署流程回写的线上版本（Redis，优先于文件）
var ONLINE_TS = "ev:online:ts";      // 各项目线上版本部署时间戳（hash project→ms）
var ONLINE_WINDOW = 10 * 60 * 1000; // 心跳 10 分钟内算「在线」
var HIST_MAX_WINDOW_H = 24 * 7;      // 历史心跳最多回看 7 天

/** 读取在线版本：文件 data/online-versions.json 作种子，Redis ev:online 覆盖（部署回写）。 */
function loadOnlineSync() {
  var online = {};
  try {
    var fp = path.join(process.cwd(), "data", "online-versions.json");
    if (fs.existsSync(fp)) {
      var o = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (o && typeof o === "object") {
        Object.keys(o).forEach(function (k) { if (k !== "_note") online[k] = o[k]; });
      }
    }
  } catch (e) { /* ignore */ }
  return online;
}

async function loadOnline() {
  var online = loadOnlineSync();
  try {
    var ov = await redis.hgetall(ONLINE_HASH);
    if (ov && typeof ov === "object") {
      Object.keys(ov).forEach(function (k) { if (ov[k] != null && ov[k] !== "") online[k] = ov[k]; });
    }
  } catch (e) { /* redis 不可用退回文件 */ }
  return online;
}

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

/**
 * 设备拉取通知流（Ev Ops 安卓端 0.2.0 起：鉴权中转，替代共享 redis 凭据直连）。
 *
 * 认证 = x-ev-device-token 头（与 device-me 相同）。消息源 = Postgres message_delivery 表
 * （与 Mac 端离线补拉同源），单调自增 id 做游标（seq）。
 *
 * 用法：
 *   GET ?action=messages                 → 不带 since：只回当前水位线 max_seq（新设备首次
 *                                          同步从「现在」开始，不回放历史，避免通知洪水）
 *   GET ?action=messages&since=<seq>     → 增量：id > since 的消息（默认上限 100 条/次）。
 *                                          离线多久都能补齐（受 336h 保留期上界约束），
 *                                          顺带解决 pub/sub 不回放的离线漏消息老问题。
 *
 * 返回的每条消息 = { seq, message_id, type, ts, payload }，与 redis PUB/SUB 的
 * { type, ts, seq, payload } 信封同构，客户端处理逻辑可完全复用。
 */
async function handleMessages(req, res) {
  var tok = String((req.headers && (req.headers["x-ev-device-token"] || req.headers["X-Ev-Device-Token"])) || "");
  if (!tok) {
    return json(res, 401, { success: false, error: "Missing x-ev-device-token" });
  }
  var row = await deviceToken.verifyDeviceToken(tok, clientIp(req));
  if (!row) {
    return json(res, 401, { success: false, error: "Invalid or revoked device token" });
  }

  var q = (req.query || {});
  if (q.since === undefined || String(q.since) === "") {
    var watermark = await messageDelivery.getMaxSeq();
    return json(res, 200, { success: true, messages: [], max_seq: watermark });
  }

  var since = parseInt(q.since, 10) || 0;
  var limit = parseInt(q.limit, 10) || 100;
  if (limit > 200) limit = 200;
  var rows = await messageDelivery.getSince(since, limit);
  var messages = [];
  var maxSeq = since;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var payload = r.payload;
    try { if (typeof payload === "string") payload = JSON.parse(payload); } catch (e) { /* 保持原样 */ }
    var seq = parseInt(r.seq, 10) || 0;
    if (seq > maxSeq) maxSeq = seq;
    var ts = Math.floor(new Date(r.created_at).getTime() / 1000) || 0;
    messages.push({
      seq: seq,
      message_id: r.message_id,
      type: r.message_type,
      ts: ts,
      payload: payload || {},
    });
  }
  return json(res, 200, { success: true, messages: messages, max_seq: maxSeq });
}

/**
 * 项目管理平台（EvOps）运行态端点：
 *   GET ?action=project-beat&app_version=<x>&device=<id>
 *
 *  - 把心跳持久化到 Redis（durable，跨 serverless 实例）：ev:beat:<device> + 设备集合；
 *  - 返回服务器时间 server_time（App 用来判定「离线」与相对时间）；
 *  - 返回 online：各项目「已部署 / 运行中」版本（文件种子 + Redis 覆盖）。
 *
 * App 端把静态开发版本（本机扫描）与 online 比对，产出『待发版 / 已同步 / 未上报』状态。
 */
async function handleProjectBeat(req, res) {
  var q = (req.query || {});
  var body = (req.method === "POST" && req.body && typeof req.body === "object") ? req.body : {};
  var appVersion = String(q.app_version || body.app_version || "").slice(0, 32);
  var device = String(q.device || body.device || "").slice(0, 64);

  // 1) 持久化心跳（Redis；失败不阻断返回）
  try {
    await redis.setWithSadd(
      BEAT_KEY + device,
      JSON.stringify({ app_version: appVersion, ts: Date.now() }),
      BEAT_DEVICES, device
    );
    // 历史序列：每次心跳记一个点（member=ts），用于画心跳新鲜度曲线。
    // ts 一律取服务端 Date.now()：不接受客户端传时间，避免伪造/回填历史。
    await redis.zadd(BEAT_HIST + device, Date.now(), String(Date.now()));
  } catch (e) { /* redis 不可用忽略 */ }

  // 2) 已部署版本（文件种子 + Redis 覆盖）
  var online = await loadOnline();

  return json(res, 200, { ok: true, server_time: Date.now(), online: online });
}

/**
 * 单设备心跳历史（画心跳新鲜度曲线）：GET ?action=project-history&device=<id>&window=<h>
 * 返回该设备最近 window 小时内（默认 24h，最多 7 天）的心跳时间戳数组（升序）。
 * 顺带清理超窗口旧点（量小，逐条 zrem，避免无限增长）。无 device → 空数组。
 */
async function handleProjectHistory(req, res) {
  var q = (req.query || {});
  var device = String(q.device || "").slice(0, 64);
  if (!device) return json(res, 200, { ok: true, history: [] });

  var windowMs = 24 * 60 * 60 * 1000;
  var w = parseInt(q.window, 10);
  if (w > 0 && w <= HIST_MAX_WINDOW_H) windowMs = w * 60 * 60 * 1000;
  var now = Date.now();
  var minTs = now - windowMs;
  var history = [];

  try {
    var members = await redis.zrange(BEAT_HIST + device, 0, -1);
    if (members && members.length) {
      for (var i = 0; i < members.length; i++) {
        var ts = parseInt(members[i], 10) || 0;
        if (ts >= minTs) history.push(ts);
        else { try { await redis.zrem(BEAT_HIST + device, members[i]); } catch (e) {} }
      }
    }
  } catch (e) { history = []; }

  return json(res, 200, {
    ok: true,
    device: device,
    window_h: windowMs / 3600000,
    server_time: now,
    history: history,
  });
}

/**
 * 运行态总览（聚合心跳）：GET ?action=project-status
 * 返回 devices（每台设备最后心跳 / 运行版本）、online_count（10 分钟内在线数）、
 * total、last_beat（全局最近心跳）、online（已部署版本）。App 用它画「运行态总览」与设备趋势。
 */
async function handleProjectStatus(req, res) {
  var online = await loadOnline();
  var onlineTs = {};
  try {
    var ots = await redis.hgetall(ONLINE_TS);
    if (ots && typeof ots === "object") {
      Object.keys(ots).forEach(function (k) {
        var n = parseInt(ots[k], 10);
        if (Number.isFinite(n)) onlineTs[k] = n;
      });
    }
  } catch (e) { onlineTs = {}; }
  var devices = [];
  var now = Date.now();
  try {
    var members = await redis.smembers(BEAT_DEVICES);
    if (members && members.length) {
      var keys = members.map(function (m) { return BEAT_KEY + m; });
      var vals = await redis.mget(keys);
      for (var i = 0; i < members.length; i++) {
        var raw = vals[i];
        if (!raw) continue;
        var obj;
        try { obj = JSON.parse(raw); } catch (e) { continue; }
        devices.push({
          device: members[i],
          app_version: obj.app_version || "",
          last_beat: obj.ts || 0,
        });
      }
      devices.sort(function (a, b) { return (b.last_beat || 0) - (a.last_beat || 0); });
    }
  } catch (e) { devices = []; }

  var lastBeat = 0, onlineCount = 0;
  for (var j = 0; j < devices.length; j++) {
    if (devices[j].last_beat > lastBeat) lastBeat = devices[j].last_beat;
    if (now - devices[j].last_beat < ONLINE_WINDOW) onlineCount++;
  }

  return json(res, 200, {
    ok: true,
    server_time: now,
    online: online,
    online_ts: onlineTs,
    devices: devices,
    total: devices.length,
    online_count: onlineCount,
    last_beat: lastBeat,
  });
}

/**
 * 部署流程自动回写在线版本：POST ?action=report-deploy
 * body = { project, version }。带 DEPLOY_TOKEN 时要求 Bearer；未配置则放开（个人环境）。
 * 写入 Redis ev:online（durable）并尽力回写 data/online-versions.json（git 可追踪历史）。
 */
async function handleReportDeploy(req, res) {
  var secret = process.env.DEPLOY_TOKEN;
  if (secret) {
    var h = (req.headers && req.headers.authorization) || "";
    if (h !== "Bearer " + secret) return json(res, 401, { success: false, error: "unauthorized" });
  }
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var project = String(body.project || "").slice(0, 64);
  var version = String(body.version || "").slice(0, 32);
  if (!project || !version) {
    return json(res, 400, { success: false, error: "Missing project/version" });
  }

  try { await redis.hset(ONLINE_HASH, (function () { var o = {}; o[project] = version; return o; })()); }
  catch (e) { /* redis 失败仍尝试回写文件 */ }

  try {
    var tsObj = {}; tsObj[project] = String(Date.now());
    await redis.hset(ONLINE_TS, tsObj);
  } catch (e) { /* redis 失败忽略部署时间戳 */ }

  try {
    var fp = path.join(process.cwd(), "data", "online-versions.json");
    var o = {};
    try { if (fs.existsSync(fp)) o = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { o = {}; }
    o[project] = version;
    fs.writeFileSync(fp, JSON.stringify(o, null, 2));
  } catch (e) { /* 只读环境忽略 */ }

  return json(res, 200, { success: true, project: project, version: version });
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
      case "messages":
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleMessages(req, res);
      case "project-beat":
        // 公开端点（EvOps 安卓端不需要登录即可上报心跳 / 拉取已部署版本）。
        return await handleProjectBeat(req, res);
      case "project-status":
        // 公开端点：聚合心跳为运行态总览（在线设备数 / 最近心跳 / 设备列表）。
        return await handleProjectStatus(req, res);
      case "project-history":
        // 公开端点：单设备心跳历史（画心跳新鲜度曲线）。
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleProjectHistory(req, res);
      case "report-deploy":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleReportDeploy(req, res);
      default:
        return json(res, 400, { success: false, error: "Unknown action" });
    }
  } catch (e) {
    console.error("[ev] error:", e && e.message ? e.message : e);
    return json(res, 500, { success: false, error: (e && e.message) || "Internal error" });
  }
};
