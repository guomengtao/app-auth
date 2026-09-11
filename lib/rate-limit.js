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

function getTodayKey() {
  var d = new Date();
  var offset = 8 * 60;
  var local = new Date(d.getTime() + (d.getTimezoneOffset() + offset) * 60000);
  var y = local.getUTCFullYear();
  var m = String(local.getUTCMonth() + 1).padStart(2, "0");
  var day = String(local.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function secondsUntilMidnight() {
  var d = new Date();
  var offset = 8 * 60;
  var local = new Date(d.getTime() + (d.getTimezoneOffset() + offset) * 60000);
  var midnight = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0));
  var diff = midnight.getTime() - local.getTime() + (offset * 60000);
  return Math.ceil(diff / 1000) + 3600;
}

var IP_WINDOW_MS = 60 * 1000;
var IP_MAX_HITS = 5;

var DEVICE_MAX_HITS = 50;

async function checkIpRateLimit(req) {
  var ip = getClientIp(req);
  var key = "ratelimit:ip:" + ip;
  var count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, IP_WINDOW_MS).catch(function () {});
  }
  if (count > IP_MAX_HITS) {
    var ttl = await redis.pttl(key).catch(function () { return IP_WINDOW_MS; });
    return { blocked: true, retryAfterMs: Math.max(ttl || 1000, 1000), reason: "请求过于频繁，请稍后再试" };
  }
  return { blocked: false };
}

async function checkDeviceRateLimit(deviceId) {
  if (!deviceId) return { blocked: false };
  var key = "ratelimit:device:" + getTodayKey() + ":" + hashKey(String(deviceId));
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

module.exports = {
  checkIpRateLimit: checkIpRateLimit,
  checkDeviceRateLimit: checkDeviceRateLimit,
  getClientIp: getClientIp,
  IP_WINDOW_MS: IP_WINDOW_MS,
  IP_MAX_HITS: IP_MAX_HITS,
  DEVICE_WINDOW_MS: DEVICE_WINDOW_MS,
  DEVICE_MAX_HITS: DEVICE_MAX_HITS,
};