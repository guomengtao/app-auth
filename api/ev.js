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

/**
 * 护栏③：把「人手动降级」覆盖合并进动态层 payload（读时生效，不必等 Mac 重采集）。
 * 覆盖只可能把优先级降到 P1/P2（写入端点已限制），故这里是安全的单向纠错。
 */
async function applyPriorityOverrides(payload) {
  try {
    var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
    var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
    if (!sbUrl || !sbKey || !payload || !Array.isArray(payload.tasks)) return;
    var r = await fetch(sbUrl + "/rest/v1/evops_priority_override?select=task_id,priority,reason", {
      headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
    });
    if (!r.ok) return;
    var rows = await r.json();
    var m = {};
    (rows || []).forEach(function (o) { if (o && o.task_id) m[o.task_id] = o; });
    payload.tasks.forEach(function (t) {
      var o = m[t && t.id];
      if (o && (o.priority === "P1" || o.priority === "P2")) {
        t.priority = o.priority;
        t.priority_reason = "人手动降级：" + (o.reason || ("→" + o.priority));
        t.overridden = true;
      }
    });
  } catch (e) { /* 覆盖读取失败不影响主数据 */ }
}

/**
 * EvOps 项目/任务动态层 —— 读：GET ?action=ev-status
 * 从 Supabase 表 evops_status(id=1) 读 payload（Mac 采集后由 ev-status-write 写入，实时，
 * 零部署延迟，不消耗 Redis 额度）。Supabase 不可用时回退仓库内 ev-status.json 静态文件。
 * App 端 StatusSource 直接读这个端点拿最新 projects/tasks。
 */
async function handleEvStatusGet(req, res) {
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (sbUrl && sbKey) {
    try {
      var r = await fetch(sbUrl + "/rest/v1/evops_status?id=eq.1&select=payload,updated_at", {
        headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
      });
      if (r.ok) {
        var rows = await r.json();
        if (Array.isArray(rows) && rows[0] && rows[0].payload) {
          var p = rows[0].payload;
          if (typeof p === "string") p = JSON.parse(p);
          await applyPriorityOverrides(p);   // 护栏③：合并人工降级（人纠错 AI，读时即生效）
          await mergeRegisteredTasks(p, evTaskDb(req, res));  // 合并真人登记任务（eta/assignee/replies…）
          return json(res, 200, p);
        }
      }
    } catch (e) { /* Supabase 失败回落文件 */ }
  }
  try {
    var fp = path.join(process.cwd(), "ev-status.json");
    if (fs.existsSync(fp)) {
      return json(res, 200, JSON.parse(fs.readFileSync(fp, "utf-8")));
    }
  } catch (e) { /* ignore */ }
  return json(res, 200, { projects: [], tasks: [] });
}

/**
 * EvOps 项目/任务动态层 —— 写：POST ?action=ev-status-write（body = 整个 tasks.json 对象）
 * 鉴权 = EV_SYNC_TOKEN Bearer（与 delivery-* 端点共享，Mac 侧持有）。用 service_role 直写
 * Supabase 表 evops_status(id=1)（upsert）。不走 git push，因此不触发 Vercel 重新部署。
 */
async function handleEvStatusWrite(req, res) {
  var secret = process.env.EV_SYNC_TOKEN;
  if (secret) {
    var h = (req.headers && req.headers.authorization) || "";
    if (h !== "Bearer " + secret) return json(res, 401, { success: false, error: "unauthorized" });
  }
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  if (!body || (!body.projects && !body.tasks)) {
    return json(res, 400, { success: false, error: "Missing projects/tasks" });
  }
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (sbUrl && sbKey) {
    try {
      var r = await fetch(sbUrl + "/rest/v1/evops_status", {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: "Bearer " + sbKey,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({ id: 1, payload: body })
      });
      if (r.ok || r.status === 201) {
        return json(res, 200, { success: true, store: "supabase" });
      }
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
    } catch (e) {
      return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
    }
  }
  // Supabase 未配置时回退：尽力写文件种子（兼容期）
  try {
    var fp = path.join(process.cwd(), "ev-status.json");
    fs.writeFileSync(fp, JSON.stringify(body, null, 2));
    return json(res, 200, { success: true, store: "file" });
  } catch (e) {}
  return json(res, 500, { success: false, error: "no_store_configured" });
}

