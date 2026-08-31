var pg = require("./postgres");

function getRedisConfig() {
  return {
    url: String(process.env.POSTGRES_URL || process.env.DATABASE_URL || "").trim(),
    token: "",
  };
}

function isRateLimitError(err) {
  return false;
}

async function purgeExpired() {
  if (!pg.isConfigured()) return;
  try {
    await pg.query("DELETE FROM kv_strings WHERE expires_at IS NOT NULL AND expires_at < NOW()");
  } catch (e) {
  }
}

async function ensureInit() {
  if (pg.ensureTables) {
    try {
      await pg.ensureTables();
    } catch (e) {
    }
  }
}

function createMissingEnvClient(err) {
  return {
    __redisError: err,
    ping: function () { return Promise.reject(err); },
    get: function () { return Promise.reject(err); },
    set: function () { return Promise.reject(err); },
    del: function () { return Promise.reject(err); },
    hgetall: function () { return Promise.reject(err); },
    hset: function () { return Promise.reject(err); },
    hget: function () { return Promise.reject(err); },
    hlen: function () { return Promise.reject(err); },
    incr: function () { return Promise.reject(err); },
    sadd: function () { return Promise.reject(err); },
    scard: function () { return Promise.reject(err); },
    sscan: function () { return Promise.reject(err); },
    scan: function () { return Promise.reject(err); },
    lrange: function () { return Promise.reject(err); },
    lpush: function () { return Promise.reject(err); },
    mget: function () { return Promise.reject(err); },
    pipeline: function () {
      return {
        get: function () { return this; },
        set: function () { return this; },
        del: function () { return this; },
        hget: function () { return this; },
        hgetall: function () { return this; },
        sadd: function () { return this; },
        incr: function () { return this; },
        exec: function () { return Promise.reject(err); },
      };
    },
  };
}

var initPromise = null;

async function safeInit() {
  if (!initPromise) {
    initPromise = ensureInit();
  }
  try {
    await initPromise;
  } catch (e) {
  }
}

async function ping() {
  await safeInit();
  await pg.query("SELECT 1");
  return "PONG";
}

async function get(key) {
  await safeInit();
  await purgeExpired();
  var result = await pg.query("SELECT value FROM kv_strings WHERE key = $1 AND (expires_at IS NULL OR expires_at >= NOW())", [key]);
  if (result.rows && result.rows.length > 0) {
    return result.rows[0].value;
  }
  return null;
}

async function set(key, value, options) {
  await safeInit();
  var expiresAt = null;
  if (options && options.ex) {
    expiresAt = new Date(Date.now() + options.ex * 1000).toISOString();
  }
  var valStr = (typeof value === "string") ? value : String(value);
  await pg.query(
    "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, $3) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
    [key, valStr, expiresAt]
  );
  return "OK";
}

async function del() {
  await safeInit();
  var keys = Array.prototype.slice.call(arguments);
  if (keys.length === 0) return 0;
  var placeholders = keys.map(function (_, i) { return "$" + (i + 1); }).join(",");
  await pg.query("DELETE FROM kv_strings WHERE key IN (" + placeholders + ")", keys);
  await pg.query("DELETE FROM kv_hashes WHERE key IN (" + placeholders + ")", keys);
  await pg.query("DELETE FROM kv_sets WHERE key IN (" + placeholders + ")", keys);
  await pg.query("DELETE FROM kv_lists WHERE key IN (" + placeholders + ")", keys);
  return keys.length;
}

async function hgetall(key) {
  await safeInit();
  var result = await pg.query("SELECT field, value FROM kv_hashes WHERE key = $1", [key]);
  var obj = {};
  if (result.rows) {
    result.rows.forEach(function (row) {
      obj[row.field] = row.value;
    });
  }
  return obj;
}

async function hset(key, obj) {
  await safeInit();
  var fields = Object.keys(obj || {});
  if (fields.length === 0) return 0;
  var count = 0;
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var val = (typeof obj[field] === "string") ? obj[field] : String(obj[field]);
    var res = await pg.query(
      "INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3) " +
      "ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value",
      [key, field, val]
    );
    if (res.rowCount) count += res.rowCount;
  }
  return count;
}

