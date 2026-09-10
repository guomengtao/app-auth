var UPSTASH_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
var UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var NOTIFY_KEY = "auth:push_notifications";
var MAX_QUEUE = 200;

function getUpstashUrl() {
  return UPSTASH_URL;
}

function getUpstashToken() {
  return UPSTASH_TOKEN;
}

async function upstashCommand() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("Upstash REST API not configured");
  }
  var args = Array.prototype.slice.call(arguments);
  var url = UPSTASH_URL + "/" + args.map(function (a) {
    return encodeURIComponent(String(a));
  }).join("/");
  var resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + UPSTASH_TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    var txt = await resp.text().catch(function () { return ""; });
    throw new Error("Upstash error " + resp.status + ": " + txt);
  }
  var json = await resp.json();
  if (json && typeof json === "object" && "result" in json) {
    return json.result;
  }
  return json;
}

async function pushNotification(type, payload) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn("[push-notify] Upstash not configured, skip push");
    return null;
  }
  var msg = JSON.stringify({
    type: type,
    payload: payload || {},
    ts: Date.now(),
  });
  try {
    await upstashCommand("LPUSH", NOTIFY_KEY, msg);
    await upstashCommand("LTRIM", NOTIFY_KEY, 0, MAX_QUEUE - 1);
    return true;
  } catch (e) {
    console.error("[push-notify] Failed:", e.message);
    return null;
  }
}

async function fetchNotifications(count) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  try {
    var n = (count && count > 0) ? count : 50;
    var raw = await upstashCommand("LRANGE", NOTIFY_KEY, 0, n - 1);
    if (!Array.isArray(raw)) return [];
    return raw.map(function (s) {
      try { return JSON.parse(s); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error("[push-notify] fetch failed:", e.message);
    return [];
  }
}

async function trimNotifications(keepCount) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    var k = (keepCount && keepCount > 0) ? keepCount : 100;
    await upstashCommand("LTRIM", NOTIFY_KEY, 0, k - 1);
  } catch (_) {}
}

module.exports = {
  pushNotification: pushNotification,
  fetchNotifications: fetchNotifications,
  trimNotifications: trimNotifications,
  getUpstashUrl: getUpstashUrl,
  getUpstashToken: getUpstashToken,
  NOTIFY_KEY: NOTIFY_KEY,
};