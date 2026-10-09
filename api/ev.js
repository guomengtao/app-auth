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
var https = require("https");   // GitHub Release 查询（线上版本事实源，见 PROJECT_REPOS）

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

var RELEASE_CACHE = "ev:online:release"; // GitHub 最新 Release 缓存（hash: project → JSON）
var RELEASE_TTL   = 10 * 60 * 1000;      // 缓存 10 分钟：够省 GitHub 配额，滞后也可接受

var DEV_CACHE = "ev:dev:github";         // 「开发版本」事实源缓存（hash: project → {v,code,src,ts}）
                                         // 2026-10-06 用户裁决 B 案：dev 也改从 GitHub main 读，
                                         // 与 online 同源同新鲜度，不再依赖 Mac 扫描（TTL 复用 RELEASE_TTL）

/**
 * 项目 id → GitHub 仓库。只登记「会发 release」的仓。
 *
 * app-auth 是网站（Vercel 自动部署 main，没有「发布」这个动作），故意不在此表
 * → 由 selfReportedVersion() 自报兜底。
 * 2026-10-06 用户裁决：线上版本以「发布 release」为准，故这张表是事实源；
 * 未登记的仓一律显示「未发布」，不伪造（用户明确不开展「发版必打 release」纪律，
 * 因为正式版要反复验证后才发 → 长期没有 release 是常态，如实留空即可）。
 */
var PROJECT_REPOS = {
  "class-schedule": "guomengtao/class-schedule",
  "ev-schedule-android": "guomengtao/ev-schedule-android",
  "ev-android": "guomengtao/ev-notifier-android",
  "ev-notifier": "guomengtao/ev-notifier",
  "ev-schedule-sync": "guomengtao/ev-schedule-sync",
  "evbox": "guomengtao/evbox",
  "ev-face": "guomengtao/ev-face",
  "ev-emubuddy": "guomengtao/ev-emubuddy",
  "region-manager": "guomengtao/region-manager",
  "ev-ops-android": "guomengtao/ev-ops-android",
  "ev-tank-battle": "guomengtao/ev-tank-battle"
};

/**
 * 项目 id → 远端「开发版本」文件（GitHub main 分支）。**开发版本的事实源**。
 *
 * 2026-10-06 用户裁决 B 案：「超前是怎么回事，我们不是获取的最新的版本号，怎么会落后？」
 * → 查实根因是 dev 侧取的是 Mac 本机 `data/projects.json` 快照，而 `gen-projects.js`
 *   全仓无人调用、4 天没跑过 → dev 冻结在旧值，与实时的 GitHub Release 相比必然错位，
 *   于是线上反而显新、误报「运行超前」。B 案：dev 也改从 GitHub 读，两条链路都实时。
 *
 * kind / 字段 / 解析规则与 `ev/ev-ops-android/scripts/gen-projects.js::readVersion()`
 * 严格保持一致 —— 保证「GitHub 读值」与「Mac 扫描值」口径相同（后者自此仅作兜底）。
 * 仓库映射本可复用 PROJECT_REPOS；但 app-auth 未登记在其中（它不是「会发 release」的仓，
 * 见上表注释），且 ev-android 的仓名是 ev-notifier-android，故此处独立成表、写全。
 *
 * 语义变化（用户已认可）：dev 自此 = **已推送到远端 main 的版本**，而非「本机工作区版本」；
 * 本机有未 push 的提交时 dev 会低于本机号，这是与 online 同源的修正，不是缺陷。
 */
var PROJECT_DEV = {
  "class-schedule":      { repo: "guomengtao/class-schedule",      path: "src/manifest.json", kind: "manifest" },
  "ev-schedule-android": { repo: "guomengtao/ev-schedule-android", path: "apk/version.env",   kind: "env", nameKey: "VERSION_NAME", codeKey: "VERSION_CODE" },
  "app-auth":            { repo: "guomengtao/app-auth",            path: "version.json",      kind: "json", nameKey: "version" },
  "ev-notifier":         { repo: "guomengtao/ev-notifier",         path: "version.json",      kind: "json", nameKey: "version" },
  "ev-schedule-sync":    { repo: "guomengtao/ev-schedule-sync",    path: "Cargo.toml",        kind: "toml" },
  "evbox":               { repo: "guomengtao/evbox",               path: "src/manifest.json", kind: "manifest" },
  "ev-face":             { repo: "guomengtao/ev-face",             path: "src/manifest.json", kind: "manifest" },
  "ev-emubuddy":         { repo: "guomengtao/ev-emubuddy",         path: "version.json",      kind: "json", nameKey: "version" },
  "region-manager":      { repo: "guomengtao/region-manager",      path: "region_manager.py", kind: "regex", pattern: "^VERSION\\s*=\\s*\"([^\"]+)\"" },
  "ev-android":          { repo: "guomengtao/ev-notifier-android", path: "version.txt",       kind: "txt" },
  "ev-ops-android":      { repo: "guomengtao/ev-ops-android",      path: "version.txt",       kind: "txt" },
  "ev-tank-battle":      { repo: "guomengtao/ev-tank-battle",      path: "src/manifest.json", kind: "manifest" }
};

/** 极简 GitHub GET（零依赖原生 https）；4s 超时、任何异常一律 resolve(null)，绝不抛。 */
function githubGet(pathname) {
  return new Promise(function (resolve) {
    var token = process.env.GITHUB_TOKEN;
    var headers = { "User-Agent": "ev-ops-status", "Accept": "application/vnd.github+json" };
    if (token) headers.Authorization = "Bearer " + token;
    var req = https.get(
      { hostname: "api.github.com", path: pathname, headers: headers, timeout: 4000 },
      function (r) {
        var buf = "";
        r.on("data", function (d) { buf += d; });
        r.on("end", function () {
          if (r.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
        });
      });
    req.on("error", function () { resolve(null); });
    req.on("timeout", function () { try { req.destroy(); } catch (e) { } resolve(null); });
  });
}

/** 拉单个项目的最新 Release → { v, at, ts }；无 release / 无权限 / 失败 → v 为 null。 */
async function fetchGithubRelease(project) {
  var rec = { v: null, at: 0, ts: Date.now() };
  var repo = PROJECT_REPOS[project];
  if (!repo) return rec;
  var got = await githubGet("/repos/" + repo + "/releases/latest");
  if (got && got.tag_name) {
    rec.v = String(got.tag_name).replace(/^v/i, "");      // v1.7.90 → 1.7.90
    rec.at = Date.parse(got.published_at || "") || 0;      // release 发布时间
  }
  return rec;
}

/** 只读 Release 缓存（不打 GitHub）。 */
async function readReleaseCache() {
  var out = {};
  try {
    var all = await redis.hgetall(RELEASE_CACHE);
    if (all && typeof all === "object") {
      Object.keys(all).forEach(function (k) {
        try { out[k] = JSON.parse(all[k]); } catch (e) { }
      });
    }
  } catch (e) { /* redis 不可用 → 空表 */ }
  return out;
}

/** 读缓存；对缺失/过期的项目并发补拉一次（缓存热时零网络请求）。 */
async function refreshReleases() {
  var cached = await readReleaseCache();
  var now = Date.now();
  var todo = Object.keys(PROJECT_REPOS).filter(function (p) {
    var c = cached[p];
    return !c || !c.ts || (now - c.ts) > RELEASE_TTL;
  });
  if (!todo.length) return cached;
  var got = await Promise.all(todo.map(function (p) { return fetchGithubRelease(p); }));
  var patch = {};
  todo.forEach(function (p, i) {
    cached[p] = got[i];
    patch[p] = JSON.stringify(got[i]);
  });
  try { await redis.hset(RELEASE_CACHE, patch); } catch (e) { /* 缓存写失败不影响本次结果 */ }
  return cached;
}

/** 极简 GitHub 原始文件 GET（零依赖原生 https）；非 200 / 任何异常一律 resolve(null)，绝不抛。 */
function githubGetRaw(repo, filePath, ref) {
  return new Promise(function (resolve) {
    var token = process.env.GITHUB_TOKEN;
    var headers = { "User-Agent": "ev-ops-status", "Accept": "application/vnd.github.raw" };
    if (token) headers.Authorization = "Bearer " + token;
    var req = https.get(
      {
        hostname: "api.github.com",
        path: "/repos/" + repo + "/contents/" + filePath + "?ref=" + (ref || "main"),
        headers: headers,
        timeout: 4000
      },
      function (r) {
        var buf = "";
        r.on("data", function (d) { buf += d; });
        r.on("end", function () {
          if (r.statusCode !== 200) return resolve(null);   // 404/403（无 token 读私有仓）→ null
          resolve(buf);
        });
      });
    req.on("error", function () { resolve(null); });
    req.on("timeout", function () { try { req.destroy(); } catch (e) { } resolve(null); });
  });
}

/** 按 kind 解析版本，规则与 gen-projects.js::readVersion() 一致。解析不出 → null。 */
function parseDevVersion(text, spec) {
  if (!text || !spec) return null;
  var v = null, code = null;
  try {
    if (spec.kind === "json") {
      var j = JSON.parse(text);
      v = j[spec.nameKey || "version"] || null;
      if (j.patch != null) code = String(j.patch);
    } else if (spec.kind === "manifest") {
      var m = JSON.parse(text);
      v = m.versionName || null;
      code = (m.versionCode != null) ? String(m.versionCode) : null;
    } else if (spec.kind === "env") {
      var pick = function (k) {
        var r = text.match(new RegExp("^" + k + "\\s*=\\s*(.+)$", "m"));
        return r ? r[1].trim() : null;
      };
      v = pick(spec.nameKey);
      code = pick(spec.codeKey);
    } else if (spec.kind === "toml") {
      var r2 = text.match(/^version\s*=\s*"([^"]+)"/m);
      v = r2 ? r2[1] : null;
    } else if (spec.kind === "txt") {
      v = text.trim() || null;
    } else if (spec.kind === "regex") {
      var r3 = text.match(new RegExp(spec.pattern, "m"));
      v = r3 ? r3[1] : null;
    }
  } catch (e) { return null; }
  if (v == null) return null;
  v = String(v).trim();
  return v ? { v: v, code: code } : null;
}

/** 拉单个项目的远端开发版本 → { v, code, src, ts }；拿不到 → v 为 null。 */
async function fetchGithubDev(project) {
  var rec = { v: null, code: null, src: null, ts: Date.now() };
  var spec = PROJECT_DEV[project];
  if (!spec) return rec;
  var text = await githubGetRaw(spec.repo, spec.path, "main");
  var parsed = parseDevVersion(text, spec);
  if (parsed) {
    rec.v = parsed.v;
    rec.code = parsed.code;
    rec.src = spec.repo + "@main:" + spec.path;
  }
  return rec;
}

/** 只读 dev 缓存（不打 GitHub）。 */
async function readDevCache() {
  var out = {};
  try {
    var all = await redis.hgetall(DEV_CACHE);
    if (all && typeof all === "object") {
      Object.keys(all).forEach(function (k) {
        try { out[k] = JSON.parse(all[k]); } catch (e) { }
      });
    }
  } catch (e) { /* redis 不可用 → 空表 */ }
  return out;
}

/** 读缓存；对缺失/过期项并发补拉一次（缓存热时零网络请求）。 */
async function refreshDevVersions() {
  var cached = await readDevCache();
  var now = Date.now();
  var todo = Object.keys(PROJECT_DEV).filter(function (p) {
    var c = cached[p];
    return !c || !c.ts || (now - c.ts) > RELEASE_TTL;
  });
  if (!todo.length) return cached;
  var got = await Promise.all(todo.map(function (p) { return fetchGithubDev(p); }));
  var patch = {};
  todo.forEach(function (p, i) {
    cached[p] = got[i];
    patch[p] = JSON.stringify(got[i]);
  });
  try { await redis.hset(DEV_CACHE, patch); } catch (e) { /* 缓存写失败不影响本次结果 */ }
  return cached;
}