/**
 * EvOps 双向任务指挥 —— 写：POST ?action=ev-command-write
 * body = { task_ref?, type: escalate|cancel|expedite|custom, payload?, reason?, device? }
 * 写入 Supabase 表 evops_commands（status=pending），由 Mac 侧监听器（Realtime 长连接，
 * 禁轮询）实时取走：写本地指令队列 + macOS 通知，AI 会话下一轮经钩子 stdout 注入执行。
 * 护栏（沿用 D1）：escalate/cancel 必须带 reason；同 device 60s 内 ≤3 条防误触连点；
 * payload 自由文本只作为 AI 提示上下文，绝不进入任何 shell/eval（公开端点无鉴权）。
 */
async function handleEvCommandWrite(req, res) {
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var type = String(body.type || "").trim();
  var taskRef = String(body.task_ref || "").trim().slice(0, 300);
  var payload = String(body.payload || "").trim().slice(0, 500);
  var reason = String(body.reason || "").trim().slice(0, 200);
  var device = String(body.device || "unknown").trim().slice(0, 80);
  // 定向：指定会话 sid 则只有该会话会消费该指令；留空 = 任意会话先到先得
  var targetSession = String(body.target_session || "").trim().slice(0, 120);
  if (["escalate", "cancel", "expedite", "custom"].indexOf(type) < 0) {
    return json(res, 400, { success: false, error: "bad_type", detail: "type 只接受 escalate/cancel/expedite/custom" });
  }
  if ((type === "escalate" || type === "cancel") && !reason) {
    return json(res, 400, { success: false, error: "reason_required", detail: "加急/取消必须给理由（护栏①）" });
  }
  if (type === "custom" && !payload) {
    return json(res, 400, { success: false, error: "payload_required", detail: "自定义指令必须带内容" });
  }
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 500, { success: false, error: "no_store_configured" });
  try {
    // 限流：同 device 最近 60s 的指令数 ≤3（REST 查询，超了拒绝并提示）
    var since = new Date(Date.now() - 60000).toISOString();
    var cnt = await fetch(sbUrl + "/rest/v1/evops_commands?device=eq." + encodeURIComponent(device)
        + "&created_at=gte." + since + "&select=id", {
      headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
    });
    if (cnt.ok) {
      var arr = await cnt.json();
      if (Array.isArray(arr) && arr.length >= 3) {
        return json(res, 429, { success: false, error: "rate_limited", detail: "同设备 60 秒内最多 3 条指令" });
      }
    }
    var id = "cmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    var ins = await fetch(sbUrl + "/rest/v1/evops_commands", {
      method: "POST",
      headers: {
        apikey: sbKey, Authorization: "Bearer " + sbKey,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        id: id, task_ref: taskRef || null, type: type,
        payload: payload || null, reason: reason || null,
        device: device, target_session: targetSession || null, status: "pending",
        created_at: new Date().toISOString()
      })
    });
    if (!ins.ok && ins.status !== 201) {
      var txt = await ins.text();
      return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
    }
    return json(res, 200, { success: true, command_id: id, status: "pending" });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * EvOps 指令读取 —— GET ?action=ev-command-get[&status=pending|delivered|executed][&limit=20]
 * 给 Mac 监听器（取走 pending 并标 delivered）与看板回查用。公开端点只读。
 */
async function handleEvCommandGet(req, res, query) {
  var q = query || {};
  var status = String(q.status || "").trim();
  var limit = Math.min(parseInt(String(q.limit || "20"), 10) || 20, 100);
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 500, { success: false, error: "no_store_configured" });
  try {
    var url = sbUrl + "/rest/v1/evops_commands?order=created_at.desc&limit=" + limit
      + (status ? ("&status=eq." + encodeURIComponent(status)) : "");
    var r = await fetch(url, { headers: { apikey: sbKey, Authorization: "Bearer " + sbKey } });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_read_failed", detail: String(txt).slice(0, 200) });
    }
    var arr = await r.json();
    return json(res, 200, { success: true, commands: Array.isArray(arr) ? arr : [] });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * EvOps 指令状态回写 —— POST ?action=ev-command-status
 * body = { command_id, status: delivered|ack|executed|rejected, result_note? }
 * 由 Mac 监听器（delivered）与 AI 会话收尾（executed，带 commit 证据时写 result_note）调用。
 */