async function hget(key, field) {
  await safeInit();
  var result = await pg.query("SELECT value FROM kv_hashes WHERE key = $1 AND field = $2", [key, field]);
  if (result.rows && result.rows.length > 0) {
    return result.rows[0].value;
  }
  return null;
}

async function hlen(key) {
  await safeInit();
  var result = await pg.query("SELECT COUNT(*) as cnt FROM kv_hashes WHERE key = $1", [key]);
  if (result.rows && result.rows.length > 0) {
    return parseInt(result.rows[0].cnt, 10);
  }
  return 0;
}

async function incr(key) {
  await safeInit();
  var result = await pg.query("SELECT value FROM kv_strings WHERE key = $1 FOR UPDATE", [key]);
  var cur = 0;
  if (result.rows && result.rows.length > 0 && result.rows[0].value != null) {
    cur = parseInt(result.rows[0].value, 10);
    if (!Number.isFinite(cur)) cur = 0;
  }
  cur += 1;
  await pg.query(
    "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, NULL) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, String(cur)]
  );
  return cur;
}

async function sadd(key) {
  await safeInit();
  var members = Array.prototype.slice.call(arguments, 1);
  if (members.length === 0) return 0;
  var added = 0;
  for (var i = 0; i < members.length; i++) {
    var mem = String(members[i]);
    try {
      var res = await pg.query(
        "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [key, mem]
      );
      if (res.rowCount) added += res.rowCount;
    } catch (e) {
    }
  }
  return added;
}

async function scard(key) {
  await safeInit();
  var result = await pg.query("SELECT COUNT(*) as cnt FROM kv_sets WHERE key = $1", [key]);
  if (result.rows && result.rows.length > 0) {
    return parseInt(result.rows[0].cnt, 10);
  }
  return 0;
}

async function sscan(key, cursor, options) {
  await safeInit();
  var count = (options && options.count) ? parseInt(options.count, 10) : 10;
  if (!Number.isFinite(count) || count < 1) count = 10;
  var cur = parseInt(cursor, 10);
  if (!Number.isFinite(cur) || cur < 0) cur = 0;
  var result = await pg.query(
    "SELECT member FROM kv_sets WHERE key = $1 ORDER BY member LIMIT $2 OFFSET $3",
    [key, count, cur]
  );
  var keys = (result.rows || []).map(function (r) { return r.member; });
  var nextCursor = (keys.length < count) ? 0 : (cur + count);
  return [String(nextCursor), keys];
}

async function scan(cursor, options) {
  await safeInit();
  var match = (options && options.match) || "*";
  var count = (options && options.count) ? parseInt(options.count, 10) : 100;
  if (!Number.isFinite(count) || count < 1) count = 100;
  var cur = parseInt(cursor, 10);
  if (!Number.isFinite(cur) || cur < 0) cur = 0;

  var pattern = match.replace(/\*/g, "%").replace(/\?/g, "_");
  var allKeys = [];

  var s1 = await pg.query("SELECT DISTINCT key FROM kv_strings WHERE key LIKE $1 ORDER BY key", [pattern]);
  var s2 = await pg.query("SELECT DISTINCT key FROM kv_hashes WHERE key LIKE $1 ORDER BY key", [pattern]);
  var s3 = await pg.query("SELECT DISTINCT key FROM kv_sets WHERE key LIKE $1 ORDER BY key", [pattern]);
  var s4 = await pg.query("SELECT DISTINCT key FROM kv_lists WHERE key LIKE $1 ORDER BY key", [pattern]);

  var set = {};
  (s1.rows || []).forEach(function (r) { set[r.key] = true; });
  (s2.rows || []).forEach(function (r) { set[r.key] = true; });
  (s3.rows || []).forEach(function (r) { set[r.key] = true; });
  (s4.rows || []).forEach(function (r) { set[r.key] = true; });

  allKeys = Object.keys(set).sort();
  var slice = allKeys.slice(cur, cur + count);
  var nextCursor = (cur + count >= allKeys.length) ? 0 : (cur + count);
  return [String(nextCursor), slice];
}