/**
 * 用 GitHub main 的版本文件覆盖 payload 里各项目的「开发版本」。
 *
 * 拿不到时（未配 GITHUB_TOKEN 的私有仓 / 文件不存在 / 网络失败）**保留 Mac 采集的原值**，
 * 既不置空也不报错 —— 保证「最坏情况 = 退回改造前的行为」，不会让页面变差。
 * 只动 version 一个字段；projects[] 里 local_path / git(dirty/ahead) 等仍由 Mac 扫描提供。
 */
async function applyDevVersions(payload) {
  if (!payload || !Array.isArray(payload.projects) || !payload.projects.length) return;
  var dev;
  try { dev = await refreshDevVersions(); } catch (e) { return; }
  payload.projects.forEach(function (pr) {
    if (!pr || !pr.id) return;
    var d = dev[pr.id];
    if (!d || !d.v) return;                    // 拿不到 → 原值不动
    if (!pr.version || typeof pr.version !== "object") pr.version = {};
    pr.version.value = d.v;
    if (d.code != null) pr.version.code = d.code;
    pr.version.source = d.src || "github:main";
    pr.version.origin = "github";              // 可观测：标明该值来自 GitHub，非 Mac 扫描
  });
}

/**
 * 自报版本：后端自己就是 app-auth，Vercel 部署的那份代码 = 线上代码，
 * 读自身 version.json（每次 commit 由 bump-version.sh 自动 +1 patch）即线上版本。
 * 本地读、无网络、无误判；本机领先远端未 push 时会正确表现为「待发版」。
 */
function selfReportedVersion() {
  try {
    var j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "version.json"), "utf-8"));
    return (j && j.version) ? String(j.version) : null;
  } catch (e) { return null; }
}

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

/**
 * 汇总「线上版本」—— 四源合并，优先级从低到高：
 *   ① 文件种子 data/online-versions.json（人工维护的历史值）
 *   ② Redis ev:online（report-deploy 回写值，定位＝纠错兜底）
 *   ③ GitHub 最新 Release（2026-10-06 用户裁决：**以发布 release 为准**）
 *   ④ 自报（app-auth 读自身 version.json）
 * 高优先级覆盖低优先级；某源缺该项目的值则不参与覆盖（不会把已有值抹成空）。
 */
async function loadOnline() {
  var online = loadOnlineSync();

  try {
    var ov = await redis.hgetall(ONLINE_HASH);
    if (ov && typeof ov === "object") {
      Object.keys(ov).forEach(function (k) { if (ov[k] != null && ov[k] !== "") online[k] = ov[k]; });
    }
  } catch (e) { /* redis 不可用退回文件 */ }

  try {
    var rel = await refreshReleases();
    Object.keys(rel).forEach(function (k) {
      if (rel[k] && rel[k].v) online[k] = rel[k].v;
    });
  } catch (e) { /* GitHub 不可用 → 保留手写/种子值，页面不报错 */ }

  var self = selfReportedVersion();
  if (self) online["app-auth"] = self;

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
  // 「线上部署于」改以 Release 发布时间为准（新口径；无 release 的项目保留手写时间戳）
  try {
    var relMeta = await readReleaseCache();
    Object.keys(relMeta).forEach(function (k) {
      if (relMeta[k] && relMeta[k].at > 0) onlineTs[k] = relMeta[k].at;
    });
  } catch (e) { /* 可选信息，失败不影响页面 */ }
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
    self_commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7),
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
 * EvOps 配置（槽位上限云端化，2026-10-06）
 *
 * 真值放 Supabase evops_config(id=1)。手机 App 直接读写本表，云端闸门
 * （handleTaskRegister）也读本表 —— Mac 侧的 collect-status 上报与
 * ev-command-listener 常驻**全部退出该链路**（方案：槽位上限云端化-摆脱Mac常驻-方案.md）。
 * 自此 evops_status.payload.summary.max_parallel 只是本表的「投影」（read 时实时覆盖）。
 * ===================================================================== */
var EV_CONFIG_DEFAULT_MAX = 9;
var EV_CONFIG_MIN = 1;
var EV_CONFIG_MAX = 99;

/** 读上限真值（供 task-register / ev-status 复用）。读不到 → fail-closed 默认 9。 */
async function readMaxParallel(db) {
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/evops_config?id=eq.1&select=max_parallel", { headers: db.headers() });
    if (r && r.ok) {
      var rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        var n = parseInt(rows[0].max_parallel, 10);
        if (n >= EV_CONFIG_MIN && n <= EV_CONFIG_MAX) return n;
      }
    }
  } catch (e) { /* fall through */ }
  return EV_CONFIG_DEFAULT_MAX;
}

/**
 * EvOps 配置 —— 读：GET ?action=ev-config-read（公开）
 * 返回 { success, max_parallel, updated_at, updated_by, store }。永不 5xx：任何异常都回退默认值。
 */
async function handleEvConfigRead(req, res) {
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) {
    return json(res, 200, { success: true, max_parallel: EV_CONFIG_DEFAULT_MAX, store: "default" });
  }
  try {
    var r = await fetch(sbUrl + "/rest/v1/evops_config?id=eq.1&select=max_parallel,updated_at,updated_by", {
      headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
    });
    if (r.ok) {
      var rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        var n = parseInt(rows[0].max_parallel, 10);
        return json(res, 200, {
          success: true,
          max_parallel: (n >= EV_CONFIG_MIN && n <= EV_CONFIG_MAX) ? n : EV_CONFIG_DEFAULT_MAX,
          updated_at: rows[0].updated_at || null,
          updated_by: rows[0].updated_by || null,
          store: "supabase"
        });
      }
      return json(res, 200, { success: true, max_parallel: EV_CONFIG_DEFAULT_MAX, store: "empty" });
    }
    return json(res, 200, { success: true, max_parallel: EV_CONFIG_DEFAULT_MAX, store: "fallback" });
  } catch (e) {
    return json(res, 200, { success: true, max_parallel: EV_CONFIG_DEFAULT_MAX, store: "error" });
  }
}

/**
 * EvOps 配置 —— 写：POST ?action=ev-config-write
 * body = { max_parallel*, device? }。公开写（与 ev-command-write 同级别安全模型），
 * 护栏：范围 1..99 + 同来源 60s ≤ 20 次。写成功即刻生效（闸门下次判定就读到新值）。
 */
async function handleEvConfigWrite(req, res) {
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var n = parseInt(body.max_parallel, 10);
  if (!(n >= EV_CONFIG_MIN && n <= EV_CONFIG_MAX)) {
    return json(res, 400, {
      success: false, error: "bad_max_parallel",
      detail: "max_parallel 需为 " + EV_CONFIG_MIN + "~" + EV_CONFIG_MAX + " 的整数"
    });
  }
  var sbUrl = process.env.NEXT_PUBLIC_Ev_SUPABASE_URL;
  var sbKey = process.env.Ev_SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return json(res, 500, { success: false, error: "no_store_configured" });

  var src = String(body.device || (req.headers && req.headers["x-forwarded-for"]) || "anon").slice(0, 60);
  if (!evConfigRateAllowed(src)) {
    return json(res, 429, { success: false, error: "rate_limited", message: "改上限太频繁，请稍后再试（单来源 60 秒最多 20 次）" });
  }

  var by = String(body.device || "app").slice(0, 60);
  try {
    var r = await fetch(sbUrl + "/rest/v1/evops_config", {
      method: "POST",
      headers: {
        apikey: sbKey, Authorization: "Bearer " + sbKey,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify({ id: 1, max_parallel: n, updated_at: new Date().toISOString(), updated_by: by })
    });
    if (r.ok || r.status === 201) {
      return json(res, 200, { success: true, max_parallel: n, updated_by: by, store: "supabase" });
    }
    var txt = await r.text();
    return json(res, 502, { success: false, error: "supabase_write_failed", detail: String(txt).slice(0, 200) });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

// 轻量限流（进程内计数；Vercel 多实例下为近似，够用且零依赖）
var _evCfgHits = {};
function evConfigRateAllowed(src) {
  var now = Date.now(), win = 60000, max = 20;
  var arr = (_evCfgHits[src] || []).filter(function (t) { return now - t < win; });
  if (arr.length >= max) { _evCfgHits[src] = arr; return false; }
  arr.push(now); _evCfgHits[src] = arr;
  return true;
}

/* =====================================================================
 * EvOps 任务登记 —— 写接口（P1，方案甲 Supabase 直写 evops_tasks 表）
 * 出处：ev-ops-android/docs/EvOps-任务登记与管理方案.md §4
 * 鉴权：同 ev-status-write，Bearer EV_SYNC_TOKEN（Mac 持有 + 手机登记页其后端代写）。
 * 纪律：9 并行上限（与 evops_status.max_parallel 一致，默认 9）每写必拦，超限禁止排队直接拒绝。
 * ================================================================== */

var TASKS_TABLE = "evops_tasks";
var SESSIONS_TABLE = "evops_sessions";   // 会话身份（方案：docs/会话身份字段入库Supabase-方案.md）
var PROJECTS_TABLE = "evops_projects";   // 项目真源（2026-10-07：取代聚合 evops_status.payload.projects[]，方案 docs/聚合下线-只留Supabase真源-方案.md）

/* ───── 任务单号生成（evtask-{type}-{project}-{YYMMDD}-{6chars}）─── */

var BASE30 = "abcdefghjkmnpqrstuvwxyz23456789"; // 排除 0/O/I/l/1
var BASE30_MAP = [];
(function () { for (var i = 0; i < BASE30.length; i++) BASE30_MAP[BASE30.charCodeAt(i)] = i; })();

var TASK_TYPE_CODES = {
  feature: "F", develop: "D", bug: "B", git: "G",
  docs: "X", infra: "I", refactor: "R", research: "S"
};

function encodeBase30(buf) {
  var s = ""; for (var i = 0; i < (buf && buf.length || 0); i++) s += BASE30[buf[i] % 30]; return s;
}

function generateTaskId(type, project) {
  var t = TASK_TYPE_CODES[type] || String(type || "F").slice(0, 1).toUpperCase();
  var p = String(project || "none").replace(/[^a-z0-9-]/g, "").slice(0, 12) || "none";
  var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  var y = String(now.getFullYear()).slice(-2);
  var m = ("0" + (now.getMonth() + 1)).slice(-2);
  var d = ("0" + now.getDate()).slice(-2);
  var date = y + m + d;
  var ts = Date.now().toString(36);
  var rnd = require("crypto").randomBytes(2).toString("hex");
  var hash = require("crypto").createHash("sha256").update(ts + rnd).digest();
  var short = encodeBase30(hash.slice(0, 9)).slice(0, 6);
  return "evtask-" + t + "-" + p + "-" + date + "-" + short;
}

/* ───────────────────── */

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
    // 会话身份（2026-10-07）：一次拉全 evops_sessions，给每条任务带上 session_title / idle_min，
    // 手机端即可直观看出「这条任务属于哪个会话、那个会话还活着吗」（总纲 §3.16 判据）。
    var sessMap = {};
    try {
      var rs = await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE +
        "?select=sid,tool,title,started_at,heartbeat_at,status&limit=500", { headers: db.headers() });
      if (rs.ok) {
        var srows = await rs.json();
        if (Array.isArray(srows)) {
          srows.forEach(function (s) {
            if (!s || !s.sid) return;
            var idle = null;
            try { idle = Math.max(0, Math.round((Date.now() - new Date(s.heartbeat_at).getTime()) / 60000)); } catch (e) {}
            sessMap[s.sid] = { tool: s.tool || "", title: s.title || "", started_at: s.started_at || null, heartbeat_at: s.heartbeat_at || null, idle_min: idle, session_status: s.status || "" };
          });
        }
      }
    } catch (e) { /* 会话表读不到不影响任务合并 */ }
    var byId = {};
    rows.forEach(function (t) {
      if (!t || !t.id) return;
      var desc = t.description ? String(t.description) : "";
      var note = (t.extra && t.extra.note) ? String(t.extra.note) : "";
      var sess = t.session_sid ? sessMap[t.session_sid] : null;
      byId[t.id] = {
        id: t.id, project: t.project || "", title: t.title || "", type: t.type || "feature",
        status: t.status || "in_progress", priority: t.priority || "P2",
        assignee: t.assignee || "", eta_min: t.eta_min || 0, description: desc,
        owner: t.owner || "", source: "register", note: note,
        session_sid: t.session_sid || null,
        session_tool: sess ? sess.tool : null,
        session_title: sess ? sess.title : null,
        session_heartbeat_at: sess ? sess.heartbeat_at : null,
        session_idle_min: sess ? sess.idle_min : null,
        effort: taskEffort(t, sess || null, null), // 工时（2026-10-08 P1）
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
// 任务详情描述最短字数（用户 2026-10-07 定：必填且 >=50 字，写清开发目标与验收）
var TASK_DESC_MIN = 50;

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
  /**
   * 拼 PostgREST 请求头。
   *
   * ⚠️ 2026-10-07 修复（用户核实「心跳字段像是会话建立时间」时挖出）：
   * 旧实现只合并 `opts.headers`，而全站调用都写成 `h({ Prefer: "..." })` ——
   * **Prefer 被静默丢弃** → `?on_conflict=sid` 的 POST 对已存在的行退化成纯 INSERT
   * → PostgREST 409 冲突 → `upsertSession` 恒返回 false。后果：会话心跳只在首次入库成功，
   * 之后永远写不进去，`heartbeat_at` 看起来就等于「会话建立时刻」，
   * 连带让规则2 僵尸判定（idle_min）失真。
   * 现在两种写法都支持：`h({ headers: {...} })` 与 `h({ Prefer: "..." })`。
   */
  function h(opts) {
    var hh = { apikey: sbKey, Authorization: "Bearer " + sbKey, "Content-Type": "application/json" };
    if (opts) {
      if (opts.headers) Object.assign(hh, opts.headers);
      Object.keys(opts).forEach(function (k) {
        if (k !== "headers" && typeof opts[k] === "string") hh[k] = opts[k];
      });
    }
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
    async listInProgress() {
      // 拉进行中任务明细（created_at 升序），供并行上限 409 返回清单与「无人处理最老优先」建议。
      // ⚠️ 读失败返回 null（不吞错为 0）：读不到就不能证明有槽位，调用方须 fail-closed 拒发单号。
      try {
        var r2 = await fetch(sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=id,title,project,assignee,owner,session_sid,created_at,updated_at&status=eq.in_progress&order=created_at.asc&limit=1000", { headers: h() });
        if (r2.ok) {
          var rows2 = await r2.json();
          if (Array.isArray(rows2)) return rows2;
        }
      } catch (e) {}
      return null;
    },
    async readRow(id) {
      var r = await fetch(sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), { headers: h() });
      if (!r.ok) return null;
      var rows = await r.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },
    /** 规则1（每会话唯一单号）：该会话是否已有进行中单号。读失败返回 null（fail-closed 由调用方处理）。 */
    async listInProgressBySession(sid) {
      try {
        var r = await fetch(sbUrl + "/rest/v1/" + TASKS_TABLE +
          "?select=id,title,status,created_at&status=eq.in_progress&session_sid=eq." +
          encodeURIComponent(sid) + "&limit=5", { headers: h() });
        if (r.ok) {
          var rows = await r.json();
          if (Array.isArray(rows)) return rows;
        }
      } catch (e) {}
      return null;
    },
    /** 会话身份 upsert（on_conflict=sid；失败返回 false，调用方决定是否阻塞）。 */
    async upsertSession(row) {
      try {
        var r = await fetch(sbUrl + "/rest/v1/" + SESSIONS_TABLE + "?on_conflict=sid", {
          method: "POST",
          headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }),
          body: JSON.stringify(row)
        });
        return r.ok || r.status === 201;
      } catch (e) { return false; }
    },
    /** 项目真源 upsert（on_conflict=id；失败返回 false）。采集器推 data/projects.json。 */
    async upsertProjects(rows) {
      try {
        var r = await fetch(sbUrl + "/rest/v1/" + PROJECTS_TABLE + "?on_conflict=id", {
          method: "POST",
          headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }),
          body: JSON.stringify(rows)
        });
        return r.ok || r.status === 201;
      } catch (e) { return false; }
    }
  };
}

