var dbRegistry = require("./db-registry");

var EDGE_PRIMARY_KEY = "auth_db_primary";

var cachedSwitches = {};
var cachedPrimary = null;
var lastLoadTime = 0;
var CACHE_TTL = 5000;

function extractEdgeConfigId() {
  var str = process.env.EDGE_CONFIG || "";
  if (!str) return null;
  var base = str.split("?token=")[0];
  var parts = base.split("/");
  return parts[parts.length - 1] || null;
}

function getEdgeConfigReadUrl() {
  var str = process.env.EDGE_CONFIG || "";
  if (!str) return null;
  var parts = str.split("?token=");
  return { baseUrl: parts[0], token: parts[1] || "" };
}

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

function initDefaults() {
  if (Object.keys(cachedSwitches).length === 0) {
    var defaults = buildDefaultSwitches();
    var defKeys = Object.keys(defaults);
    for (var dk = 0; dk < defKeys.length; dk++) {
      cachedSwitches[defKeys[dk]] = defaults[defKeys[dk]];
    }
  }
}

async function loadPrimaryFromEdgeConfig() {
  var cfg = getEdgeConfigReadUrl();
  if (!cfg || !cfg.baseUrl || !cfg.token) {
    console.log("[db-switches] EDGE_CONFIG not set, skip Edge Config read");
    return;
  }
  console.log("[db-switches] Edge Config reading from:", cfg.baseUrl.replace(/\/\/.*@/, "//***@"));

  try {
    var resp = await fetch(cfg.baseUrl + "/items?token=" + cfg.token, {
      signal: AbortSignal.timeout(10000),
    });
    console.log("[db-switches] Edge Config read status:", resp.status);
    if (resp.ok) {
      var data = await resp.json();
      console.log("[db-switches] Edge Config data:", JSON.stringify(data));
      if (data[EDGE_PRIMARY_KEY]) {
        cachedPrimary = String(data[EDGE_PRIMARY_KEY]).trim();
        console.log("[db-switches] Primary set from Edge Config:", cachedPrimary);
      } else {
        console.log("[db-switches] Edge Config has no auth_db_primary key");
      }
    } else {
      console.log("[db-switches] Edge Config read failed, status:", resp.status);
    }
  } catch (e) {
    console.log("[db-switches] Edge Config fetch error:", e.message);
  }
}

async function loadSwitchesFromUpstash() {
  var config = getUpstashConfig();
  if (!config.url || !config.token) {
    return;
  }

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
}

async function loadSwitchesFromPostgres() {
  try {
    var pg = require("./postgres");
    var pool = pg.getNativePool();
    var dbs = dbRegistry.getAllDatabases();

    for (var i = 0; i < dbs.length; i++) {
      var switchKey = "db:switch:" + dbs[i].id;
      try {
        var result = await pool.query("SELECT value FROM kv_strings WHERE key = $1", [switchKey]);
        if (result.rows && result.rows.length > 0) {
          var val = result.rows[0].value;
          if (val === "off") {
            cachedSwitches[dbs[i].id] = "off";
          } else if (val === "on") {
            cachedSwitches[dbs[i].id] = "on";
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function loadSwitches() {
  var now = Date.now();
  if (now - lastLoadTime < CACHE_TTL) {
    return cachedSwitches;
  }

  initDefaults();

  console.log("[db-switches] DB_PROVIDER env:", process.env.DB_PROVIDER || "(not set)");
  await loadPrimaryFromEdgeConfig();

  var effectiveProvider = cachedPrimary || process.env.DB_PROVIDER;
  console.log("[db-switches] effectiveProvider:", effectiveProvider || "(not set, using defaults)");

  if (effectiveProvider === "upstash") {
    console.log("[db-switches] Reading switches from Upstash");
    await loadSwitchesFromUpstash();
  } else {
    console.log("[db-switches] Reading switches from Postgres (provider:", effectiveProvider, ")");
    await loadSwitchesFromPostgres();
  }

  console.log("[db-switches] Final switches:", JSON.stringify(cachedSwitches));

  lastLoadTime = now;
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
  var edgeConfigId = extractEdgeConfigId();

  if (edgeConfigId) {
    var vercelToken = process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN || process.env.VERCEL_TOKEN_ALT;
    if (vercelToken) {
      try {
        var teamId = process.env.VERCEL_TEAM_ID;
        var apiUrl = "https://api.vercel.com/v1/edge-config/" + edgeConfigId + "/items";
        if (teamId) apiUrl += "?teamId=" + teamId;

        var resp = await fetch(apiUrl, {
          method: "PATCH",
          headers: {
            "Authorization": "Bearer " + vercelToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            items: [{ operation: "upsert", key: EDGE_PRIMARY_KEY, value: name }],
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (resp.ok) {
          console.log("Edge Config updated: " + EDGE_PRIMARY_KEY + " = " + name);
        }
      } catch (_) {}
    }
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