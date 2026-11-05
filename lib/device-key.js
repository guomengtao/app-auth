/**
 * lib/device-key.js —— 零操作激活通道：设备主键、会话 sid、授权归属
 *
 * 设计边界（方案 C1：只加不改）：
 *   - 本模块只写 zero:* 前缀的新键，不触碰 auth:redeem:* / auth:activation:* 等既有键。
 *   - 授权真源仍在既有 18 位码体系；这里只维护「设备 → 已购授权」的旁路索引。
 *   - 所有函数对调用方失败安全：异常由调用方 try/catch，绝不抛到主链路。
 *
 * 键：
 *   zero:devkey:<12hex MAC>   → 授权记录 JSON（无 TTL）
 *   zero:nodeid:<nodeId>      → 12hex MAC（互指，命中任一即认定已购）
 *   zero:sess:<12hex sid>     → 会话 JSON（TTL 900s）
 *
 * ⚠️ sid 是 CSPRNG 随机会话标识，**不是 MAC、也不由 MAC 派生**。
 *    MAC 可预测，若用作 sid，知道 MAC 的人可订阅会话并取走 18 位码。
 */
var crypto = require("crypto");
var redis = require("./redis");

var SESSION_TTL_SEC = 900;
var ZERO_PREFIX = "zero:";

function safeParse(raw) {
  if (!raw) return null;
  try { return (typeof raw === "string") ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

/** MAC 归一：去分隔符、大写、12 位 hex；过滤 Android 脱敏地址与全 0/全 F */
function normalizeMac(v) {
  var s = String(v == null ? "" : v).replace(/[:\-\s.]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(s)) return "";
  if (/^(020000000000|000000000000|FFFFFFFFFFFF)$/.test(s)) return "";
  return s;
}

/** nodeId：小米运动健康侧的数字 ID，换手机不变；只接受 6~20 位数字 */
function normalizeNodeId(v) {
  var s = String(v == null ? "" : v).trim();
  return /^\d{6,20}$/.test(s) ? s : "";
}

/** deviceId 只做长度/字符约束，不参与归属判定（重置会变） */
function normalizeDeviceId(v) {
  var s = String(v == null ? "" : v).trim();
  return /^[0-9A-Za-z_-]{4,64}$/.test(s) ? s : "";
}

function newSid() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}
function normalizeSid(v) {
  var s = String(v == null ? "" : v).trim().toUpperCase();
  return /^[0-9A-F]{12}$/.test(s) ? s : "";
}

function devkeyKey(mac) { return ZERO_PREFIX + "devkey:" + mac; }
function nodeidKey(nid) { return ZERO_PREFIX + "nodeid:" + nid; }
function sessKey(sid) { return ZERO_PREFIX + "sess:" + sid; }

/**
 * 查已购：deviceKey 优先，nodeId 兜底。命中任一即返回授权记录。
 * @returns {Promise<Object|null>}
 */
async function lookup(deviceKey, nodeId) {
  var mac = normalizeMac(deviceKey);
  var nid = normalizeNodeId(nodeId);
  if (mac) {
    var rec = safeParse(await redis.get(devkeyKey(mac)));
    if (rec && rec.redeemCode) return rec;
  }
  if (nid) {
    var alias = normalizeMac(await redis.get(nodeidKey(nid)));
    if (alias) {
      var rec2 = safeParse(await redis.get(devkeyKey(alias)));
      if (rec2 && rec2.redeemCode) return rec2;
    }
  }
  return null;
}

/**
 * 建立/刷新设备归属索引。两个 ID 都传，双保险；只传一个也成立。
 * 只写 zero:* 新键，不改任何既有授权记录。
 */
async function bind(opts) {
  var mac = normalizeMac(opts && opts.deviceKey);
  var nid = normalizeNodeId(opts && opts.nodeId);
  if (!mac && !nid) return { bound: false, reason: "no_valid_id" };
  var rec = {
    redeemCode: String((opts && opts.redeemCode) || "").toUpperCase(),
    productId: String((opts && opts.productId) || ""),
    months: Number((opts && opts.months) || 0),
    deviceKey: mac,
    nodeId: nid,
    boundAt: Date.now(),
    source: String((opts && opts.source) || "")
  };
  if (!rec.redeemCode) return { bound: false, reason: "no_redeem_code" };
  if (mac) await redis.set(devkeyKey(mac), JSON.stringify(rec));
  if (nid && mac) await redis.set(nodeidKey(nid), mac);
  return { bound: true, deviceKey: mac, nodeId: nid };
}

/** 会话：建 / 读 / 局部更新（读改写，TTL 续期为 900s） */
async function saveSession(sid, data) {
  var s = normalizeSid(sid);
  if (!s) throw new Error("invalid sid");
  await redis.set(sessKey(s), JSON.stringify(data), { ex: SESSION_TTL_SEC });
  return s;
}
async function getSession(sid) {
  var s = normalizeSid(sid);
  return s ? safeParse(await redis.get(sessKey(s))) : null;
}
async function updateSession(sid, patch) {
  var cur = await getSession(sid);
  if (!cur) return null;
  var next = Object.assign({}, cur, patch || {});
  await saveSession(sid, next);
  return next;
}

module.exports = {
  SESSION_TTL_SEC: SESSION_TTL_SEC,
  safeParse: safeParse,
  normalizeMac: normalizeMac,
  normalizeNodeId: normalizeNodeId,
  normalizeDeviceId: normalizeDeviceId,
  newSid: newSid,
  normalizeSid: normalizeSid,
  lookup: lookup,
  bind: bind,
  saveSession: saveSession,
  getSession: getSession,
  updateSession: updateSession
};