/**
 * 登记新任务 POST ?action=task-register
 * body: { type?, title*, assignee*, description?, eta_min?, status?, project? }
 * 9 上限：status=in_progress 时超限拒绝（409），不落库不排队。
 */
async function handleTaskRegister(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var title = String(body.title || "").trim();
  if (!title) return json(res, 400, { success: false, error: "Missing title" });
  // 任务详情描述必填（用户 2026-10-07 定：>=50 字）——杜绝「一句话空单」：
  // 没有可交付描述的任务不配拿单号，不足时明确告知还差多少字。
  var descVal = String(body.description == null ? "" : body.description).trim();
  if (descVal.length < TASK_DESC_MIN) {
    return json(res, 400, {
      success: false, error: "bad_description",
      min: TASK_DESC_MIN, current: descVal.length, need: TASK_DESC_MIN - descVal.length,
      message: "任务详情描述（description）必填且不少于 " + TASK_DESC_MIN + " 字，当前 " +
        descVal.length + " 字，还差 " + (TASK_DESC_MIN - descVal.length) +
        " 字。需写清：开发目标、改动范围、验收方式。"
    });
  }
  // 负责人【不再由调用方随意登记】：强制 = 会话 ID（见下方 session 解析），
  // 由钩子/登记助手随 body.session 带入 —— 接口侧不接受自定义 assignee（禁止无人认领）。
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

  // —— 会话身份（必填）——  调用方传 body.session = "<sid>" 或对象 {sid, raw_sid, tool, cwd, repo, title}
  // 方案：docs/会话身份字段入库Supabase-方案.md（用户 2026-10-07 已批「开始」）
  var sessIn = body.session;
  var sess = null;
  if (sessIn && typeof sessIn === "object") {
    sess = {
      sid: String(sessIn.sid || "").trim().slice(0, 120),
      raw_sid: sessIn.raw_sid ? String(sessIn.raw_sid).slice(0, 120) : null,
      tool: sessIn.tool ? String(sessIn.tool).slice(0, 32) : null,
      cwd: sessIn.cwd ? String(sessIn.cwd).slice(0, 240) : null,
      repo: sessIn.repo ? String(sessIn.repo).slice(0, 240) : null,
      title: sessIn.title ? String(sessIn.title).slice(0, 240) : null
    };
    if (!sess.sid) sess = null;
  } else if (sessIn) {
    sess = { sid: String(sessIn).trim().slice(0, 120) };
    if (!sess.sid) sess = null;
  }
  var sessionSid = sess ? sess.sid : null;
  if (!sessionSid) {
    return json(res, 400, {
      success: false, error: "missing_session",
      message: "禁止无人认领：body.session 必填（字符串 sid 或 {sid,...}）。" +
        "负责人（assignee）由服务端强制写成会话 ID，接口不接受自定义负责人。"
    });
  }

  // 规则1（用户 2026-10-07 重定义）：同一会话【进行中任务】只能有 1 个——
  // 不是「不许开新任务」，而是「手上的活没结束就不许再开新的」。
  // 命中即 409 并回传占用单 ID，要求调用方自己 task-close 收尾（禁止留垃圾）。
  if (sessionSid && status === "in_progress") {
    var openBySess = await db.listInProgressBySession(sessionSid);
    if (openBySess === null) {
      return json(res, 503, { success: false, error: "store_unavailable",
        message: "会话占用检查读取失败，无法确认该会话是否已有进行中单号，暂不发新单号；请稍后重试" });
    }
    if (openBySess.length) {
      return json(res, 409, {
        success: false, error: "session_has_open_task",
        session_sid: sessionSid,
        open_id: openBySess[0].id, open_task: openBySess[0],
        message: "你手上有未结束的任务 " + openBySess[0].id + "（同一会话同时只能有 1 个进行中任务，" +
          "不是不许开新任务，是手上的活必须先结束）。请先 task-close 结束它并收尾，不要留垃圾；" +
          "结束后就有名额，再提交这条新任务。"
      });
    }
  }

  // 9 上限拦截（仅限进行中）
  if (status === "in_progress") {
    // 上限真值来自云端 evops_config（2026-10-06 云端化：不再读 evops_status 快照，
    // 因而彻底不依赖 Mac 的 collect-status 上报与 listener 常驻）；读不到 → fail-closed 默认 9。
    var limit = await readMaxParallel(db);
    var prog = await db.listInProgress();
    if (prog === null) {
      // fail-closed：读不到进行中清单 = 无法证明有槽位，拒发单号（宁可挡、不可超发）
      return json(res, 503, {
        success: false, error: "store_unavailable",
        message: "进行中任务清单读取失败，无法确认并行槽位，暂不发新单号；请稍后重试（没有任务单号禁止开发）"
      });
    }
    var cur = prog.length;
    if (cur >= limit) {
      // 「无人处理」判定：assignee 为空，或 owner 为匿名/登记默认值（非具体认领人）
      function unclaimed(t) {
        var a = t && t.assignee ? String(t.assignee).trim() : "";
        if (a) return false;
        var o = t && t.owner ? String(t.owner).trim().toLowerCase() : "";
        return !o || o === "register" || o === "anon" || o === "aitest" || o.indexOf("dev:") === 0;
      }
      function withAge(t) {
        var age = 0;
        try { age = Math.max(0, Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000)); } catch (e) {}
        return {
          id: t.id, title: t.title, project: t.project || "",
          assignee: t.assignee || "", owner: t.owner || "",
          session_sid: t.session_sid || null,
          created_at: t.created_at, age_min: age
        };
      }
      // 排序：无人处理优先 → created_at 升序（最老在前）
      var sorted = prog.map(withAge).sort(function (x, y) {
        var ux = unclaimed(x) ? 0 : 1, uy = unclaimed(y) ? 0 : 1;
        if (ux !== uy) return ux - uy;
        return String(x.created_at).localeCompare(String(y.created_at));
      });
      return json(res, 409, {
        success: false, error: "parallel_limit_reached",
        in_progress: cur, max: limit,
        suggested: sorted.length ? sorted[0] : null,
        tasks: sorted,
        message: "已达并行上限 " + limit + "（当前进行中 " + cur + "）。请先选择一条【无人处理的较老任务】处理掉（task-close 或 task-update 改 status），才能获得新任务单号；没有任务单号禁止开发。"
      });
    }
  }

  var id = generateTaskId(type, body.project);
  var now = new Date().toISOString();
  var row = {
    id: id, project: String(body.project || "").trim().slice(0, 120),
    title: title.slice(0, 240), type: type,
    description: descVal.slice(0, 2000),
    assignee: sessionSid.slice(0, 64),   // 负责人 = 会话 ID（禁止无人认领；不采信调用方传值）
    eta_min: eta > 0 ? eta : null,
    status: status, priority: String(body.priority || "P2").trim().slice(0, 4),
    owner: deviceOwner || String(body.owner || sessionSid || "register").trim().slice(0, 120),
    session_sid: sessionSid,
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
    // 会话身份入库（规则1 / 僵尸判定用）：upsert evops_sessions + 维护 open_task_id。
    // ⚠️ 失败不阻塞主链路（任务已落库）；会话维度的全量同步走 ?action=session-sync。
    if (sessionSid) {
      var srow = { sid: sessionSid, heartbeat_at: now, status: "live", updated_at: now };
      if (sess.raw_sid) srow.raw_sid = sess.raw_sid;
      if (sess.tool) srow.tool = sess.tool;
      if (sess.cwd) srow.cwd = sess.cwd;
      if (sess.repo) srow.repo = sess.repo;
      if (sess.title) srow.title = sess.title;
      if (status === "in_progress") srow.open_task_id = id;
      await db.upsertSession(srow);
    }
    return json(res, 201, { ok: true, id: id, status: status, assignee: sessionSid, store: "supabase" });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 会话身份全量 upsert POST ?action=session-sync
 * body: { sessions: [ { sid*, raw_sid?, tool?, cwd?, repo?, title?, started_at?, heartbeat_at?, open_task_id?, status?, tasks? } ] }
 * 由 Mac 采集器（collect-status.js）把黑板 data/active/*.json 推上来；幂等（on_conflict=sid）。
 * —— 规则2（无名额判僵尸）：审查员读 evops_sessions.heartbeat_at 判断该会话是否还活着。
 */
async function handleSessionSync(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var list = Array.isArray(body.sessions) ? body.sessions : null;
  if (!list || !list.length) return json(res, 400, { success: false, error: "Missing sessions" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });
  var ok = 0, fail = 0;
  for (var i = 0; i < list.length && i < 200; i++) {
    var s = list[i] || {};
    var sid = String(s.sid || "").trim().slice(0, 120);
    if (!sid) { fail++; continue; }
    var row = { sid: sid, updated_at: new Date().toISOString() };
    if (s.raw_sid) row.raw_sid = String(s.raw_sid).slice(0, 120);
    if (s.tool) row.tool = String(s.tool).slice(0, 32);
    if (s.cwd) row.cwd = String(s.cwd).slice(0, 240);
    if (s.repo) row.repo = String(s.repo).slice(0, 240);
    if (s.title) row.title = String(s.title).slice(0, 240);
    // 模型维度（2026-10-09）：会话当前模型 + 用过的模型集合 + 客户端/版本
    if (s.model) row.model = String(s.model).slice(0, 64);
    if (Array.isArray(s.models)) row.models = s.models;
    if (s.client) row.client = String(s.client).slice(0, 32);
    if (s.version) row.version = String(s.version).slice(0, 32);
    if (s.started_at) row.started_at = s.started_at;
    if (s.heartbeat_at) row.heartbeat_at = s.heartbeat_at;
    if (s.open_task_id != null) row.open_task_id = String(s.open_task_id).slice(0, 80);
    if (s.status) row.status = String(s.status).slice(0, 16);
    if (Array.isArray(s.tasks)) {
      row.tasks = s.tasks.filter(function(t) {
        return t && t.id && String(t.id).indexOf("evtask-") === 0;
      });
    }
    if (s.extra) row.extra = s.extra;
    var r = await db.upsertSession(row);
    if (r) ok++; else fail++;
  }
  return json(res, 200, { success: true, upserted: ok, failed: fail, total: list.length });
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
    // 2026-10-08：detail 明确指出字段名 close_reason——此前只说"必须给原因"，
    // 调用方拿 body.reason 盲试 6 次全失败（晨割-20261008 实测，正确字段见 L1702 注释）
    return json(res, 400, { success: false, error: "reason_required", detail: "cancelled/blocked 必须给原因（护栏①）：body 传 close_reason 字段（≤40字），closed_note 可附详细说明" });
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
  extra.closed_at = new Date().toISOString(); // 工时方案③：精确关闭时刻，墙钟终点不再靠 updated_at 猜
  patch.extra = extra;
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: db.headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_close_failed", detail: String(txt).slice(0, 200) });
    }
    // 会话绑定清理（2026-10-07）：把指向本单的 open_task_id 清空。
    // 之前单关了字段还挂着旧号——用户发现 open_task_id 失真的一环。
    try {
      await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE + "?open_task_id=eq." + encodeURIComponent(id), {
        method: "PATCH", headers: db.headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({ open_task_id: null })
      });
    } catch (e2) { /* 清理失败不阻塞主链路 */ }
    return json(res, 200, { success: true, id: id, status: status, reason: reason || null });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/** extra 里的 note（对象或 JSON 字符串都兼容）—— 手机端「最后一条日志」的数据源。 */