async function handleEvCommandStatus(req, res) {
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var id = String(body.command_id || "").trim();
  var status = String(body.status || "").trim();
  var note = String(body.result_note || "").trim().slice(0, 300);
  if (!id) return json(res, 400, { success: false, error: "Missing command_id" });
  if (["delivered", "ack", "executed", "rejected"].indexOf(status) < 0) {
    return json(res, 400, { success: false, error: "bad_status", detail: "只接受 delivered/ack/executed/rejected" });
  }
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 500, { success: false, error: "no_store_configured" });
  try {
    var patch = { status: status };
    if (note) patch.result_note = note;
    var r = await fetch(sbUrl + "/rest/v1/evops_commands?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: {
        apikey: sbKey, Authorization: "Bearer " + sbKey,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
    }
    return json(res, 200, { success: true, command_id: id, status: status });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * EvOps 优先级覆盖（护栏③：人可一键降级 AI 的 P0/P1）—— 写：POST ?action=ev-priority-set
 * body = { task_id, priority, reason }。**公开端点**，但只接受 P1/P2（禁止升到 P0），
 * 避免被滥用刷高告警。写入 Supabase 表 evops_priority_override（service_role）。
 */
async function handleEvPrioritySet(req, res) {
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var taskId = String(body.task_id || "").trim();
  var priority = String(body.priority || "").trim();
  var reason = String(body.reason || "").trim().slice(0, 120);
  if (!taskId) return json(res, 400, { success: false, error: "Missing task_id" });
  if (priority !== "P1" && priority !== "P2") {
    return json(res, 400, { success: false, error: "only_downgrade_allowed", detail: "priority 只接受 P1/P2（禁止升到 P0）" });
  }
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 500, { success: false, error: "no_store_configured" });
  try {
    var r = await fetch(sbUrl + "/rest/v1/evops_priority_override", {
      method: "POST",
      headers: {
        apikey: sbKey,
        Authorization: "Bearer " + sbKey,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        task_id: taskId, priority: priority,
        reason: reason || ("人手动降级为 " + priority),
        updated_at: new Date().toISOString()
      })
    });
    if (r.ok || r.status === 201) {
      return json(res, 200, { success: true, store: "supabase", task_id: taskId, priority: priority });
    }
    var txt = await r.text();
    return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * EvOps 优先级覆盖 —— 读：GET ?action=ev-priority-get（公开）
 * 返回 { overrides: [{task_id, priority, reason, updated_at}] }；Mac 采集器据此把人工降级看板化。
 */
async function handleEvPriorityGet(req, res) {
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 200, { overrides: [] });
  try {
    var r = await fetch(sbUrl + "/rest/v1/evops_priority_override?select=task_id,priority,reason,updated_at", {
      headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
    });
    if (r.ok) {
      var rows = await r.json();
      return json(res, 200, { overrides: Array.isArray(rows) ? rows : [] });
    }
    return json(res, 502, { success: false, error: "supabase_read_failed" });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/* =====================================================================
 * EvOps 任务登记 —— 写接口（P1，方案甲 Supabase 直写 evops_tasks 表）
 * 出处：ev-ops-android/docs/EvOps-任务登记与管理方案.md §4
 * 鉴权：同 ev-status-write，Bearer EV_SYNC_TOKEN（Mac 持有 + 手机登记页其后端代写）。
 * 纪律：9 并行上限（与 evops_status.max_parallel 一致，默认 9）每写必拦，超限禁止排队直接拒绝。
 * ================================================================== */

var TASKS_TABLE = "evops_tasks";

/**
 * 把 evops_tasks 登记的真人任务即时合并进 ev-status 的 tasks(Dyn层)。
 * —— 手机端直接读 ev-status，只有把登记任务并进来，列表/详情才能看到
 *    eta_min/assignee/description/replies/close_reason 等新字段（seen §方案）。
 * 规则：按 id 合并；聚合看板已有该 id → 用登记数据覆盖新字段（状态/原因/回复/耗时/描述）；
 *       聚合看板没有 → 追加为来源=register 的一行。空 DB / 失败静默放行（不影响主链路）。
 */
async function mergeRegisteredTasks(payload, db) {
  if (!db || !payload || !payload.tasks) return payload;
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=*&order=updated_at.desc&limit=300", { headers: db.headers() });
    if (!r.ok) return payload;
    var rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return payload;
    var byId = {};
    rows.forEach(function (t) {
      if (!t || !t.id) return;
      var desc = t.description ? String(t.description) : "";
      var note = (t.extra && t.extra.note) ? String(t.extra.note) : "";
      byId[t.id] = {
        id: t.id, project: t.project || "", title: t.title || "", type: t.type || "feature",
        status: t.status || "in_progress", priority: t.priority || "P2",
        assignee: t.assignee || "", eta_min: t.eta_min || 0, description: desc,
        owner: t.owner || "", source: "register", note: note,
        close_reason: t.close_reason || "", closed_note: t.closed_note || "",
        replies: Array.isArray(t.replies) ? t.replies : [],
        created_at: t.created_at, updated_at: t.updated_at
      };
    });
    var list = payload.tasks;
    for (var i = 0; i < list.length; i++) {
      var v = byId[list[i] && list[i].id];
      if (v) { list[i] = v; delete byId[v.id]; }
    }
    Object.keys(byId).forEach(function (id) { list.push(byId[id]); });
    var sm = payload.summary || (payload.summary = {});
    sm.registered_total = Object.keys(byId).length + countIn(list) || sm.registered_total;
  } catch (e) { /* 合并失败不阻断读 */ }
  return payload;
}

function countIn(list) {
  var n = 0;
  if (list) for (var i = 0; i < list.length; i++) if (list[i] && list[i].source === "register") n++;
  return n;
}

var TASK_TYPES = ["feature", "develop", "bug", "git", "docs", "infra", "refactor", "research"];
var TASK_STATUSES = ["in_progress", "planned", "done", "cancelled", "blocked"];

/** 鉴权：EV_SYNC_TOKEN 可配则要求 Bearer 匹配；未配则放行（兼容本地/dev）。 */
function evTaskAuthOk(req) {
  // 双通道鉴权：
  //   - 配置了 EV_SYNC_TOKEN 且请求带 Bearer → 必须匹配（AI/脚本/管理员强安全路径）。
  //   - 手机端（无 token 持有）→ 放行，但 register 端点内置频率护栏防滥用（见 registerOfRateLimit）。
  //   - 未配置 EV_SYNC_TOKEN → 一律放行（兼容本地/dev）。
  var secret = process.env.EV_SYNC_TOKEN;
  if (!secret) return true;
  var h = (req.headers && req.headers.authorization) || "";
  if (!h || h.indexOf("Bearer ") !== 0) return true;          // 无 token：走匿名护栏通道
  return h === "Bearer " + secret;                            // 有 token：必须正确，防伪造冒写
}

/**
 * 匿名登记频率护栏：同来源(device|ip)最近 RATE_WINDOW 秒内在 evops_tasks 写的登记任务数 ≤ RATE_MAX。
 * 与 ev-command-write 的限流精神一致，防止公开写被刷。
 */
var TASK_RATE_MAX = 12;          // 每个来源在窗口内最多
var TASK_RATE_WINDOW_S = 300;    // 5 分钟
async function registerRateAllowed(db, source) {
  if (!source || !db) return true;
  try {
    var since = new Date(Date.now() - TASK_RATE_WINDOW_S * 1000).toISOString();
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE +
      "?select=id&owner=eq." + encodeURIComponent("dev:" + source.slice(0, 60)) +
      "&created_at=gte." + encodeURIComponent(since) + "&limit=" + (TASK_RATE_MAX + 1),
      { headers: db.headers() });
    if (!r.ok) return true;
    var rows = await r.json();
    return !(Array.isArray(rows) && rows.length >= TASK_RATE_MAX);
  } catch (e) { return true; }
}