async function lrange(key, start, stop) {
  await safeInit();
  var s = parseInt(start, 10);
  var e = parseInt(stop, 10);
  if (!Number.isFinite(s)) s = 0;
  if (!Number.isFinite(e)) e = -1;

  var total = await pg.query("SELECT COUNT(*) as cnt FROM kv_lists WHERE key = $1", [key]);
  var totalCnt = (total.rows && total.rows[0]) ? parseInt(total.rows[0].cnt, 10) : 0;
  if (totalCnt === 0) return [];

  if (s < 0) s = Math.max(0, totalCnt + s);
  if (e < 0) e = totalCnt + e;
  if (e >= totalCnt) e = totalCnt - 1;
  if (s > e || s >= totalCnt) return [];

  var limit = e - s + 1;
  var result = await pg.query(
    "SELECT value FROM kv_lists WHERE key = $1 ORDER BY idx DESC OFFSET $2 LIMIT $3",
    [key, s, limit]
  );
  return (result.rows || []).map(function (r) { return r.value; });
}

async function lpush(key, value) {
  await safeInit();
  var val = (typeof value === "string") ? value : String(value);
  await pg.query("INSERT INTO kv_lists (key, value) VALUES ($1, $2)", [key, val]);
  var total = await pg.query("SELECT COUNT(*) as cnt FROM kv_lists WHERE key = $1", [key]);
  return (total.rows && total.rows[0]) ? parseInt(total.rows[0].cnt, 10) : 1;
}

async function mget() {
  await safeInit();
  await purgeExpired();
  var keys = Array.prototype.slice.call(arguments);
  if (keys.length === 0) return [];
  var placeholders = keys.map(function (_, i) { return "$" + (i + 1); }).join(",");
  var result = await pg.query(
    "SELECT key, value FROM kv_strings WHERE key IN (" + placeholders + ") AND (expires_at IS NULL OR expires_at >= NOW())",
    keys
  );
  var map = {};
  (result.rows || []).forEach(function (r) { map[r.key] = r.value; });
  return keys.map(function (k) { return (k in map) ? map[k] : null; });
}

function pipeline() {
  var commands = [];
  var pip = {
    get: function (k) { commands.push({ op: "get", args: [k] }); return pip; },
    set: function (k, v, o) { commands.push({ op: "set", args: [k, v, o] }); return pip; },
    del: function () { var a = Array.prototype.slice.call(arguments); commands.push({ op: "del", args: a }); return pip; },
    hget: function (k, f) { commands.push({ op: "hget", args: [k, f] }); return pip; },
    hgetall: function (k) { commands.push({ op: "hgetall", args: [k] }); return pip; },
    sadd: function () { var a = Array.prototype.slice.call(arguments); commands.push({ op: "sadd", args: a }); return pip; },
    incr: function (k) { commands.push({ op: "incr", args: [k] }); return pip; },
    exec: async function () {
      var results = [];
      for (var i = 0; i < commands.length; i++) {
        var c = commands[i];
        try {
          var r = await client[c.op].apply(null, c.args);
          results.push(r);
        } catch (e) {
          results.push(null);
        }
      }
      return results;
    },
  };
  return pip;
}

var client;
try {
  if (!pg.isConfigured()) {
    var envErr = new Error(
      "Postgres environment variables missing: POSTGRES_URL is required"
    );
    envErr.code = "REDIS_ENV_MISSING";
    client = createMissingEnvClient(envErr);
  } else {
    client = {
      ping: ping,
      get: get,
      set: set,
      del: del,
      hgetall: hgetall,
      hset: hset,
      hget: hget,
      hlen: hlen,
      incr: incr,
      sadd: sadd,
      scard: scard,
      sscan: sscan,
      scan: scan,
      lrange: lrange,
      lpush: lpush,
      mget: mget,
      pipeline: pipeline,
    };
  }
} catch (e) {
  client = createMissingEnvClient(e);
}

client.getRedisConfig = getRedisConfig;
client.createRedis = function () { return client; };
client.isRateLimitError = isRateLimitError;

module.exports = client;