function noteOfExtra(extra) {
  if (!extra) return "";
  try {
    var o = (typeof extra === "string") ? JSON.parse(extra) : extra;
    var v = o && o.note;
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}

/**
 * 任务列表公开读 —— 手机端「任务」栏目直接从 evops_tasks 表拉取（不经过聚合）。
 * 支持 ?status=in_progress 过滤（可选）；返回按 updated_at 降序，limit 200。
 */
/* ── 任务活跃度（2026-10-08，docs/任务活跃度-设计方案-v1.md）──
 * 三信号合成、木桶原则取最差：绑定会话心跳 / 任务 updated_at / 会话绑定存在性。
 * 纯派生值：不写库、零 schema 变更；阈值走环境变量 EV_ACT_TH_*（分钟），缺省 30/120/360。
 * orphan = 晨割 v2 的「无人负责」系统定义；unbound = 从未绑定会话（Trae 裸奔雷达）。
 */
function evActThresholds() {
  function num(v, dflt) { var n = parseInt(v, 10); return (n > 0) ? n : dflt; }
  var e = (typeof process !== "undefined" && process.env) || {};
  return {
    active: num(e.EV_ACT_TH_ACTIVE_MIN, 30),    // 心跳 ≤30min 视为活着
    stale: num(e.EV_ACT_TH_STALE_MIN, 120),     // updated_at ≤2h 视为活跃
    orphan: num(e.EV_ACT_TH_ORPHAN_MIN, 360)    // 6h = 晨割收割线
  };
}

/** @param t 任务行（需 updated_at / session_sid / status）
 *  @param sess 会话行或 null（需 heartbeat_at / session_status） */
function taskActivity(t, sess) {
  var th = evActThresholds();
  var now = Date.now();
  function ageMin(x) { try { return Math.max(0, Math.round((now - new Date(x).getTime()) / 60000)); } catch (e) { return null; } }
  var updIdle = t && t.updated_at ? ageMin(t.updated_at) : null;
  var hbIdle = sess && sess.heartbeat_at ? ageMin(sess.heartbeat_at) : null;
  if (!t || !t.session_sid) {
    // 从未绑定会话：updated_at 超收割线也算 orphan（挂着没人管），否则 unbound
    if (updIdle != null && updIdle > th.orphan) {
      return { activity: "orphan", idle_min: updIdle, stale_since: t && t.updated_at || null, reason: "no_session_and_stale" };
    }
    return { activity: "unbound", idle_min: updIdle, stale_since: null, reason: "never_bound" };
  }
  var ss = sess && sess.session_status ? String(sess.session_status) : "";
  var sessDead = ss !== "" && ["active", "online", "live"].indexOf(ss) < 0; // live=采集器在线态
  var orphan = (hbIdle != null && hbIdle > th.orphan) || !!sessDead ||
               (hbIdle == null && updIdle != null && updIdle > th.orphan);
  if (orphan) {
    return { activity: "orphan", idle_min: hbIdle != null ? hbIdle : updIdle,
             stale_since: sess && sess.heartbeat_at || t.updated_at || null,
             reason: sessDead ? "session_dead" : (hbIdle != null ? "heartbeat_stale" : "no_heartbeat_stale_task") };
  }
  if ((hbIdle != null && hbIdle <= th.active) && (updIdle != null && updIdle <= th.stale)) {
    return { activity: "active", idle_min: hbIdle, stale_since: null, reason: "" };
  }
  return { activity: "stale", idle_min: hbIdle != null ? hbIdle : updIdle,
           stale_since: (hbIdle != null && hbIdle > th.active) ? sess.heartbeat_at : t.updated_at, reason: "" };
}

/** 只读查询：任务活跃度清单（2026-10-08 P2）。
 * GET ?action=task-activity[&scope=orphan|stale|active|unbound][&status=in_progress][&limit=200]
 * 晨割 v2 消费方：scope=orphan 即「无人负责」收割清单，替代人肉时间戳判断。 */
async function handleTaskActivity(req, res) {
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  var q = (req && req.query) || {};
  var scope = String(q.scope || "").toLowerCase();
  var status = String(q.status || "in_progress");
  var limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 500);
  var url = db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=*&order=updated_at.desc&limit=" + limit;
  if (status && status !== "all") url += "&status=eq." + encodeURIComponent(status);
  try {
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) { var txt = await r.text(); return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) }); }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
    var sessMap = {};
    try {
      var rs = await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE +
        "?select=sid,started_at,heartbeat_at,status&limit=500", { headers: db.headers() });
      if (rs.ok) {
        var srows = await rs.json();
        if (Array.isArray(srows)) srows.forEach(function (s) { if (s && s.sid) sessMap[s.sid] = s; });
      }
    } catch (e) { /* 会话表读不到 → 全按无心跳判定 */ }
    var list = [];
    rows.forEach(function (t) {
      if (!t || !t.id) return;
      var s = t.session_sid ? (sessMap[t.session_sid] || null) : null;
      var act = taskActivity(t, s);
      var eff = taskEffort(t, s, null);
      // scope 扩展（P2）：capped/frozen 是工时复核雷达
      if (scope === "capped" && !eff.capped) return;
      if (scope === "frozen" && !eff.frozen) return;
      if (scope && ["orphan", "stale", "active", "unbound"].indexOf(scope) >= 0 && act.activity !== scope) return;
      list.push({ id: t.id, project: t.project || "", title: t.title || "", status: t.status || "in_progress",
                  assignee: t.assignee || "", activity: act.activity, idle_min: act.idle_min,
                  effort: { wall_min: eff.wall_min, active_min: eff.active_min, evidenced_min: eff.evidenced_min,
                            confidence: eff.confidence, frozen: eff.frozen, capped: eff.capped },
                  stale_since: act.stale_since, reason: act.reason, updated_at: t.updated_at });
    });
    var counts = { active: 0, stale: 0, orphan: 0, unbound: 0 };
    rows.forEach(function (t) {
      if (!t || !t.id) return;
      counts[taskActivity(t, t.session_sid ? (sessMap[t.session_sid] || null) : null).activity]++;
    });
    return json(res, 200, { success: true, scope: scope || "all", total: list.length, counts: counts, thresholds: { gap_min: evEffThresholds().gap, cap_days: evEffThresholds().capDays }, tasks: list });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/* ── 数字大屏聚合（2026-10-08，docs/数字大屏-设计方案-v1.md P1）──
 * GET ?action=dashboard —— 一帧返回 开发(任务) + 运营(PV/UV/激活/城市/周走势) 全量数据。
 * 数据源（零新表）：visitor_logs(Postgres, lib/visitor-log.js) / auth:activation_logs(redis) / evops_tasks+sessions(Supabase)。
 * 订单：爱发电订单散在 redis afdian:order:<no> 私钥下，无索引键可数 → 本期返回 null（端上显示 —），列入待办。
 * 缓存：内存 60s（大屏 30s 轮询，防打爆下游）；?fresh=1 跳缓存。 */
var _dashCache = { at: 0, data: null };

async function handleDashboard(req, res) {
  var now = Date.now();
  if (!_dashCache.data || now - _dashCache.at > 60000 || (req.query && req.query.fresh === "1")) {
    _dashCache.data = await buildDashboard(req);
    _dashCache.at = now;
  }
  return json(res, 200, Object.assign({ success: true, cached: now - _dashCache.at < 55000 }, _dashCache.data));
}