function evTaskDb(req, res) {
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return null;
  function h(opts) {
    var hh = { apikey: sbKey, Authorization: "Bearer " + sbKey, "Content-Type": "application/json" };
    if (opts && opts.headers) Object.assign(hh, opts.headers);
    return hh;
  }
  return {
    sbUrl: sbUrl, sbKey: sbKey, headers: h,
    async countInProgress() {
      // 统计 evops_tasks 表中进行中任务数（service_role 可读全表）
      try {
        var r = await fetch(sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=id&status=eq.in_progress&limit=1000", { headers: h() });
        if (r.ok) {
          var rows = await r.json();
          if (Array.isArray(rows)) return rows.length;
        }
      } catch (e) {}
      return 0;
    },
    async readRow(id) {
      var r = await fetch(sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), { headers: h() });
      if (!r.ok) return null;
      var rows = await r.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    }
  };
}

/** 读聚合看板 evops_status.identity=1 的 payload（对象），读不到返回 null。 */
async function readEvAggregated(db) {
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/evops_status?select=payload&id=eq.1", { headers: db.headers() });
    if (!r.ok) return null;
    var a = await r.json();
    if (Array.isArray(a) && a.length && a[0] && a[0].payload) return a[0].payload;
  } catch (e) {}
  return null;
}

