process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var redis = require("./redis");
var pgSync = null;
try { pgSync = require("pg"); } catch(e) {}

module.exports = async function verifySwitch(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var targetDb = (req.query.target || "").toLowerCase();
    if (["supabase", "neon", "upstash"].indexOf(targetDb) === -1) {
      return res.status(400).json({
        success: false,
        error: "Invalid target. Use: supabase, neon, or upstash",
      });
    }

    var primaryProvider = String(process.env.DB_PROVIDER || "auto").trim();
    var useUpstash = process.env.USE_UPSTASH === "true";
    if (useUpstash || primaryProvider === "upstash") {
      primaryProvider = "upstash";
    } else if (primaryProvider === "supabase") {
      primaryProvider = "supabase";
    } else if (primaryProvider === "neon") {
      primaryProvider = "neon";
    } else {
      primaryProvider = "neon";
    }

    if (targetDb === primaryProvider) {
      return res.json({
        success: true,
        canSwitch: false,
        reason: "Target is the same as current primary database",
        primary: primaryProvider,
        target: targetDb,
        comparison: null,
      });
    }

    var upstashUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
    var upstashToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || "";

    var neonUrl = process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.DATABASE_URL || "";

    var supabaseUrl = process.env.Ev_POSTGRES_URL ||
      process.env.Ev_POSTGRES_URL_NON_POOLING ||
      process.env.SUPABASE_POSTGRES_URL ||
      process.env.Ev_POSTGRES_PRISMA_URL || "";

    if (supabaseUrl) {
      supabaseUrl = supabaseUrl.replace(/&supa=base-pooler\.x/, "").replace(/\?sslmode=require/, "?sslmode=verify-full");
    }

    function getDbUrl(name) {
      if (name === "supabase") return supabaseUrl;
      if (name === "neon") return neonUrl;
      if (name === "upstash") return upstashUrl;
      return "";
    }

    function createPgPool(url) {
      if (!url || !pgSync) return null;
      return new pgSync.Pool({
        connectionString: url,
        max: 3,
        connectionTimeoutMillis: 10000,
        ssl: { rejectUnauthorized: false },
      });
    }

    async function getPgStats(pool) {
      if (!pool) return null;
      try {
        var strRes = await pool.query("SELECT COUNT(*) AS cnt FROM kv_strings");
        var hashRes = await pool.query("SELECT COUNT(*) AS cnt FROM kv_hashes");
        var setRes = await pool.query("SELECT COUNT(*) AS cnt FROM kv_sets");
        var zsetRes = await pool.query("SELECT COUNT(*) AS cnt FROM kv_zsets");
        var strings = parseInt(strRes.rows[0].cnt, 10) || 0;
        var hashes = parseInt(hashRes.rows[0].cnt, 10) || 0;
        var sets = parseInt(setRes.rows[0].cnt, 10) || 0;
        var zsets = parseInt(zsetRes.rows[0].cnt, 10) || 0;

        var distinctKeys = await pool.query(
          "SELECT COUNT(DISTINCT key) AS cnt FROM (SELECT key FROM kv_strings UNION SELECT key FROM kv_hashes UNION SELECT key FROM kv_sets UNION SELECT key FROM kv_zsets) AS all_keys"
        );
        var keys = parseInt(distinctKeys.rows[0].cnt, 10) || 0;

        var fingerprint = await pool.query(
          "SELECT MD5(string_agg(src, '' ORDER BY src COLLATE \"C\")) AS fp FROM (" +
          "SELECT key || ':' || COALESCE(value,'') AS src FROM kv_strings WHERE key NOT LIKE 'auth:db:%' AND key NOT LIKE 'auth:cron:%' " +
          "UNION ALL SELECT key || ':' || field || ':' || COALESCE(value,'') FROM kv_hashes " +
          "UNION ALL SELECT key || ':' || member FROM kv_sets " +
          "UNION ALL SELECT key || ':' || member || ':' || score FROM kv_zsets" +
          ") AS all_src"
        );
        var fp = fingerprint.rows[0].fp || "";

        return {
          keys: keys,
          strings: strings,
          hashes: hashes,
          sets: sets,
          zsets: zsets,
          totalRecords: strings + hashes + sets + zsets,
          fingerprint: fp,
          error: null,
        };
      } catch (e) {
        return { keys: 0, strings: 0, hashes: 0, sets: 0, zsets: 0, totalRecords: 0, fingerprint: "", error: e.message || String(e) };
      }
    }

    async function getUpstashStats() {
      if (!upstashUrl) return null;
      var baseUrl = upstashUrl.replace(/\/$/, "");
      var headers = { Authorization: "Bearer " + upstashToken };
      try {
        var sizeRes = await fetch(baseUrl + "/dbsize", { headers: headers });
        var sizeData = await sizeRes.json();
        var totalKeys = sizeData.result || 0;

        var allKeys = [];
        var cursor = 0;
        var scanRounds = 0;
        do {
          var scanRes = await fetch(baseUrl + "/scan/" + cursor, { headers: headers });
          var scanData = await scanRes.json();
          cursor = scanData.result[0];
          var batch = scanData.result[1] || [];
          for (var bi = 0; bi < batch.length; bi++) {
            allKeys.push(batch[bi]);
          }
          scanRounds++;
        } while (cursor !== 0 && scanRounds < 100);

        var fpParts = [];
        var strings = 0;
        var hashes = 0;
        var sets = 0;
        var zsets = 0;

        for (var ki = 0; ki < allKeys.length; ki++) {
          var key = allKeys[ki];
          if (key.indexOf("auth:db:") === 0 || key.indexOf("auth:cron:") === 0) {
            continue;
          }
          try {
            var typeRes = await fetch(baseUrl + "/type/" + encodeURIComponent(key), { headers: headers });
            var typeData = await typeRes.json();
            var type = typeData.result;

            if (type === "string") {
              var valRes = await fetch(baseUrl + "/get/" + encodeURIComponent(key), { headers: headers });
              var valData = await valRes.json();
              var val = valData.result;
              fpParts.push(key + ":" + (val !== null && val !== undefined ? String(val) : ""));
              strings++;
            } else if (type === "hash") {
              var hgetRes = await fetch(baseUrl + "/hgetall/" + encodeURIComponent(key), { headers: headers });
              var hgetData = await hgetRes.json();
              var fields = hgetData.result || [];
              for (var fi = 0; fi < fields.length; fi += 2) {
                fpParts.push(key + ":" + fields[fi] + ":" + (fields[fi + 1] !== null && fields[fi + 1] !== undefined ? String(fields[fi + 1]) : ""));
                hashes++;
              }
            } else if (type === "set") {
              var smemRes = await fetch(baseUrl + "/smembers/" + encodeURIComponent(key), { headers: headers });
              var smemData = await smemRes.json();
              var members = smemData.result || [];
              for (var si = 0; si < members.length; si++) {
                fpParts.push(key + ":" + members[si]);
                sets++;
              }
            } else if (type === "zset") {
              var zrngRes = await fetch(baseUrl + "/zrange/" + encodeURIComponent(key) + "/0/-1/WITHSCORES", { headers: headers });
              var zrngData = await zrngRes.json();
              var zmembers = zrngData.result || [];
              for (var zi = 0; zi < zmembers.length; zi += 2) {
                fpParts.push(key + ":" + zmembers[zi] + ":" + zmembers[zi + 1]);
                zsets++;
              }
            }
          } catch (_) {}
        }

        fpParts.sort();
        var cryptoMod = require("crypto");
        var fingerprint = cryptoMod.createHash("md5").update(fpParts.join("")).digest("hex");

        var dataKeys = allKeys.filter(function(k) {
          return k.indexOf("auth:db:") !== 0 && k.indexOf("auth:cron:") !== 0;
        }).length;

        return {
          keys: dataKeys,
          strings: strings,
          hashes: hashes,
          sets: sets,
          zsets: zsets,
          totalRecords: strings + hashes + sets + zsets,
          fingerprint: fingerprint,
          error: null,
        };
      } catch (e) {
        return { keys: 0, strings: 0, hashes: 0, sets: 0, zsets: 0, totalRecords: 0, fingerprint: "", error: e.message || String(e) };
      }
    }

    async function getDbStats(name) {
      if (name === "upstash") return getUpstashStats();
      var url = getDbUrl(name);
      if (!url) return { keys: 0, strings: 0, hashes: 0, sets: 0, zsets: 0, totalRecords: 0, fingerprint: "", error: "No connection URL configured for " + name };
      var pool = createPgPool(url);
      if (!pool) return { keys: 0, strings: 0, hashes: 0, sets: 0, zsets: 0, totalRecords: 0, fingerprint: "", error: "pg module not available" };
      try {
        var stats = await getPgStats(pool);
        return stats;
      } finally {
        try { await pool.end(); } catch (_) {}
      }
    }

    var primaryStats = await getDbStats(primaryProvider);
    var targetStats = await getDbStats(targetDb);

    var lastSyncAt = null;
    var syncStatus = null;
    try {
      var rawSync = await redis.get("auth:db:sync_status");
      if (rawSync && typeof rawSync === "string") {
        syncStatus = JSON.parse(rawSync);
        lastSyncAt = syncStatus.lastSyncDate || null;
      }
    } catch (_) {}

    var recentlySynced = false;
    if (lastSyncAt) {
      var syncTime = new Date(lastSyncAt).getTime();
      recentlySynced = (Date.now() - syncTime) < 3600000;
    }

    var primaryRecordCount = primaryStats ? primaryStats.totalRecords : 0;
    var targetRecordCount = targetStats ? targetStats.totalRecords : 0;
    var primaryKeyCount = primaryStats ? primaryStats.keys : 0;
    var targetKeyCount = targetStats ? targetStats.keys : 0;

    var keyCountMatch = primaryKeyCount > 0 && targetKeyCount > 0 &&
      Math.abs(primaryKeyCount - targetKeyCount) <= Math.max(5, primaryKeyCount * 0.05);

    var fingerprintMatch = primaryStats && targetStats &&
      primaryStats.fingerprint && targetStats.fingerprint &&
      primaryStats.fingerprint === targetStats.fingerprint;

    var primaryHasError = primaryStats && primaryStats.error;
    var targetHasError = targetStats && targetStats.error;

    var canSwitch = false;
    var reason = "";
    var suggestion = "";

    if (primaryHasError) {
      reason = "Cannot read primary database (" + primaryProvider + "): " + primaryHasError;
      suggestion = "Check the primary database connection and try again";
    } else if (targetHasError) {
      reason = "Cannot read target database (" + targetDb + "): " + targetHasError;
      suggestion = "Check the target database connection and try again";
    } else if (!primaryStats || primaryKeyCount === 0) {
      reason = "Primary database (" + primaryProvider + ") has no data";
      suggestion = "Primary database is empty. Add data before switching";
    } else if (!targetStats || targetKeyCount === 0) {
      reason = "Target database (" + targetDb + ") has no data";
      suggestion = "Sync data from primary to target first, then try switching";
    } else if (!keyCountMatch && !fingerprintMatch) {
      reason = "Data mismatch: key count and fingerprint both differ";
      suggestion = "Run a full sync from " + primaryProvider + " to " + targetDb + " before switching";
    } else if (!keyCountMatch) {
      reason = "Key count mismatch: primary has " + primaryKeyCount + " keys, target has " + targetKeyCount + " keys";
      suggestion = "Run a sync from " + primaryProvider + " to " + targetDb + " to align data";
    } else if (!fingerprintMatch) {
      reason = "Data fingerprint mismatch: content differs between databases";
      suggestion = "Run a sync from " + primaryProvider + " to " + targetDb + " to align data";
    } else {
      canSwitch = true;
      reason = "Data is consistent between primary and target";
      suggestion = "Safe to switch primary database to " + targetDb;
    }

    return res.json({
      success: true,
      canSwitch: canSwitch,
      reason: reason,
      suggestion: suggestion,
      primary: {
        name: primaryProvider,
        stats: primaryStats,
        hasError: !!primaryHasError,
      },
      target: {
        name: targetDb,
        stats: targetStats,
        hasError: !!targetHasError,
      },
      comparison: {
        keyCountMatch: keyCountMatch,
        fingerprintMatch: fingerprintMatch,
        primaryKeys: primaryKeyCount,
        targetKeys: targetKeyCount,
        primaryRecords: primaryRecordCount,
        targetRecords: targetRecordCount,
        keyDiff: targetKeyCount - primaryKeyCount,
        recordDiff: targetRecordCount - primaryRecordCount,
      },
      sync: {
        lastSyncAt: lastSyncAt,
        recentlySynced: recentlySynced,
        syncType: syncStatus ? syncStatus.lastSyncType : null,
        updateCount: syncStatus ? syncStatus.updateCount : 0,
      },
    });
  } catch (e) {
    console.error("verify-switch error:", e);
    return res.status(500).json({
      success: false,
      error: (e && e.message) || String(e),
    });
  }
};