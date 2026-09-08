var SWITCH_KEYS = ["db:switch:supabase", "db:switch:neon", "db:switch:upstash"];
var PRIMARY_KEY = "auth:db:primary";

var cachedSwitches = { supabase: "on", neon: "on", upstash: "on" };
var cachedPrimary = null;
var lastLoadTime = 0;
var CACHE_TTL = 5000;

function getUpstashConfig() {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || "";
  return { url: url, token: token };
}

async function loadSwitches() {
  var now = Date.now();
  if (now - lastLoadTime < CACHE_TTL) {
    return cachedSwitches;
  }

  var config = getUpstashConfig();
  if (!config.url || !config.token) {
    lastLoadTime = now;
    return cachedSwitches;
  }

  try {
    var baseUrl = config.url.replace(/\/$/, "");
    var results = { supabase: "on", neon: "on", upstash: "on" };
    var keyMap = { "db:switch:supabase": "supabase", "db:switch:neon": "neon", "db:switch:upstash": "upstash" };

    for (var i = 0; i < SWITCH_KEYS.length; i++) {
      var key = SWITCH_KEYS[i];
      try {
        var resp = await fetch(baseUrl + "/get/" + encodeURIComponent(key), {
          headers: { Authorization: "Bearer " + config.token },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          var data = await resp.json();
          var val = data.result;
          if (val === "off") {
            results[keyMap[key]] = "off";
          }
        }
      } catch (_) {}
    }

    try {
      var primaryResp = await fetch(baseUrl + "/get/" + encodeURIComponent(PRIMARY_KEY), {
        headers: { Authorization: "Bearer " + config.token },
        signal: AbortSignal.timeout(3000),
      });
      if (primaryResp.ok) {
        var primaryData = await primaryResp.json();
        if (primaryData.result) {
          cachedPrimary = String(primaryData.result).trim();
        }
      }
    } catch (_) {}

    cachedSwitches = results;
    lastLoadTime = now;
  } catch (_) {}

  return cachedSwitches;
}

function getSwitches() {
  return cachedSwitches;
}

function setSwitches(switches) {
  if (switches.supabase !== undefined) cachedSwitches.supabase = switches.supabase;
  if (switches.neon !== undefined) cachedSwitches.neon = switches.neon;
  if (switches.upstash !== undefined) cachedSwitches.upstash = switches.upstash;
  lastLoadTime = Date.now();
}

function isEnabled(name) {
  var map = { supabase: cachedSwitches.supabase, neon: cachedSwitches.neon, upstash: cachedSwitches.upstash };
  return map[name] !== "off";
}

function getPrimary() {
  return cachedPrimary || null;
}

function setPrimary(name) {
  cachedPrimary = name;
  lastLoadTime = Date.now();
}

async function savePrimary(name) {
  var config = getUpstashConfig();
  if (!config.url || !config.token) {
    throw new Error("Upstash not configured, cannot save primary switch");
  }
  var baseUrl = config.url.replace(/\/$/, "");
  var resp = await fetch(baseUrl + "/set/" + encodeURIComponent(PRIMARY_KEY) + "/" + encodeURIComponent(name), {
    headers: { Authorization: "Bearer " + config.token },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error("Failed to save primary switch: HTTP " + resp.status);
  }
  cachedPrimary = name;
  lastLoadTime = Date.now();
  return true;
}

module.exports = {
  loadSwitches: loadSwitches,
  getSwitches: getSwitches,
  setSwitches: setSwitches,
  isEnabled: isEnabled,
  getPrimary: getPrimary,
  setPrimary: setPrimary,
  savePrimary: savePrimary,
};