/** 写聚合看板 evops_status.identity=1（upsert），登记/结束即时回流用。 */
async function writeEvAggregated(db, payload) {
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/evops_status", {
      method: "POST",
      headers: db.headers({ "Prefer": "resolution=merge-duplicates" }),
      body: JSON.stringify({ id: 1, payload: payload, updated_at: new Date().toISOString() })
    });
    return r.ok || r.status === 201;
  } catch (e) { return false; }
}

/**
 * 登记新任务 POST ?action=task-register
 * body: { type?, title*, description?, assignee?, eta_min?, status?, project? }
 * 9 上限：status=in_progress 时超限拒绝（409），不落库不排队。
 */
async function handleTaskRegister(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var title = String(body.title || "").trim();
  if (!title) return json(res, 400, { success: false, error: "Missing title" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });

  var type = String(body.type || "feature").trim();
  if (TASK_TYPES.indexOf(type) < 0) return json(res, 400, { success: false, error: "bad_type", detail: "type 只接受 " + TASK_TYPES.join("/") });
  var status = String(body.status || "in_progress").trim();
  if (TASK_STATUSES.indexOf(status) < 0) return json(res, 400, { success: false, error: "bad_status" });
  var eta = parseInt(body.eta_min, 10);
  if (body.eta_min != null && String(body.eta_min).length && !(eta > 0 && eta <= 1440)) {
    return json(res, 400, { success: false, error: "bad_eta", detail: "eta_min 需为 1~1440 的整数" });
  }

  // 匿名频率护栏：同来源(device|ip)5 分钟内登记数 ≤ 12，防公开写被刷（AI 带 token 不受此限）
  var authH = (req.headers && req.headers.authorization) || "";
  var deviceOwner = null;
  if (!authH || authH.indexOf("Bearer ") !== 0) {
    var src = String(body.device || (req.headers && req.headers["x-forwarded-for"]) || "anon").slice(0, 60);
    deviceOwner = "dev:" + src;
    if (!(await registerRateAllowed(db, src))) {
      return json(res, 429, {
        success: false, error: "rate_limited",
        message: "登记太频繁，请稍后再试（单来源 " + TASK_RATE_WINDOW_S + " 秒最多 " + TASK_RATE_MAX + " 条）"
      });
    }
  }

  // 9 上限拦截（仅限进行中）
  if (status === "in_progress") {
    var limit = 9;
    try { var cfg = await fetch(db.sbUrl + "/rest/v1/evops_status?select=payload&id=eq.1", { headers: db.headers() }); }
    catch (e) { cfg = null; }
    if (cfg && cfg.ok) {
      var rows = await cfg.json();
      if (Array.isArray(rows) && rows.length && rows[0] && rows[0].payload && rows[0].payload.summary) {
        var m = parseInt(rows[0].payload.summary.max_parallel, 10);
        if (m > 0) limit = m;
      }
    }
    var cur = await db.countInProgress();
    if (cur >= limit) {
      return json(res, 409, {
        success: false, error: "parallel_limit_reached",
        message: "已达并行上限 " + limit + "，禁止排队：先结束一个进行中任务腾出槽位",
        in_progress: cur, max: limit
      });
    }
  }

  var id = "reg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  var now = new Date().toISOString();
  var row = {
    id: id, project: String(body.project || "").trim().slice(0, 120),
    title: title.slice(0, 240), type: type,
    description: body.description != null ? String(body.description).slice(0, 2000) : null,
    assignee: body.assignee ? String(body.assignee).trim().slice(0, 64) : null,
    eta_min: eta > 0 ? eta : null,
    status: status, priority: String(body.priority || "P2").trim().slice(0, 4),
    owner: deviceOwner || String(body.owner || body.assignee || "register").trim().slice(0, 120),
    source: "register",
    extra: { note: body.note ? String(body.note).slice(0, 500) : null },
    created_at: now, updated_at: now
  };
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE, {
      method: "POST", headers: db.headers({ Prefer: "return=minimal" }), body: JSON.stringify(row)
    });
    if (!(r.ok || r.status === 201)) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
    }
    // 登记即回流：把任务即时并入聚合看板（写 evops_status → Realtime → 手机秒级可见）。
    // 权威仍在 evops_tasks；这里只是"预置展示"，采集器下次合并按 id 去重统一聚合。
    var agg = await readEvAggregated(db);
    if (agg) {
      var s = agg.summary || (agg.summary = {});
      var inc = status === "in_progress" ? 1 : 0;
      s.total = (s.total || 0) + 1;
      if (status === "in_progress") s.in_progress = (s.in_progress || 0) + inc;
      if (status === "planned") s.planned = (s.planned || 0) + 1;
      // 避免重复追加：同 id 已存在则替换，否则尾插
      var list = agg.tasks || (agg.tasks = []);
      var idx = list.findIndex(function (t) { return t.id === id; });
      var view = { id: id, project: row.project, title: row.title, type: row.type, status: row.status,
        assignee: row.assignee, eta_min: row.eta_min, description: row.description,
        priority: row.priority, owner: row.owner, source: "register", created_at: now, updated_at: now };
      if (idx >= 0) list[idx] = view; else list.push(view);
      agg.count = list.length;
      agg.updated_at = new Date().toISOString();
      await writeEvAggregated(db, agg);
      return json(res, 201, {
        ok: true, id: id, status: status,
        summary: { total: s.total, in_progress: s.in_progress, max_parallel: limit },
        note: "已登记并即时回流看板（采集器将合并进 tasks.json 正式聚合）"
      });
    }
    return json(res, 201, { ok: true, id: id, status: status, store: "supabase" });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 修改任务 POST ?action=task-update（按 id 定位，只更新给定字段，幂等）
 * body: { id*, title?, type?, description?, assignee?, eta_min?, priority?, project? }
 */
