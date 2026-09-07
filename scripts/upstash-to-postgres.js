function getUpstashClient() {
  var upstashUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var upstashToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    console.error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
    process.exit(1);
  }

  var baseUrl = upstashUrl.replace(/\/$/, "");

  return {
    scan: async function(cursor) {
      var res = await fetch(baseUrl + "/scan/" + (cursor || 0), {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    },
    type: async function(key) {
      var res = await fetch(baseUrl + "/type/" + encodeURIComponent(key), {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    },
    get: async function(key) {
      var res = await fetch(baseUrl + "/get/" + encodeURIComponent(key), {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    },
    hgetall: async function(key) {
      var res = await fetch(baseUrl + "/hgetall/" + encodeURIComponent(key), {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result || [];
    },
    smembers: async function(key) {
      var res = await fetch(baseUrl + "/smembers/" + encodeURIComponent(key), {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result || [];
    },
    zrange: async function(key) {
      var res = await fetch(baseUrl + "/zrange/" + encodeURIComponent(key) + "/0/-1/WITHSCORES", {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result || [];
    },
    lrange: async function(key) {
      var res = await fetch(baseUrl + "/lrange/" + encodeURIComponent(key) + "/0/-1", {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result || [];
    },
    dbsize: async function() {
      var res = await fetch(baseUrl + "/dbsize", {
        headers: { "Authorization": "Bearer " + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
  };
}

async function syncToPostgres() {
  var pg = require("../lib/postgres");
  var upstash = getUpstashClient();

  console.log("=== Upstash KV → Neon Postgres ===\n");

  var totalKeys = await upstash.dbsize();
  console.log("Upstash KV keys: " + totalKeys + "\n");

  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, unknown: 0, errors: 0 };
  var processed = 0;

  var cursor = 0;
  var round = 0;
  do {
    round++;
    var scanResult = await upstash.scan(cursor);
    cursor = scanResult[0];
    var keys = scanResult[1] || [];

    console.log("Scan round " + round + ": " + keys.length + " keys (cursor=" + cursor + ")");

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      try {
        var type = await upstash.type(key);

        if (type === "string") {
          var value = await upstash.get(key);
          if (value !== null && value !== undefined) {
            await pg.query(
              "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, NULL) " +
              "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
              [key, String(value)]
            );
            stats.strings++;
          }
        } else if (type === "hash") {
          var fields = await upstash.hgetall(key);
          for (var f = 0; f < fields.length; f += 2) {
            var field = fields[f];
            var hval = fields[f + 1];
            await pg.query(
              "INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3) " +
              "ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value",
              [key, field, String(hval)]
            );
            stats.hashes++;
          }
        } else if (type === "set") {
          var members = await upstash.smembers(key);
          for (var m = 0; m < members.length; m++) {
            await pg.query(
              "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [key, String(members[m])]
            );
            stats.sets++;
          }
        } else if (type === "zset") {
          var entries = await upstash.zrange(key);
          for (var z = 0; z < entries.length; z += 2) {
            var member = entries[z];
            var score = parseFloat(entries[z + 1]);
            if (!Number.isFinite(score)) score = 0;
            await pg.query(
              "INSERT INTO kv_zsets (key, member, score) VALUES ($1, $2, $3) " +
              "ON CONFLICT (key, member) DO UPDATE SET score = EXCLUDED.score",
              [key, String(member), score]
            );
            stats.zsets++;
          }
        } else if (type === "list") {
          var items = await upstash.lrange(key);
          for (var li = 0; li < items.length; li++) {
            await pg.query(
              "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, NULL) " +
              "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
              [key + ":" + li, String(items[li])]
            );
            stats.strings++;
          }
        } else {
          stats.unknown++;
          console.log("  unknown type: " + key + " -> " + type);
        }

        processed++;
        if (processed % 50 === 0) {
          console.log("  progress: " + processed + "/" + totalKeys);
        }
      } catch (e) {
        stats.errors++;
        console.error("  error on key " + key + ": " + (e.message || e));
      }
    }
  } while (cursor !== 0 && cursor !== "0");

  console.log("\n=== Sync Complete ===");
  console.log("  strings: " + stats.strings);
  console.log("  hashes:  " + stats.hashes + " fields");
  console.log("  sets:    " + stats.sets + " members");
  console.log("  zsets:   " + stats.zsets + " entries");
  console.log("  unknown: " + stats.unknown);
  console.log("  errors:  " + stats.errors);
  console.log("  total keys processed: " + processed);
}

syncToPostgres().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error("Fatal error:", e.message || e);
  process.exit(1);
});