async function buildDashboard(req) {
  var out = { generated_at: new Date().toISOString(), ops: {}, dev: {} };
  var CST = 8 * 3600 * 1000;
  var bjDay = function (ms) { var d = new Date(ms + CST); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); };
  var todayStartIso = new Date(bjDay(Date.now()) + "T00:00:00+08:00").toISOString();
  var ystStartIso = new Date(new Date(todayStartIso).getTime() - 86400000).toISOString();
  var todayKey = bjDay(Date.now());
  var ystKey = bjDay(Date.now() - 86400000);

  // ── 运营：visitor_logs（PG）──
  try {
    var pg = require("../lib/postgres");
    var q = function (sql) { return pg.query(sql).then(function (r) { return r.rows || []; }); };
    var today = (await q("select count(*)::int pv, count(distinct visitor_hash)::int uv from visitor_logs where ts >= '" + todayStartIso + "'"))[0] || {};
    var total = (await q("select count(*)::int pv, count(distinct visitor_hash)::int uv from visitor_logs"))[0] || {};
    // 新访客：今天出现的 hash 在今天之前从没出现过
    var nv = (await q("select count(*)::int n from (select distinct visitor_hash from visitor_logs where ts >= '" + todayStartIso + "' and visitor_hash <> '' and visitor_hash not in (select distinct visitor_hash from visitor_logs where ts < '" + todayStartIso + "' and visitor_hash <> '')) t"))[0] || {};
    var city = await q("select coalesce(nullif(city,''),'未知') city, count(*)::int c from visitor_logs where ts >= '" + todayStartIso + "' group by 1 order by c desc limit 5");
    // 24 小时走势（bupe2h，用户 2026-10-08 指定由 7 日改）：pv / uv / app_pv 按小时桶（北京时间）
    var trend = await q("select to_char(ts at time zone 'Asia/Shanghai','MM-DD HH24:00') dkey," +
      " count(*)::int pv, count(distinct visitor_hash)::int uv," +
      " count(*) filter (where coalesce(device->>'model','')<>'' or coalesce(device->>'app_version','')<>'' or coalesce(device->>'install_id','')<>'')::int app_pv" +
      " from visitor_logs where ts >= now() - interval '24 hours' group by 1 order by 1");
    trend.forEach(function (r) { r.d = String(r.dkey || ""); });   // 'MM-DD HH24:00'
    // 大屏实时化（prv5y5）+ 访客增强（phkgzq，用户 2026-10-08 指定）：最新 10 条访客明细，
    // 城市中文化（复用 geo-zh 的 cityZhOf，307 城市映射；’/' 归一化兜底，翻不出回落原名），
    // 带访问网址 path——只取展示字段，不吐 ip/ua/hash（dash_events 推送同口径）
    var geoZh = require("../lib/geo-zh");
    var zhCity = function (c) {
      var v = String(c || "").trim();
      if (!v) return "未知";
      return geoZh.cityZhOf(v.replace(/’/g, "'")) || v;
    };
    var rv = await q("select ts, city, coalesce(device_model,'') model, coalesce(source,'visit') src, coalesce(path,'') p" +
      " from visitor_logs order by ts desc limit 10");
    // 最新订单：tracking_events kind=order（PG 同库，禁 redis 口径），取历史最新 1 条兜底
    var lo = await q("select ts, payload->>'plan_title' title, payload->>'amount' amount, coalesce(out_trade_no,'') no" +
      " from tracking_events where kind='order' order by ts desc limit 1");
    // ── 最近心跳（bupe2h，用户 2026-10-08 指定大屏加栏目）：hb 事件留痕表取近 24h，
    //    同 sid+task 取最新一次去重，最多 5 条；不足回退补 evops_sessions 最近会话 ──
    var hbRows = await q("select distinct on (payload->>'sid', payload->>'task') ts, payload->>'title' title," +
      " payload->>'tool' tool, payload->>'task' task, payload->>'sid' sid" +
      " from dash_events where t='hb' and ts >= now() - interval '24 hours'" +
      " order by payload->>'sid', payload->>'task', ts desc");
    hbRows.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    var hb = hbRows.slice(0, 5).map(function (r) { return { ts: new Date(r.ts).getTime(), title: r.title || "", tool: r.tool || "", task: r.task || "", sid: r.sid || "" }; });
    if (hb.length < 5) {
      var have = {}; hb.forEach(function (x) { have[x.sid + "|" + x.task] = 1; });
      var sessRows = await q("select sid, coalesce(title,'') title, coalesce(tool,'') tool, coalesce(open_task_id,'') task, heartbeat_at ts" +
        " from evops_sessions where heartbeat_at is not null order by heartbeat_at desc limit 10");
      for (var si = 0; si < sessRows.length && hb.length < 5; si++) {
        var s0 = sessRows[si];
        var key0 = s0.sid + "|" + s0.task;
        if (!have[key0]) { have[key0] = 1; hb.push({ ts: new Date(s0.ts).getTime(), title: s0.title, tool: s0.tool, task: s0.task, sid: s0.sid }); }
      }
      hb.sort(function (a, b) { return b.ts - a.ts; });
    }
    // ── 最近对话（evtask-D-evapp-auth-261009-fhtddx，2026-10-09 用户指定大屏加栏目）：
    //    dash_events t=prompt 全局最近 12 条（复用 qatst4 留痕数据，无新 action）；text 截 300 字 ──
    var pr = await q("select ts, payload->>'tool' tool, payload->>'sid' sid, payload->>'task' task," +
      " payload->>'title' title," +
      " left(coalesce(payload->>'text',''), 300) text" +
      " from dash_events where t='prompt' order by ts desc limit 12");
    var recentPrompts = pr.map(function (r) {
      return { ts: new Date(r.ts).getTime(), tool: r.tool || "", sid: r.sid || "", task: r.task || "", title: r.title || "", text: String(r.text || "") };
    });
    // ── 昨日对比（evtask-D-evev-ops-and-261008-gecm6s，用户 2026-10-08 指定）──
    var yp = (await q("select count(*)::int pv, count(distinct visitor_hash)::int uv from visitor_logs where ts >= '" + ystStartIso + "' and ts < '" + todayStartIso + "'"))[0] || {};
    // 昨日新访客：昨天出现的 hash 在昨天之前从没出现过
    var ynv = (await q("select count(*)::int n from (select distinct visitor_hash from visitor_logs where ts >= '" + ystStartIso + "' and ts < '" + todayStartIso + "' and visitor_hash <> '' and visitor_hash not in (select distinct visitor_hash from visitor_logs where ts < '" + ystStartIso + "' and visitor_hash <> '')) t"))[0] || {};
    var odCnt = (await q("select count(*) filter (where ts >= '" + todayStartIso + "')::int t, count(*) filter (where ts >= '" + ystStartIso + "' and ts < '" + todayStartIso + "')::int y from tracking_events where kind='order'"))[0] || {};
    out.ops = {
      pv_today: today.pv || 0, uv_today: today.uv || 0,
      pv_total: total.pv || 0, uv_total: total.uv || 0,
      new_visitors_today: nv.n || 0,
      city_top5: city.map(function (c) { return { city: zhCity(c.city), c: c.c }; }),  // V4 fubd7v：top5 也过中文（原漏映射输出英文） trend: trend,
      recent_visits: rv.map(function (r) { return { ts: new Date(r.ts).getTime(), city: zhCity(r.city), model: r.model, src: r.src, path: r.p }; }),
      last_order: lo.length ? { ts: new Date(lo[0].ts).getTime(), title: lo[0].title || "爱发电订单", amount: lo[0].amount || "", no: lo[0].no || "" } : null,
      orders: null,  // 待办：订单总数口径（tracking_events 之前的历史散键），见方案 §七
      orders_today: odCnt.t || 0, orders_yesterday: odCnt.y || 0,
      yesterday: { pv: yp.pv || 0, uv: yp.uv || 0, orders: odCnt.y || 0, new_visitors: ynv.n || 0 },
      recent_heartbeats: hb,
      recent_prompts: recentPrompts
    };
  } catch (e) { out.ops = { error: String(e && e.message) }; }

  // ── 运营：激活（redis auth:activation_logs，口径同 handleActivationStats）──
  try {
    var list = await redis.lrange("auth:activation_logs", 0, -1);
    var entries = [];
    for (var i = 0; i < list.length; i++) { try { entries.push(JSON.parse(list[i])); } catch (e2) {} }
    var today = bjDay(Date.now());
    var wk = bjDay(Date.now() - 6 * 86400000);
    var seenAll = {}, seenToday = {}, aToday = 0, aWeek = 0, aTotal = 0;
    var weekByDay = {};
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var eDay = bjDay(new Date(e.ts));
      var key = (e.code && String(e.code)) || (e.redeem && String(e.redeem)) || (e.device && String(e.device)) || ("i" + j);
      if (!seenAll[key]) { seenAll[key] = true; aTotal++; }
      if (eDay === today && !seenToday[key]) { seenToday[key] = true; aToday++; }
      if (eDay >= wk) { aWeek++; if (!weekByDay[eDay]) weekByDay[eDay] = 0; weekByDay[eDay]++; }
    }
    out.ops.act_today = aToday; out.ops.act_week7 = aWeek; out.ops.act_total = aTotal;
    out.ops.act_week_by_day = weekByDay;
  } catch (e3) { out.ops.act_today = 0; out.ops.act_total = 0; }

  // ── 开发：任务聚合（复用 taskActivity/taskEffort，同 task-activity 的取数模式）──
  try {
    var db = evTaskDb(req, null);
    if (db) {
      var url = db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=*&order=updated_at.desc&limit=300";
      var r = await fetch(url, { headers: db.headers() });
      var rows = r.ok ? await r.json() : [];
      if (!Array.isArray(rows)) rows = [];
      var sessMap = {};
      try {
        var rs = await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE + "?select=sid,title,started_at,heartbeat_at,status&limit=500", { headers: db.headers() });
        if (rs.ok) { var sr = await rs.json(); if (Array.isArray(sr)) sr.forEach(function (s) { if (s && s.sid) sessMap[s.sid] = s; }); }
      } catch (e4) {}
      var open = 0, active = 0, frozen = 0, blocked = 0;
      var doneRecent = [], flow = [];
      rows.forEach(function (t) {
        if (!t || !t.id) return;
        var s = t.session_sid ? (sessMap[t.session_sid] || null) : null;
        if (t.status === "blocked") blocked++;
        else if (t.status === "in_progress" || t.status === "planned") {
          open++;
          var a = taskActivity(t, s);
          if (a.activity === "active") active++;
          if (a.activity === "orphan" || a.activity === "unbound") frozen++;
        } else if (t.status === "done") {
          var eff = taskEffort(t, s, null);
          doneRecent.push({ id: t.id, title: t.title || "", project: t.project || "", wall_min: eff.wall_min, active_min: eff.active_min, closed_at: (t.extra && typeof t.extra === "object" && t.extra.closed_at) || t.updated_at });
        }
        if (t.status === "in_progress" && flow.length < 6) {
          var a2 = taskActivity(t, s), f2 = taskEffort(t, s, null);
          flow.push({ id: t.id, title: t.title || "", activity: a2.activity, active_min: f2.active_min, frozen: f2.frozen });
        }
      });
      doneRecent.sort(function (a, b) { return String(b.closed_at).localeCompare(String(a.closed_at)); });
      // 昨日对比（gecm6s）：今日/昨日完成任务数（closed_at 前缀比较）+ 新建任务数
      var doneToday = 0, doneYst = 0, newToday = 0, newYst = 0;
      // 勤奋AI（evtask-fhtddx，2026-10-09 用户指定）：按负责人统计完成数，total 倒序前 8
      var diliMap = {};
      rows.forEach(function (t) {
        if (!t || !t.id) return;
        var cl = (t.extra && typeof t.extra === "object" && t.extra.closed_at) || (t.status === "done" ? t.updated_at : "");
        if (t.status === "done") {
          var cls = String(cl || "");
          var wkey = (t.assignee && String(t.assignee)) || (t.session_sid ? String(t.session_sid) : "未知");
          var d0 = diliMap[wkey] || (diliMap[wkey] = { who: wkey, today: 0, total: 0 });
          d0.total++;
          if (cls.substring(0, 10) === todayKey) { doneToday++; d0.today++; }
          if (cls.substring(0, 10) === ystKey) doneYst++;
        }
        var cr = String(t.created_at || "").substring(0, 10);
        if (cr === todayKey) newToday++;
        if (cr === ystKey) newYst++;
      });
      var diligence = Object.keys(diliMap).map(function (k) { return diliMap[k]; })
        .sort(function (a, b) { return b.total - a.total || b.today - a.today; }).slice(0, 8);
      // 在岗开发列表（用户 2026-10-08 两次指定）：与「在岗」统计逐一对齐 ——
      // 每个 in_progress 任务一行（不再按负责人去重、不再滤掉心跳停滞的，
      // 停滞的 stale:true 由客户端灰显「心跳停滞」），上限 8（ef5tq5 修复丢 2 条）
      var devs = [];
      rows.forEach(function (t) {
        if (!t || t.status !== "in_progress" || devs.length >= 8) return;
        var s2 = t.session_sid ? (sessMap[t.session_sid] || null) : null;
        var a3 = taskActivity(t, s2);
        // 负责人显示名（evtask-D-ev-ops-andro-261008-8pkmws，2026-10-08 用户批）：
        // 有会话标题（WorkBuddy 自定义名）→ 显示标题；否则退回 assignee(sid)/session_sid。
        // assignee 仍强制 = sid（禁止无人认领铁律不动），这里只是展示层。
        var who = (s2 && s2.title && String(s2.title).trim())
          ? String(s2.title).trim()
          : ((t.assignee && String(t.assignee)) || (t.session_sid ? String(t.session_sid) : "未知"));
        var f3 = taskEffort(t, s2, null);
        devs.push({ who: who, title: t.title || "", active_min: f3.active_min, hb: (s2 && s2.heartbeat_at) || null,
          stale: a3.activity !== "active", sid: t.session_sid || "" });
      });
      out.dev = { open: open, active: active, frozen: frozen, blocked: blocked, flow: flow, devs: devs, done_recent: doneRecent.slice(0, 5),
        done_today: doneToday, done_yesterday: doneYst, new_today: newToday, new_yesterday: newYst,
        diligence: diligence };
      // ── V4（evtask-fubd7v，用户 2026-10-09 指定）：dash_events(PG) per-task 文件/对话计数 +
      //    per-AI 今日五指标（进行中/今日完成/对话数/文件数/编辑行数）。行数字段钩子未上报，暂 null（见规格 §三） ──
      try {
        var pg2 = require("../lib/postgres");
        var q2 = function (sql) { return pg2.query(sql).then(function (r) { return r.rows || []; }); };
        var tcnt = await q2("select payload->>'task' task," +
          " count(*) filter (where t='files')::int fc," +
          " count(*) filter (where t='prompt')::int pc" +
          " from dash_events where coalesce(payload->>'task','')<>'' group by 1");
        var tcMap = {};
        tcnt.forEach(function (r) { tcMap[r.task] = { files: r.fc || 0, prompts: r.pc || 0 }; });
        flow.forEach(function (f) { var c = tcMap[f.id] || {}; f.files = c.files || 0; f.prompts = c.prompts || 0; });
        doneRecent.forEach(function (d) { var c = tcMap[d.id] || {}; d.files = c.files || 0; d.prompts = c.prompts || 0; });
        var aiAgg = await q2("select payload->>'sid' sid," +
          " count(*) filter (where t='prompt')::int pc," +
          " count(*) filter (where t='files')::int fc," +
          " coalesce(sum((payload->>'count')::int) filter (where t='files'),0)::int edits" +
          " from dash_events where ts >= '" + todayStartIso + "' and coalesce(payload->>'sid','')<>'' group by 1");
        var aiMap = {};
        rows.forEach(function (t) {
          if (!t || !t.id) return;
          var sk = (t.session_sid && String(t.session_sid)) || (t.assignee && String(t.assignee)) || "";
          if (!sk) return;
          var a = aiMap[sk] || (aiMap[sk] = { sid: sk, open: 0, done_today: 0, prompts: 0, files: 0, edits: 0, lines: null });
          if (t.status === "in_progress" || t.status === "planned") a.open++;
          var cl4 = (t.extra && typeof t.extra === "object" && t.extra.closed_at) || (t.status === "done" ? t.updated_at : "");
          if (t.status === "done" && String(cl4 || "").substring(0, 10) === todayKey) a.done_today++;
        });
        aiAgg.forEach(function (r) {
          var a = aiMap[r.sid] || (aiMap[r.sid] = { sid: r.sid, open: 0, done_today: 0, prompts: 0, files: 0, edits: 0, lines: null });
          a.prompts = r.pc || 0; a.files = r.fc || 0; a.edits = r.edits || 0;
        });
        var aiStats = Object.keys(aiMap).map(function (k) {
          var a = aiMap[k]; var s4 = sessMap[k];
          a.name = (s4 && s4.title && String(s4.title).trim()) ? String(s4.title).trim() : k;
          return a;
        }).sort(function (x, y) { return (y.open * 100 + y.done_today) - (x.open * 100 + x.done_today) || y.prompts - x.prompts; }).slice(0, 8);
        out.dev.ai_stats = aiStats;
      } catch (e6) { /* 聚合失败不影响主数据 */ }
    }
  } catch (e5) { out.dev = { error: String(e5 && e5.message) }; }
  return out;
}