async function handleTaskUpdate(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var id = String(body.id || "").trim();
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });

  var patch = {}, has = false;
  ["title", "type", "project"].forEach(function (k) {
    if (body[k] != null) { patch[k] = String(body[k]).slice(0, k === "description" ? 2000 : 240); has = true; }
  });
  if (body.description != null) { patch.description = String(body.description).slice(0, 2000); has = true; }
  if (body.assignee != null) { patch.assignee = String(body.assignee).trim().slice(0, 64) || null; has = true; }
  if (body.priority != null) { patch.priority = String(body.priority).trim().slice(0, 4); has = true; }
  if (body.eta_min != null) {
    var eta = parseInt(body.eta_min, 10);
    if (!(eta > 0 && eta <= 1440)) return json(res, 400, { success: false, error: "bad_eta" });
    patch.eta_min = eta; has = true;
  }
  if (body.type != null && TASK_TYPES.indexOf(patch.type) < 0) return json(res, 400, { success: false, error: "bad_type" });
  if (!has) return json(res, 400, { success: false, error: "Nothing to update" });
  var existing = await db.readRow(id);
  if (!existing) return json(res, 404, { success: false, error: "not_found", detail: "任务 " + id + " 不存在" });
  patch.updated_at = new Date().toISOString();
  try {
    // 预检查：PATCH 对不存在的行静默返回成功（Supabase 行为），故先用 readRow 确认存在，避免「改了不存在的任务还报成功」。
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: db.headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_update_failed", detail: String(txt).slice(0, 200) });
    }
    return json(res, 200, { success: true, id: id, updated: Object.keys(patch) });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 补充任务 POST ?action=task-append（追加描述段落 / 管理员答复，永不覆盖）
 * body: { id*, append?<追加描述>, reply?{by,role,text} }
 */
async function handleTaskAppend(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var id = String(body.id || "").trim();
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var append = body.append != null ? String(body.append).trim().slice(0, 2000) : "";
  var reply = body.reply && typeof body.reply === "object" ? body.reply : null;
  if (!append && !reply) return json(res, 400, { success: false, error: "Nothing to append" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });

  var row = await db.readRow(id);
  if (!row) return json(res, 404, { success: false, error: "not_found", detail: "任务 " + id + " 不存在" });

  var patch = { updated_at: new Date().toISOString() };
  if (append) {
    var combined = String(row.description || "");
    combined = combined ? combined + "\n\n—— 补充（" + new Date().toISOString() + "）——\n" + append : append;
    patch.description = combined.slice(0, 5000);
  }
  if (reply) {
    var replies = Array.isArray(row.replies) ? row.replies : [];
    replies.push({
      by: String(reply.by || "admin").trim().slice(0, 64),
      role: String(reply.role || "admin").trim().slice(0, 16),
      at: new Date().toISOString(),
      text: String(reply.text || "").slice(0, 500)
    });
    patch.replies = replies;
  }
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: db.headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_append_failed", detail: String(txt).slice(0, 200) });
    }
    return json(res, 200, { success: true, id: id, appended: !!append, replied: !!reply });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 结束任务 POST ?action=task-close
 * body: { id*, status*: done|cancelled|blocked, close_reason?, closed_note?, evidence? }
 * done(解决)：close_reason=fixed，closed_note 作为文字证明（§五 已确认松绑，可无 git commit）。
 * cancelled(废弃)/blocked(未解决)：close_reason 必填。
 */
