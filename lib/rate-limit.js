var redis = require("./redis");

function getClientIp(req) {
  var headers = req.headers || {};
  var forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    var parts = String(forwarded).split(",");
    return parts[0].trim();
  }
  var realIp = headers["x-real-ip"];
  if (realIp) return String(realIp).trim();
  return (req.socket && req.socket.remoteAddress) || "127.0.0.1";
}

function hashKey(str) {
  if (!str) return "unknown";
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// ---------- 北京时间（UTC+8）时间键：全项目唯一实现 ----------
// ⚠️ 不要再用 `new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000)` 这种公式：
//    它只在运行时本身就是 UTC（Vercel）时才等价于北京时间；本地（CST）跑会退化成 UTC，
//    这正是「访客统计把早上 0:00–8:00 的访问记到前一天」的根因。改为「瞬间 +8h 再读 UTC 分量」，与运行时时区无关。
var CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingDateTime(ts) {
  var ms = ts == null ? Date.now() : Number(ts);
  if (!Number.isFinite(ms)) ms = Date.now();
  return new Date(ms + CST_OFFSET_MS);
}

// YYYY-MM-DD（北京时间）
function beijingDateKey(ts) {
  var d = beijingDateTime(ts);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function getTodayKey() {
  return beijingDateKey();
}

function secondsUntilMidnight() {
  // 北京时间当天 24:00 对应 UTC 前一天 16:00 → 用 +8h 后的 UTC 分量算下一个零点
  var local = beijingDateTime();
  var midnightUtcMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0) - CST_OFFSET_MS;
  var diff = midnightUtcMs - Date.now();
  return Math.ceil(diff / 1000) + 3600;
}

var IP_WINDOW_MS = 60 * 1000;
var IP_MAX_HITS = 15;

var DEVICE_MAX_HITS = 10;

function getMinuteKey() {
  var d = beijingDateTime();
  var h = String(d.getUTCHours()).padStart(2, "0");
  var min = String(d.getUTCMinutes()).padStart(2, "0");
  return beijingDateKey() + "-" + h + "-" + min;
}

function secondsToNextMinute() {
  var d = new Date();
  var seconds = 60 - d.getSeconds();
  return seconds + 2;
}

async function checkIpRateLimit(req) {
  var ip = getClientIp(req);
  var key = "ratelimit:ip:" + getMinuteKey() + ":" + ip;
  var count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, secondsToNextMinute() * 1000).catch(function () {});
  }
  if (count > IP_MAX_HITS) {
    var ttl = await redis.pttl(key).catch(function () { return IP_WINDOW_MS; });
    return { blocked: true, retryAfterMs: Math.max(ttl || 1000, 1000), reason: "请求过于频繁，请稍后再试" };
  }
  return { blocked: false };
}

// 访客埋点限流：原先 30 次/分钟/IP，公司/校园等共享出口 IP 容易撞到 → 直接 429 丢访客记录。
// 埋点本身是低成本的 XHR，放宽到 120 次/分钟，避免统计漏记。
var VISITOR_IP_MAX_HITS = 120;

async function checkVisitorIpRateLimit(req) {
  var ip = getClientIp(req);
  var key = "ratelimit:visitor:" + getMinuteKey() + ":" + ip;
  var count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, secondsToNextMinute() * 1000).catch(function () {});
  }
  if (count > VISITOR_IP_MAX_HITS) {
    return { blocked: true, retryAfterMs: 30000, reason: "请求过于频繁" };
  }
  return { blocked: false };
}

async function checkDeviceRateLimit(deviceId, redeemCode) {
  if (!deviceId) return { blocked: false };
  var codeHash = redeemCode ? ":" + hashKey(String(redeemCode)) : "";
  var key = "ratelimit:device:" + getTodayKey() + ":" + hashKey(String(deviceId)) + codeHash;
  var count = await redis.incr(key);
  if (count === 1) {
    var ttlMs = secondsUntilMidnight() * 1000;
    await redis.pexpire(key, ttlMs).catch(function () {});
  }
  if (count > DEVICE_MAX_HITS) {
    var ttlMs = await redis.pttl(key).catch(function () { return 86400000; });
    return { blocked: true, retryAfterMs: Math.max(ttlMs || 3600000, 1000), reason: "该设备激活次数过多，请明天再试" };
  }
  return { blocked: false };
}

async function clearDeviceRateLimit(deviceId) {
  if (!deviceId) return;
  var prefix = "ratelimit:device:" + getTodayKey() + ":" + hashKey(String(deviceId));
  var scan = redis.scan || function () { return ["0", []]; };
  var cursor = "0";
  var keys = [];
  try {
    for (var i = 0; i < 10; i++) {
      var result = await scan(cursor, { match: prefix + "*", count: 100 });
      cursor = result[0];
      keys = keys.concat(result[1]);
      if (cursor === "0") break;
    }
  } catch (e) {
    console.error("[rate-limit] scan failed:", e.message);
  }
  if (keys.length > 0) {
    try {
      var delFn = redis.del;
      delFn.apply(redis, keys);
    } catch (e) {
      console.error("[rate-limit] clear failed:", e.message);
    }
  }
}

module.exports = {
  checkIpRateLimit: checkIpRateLimit,
  checkVisitorIpRateLimit: checkVisitorIpRateLimit,
  checkDeviceRateLimit: checkDeviceRateLimit,
  clearDeviceRateLimit: clearDeviceRateLimit,
  getClientIp: getClientIp,
  getMinuteKey: getMinuteKey,
  beijingDateKey: beijingDateKey,
  CST_OFFSET_MS: CST_OFFSET_MS,
  secondsToNextMinute: secondsToNextMinute,
  IP_WINDOW_MS: IP_WINDOW_MS,
  IP_MAX_HITS: IP_MAX_HITS,
  VISITOR_IP_MAX_HITS: VISITOR_IP_MAX_HITS,
  DEVICE_MAX_HITS: DEVICE_MAX_HITS,
};