/* ── 任务工时（2026-10-08，docs/任务工时-设计方案-v1.md）──
 * 三口径：wall_min（墙钟，不进指标）/ active_min（有效工时=主指标）/ evidenced_min（per-prompt 证据）。
 * 防虚高四道闸：①orphan/unbound 冻结（停表）②gap>30min 只计 30min ③close 落 extra.closed_at ④超 7 天无证据 capped。
 * 零 schema 变更：closed_at 进 extra jsonb，工时实时派生。阈值 EV_EFF_GAP_MIN / EV_EFF_CAP_DAYS 可调。
 */
function evEffThresholds() {
  function num(v, dflt) { var n = parseInt(v, 10); return (n > 0) ? n : dflt; }
  var e = (typeof process !== "undefined" && process.env) || {};
  return { gap: num(e.EV_EFF_GAP_MIN, 30), capDays: num(e.EV_EFF_CAP_DAYS, 7) };
}

/** @param t 任务行（created_at/updated_at/extra/status/session_sid）
 *  @param sess 会话行或 null（started_at/heartbeat_at）
 *  @param tstats 该任务在会话黑板里的统计或 null（prompts[{t}]/adds/last_prompt） */
function taskEffort(t, sess, tstats) {
  var th = evEffThresholds();
  var now = Date.now();
  var isClosed = t && ["done", "cancelled", "blocked"].indexOf(t.status) >= 0;
  var extraObj = (t && t.extra && typeof t.extra === "object") ? t.extra : null;
  if (!extraObj && t && typeof t.extra === "string" && t.extra) { try { extraObj = JSON.parse(t.extra); } catch (e) { extraObj = null; } }
  var closedAtIso = (extraObj && extraObj.closed_at) || null;
  var endMs = closedAtIso ? new Date(closedAtIso).getTime() : (isClosed && t.updated_at ? new Date(t.updated_at).getTime() : now);
  if (isNaN(endMs)) endMs = now;
  var startMs = t && t.created_at ? new Date(t.created_at).getTime() : now;
  if (isNaN(startMs)) startMs = now;
  var wallMin = Math.max(0, Math.round((endMs - startMs) / 60000));
  var act = taskActivity(t, sess);
  var frozen = act.activity === "orphan" || act.activity === "unbound";

  // 口径 A：per-prompt 轨迹切片（最硬证据；轨迹只有最近 20 条 → 是下界样本）
  var prompts = (tstats && Array.isArray(tstats.prompts) ? tstats.prompts : [])
    .map(function (p) { var ms = new Date((p && (p.t || p.time || p.at)) || p).getTime(); return isNaN(ms) ? null : ms; })
    .filter(function (x) { return x !== null; }).sort(function (a, b) { return a - b; });
  var evidencedMin = 0;
  for (var i = 1; i < prompts.length; i++) {
    evidencedMin += Math.min(Math.max(0, (prompts[i] - prompts[i - 1]) / 60000), th.gap);
  }
  evidencedMin = Math.round(evidencedMin);

  // 口径 B：心跳窗口（无 prompt 轨迹时的主证据；单窗无法切片 → 超 8h 标 capped 人工复核）
  var activeMin = 0, capped = false;
  if (sess && sess.heartbeat_at) {
    // started_at 常缺（采集器未上报）→ 回退任务创建时刻，窗口从任务诞生算到最后一次心跳
    var st = sess.started_at || (t && t.created_at) || null;
    if (st) {
      var s0 = Math.max(new Date(st).getTime(), startMs);
      var e0 = Math.min(new Date(sess.heartbeat_at).getTime(), endMs);
      activeMin = Math.max(0, Math.round((e0 - s0) / 60000));
      if (activeMin > 480) capped = true; // 单窗超 8h 却无 prompt 证据 → 存疑
    }
  } else if (evidencedMin > 0) {
    activeMin = evidencedMin;
  }
  if (evidencedMin > 0 && evidencedMin > activeMin) activeMin = evidencedMin;

  // 大限闸：开着的任务超 capDays 且无 prompt 证据 → 封顶复核
  if (!isClosed && wallMin > th.capDays * 1440 && prompts.length === 0) capped = true;

  var confidence = "low";
  if (prompts.length >= 2 && activeMin >= evidencedMin * 0.5) confidence = "high";
  else if (tstats && ((tstats.adds || 0) > 0 || tstats.last_prompt)) confidence = "mid";
  if (act.activity === "unbound") confidence = "low";

  return {
    wall_min: wallMin,
    active_min: Math.min(activeMin, wallMin),
    evidenced_min: evidencedMin,
    confidence: confidence,
    frozen: frozen,
    capped: capped,
    closed_at: closedAtIso
  };
}

