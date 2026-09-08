var dbRegistry = require("./db-registry");
var PRIMARY_KEY = "auth:db:primary";

var cachedSwitches = {};
var cachedPrimary = null;
var lastLoadTime = 0;
var CACHE_TTL = 5000;

function getUpstashConfig() {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || "";
  return { url: url, token: token };
}

function buildDefaultSwitches() {
  var dbs = dbRegistry.getAllDatabases();
  var defaults = {};
  for (var i = 0; i < dbs.length; i++) {
    defaults[dbs[i].id] = "on";
  }
  return defaults;
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

  var defaults = buildDefaultSwitches();
  if (Object.keys(cachedSwitches).length === 0) {
    cachedSwitches = {};
    var defKeys = Object.keys(defaults);
    for (var dk = 0; dk < defKeys.length; dk++) {
      cachedSwitches[defKeys[dk]] = defaults[defKeys[dk]];
    }
  }

  try {
    var baseUrl = config.url.replace(/\/$/, "");
    var dbs = dbRegistry.getAllDatabases();

    for (var i = 0; i < dbs.length; i++) {
      var switchKey = "db:switch:" + dbs[i].id;
      try {
        var resp = await fetch(baseUrl + "/get/" + encodeURIComponent(switchKey), {
          headers: { Authorization: "Bearer " + config.token },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          var data = await resp.json();
          if (data.result === "off") {
            cachedSwitches[dbs[i].id] = "off";
          } else if (data.result === "on") {
            cachedSwitches[dbs[i].id] = "on";
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

    lastLoadTime = now;
  } catch (_) {}

  return cachedSwitches;
}

function getSwitches() {
  var defaults = buildDefaultSwitches();
  var result = {};
  var keys = Object.keys(defaults);
  for (var i = 0; i < keys.length; i++) {
    var id = keys[i];
    result[id] = cachedSwitches[id] !== undefined ? cachedSwitches[id] : defaults[id];
  }
  return result;
}

function setSwitches(switches) {
  var keys = Object.keys(switches);
  for (var i = 0; i < keys.length; i++) {
    cachedSwitches[keys[i]] = switches[keys[i]];
  }
  lastLoadTime = Date.now();
}

function isEnabled(name) {
  var defaults = buildDefaultSwitches();
  var val = cachedSwitches[name];
  if (val === undefined) val = defaults[name];
  return val !== "off";
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