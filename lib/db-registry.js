var fs = require("fs");
var path = require("path");

var registryPath = path.join(__dirname, "..", "db-registry.json");
var cachedRegistry = null;
var cacheTime = 0;
var CACHE_TTL = 30000;

function loadRegistry() {
  var now = Date.now();
  if (cachedRegistry && (now - cacheTime) < CACHE_TTL) {
    return cachedRegistry;
  }
  try {
    var raw = fs.readFileSync(registryPath, "utf-8");
    var data = JSON.parse(raw);
    cachedRegistry = data.databases || [];
    cacheTime = now;
    return cachedRegistry;
  } catch (e) {
    if (cachedRegistry) return cachedRegistry;
    return [];
  }
}

function getDatabase(id) {
  var dbs = loadRegistry();
  for (var i = 0; i < dbs.length; i++) {
    if (dbs[i].id === id) return dbs[i];
  }
  return null;
}

function getDatabaseUrl(id) {
  var db = getDatabase(id);
  if (!db) return null;
  return process.env[db.urlEnv] || null;
}

function getDatabaseToken(id) {
  var db = getDatabase(id);
  if (!db || !db.tokenEnv) return null;
  return process.env[db.tokenEnv] || null;
}

function getAllDatabases() {
  return loadRegistry();
}

function getPostgresDatabases() {
  return loadRegistry().filter(function (db) { return db.type === "postgres"; });
}

function getRedisDatabases() {
  return loadRegistry().filter(function (db) { return db.type === "redis"; });
}

function getEnabledDatabases(enabledMap) {
  var dbs = loadRegistry();
  if (!enabledMap) return dbs;
  return dbs.filter(function (db) {
    return enabledMap[db.id] !== "off";
  });
}

module.exports = {
  loadRegistry: loadRegistry,
  getDatabase: getDatabase,
  getDatabaseUrl: getDatabaseUrl,
  getDatabaseToken: getDatabaseToken,
  getAllDatabases: getAllDatabases,
  getPostgresDatabases: getPostgresDatabases,
  getRedisDatabases: getRedisDatabases,
  getEnabledDatabases: getEnabledDatabases,
};