async function handleTaskList(req, res) {
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  var status = (req.query && req.query.status) || "";
  var url = db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=*&order=updated_at.desc&limit=200";
  if (status) url += "&status=eq." + encodeURIComponent(status);
  try {
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) { var txt = await r.text(); return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) }); }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
    var list = rows.map(function (t) { return {
      id: t.id, project: t.project || "", title: t.title || "", type: t.type || "feature",
      status: t.status || "in_progress", priority: t.priority || "P2",
      assignee: t.assignee || "", eta_min: t.eta_min || 0, description: t.description || "",
      owner: t.owner || "", replies: Array.isArray(t.replies) ? t.replies : [],
      session_sid: t.session_sid || null,
      // note：手机端「台账最近 10 条」要显示「最后一条日志」（2026-10-06）。
      // 表里 note 存在 extra.note（登记时的备注 / 收尾结论），这里提成顶层字段，
      // 免得每个客户端各解析一遍 extra。extra 可能是对象也可能是字符串，两种都吃。
      note: noteOfExtra(t.extra),
      close_reason: t.close_reason || "", closed_note: t.closed_note || "",
      created_at: t.created_at, updated_at: t.updated_at,
      extra: t.extra ? (typeof t.extra === "string" ? t.extra : JSON.stringify(t.extra)) : ""
    }; });
    // 会话身份增强（2026-10-07）：一次拉全 evops_sessions，按 session_sid 附上
    // session_title / session_idle_min —— 手机端任务卡片据此显示「属于哪个会话、还活着吗」。
    // 同时把会话黑板 tasks[] 里 ev-edit-stats 钩子累加的改动统计（adds/dels/file_count/files）
    // 按 evtask- 单号附到对应任务行（session_adds 等）—— 手机端任务详情/卡片据此显示改动量。
    // 会话表读不到时静默放行（不影响任务列表主链路）。
    try {
      var rs = await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE +
        "?select=sid,raw_sid,tool,cwd,repo,title,started_at,heartbeat_at,status,tasks,extra&limit=500", { headers: db.headers() });
      if (rs.ok) {
        var srows = await rs.json();
        var smap = {};
        if (Array.isArray(srows)) {
          srows.forEach(function (s) {
            if (!s || !s.sid) return;
            var idle = null;
            try { idle = Math.max(0, Math.round((Date.now() - new Date(s.heartbeat_at).getTime()) / 60000)); } catch (e) {}
            // 单号 → 改动统计（钩子每次编辑累加；无则空）
            var stMap = {};
            if (Array.isArray(s.tasks)) {
              s.tasks.forEach(function (tt) {
                if (!tt || !tt.id) return;
                stMap[tt.id] = {
                  adds: Number(tt.adds) || 0,
                  dels: Number(tt.dels) || 0,
                  file_count: Number(tt.file_count) || (tt.files ? Object.keys(tt.files).length : 0),
                  files: tt.files || {},
                  prompt_count: Number(tt.prompts) || 0,
                  last_prompt: tt.last_prompt || "",
                  prompts: Array.isArray(tt.ps) ? tt.ps : []   // per-prompt trace (time + content, max 20)
                };
              });
            }
            smap[s.sid] = { raw_sid: s.raw_sid || "", tool: s.tool || "", cwd: s.cwd || "", repo: s.repo || "", title: s.title || "", started_at: s.started_at || null, heartbeat_at: s.heartbeat_at || null, idle_min: idle, session_status: s.status || "", stats: stMap };
          });
        }
        list.forEach(function (t) {
          var s = t.session_sid ? smap[t.session_sid] : null;
          // 活跃度注入（2026-10-08）：纯派生，四档位 active/stale/orphan/unbound
          var act = taskActivity(t, s || null);
          t.activity = act.activity;
          t.activity_idle_min = act.idle_min;
          t.activity_stale_since = act.stale_since;
          t.activity_reason = act.reason;
          // 工时注入（2026-10-08 P1）：三口径 + confidence + frozen/capped
          t.effort = taskEffort(t, s || null, (s && s.stats ? s.stats[t.id] : null) || null);
          if (!s) return;
          t.session_raw_sid = s.raw_sid;
          t.session_tool = s.tool;
          t.session_cwd = s.cwd;
          t.session_repo = s.repo;
          t.session_title = s.title;
          t.session_started_at = s.started_at;
          t.session_heartbeat_at = s.heartbeat_at;
          t.session_idle_min = s.idle_min;
          t.session_status = s.session_status;
          var st = s.stats ? s.stats[t.id] : null;
          if (st) {
            t.session_adds = st.adds;
            t.session_dels = st.dels;
            t.session_file_count = st.file_count;
            t.session_files = st.files;
            t.session_prompt_count = st.prompt_count;
            if (st.last_prompt) t.session_last_prompt = st.last_prompt;
            if (st.prompts.length) t.session_prompts = st.prompts;
          }
        });
      }
    } catch (e) { /* ignore */ }
    return json(res, 200, { success: true, tasks: list, total: list.length });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/* ── V4（fubd7v）大屏 SSE 长连接：禁前端轮询 ──
 * 每 5s 服务端构建一帧并与上次比对，**有变化才推 data 帧**，无变化只发 ping 注释行；
 * 55s 主动收尾（Vercel 函数时长上限内），客户端 EventSource 内置自动重连。
 * 多客户端共享 4s 节流缓存，避免下游被打爆。 */
var _streamCache = { at: 0, data: null };
async function buildFresh(req) {
  var now = Date.now();
  if (_streamCache.data && now - _streamCache.at < 4000) return _streamCache.data;
  _streamCache.data = await buildDashboard(req);
  _streamCache.at = now;
  return _streamCache.data;
}
async function handleDashStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  var last = "", closed = false, start = Date.now();
  req.on("close", function () { closed = true; });
  async function push(force) {
    if (closed) return;
    try {
      var data = await buildFresh(req);
      var s = JSON.stringify(data);
      if (force || s !== last) { last = s; res.write("data: " + s + "\n\n"); }
      else { res.write(": ping\n\n"); }
    } catch (e) {
      try { res.write("event: err\ndata: " + JSON.stringify({ error: String(e && e.message) }) + "\n\n"); } catch (e2) {}
    }
  }
  await push(true);
  var iv = setInterval(function () {
    if (closed || Date.now() - start > 55000) { clearInterval(iv); try { res.end(); } catch (e) {} return; }
    push(false);
  }, 5000);
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
      case "task-list":
        // 公开读：手机端任务栏目直接拉 evops_tasks（过滤/分页由后端管）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskList(req, res);
      case "task-activity":
        // 公开读：任务活跃度四档位清单（orphan=晨割收割线，unbound=裸奔雷达）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskActivity(req, res);
      case "dashboard":
        // 数字大屏聚合（只读）：开发+运营一帧全量，60s 内存缓存
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleDashboard(req, res);
      case "dash-stream":
        // V4（fubd7v）大屏 SSE 长连接：服务端每 5s 构建+比对，变化才推，禁前端轮询
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleDashStream(req, res);
      case "task-update":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskUpdate(req, res);
      case "task-append":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskAppend(req, res);
      case "task-close":
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleTaskClose(req, res);
      case "session-sync":
        // 会话身份全量 upsert（采集器把 Mac 黑板 data/active/*.json 推上来；规则2 的判据源）
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleSessionSync(req, res);
      case "message-log":
        // 钩子事件逐条落库（会话/模型全字段 append，evtask-D-evevbox-261009-3ekk7u）
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleMessageLog(req, res);
      case "model-daily":
        // 模型用量按天汇总（视图 v_evops_model_daily 现算，公开读）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleModelDaily(req, res);

      case "project-list":
        // 公开读：项目真源（取代聚合 payload.projects[]）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleProjectList(req, res);
      case "project-sync":
        // 采集器 upsert 项目真源（幂等 on_conflict=id）
        if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
        return await handleProjectSync(req, res);
      case "task-summary":
        // 公开读：任务汇总（取代聚合 payload.summary —— 真源 evops_tasks 现算，不再有漂移）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskSummary(req, res);
      case "session-get":
        // 公开读：按 sid 查会话身份整行（任务详情页「发帖人」卡用；读不到返回 session=null）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleSessionGet(req, res);
      case "task-hb-list":
        // 公开读：任务心跳时间线（dash_events t=hb 按任务过滤，evtask-heewdq）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskHbList(req, res);
      case "prompt-log":
        // 指令留痕逐条上云（token 鉴权由 evTaskDb 统一处理，evtask-qatst4）
        return await handlePromptLog(req, res);
      case "task-ps-list":
        // 任务指令留痕全量时间线（dash_events t=prompt，evtask-qatst4）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskPsList(req, res);
      case "progress-log":
        // 进度汇报逐条上云（evtask-aphwge）：task-notify.sh 设 EV_PROGRESS_TASK 后附带调用
        return await handleProgressLog(req, res);
      case "task-progress-list":
        // 任务进度时间线公开读（evtask-aphwge）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskProgressList(req, res);
      case "file-log":
        // 文件改动逐条上云（evtask-pjzrta）：PostToolUse 钩子每次写/改文件调用一次
        return await handleFileLog(req, res);
      case "task-file-list":
        // 任务文件改动全量时间线（dash_events t=files，evtask-pjzrta）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleTaskFileList(req, res);
      case "session-list":
        // 公开读：会话清单按心跳倒序（运行态 Tab「AI 会话在线总览」数据源）
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleSessionList(req, res);
      case "ev-config-read":
        // 槽位上限云端读（evtask-gz3fg2）：此前 handler 已实现但从未注册进 dispatch，
        // 手机设置页读写一律 Unknown action → 上限改不动。补注册。
        if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
        return await handleEvConfigRead(req, res);
      case "ev-config-write":
        // 槽位上限云端写（公开写，与 ev-command-write 同安全模型）
        return await handleEvConfigWrite(req, res);
      default:
        return json(res, 400, { success: false, error: "Unknown action" });
    }
  } catch (e) {
    console.error("[ev] error:", e && e.message ? e.message : e);
    return json(res, 500, { success: false, error: (e && e.message) || "Internal error" });
  }
};


/**
 * 会话身份公开读 GET ?action=session-get&id=<sid>
 * 返回 { success, session: <evops_sessions 整行 | null> }——任务详情页「发帖人」卡据此展示
 * 发帖会话的标题 / 会话ID / 工具 / 工作目录 / 启动与心跳时间。读不到时 session=null（不报错）。
 */
async function handleSessionGet(req, res) {
  var sid = String((req.query && req.query.id) || "").trim().slice(0, 120);
  if (!sid) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/" + SESSIONS_TABLE +
      "?select=*&sid=eq." + encodeURIComponent(sid) + "&limit=1";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    var row = (Array.isArray(rows) && rows.length) ? rows[0] : null;
    // 会话详情任务清单补全（evtask-D-ev-ops-andro-261008-a8qzf7）：
    // evops_sessions.tasks 是心跳 upsert 的快照，会被新任务冲掉历史——
    // 这里按 session_sid 反查 evops_tasks 全量（倒序 50 条），云任务非空时覆盖快照，
    // Android 端 tasksCard 零改动直接受益。
    if (row) {
      try {
        var turl = db.sbUrl + "/rest/v1/evops_tasks" +
          "?select=id,status,title,description,created_at,updated_at" +
          "&session_sid=eq." + encodeURIComponent(sid) +
          "&order=created_at.desc&limit=50";
        var tr = await fetch(turl, { headers: db.headers() });
        if (tr.ok) {
          var trows = await tr.json();
          if (Array.isArray(trows) && trows.length) {
            row.tasks = trows.map(function (t) {
              return { id: t.id, status: t.status, title: t.title,
                description: t.description || "", ps: [],
                at: t.created_at };
            });
          }
        }
      } catch (e2) { /* 补全失败静默回退快照 */ }
    }
    return json(res, 200, { success: true, session: row });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}


/**
 * 任务心跳时间线 GET ?action=task-hb-list&id=<taskId>（evtask-D-ev-ops-andro-261008-heewdq）
 * 数据源：dash_events（t='hb'，fn_dash_on_hb 触发器逐次心跳写入）。
 * 过滤 payload->>'task' = 任务 id，ts 倒序取 50 条。
 * 返回 { success, items: [ { ts, payload } ] } —— payload 含 sid/title/tool/repo。
 */