async function handleTaskClose(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var id = String(body.id || "").trim();
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var status = String(body.status || "").trim();
  if (["done", "cancelled", "blocked"].indexOf(status) < 0) {
    return json(res, 400, { success: false, error: "bad_status", detail: "结束状态只接受 done/cancelled/blocked" });
  }
  var reason = String(body.close_reason || "").trim().slice(0, 40);
  var note = body.closed_note != null ? String(body.closed_note).slice(0, 1000) : null;
  if (status !== "done" && !reason) {
    return json(res, 400, { success: false, error: "reason_required", detail: "cancelled/blocked 必须给原因（护栏①）" });
  }
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });

  var row = await db.readRow(id);
  if (!row) return json(res, 404, { success: false, error: "not_found", detail: "任务 " + id + " 不存在" });

  var patch = {
    status: status,
    close_reason: reason || null,
    closed_note: note,
    updated_at: new Date().toISOString()
  };
  var extra = (typeof row.extra === "object" && row.extra) || {};
  if (body.evidence) extra.evidence = Array.isArray(body.evidence) ? body.evidence.map(String).slice(0, 10) : [String(body.evidence)];
  if (note) extra.closed_note = note;
  patch.extra = extra;
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: db.headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_close_failed", detail: String(txt).slice(0, 200) });
    }
    // 回流看板：同步聚合快照中的该任务状态与计数（真正写回）
    var agg = await readEvAggregated(db);
    if (agg) {
      var s = agg.summary || (agg.summary = {});
      var wasInProgress = String(row.status) === "in_progress";
      if (status === "in_progress" && !wasInProgress) s.in_progress = (s.in_progress || 0) + 1;
      if (wasInProgress && status !== "in_progress") s.in_progress = Math.max(0, (s.in_progress || 1) - 1);
      var list = agg.tasks || (agg.tasks = []);
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === id) { list[i].status = status; list[i].close_reason = reason || list[i].close_reason; break; }
      }
      agg.updated_at = new Date().toISOString();
      await writeEvAggregated(db, agg);
    }
    return json(res, 200, { success: true, id: id, status: status, reason: reason || null });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  var action = (req.query && req.query.action) || "";
  var query = req.query || {};

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
      case "ev-status":
        // 公开读：EvOps 安卓端拉取项目/任务动态层
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleEvStatusGet(req, res);
      case "ev-status-write":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleEvStatusWrite(req, res);
      case "ev-priority-set":
        // 公开写：只允许降级（P1/P2），护栏③「人一键降级」
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleEvPrioritySet(req, res);
      case "ev-priority-get":
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleEvPriorityGet(req, res);
      case "ev-command-write":
        // 公开写：手机端任务指令（加急/取消/尽快收尾/自定义），护栏内置（理由必填+限流）
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleEvCommandWrite(req, res);
      case "ev-command-get":
        // 公开读：Mac 监听器取指令 / 看板回查指令轨迹
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleEvCommandGet(req, res, query);
      case "ev-command-status":
        // 公开写：指令状态回写（delivered/ack/executed/rejected），仅供状态机流转
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleEvCommandStatus(req, res);
      case "task-register":
        // 任务登记（P1）：Bearer EV_SYNC_TOKEN，写 evops_tasks 表 + 9 上限拦截
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskRegister(req, res);
      case "task-update":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskUpdate(req, res);
      case "task-append":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskAppend(req, res);
      case "task-close":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskClose(req, res);
      default:
        return json(res, 400, { success: false, error: "Unknown action" });
    }
  } catch (e) {
    console.error("[ev] error:", e && e.message ? e.message : e);
    return json(res, 500, { success: false, error: (e && e.message) || "Internal error" });
  }
};