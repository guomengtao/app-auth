var pg = require("../lib/postgres");

function getUpstashClient() {
  var upstashUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var upstashToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN environment variables");
    console.error("Get them from: https://console.upstash.com/redis");
    process.exit(1);
  }

  var baseUrl = upstashUrl.replace(/\/$/, "");

  async function upstashRequest(path, options) {
    var url = baseUrl + path;
    var fetchOptions = {
      method: (options && options.method) || "GET",
      headers: {
        "Authorization": "Bearer " + upstashToken,
        "Content-Type": "application/json",
      },
    };
    if (options && options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }
    var res = await fetch(url, fetchOptions);
    var data = await res.json();
    if (data.error) {
      throw new Error("Upstash error: " + data.error);
    }
    return data.result;
  }

  return {
    set: async function(key, value) {
      return await upstashRequest("/set/" + encodeURIComponent(key), {
        method: "POST",
        body: [value],
      });
    },
    sadd: async function(key, member) {
      return await upstashRequest("/sadd/" + encodeURIComponent(key) + "/" + encodeURIComponent(member), {
        method: "POST",
      });
    },
    hset: async function(key, field, value) {
      return await upstashRequest("/hset/" + encodeURIComponent(key) + "/" + encodeURIComponent(field), {
        method: "POST",
        body: [value],
      });
    },
    del: async function(key) {
      return await upstashRequest("/del/" + encodeURIComponent(key), {
        method: "POST",
      });
    },
    flushdb: async function() {
      return await upstashRequest("/flushdb", { method: "POST" });
    },
    zadd: async function(key, score, member) {
      return await upstashRequest("/zadd/" + encodeURIComponent(key) + "/" + score + "/" + encodeURIComponent(member), {
        method: "POST",
      });
    },
    dbsize: async function() {
      return await upstashRequest("/dbsize");
    },
    pipeline: function() {
      var commands = [];
      var self = this;
      return {
        set: function(key, value) {
          commands.push({ op: "set", args: [key, value] });
          return this;
        },
        sadd: function(key, member) {
          commands.push({ op: "sadd", args: [key, member] });
          return this;
        },
        hset: function(key, field, value) {
          commands.push({ op: "hset", args: [key, field, value] });
          return this;
        },
        exec: async function() {
          var pipelineBody = commands.map(function(c) {
            return [c.op, c.args[0], c.args[1], c.args[2]].filter(function(x) { return x !== undefined; });
          });
          return await upstashRequest("/pipeline", {
            method: "POST",
            body: pipelineBody,
          });
        },
      };
    },
  };
}

function chunkArray(arr, size) {
  var chunks = [];
  for (var i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function readAllFromPostgres() {
  console.log("Reading data from Postgres...\n");

  var kvStrings = await pg.query("SELECT key, value FROM kv_strings WHERE expires_at IS NULL OR expires_at >= NOW() ORDER BY key");
  console.log("  kv_strings: " + (kvStrings.rows ? kvStrings.rows.length : 0) + " rows");

  var kvHashes = await pg.query("SELECT key, field, value FROM kv_hashes ORDER BY key, field");
  console.log("  kv_hashes:  " + (kvHashes.rows ? kvHashes.rows.length : 0) + " rows");

  var kvSets = await pg.query("SELECT key, member FROM kv_sets ORDER BY key, member");
  console.log("  kv_sets:    " + (kvSets.rows ? kvSets.rows.length : 0) + " rows");

  var kvZsets = await pg.query("SELECT key, member, score FROM kv_zsets ORDER BY key, score");
  console.log("  kv_zsets:   " + (kvZsets.rows ? kvZsets.rows.length : 0) + " rows");

  return {
    strings: kvStrings.rows || [],
    hashes: kvHashes.rows || [],
    sets: kvSets.rows || [],
    zsets: kvZsets.rows || [],
  };
}

async function backupToUpstash() {
  var data = await readAllFromPostgres();

  var totalRows = data.strings.length + data.hashes.length + data.sets.length + data.zsets.length;
  if (totalRows === 0) {
    console.log("\nNo data to backup. Exiting.");
    return;
  }

  console.log("\nTotal rows to backup: " + totalRows);

  var upstash = getUpstashClient();

  var currentSize = await upstash.dbsize().catch(function() { return -1; });
  console.log("Upstash current keys: " + currentSize);

  var processed = 0;
  var errors = 0;

  console.log("\n--- Writing kv_strings ---");
  var stringChunks = chunkArray(data.strings, 100);
  for (var sc = 0; sc < stringChunks.length; sc++) {
    var chunk = stringChunks[sc];
    var pip = upstash.pipeline();
    for (var i = 0; i < chunk.length; i++) {
      pip.set(chunk[i].key, chunk[i].value);
    }
    try {
      await pip.exec();
      processed += chunk.length;
      console.log("  strings: " + processed + "/" + data.strings.length);
    } catch (e) {
      errors += chunk.length;
      console.error("  strings ERROR: " + e.message);
    }
  }

  console.log("\n--- Writing kv_hashes ---");
  var hashChunks = chunkArray(data.hashes, 100);
  var hashProcessed = 0;
  for (var hc = 0; hc < hashChunks.length; hc++) {
    var chunk = hashChunks[hc];
    var pip = upstash.pipeline();
    for (var i = 0; i < chunk.length; i++) {
      pip.hset(chunk[i].key, chunk[i].field, chunk[i].value);
    }
    try {
      await pip.exec();
      hashProcessed += chunk.length;
      processed += chunk.length;
      console.log("  hashes: " + hashProcessed + "/" + data.hashes.length);
    } catch (e) {
      errors += chunk.length;
      console.error("  hashes ERROR: " + e.message);
    }
  }

  console.log("\n--- Writing kv_sets ---");
  var setChunks = chunkArray(data.sets, 100);
  var setProcessed = 0;
  for (var sc2 = 0; sc2 < setChunks.length; sc2++) {
    var chunk = setChunks[sc2];
    var pip = upstash.pipeline();
    for (var i = 0; i < chunk.length; i++) {
      pip.sadd(chunk[i].key, chunk[i].member);
    }
    try {
      await pip.exec();
      setProcessed += chunk.length;
      processed += chunk.length;
      console.log("  sets: " + setProcessed + "/" + data.sets.length);
    } catch (e) {
      errors += chunk.length;
      console.error("  sets ERROR: " + e.message);
    }
  }

  console.log("\n--- Writing kv_zsets ---");
  for (var z = 0; z < data.zsets.length; z++) {
    var zrow = data.zsets[z];
    try {
      await upstash.zadd(zrow.key, zrow.score, zrow.member);
      processed++;
    } catch (e) {
      errors++;
      console.error("  zset ERROR: " + e.message);
    }
  }
  console.log("  zsets: " + data.zsets.length + "/" + data.zsets.length);

  var finalSize = await upstash.dbsize().catch(function() { return -1; });
  console.log("\n=== Backup Complete ===");
  console.log("  Rows written: " + processed);
  console.log("  Errors: " + errors);
  console.log("  Upstash keys after backup: " + finalSize);
}

backupToUpstash().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error("Fatal error:", e.message || e);
  process.exit(1);
});