async function handleTaskHbList(req, res) {
  var id = String((req.query && req.query.id) || "").trim().slice(0, 120);
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/dash_events" +
      "?select=ts,payload&t=eq.hb&payload-%3E%3Etask=eq." + encodeURIComponent(id) +
      "&order=ts.desc&limit=50";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    return json(res, 200, { success: true, items: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}


/**
 * 指令留痕逐条上云 POST ?action=prompt-log（evtask-D-ev-ops-andro-261008-qatst4，B 方案）
 * 钩子在任务进行中时对每条用户消息调用一次，追加写入 dash_events(t='prompt')——
 * 事件流式存储，无上限、不覆盖；本地黑板 ps 20 条仅作缓存镜像。
 * body: { sid, task, tool, title, text }；text 截 500 字。
 */
async function handlePromptLog(req, res) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var sid = String(body.sid || "").slice(0, 120);
  var task = String(body.task || "").slice(0, 120);
  var text = String(body.text || "").slice(0, 500);
  if (!sid || !task || !text) return json(res, 400, { success: false, error: "sid/task/text required" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/dash_events", {
      method: "POST",
      headers: Object.assign({}, db.headers(), { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify([{ t: "prompt", payload: {
        sid: sid, task: task, tool: String(body.tool || "").slice(0, 40),
        title: String(body.title || "").slice(0, 120), text: text,
        model: String(body.model || "").slice(0, 64),
        client: String(body.client || "").slice(0, 32),
        version: String(body.version || "").slice(0, 32),
        generation_id: String(body.generation_id || "").slice(0, 64),
        short: !!body.short, at: new Date().toISOString() } }])
    });
    if (!r.ok && r.status !== 201) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_insert_failed", detail: txt.slice(0, 200) });
    }
    return json(res, 200, { success: true });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 钩子事件逐条落库 POST ?action=message-log（evtask-D-evevbox-261009-3ekk7u）
 * 钩子（ev-report.js）每次调用上报一行 evops_messages：会话/模型全字段 append-only（永不覆盖）。
 * 与 session-sync 的分工：sessions=当前态（谁在线）；messages=历史事件流（模型用量）。
 * body: { hook_event, sid*, raw_sid, tool, task, model, client, version, generation_id,
 *         agent_type, permission_mode, prompt, short, transcript_path, cwd, repo, payload }
 * 失败由调用方静默处理；此处只做字段白名单 + 截断 + 401/400 校验。
 */
async function handleMessageLog(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var sid = String(body.sid || "").slice(0, 120);
  if (!sid) return json(res, 400, { success: false, error: "sid required" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  var row = {
    hook_event: String(body.hook_event || "").slice(0, 32) || null,
    sid: sid,
    raw_sid: String(body.raw_sid || "").slice(0, 120),
    tool: String(body.tool || "").slice(0, 32),
    task_id: String(body.task || "").slice(0, 120),
    model: String(body.model || "").slice(0, 64) || null,
    client: String(body.client || "").slice(0, 32) || null,
    version: String(body.version || "").slice(0, 32) || null,
    generation_id: String(body.generation_id || "").slice(0, 64) || null,
    agent_type: String(body.agent_type || "").slice(0, 24) || null,
    permission_mode: String(body.permission_mode || "").slice(0, 24) || null,
    prompt: String(body.prompt || "").slice(0, 500),
    is_short: !!body.short,
    transcript_path: String(body.transcript_path || "").slice(0, 400),
    cwd: String(body.cwd || "").slice(0, 240),
    repo: String(body.repo || "").slice(0, 240),
    payload: (body.payload && typeof body.payload === "object") ? body.payload : {}
  };
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/evops_messages", {
      method: "POST",
      headers: Object.assign({}, db.headers(), { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify([row])
    });
    if (!r.ok && r.status !== 201) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_insert_failed", detail: String(txt).slice(0, 200) });
    }
    return json(res, 200, { success: true });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 模型用量按天汇总 GET ?action=model-daily&days=<n>（evtask-D-evevbox-261009-3ekk7u）
 * 数据源：视图 v_evops_model_daily（evops_messages 现算，非冗余表）。默认最近 7 天。
 * 返回 { success, days, items: [ {day, tool, model, client, messages, sessions, tasks} ] }
 */
async function handleModelDaily(req, res) {
  var days = parseInt((req.query && req.query.days) || "7", 10);
  if (!(days > 0 && days <= 90)) days = 7;
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/v_evops_model_daily?day=gte." + since +
      "&order=day.desc,messages.desc", { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_read_failed", detail: String(txt).slice(0, 200) });
    }
    var items = await r.json();
    return json(res, 200, { success: true, days: days, items: items });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 任务指令留痕全量时间线 GET ?action=task-ps-list&id=<taskId>（evtask-qatst4）
 * 数据源：dash_events（t='prompt'，prompt-log 逐条写入），按任务过滤，ts 正序取 500 条。
 * 返回 { success, items: [ { ts, payload } ] } —— payload 含 sid/tool/title/text/at。
 */
async function handleTaskPsList(req, res) {
  var id = String((req.query && req.query.id) || "").trim().slice(0, 120);
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/dash_events" +
      "?select=ts,payload&t=eq.prompt&payload-%3E%3Etask=eq." + encodeURIComponent(id) +
      "&order=ts.asc&limit=500";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    return json(res, 200, { success: true, items: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 文件改动逐条上云 POST ?action=file-log（evtask-D-evapp-auth-261008-pjzrta）
 * PostToolUse 钩子每次 Write/Edit/MultiEdit/NotebookEdit 调用一次，
 * 追加写入 dash_events(t='files')——事件流式、不覆盖、无上限。
 * 只记路径与次数，不存文件内容（避免隐私与体积）。
 * body: { sid, task, tool, path, count }；path 截 300 字，task 可空（此时只有 sid 维度）。
 */
async function handleFileLog(req, res) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var sid = String(body.sid || "").slice(0, 120);
  var path_ = String(body.path || "").slice(0, 300);
  if (!sid || !path_) return json(res, 400, { success: false, error: "sid/path required" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/dash_events", {
      method: "POST",
      headers: Object.assign({}, db.headers(), { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify([{ t: "files", payload: {
        sid: sid, task: String(body.task || "").slice(0, 120),
        tool: String(body.tool || "").slice(0, 40),
        path: path_, count: Number(body.count) || 1,
        at: new Date().toISOString() } }])
    });
    if (!r.ok && r.status !== 201) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_insert_failed", detail: txt.slice(0, 200) });
    }
    return json(res, 200, { success: true });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 任务文件改动全量时间线 GET ?action=task-file-list&id=<taskId>（evtask-pjzrta）
 * 数据源：dash_events（t='files'，file-log 逐条写入），按任务过滤，ts 正序取 500 条。
 * 返回 { success, items: [ { ts, payload } ] } —— payload 含 sid/tool/path/count/at。
 */
async function handleTaskFileList(req, res) {
  var id = String((req.query && req.query.id) || "").trim().slice(0, 120);
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/dash_events" +
      "?select=ts,payload&t=eq.files&payload-%3E%3Etask=eq." + encodeURIComponent(id) +
      "&order=ts.asc&limit=500";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    return json(res, 200, { success: true, items: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 进度汇报逐条上云 POST ?action=progress-log（evtask-D-ev-ops-andro-261008-aphwge）
 * 长任务中途报进度时调用（task-notify.sh 设 EV_PROGRESS_TASK 后自动附带），
 * 追加写入 dash_events(t='progress')——事件流式、不覆盖。
 * body: { sid, task, tool, text }；text 截 300 字。
 */
async function handleProgressLog(req, res) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var sid = String(body.sid || "").slice(0, 120);
  var task = String(body.task || "").slice(0, 120);
  var text = String(body.text || "").slice(0, 300);
  if (!sid || !task || !text) return json(res, 400, { success: false, error: "sid/task/text required" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/dash_events", {
      method: "POST",
      headers: Object.assign({}, db.headers(), { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify([{ t: "progress", payload: {
        sid: sid, task: task, tool: String(body.tool || "").slice(0, 40),
        text: text, at: new Date().toISOString() } }])
    });
    if (!r.ok && r.status !== 201) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_insert_failed", detail: txt.slice(0, 200) });
    }
    return json(res, 200, { success: true });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 任务进度汇报时间线 GET ?action=task-progress-list&id=<taskId>（evtask-aphwge）
 * 数据源：dash_events（t='progress'），按任务过滤，ts 正序取 200 条。
 */
async function handleTaskProgressList(req, res) {
  var id = String((req.query && req.query.id) || "").trim().slice(0, 120);
  if (!id) return json(res, 400, { success: false, error: "Missing id" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/dash_events" +
      "?select=ts,payload&t=eq.progress&payload-%3E%3Etask=eq." + encodeURIComponent(id) +
      "&order=ts.asc&limit=200";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    return json(res, 200, { success: true, items: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 会话清单公开读 GET ?action=session-list（2026-10-07 运行态改造：AI 会话在线总览）
 * 返回 { success, sessions: [...] }，按 heartbeat_at 倒序取 100 条。
 * 字段：sid/raw_sid/tool/title/started_at/heartbeat_at/open_task_id/status（不含 tasks 大字段）。
 * 在线判定由客户端按 heartbeat_at 算（≤5min 绿 / ≤30min 琥珀 / 更久灰）。
 */
async function handleSessionList(req, res) {
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var url = db.sbUrl + "/rest/v1/" + SESSIONS_TABLE +
      "?select=sid,raw_sid,tool,title,started_at,heartbeat_at,open_task_id,status" +
      "&order=heartbeat_at.desc&limit=100";
    var r = await fetch(url, { headers: db.headers() });
    if (!r.ok) {
      var txt = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: txt.slice(0, 200) });
    }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
    return json(res, 200, { success: true, sessions: rows, total: rows.length });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 项目真源公开读 GET ?action=project-list
 * 取代聚合 evops_status.payload.projects[] —— 手机项目总览 / 运行态据此取数。
 */
async function handleProjectList(req, res) {
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + PROJECTS_TABLE + "?select=*&order=id.asc&limit=200", { headers: db.headers() });
    if (!r.ok) {
      var t = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: String(t).slice(0, 200) });
    }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
    return json(res, 200, { success: true, projects: rows, total: rows.length });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}

/**
 * 项目真源 upsert POST ?action=project-sync
 * body: { projects: [ {id*, name_cn, name_en, category, local_path, repo, version, runtime, docs, git, stats} ] }
 * 由 Mac 采集器（collect-status.js）把 data/projects.json 推上来；幂等（on_conflict=id）。
 */
async function handleProjectSync(req, res) {
  if (!evTaskAuthOk(req)) return json(res, 401, { success: false, error: "unauthorized" });
  var body = (req.body && typeof req.body === "object") ? req.body : {};
  var list = Array.isArray(body.projects) ? body.projects : null;
  if (!list || !list.length) return json(res, 400, { success: false, error: "Missing projects" });
  var db = evTaskDb(req, res);
  if (!db) return json(res, 500, { success: false, error: "no_store_configured" });
  var batch = list.slice(0, 200);
  var ok = await db.upsertProjects(batch);
  return json(res, 200, { success: ok, upserted: ok ? batch.length : 0, total: list.length });
}

/**
 * 任务汇总公开读 GET ?action=task-summary
 * 取代聚合 evops_status.payload.summary —— 全部由真源 evops_tasks 现算（再无「只加不减」的漂移），
 * max_parallel 取 evops_config 真值，active_sessions = 24h 内有心跳的会话数（evops_sessions）。
 */
async function handleTaskSummary(req, res) {
  var db = evTaskDb(req, res);
  if (!db) return json(res, 502, { success: false, error: "supabase_unavailable" });
  try {
    var r = await fetch(db.sbUrl + "/rest/v1/" + TASKS_TABLE + "?select=status&limit=1000", { headers: db.headers() });
    if (!r.ok) {
      var t = await r.text();
      return json(res, 502, { success: false, error: "supabase_fetch_failed", detail: String(t).slice(0, 200) });
    }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];
    var s = { total: rows.length, in_progress: 0, done: 0, blocked: 0, planned: 0, cancelled: 0 };
    rows.forEach(function (t) {
      var k = String((t && t.status) || "");
      if (Object.prototype.hasOwnProperty.call(s, k)) s[k]++;
    });
    var limit = await readMaxParallel(db);
    s.max_parallel = limit;
    s.needs_attention = s.blocked;
    var active = null;
    try {
      var rs = await fetch(db.sbUrl + "/rest/v1/" + SESSIONS_TABLE + "?select=sid,heartbeat_at&limit=500", { headers: db.headers() });
      if (rs.ok) {
        var sr = await rs.json();
        if (Array.isArray(sr)) {
          var cut = Date.now() - 24 * 3600 * 1000;
          active = sr.filter(function (x) {
            try { return x && x.heartbeat_at && new Date(x.heartbeat_at).getTime() >= cut; } catch (e) { return false; }
          }).length;
        }
      }
    } catch (e) { /* 会话表读不到不影响主口径 */ }
    s.active_sessions = active;
    return json(res, 200, {
      success: true, summary: s, in_progress: s.in_progress, max_parallel: limit,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    return json(res, 502, { success: false, error: "supabase_error", detail: String(e && e.message) });
  }
}
// V4（fubd7v）：SSE 长连接需要更长的函数执行窗口（fluid compute；不影响普通请求）
module.exports.maxDuration = 60;
