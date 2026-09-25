// lib/device-token.js
//
// 桌面客户端（EvNotifier）的长期设备令牌。
//
// 为什么需要它：原来客户端靠一个手工写进 .env 的共享密钥（EV_SYNC_TOKEN）调用 delivery-* 接口。
// 那个做法的问题是：① 换机器要人工搬运，而它在 Vercel 上是 Secret、`vercel env pull` 拉不到，
// 忘了就永久 401 且没有报错；② 泄漏只能全局轮换，一换所有客户端一起断；③ 看不到"谁在用"。
//
// 现在改为：客户端走一次「设备授权登录」（浏览器确认），拿到一个长期令牌存进 macOS Keychain。
// 服务端**只存 sha256 哈希**，明文只在 poll 取走的那一次返回；可逐台撤销、可审计。
//
// 设计详见 `tools/ev-notifier/后台登录鉴权改造方案.md` §4。

var pg = require("./postgres");
var crypto = require("crypto");

var TABLE = "device_tokens";
var TOUCH_THROTTLE_MS = 60 * 60 * 1000; // last_seen_at 最多每小时写一次，别每个请求都写库

function escapeLiteral(str) {
  if (str === null || str === undefined) return "NULL";
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

/** 数字主键用数字字面量，不要走字符串引号（否则依赖 Postgres 隐式类型转换） */
function pgId(v) {
  var n = parseInt(v, 10);
  return Number.isFinite(n) ? String(n) : "NULL";
}

/** 32 字节随机 → base64url（43 字符），足够抗暴力枚举 */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * 创建设备令牌。返回 { id, token } —— **token 明文只在这里出现一次**，之后服务端只有哈希。
 */
async function createDeviceToken({ label, email, appVersion }) {
  var token = generateToken();
  var hash = sha256(token);
  var sql = "INSERT INTO " + TABLE +
    " (token_hash, label, email, app_version) VALUES (" +
    escapeLiteral(hash) + ", " +
    escapeLiteral(label || "unknown-device") + ", " +
    escapeLiteral(email || "") + ", " +
    escapeLiteral(appVersion || null) +
    ") RETURNING id";
  try {
    var r = await pg.query(sql);
    var id = (r && r.rows && r.rows[0] && r.rows[0].id) || null;
    return { id: id, token: token };
  } catch (e) {
    console.error("[device-token] create failed:", e.message || e);
    return null;
  }
}

/**
 * 校验设备令牌。有效返回 { id, email, label }，否则 null。
 * 顺带（节流地）更新 last_seen_at / last_seen_ip，用于面板展示「最后活跃」。
 */
async function verifyDeviceToken(token, clientIp) {
  if (!token || typeof token !== "string") return null;
  var hash = sha256(token);
  var sql = "SELECT id, email, label, last_seen_at FROM " + TABLE +
    " WHERE token_hash = " + escapeLiteral(hash) + " AND revoked_at IS NULL";
  try {
    var r = await pg.query(sql);
    var row = r && r.rows && r.rows[0];
    if (!row) return null;

    var lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeen > TOUCH_THROTTLE_MS) {
      var upd = "UPDATE " + TABLE + " SET last_seen_at = now()";
      if (clientIp) upd += ", last_seen_ip = " + escapeLiteral(String(clientIp).slice(0, 60));
      upd += " WHERE id = " + pgId(row.id);
      pg.query(upd).catch(function (e) {
        console.warn("[device-token] touch failed:", e.message || e);
      });
    }

    return { id: row.id, email: row.email, label: row.label };
  } catch (e) {
    console.error("[device-token] verify failed:", e.message || e);
    return null;
  }
}

async function revokeDeviceToken(id) {
  var sql = "UPDATE " + TABLE + " SET revoked_at = now() WHERE id = " + pgId(id) +
    " AND revoked_at IS NULL";
  try {
    var r = await pg.query(sql);
    return (r && r.rowCount) || 0;
  } catch (e) {
    console.error("[device-token] revoke failed:", e.message || e);
    return 0;
  }
}

async function revokeAllDevices() {
  var sql = "UPDATE " + TABLE + " SET revoked_at = now() WHERE revoked_at IS NULL";
  try {
    var r = await pg.query(sql);
    return (r && r.rowCount) || 0;
  } catch (e) {
    console.error("[device-token] revokeAll failed:", e.message || e);
    return 0;
  }
}

async function listDevices() {
  var sql = "SELECT id, label, email, app_version, created_at, last_seen_at, last_seen_ip, revoked_at " +
    "FROM " + TABLE + " ORDER BY created_at DESC LIMIT 100";
  try {
    var r = await pg.query(sql);
    return r.rows || [];
  } catch (e) {
    console.error("[device-token] list failed:", e.message || e);
    return [];
  }
}

async function getById(id) {
  var sql = "SELECT id, label, email, app_version, created_at, last_seen_at, revoked_at FROM " + TABLE +
    " WHERE id = " + pgId(id);
  try {
    var r = await pg.query(sql);
    return (r && r.rows && r.rows[0]) || null;
  } catch (e) {
    console.error("[device-token] getById failed:", e.message || e);
    return null;
  }
}

module.exports = {
  createDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  revokeAllDevices,
  listDevices,
  getById,
  sha256,
};
