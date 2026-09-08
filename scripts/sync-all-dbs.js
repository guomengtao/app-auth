var fs = require('fs');
var path = require('path');

function loadEnvFile(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var lines = content.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      var eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      var key = line.substring(0, eqIdx).trim();
      var value = line.substring(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {}
}

loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(__dirname, '..', '.env.local'));

var Pool = require('pg').Pool;

var LOG = [];

function log(msg) {
  LOG.push(msg);
  console.log(msg);
}

function getUpstashClient() {
  var upstashUrl = process.env.KV_REST_API_URL;
  var upstashToken = process.env.KV_REST_API_TOKEN;

  if (!upstashUrl || !upstashToken) {
    log('Upstash: NOT CONFIGURED');
    return null;
  }

  var baseUrl = upstashUrl.replace(/\/$/, '');

  return {
    dbsize: async function() {
      var res = await fetch(baseUrl + '/dbsize', {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
    scan: async function(cursor) {
      var res = await fetch(baseUrl + '/scan/' + (cursor || 0), {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
    get: async function(key) {
      var res = await fetch(baseUrl + '/get/' + encodeURIComponent(key), {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
    type: async function(key) {
      var res = await fetch(baseUrl + '/type/' + encodeURIComponent(key), {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
    smembers: async function(key) {
      var res = await fetch(baseUrl + '/smembers/' + encodeURIComponent(key), {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result || [];
    },
    hgetall: async function(key) {
      var res = await fetch(baseUrl + '/hgetall/' + encodeURIComponent(key), {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result || [];
    },
    zrange: async function(key) {
      var res = await fetch(baseUrl + '/zrange/' + encodeURIComponent(key) + '/0/-1/WITHSCORES', {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result || [];
    },
    lrange: async function(key) {
      var res = await fetch(baseUrl + '/lrange/' + encodeURIComponent(key) + '/0/-1', {
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result || [];
    },
    set: async function(key, value) {
      var res = await fetch(baseUrl + '/set/' + encodeURIComponent(key), {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + upstashToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([value]),
      });
      var data = await res.json();
      if (data.error) throw new Error('Upstash error: ' + data.error);
      return data.result;
    },
    sadd: async function(key, member) {
      var res = await fetch(baseUrl + '/sadd/' + encodeURIComponent(key) + '/' + encodeURIComponent(member), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error('Upstash error: ' + data.error);
      return data.result;
    },
    hset: async function(key, field, value) {
      var res = await fetch(baseUrl + '/hset/' + encodeURIComponent(key) + '/' + encodeURIComponent(field), {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + upstashToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([value]),
      });
      var data = await res.json();
      if (data.error) throw new Error('Upstash error: ' + data.error);
      return data.result;
    },
    zadd: async function(key, score, member) {
      var res = await fetch(baseUrl + '/zadd/' + encodeURIComponent(key) + '/' + score + '/' + encodeURIComponent(member), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      if (data.error) throw new Error('Upstash error: ' + data.error);
      return data.result;
    },
    flushdb: async function() {
      var res = await fetch(baseUrl + '/flushdb', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + upstashToken },
      });
      var data = await res.json();
      return data.result;
    },
  };
}

function getPgPool(envUrlKey, label) {
  var url = process.env[envUrlKey];
  if (!url) {
    log(label + ': NOT CONFIGURED (missing ' + envUrlKey + ')');
    return null;
  }
  try {
    var fixedUrl = url.replace(/sslmode=require/g, 'sslmode=no-verify');
    var pool = new Pool({
      connectionString: fixedUrl,
      max: 5,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
    log(label + ': connected (' + fixedUrl.replace(/:[^:@]+@/, ':****@') + ')');
    return pool;
  } catch (e) {
    log(label + ': connection error - ' + e.message);
    return null;
  }
}

async function diagnosePg(pool, label) {
  if (!pool) return { label: label, ok: false, strings: 0, sets: 0, hashes: 0, zsets: 0, error: 'not connected' };

  try {
    var stringsRes = await pool.query("SELECT COUNT(*) as cnt FROM kv_strings WHERE expires_at IS NULL OR expires_at >= NOW()");
    var setsRes = await pool.query("SELECT COUNT(*) as cnt FROM kv_sets");
    var hashesRes = await pool.query("SELECT COUNT(*) as cnt FROM kv_hashes");
    var zsetsRes = await pool.query("SELECT COUNT(*) as cnt FROM kv_zsets");

    var activationCodes = await pool.query("SELECT COUNT(*) as cnt FROM kv_sets WHERE key = 'auth:activation_codes'");
    var redeemCodes = await pool.query("SELECT COUNT(*) as cnt FROM kv_sets WHERE key = 'auth:redeem_codes'");
    var activationRecords = await pool.query("SELECT COUNT(*) as cnt FROM kv_strings WHERE key LIKE 'auth:activation:%'");
    var redeemRecords = await pool.query("SELECT COUNT(*) as cnt FROM kv_strings WHERE key LIKE 'auth:redeem:%'");

    var result = {
      label: label,
      ok: true,
      strings: parseInt(stringsRes.rows[0].cnt) || 0,
      sets: parseInt(setsRes.rows[0].cnt) || 0,
      hashes: parseInt(hashesRes.rows[0].cnt) || 0,
      zsets: parseInt(zsetsRes.rows[0].cnt) || 0,
      activationCodes: parseInt(activationCodes.rows[0].cnt) || 0,
      redeemCodes: parseInt(redeemCodes.rows[0].cnt) || 0,
      activationRecords: parseInt(activationRecords.rows[0].cnt) || 0,
      redeemRecords: parseInt(redeemRecords.rows[0].cnt) || 0,
    };

    log(label + ': strings=' + result.strings + ' sets=' + result.sets + ' hashes=' + result.hashes + ' zsets=' + result.zsets);
    log('  auth:activation_codes: ' + result.activationCodes + ' members');
    log('  auth:redeem_codes: ' + result.redeemCodes + ' members');
    log('  auth:activation:* records: ' + result.activationRecords);
    log('  auth:redeem:* records: ' + result.redeemRecords);

    return result;
  } catch (e) {
    log(label + ': query error - ' + e.message);
    return { label: label, ok: false, strings: 0, sets: 0, hashes: 0, zsets: 0, error: e.message };
  }
}

async function diagnoseUpstash(upstash) {
  if (!upstash) return { label: 'Upstash', ok: false, keys: 0, error: 'not configured' };

  try {
    var totalKeys = await upstash.dbsize();
    log('Upstash: total keys=' + totalKeys);

    var activationCodes = [];
    try { activationCodes = await upstash.smembers('auth:activation_codes'); } catch (_) {}
    var redeemCodes = [];
    try { redeemCodes = await upstash.smembers('auth:redeem_codes'); } catch (_) {}

    log('  auth:activation_codes: ' + activationCodes.length + ' members');
    log('  auth:redeem_codes: ' + redeemCodes.length + ' members');

    return {
      label: 'Upstash',
      ok: true,
      keys: totalKeys,
      activationCodes: activationCodes.length,
      redeemCodes: redeemCodes.length,
    };
  } catch (e) {
    log('Upstash: error - ' + e.message);
    return { label: 'Upstash', ok: false, keys: 0, error: e.message };
  }
}

async function syncUpstashToPg(upstash, pg, label) {
  log('\n=== Syncing Upstash -> ' + label + ' ===');

  var totalKeys = await upstash.dbsize();
  log('Upstash keys: ' + totalKeys);

  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };
  var processed = 0;
  var cursor = 0;
  var round = 0;

  do {
    round++;
    var scanResult = await upstash.scan(cursor);
    cursor = scanResult[0];
    var keys = scanResult[1] || [];

    log('Scan round ' + round + ': ' + keys.length + ' keys (cursor=' + cursor + ')');

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      try {
        var type = await upstash.type(key);

        if (type === 'string') {
          var value = await upstash.get(key);
          if (value !== null && value !== undefined) {
            await pg.query(
              "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, NULL) " +
              "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
              [key, String(value)]
            );
            stats.strings++;
          }
        } else if (type === 'hash') {
          var fields = await upstash.hgetall(key);
          if (fields && fields.length > 0) {
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
          }
        } else if (type === 'set') {
          var members = await upstash.smembers(key);
          for (var m = 0; m < members.length; m++) {
            await pg.query(
              "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [key, String(members[m])]
            );
            stats.sets++;
          }
        } else if (type === 'zset') {
          var entries = await upstash.zrange(key);
          if (entries && entries.length > 0) {
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
          }
        } else if (type === 'list') {
          var items = await upstash.lrange(key);
          if (items && items.length > 0) {
            for (var li = 0; li < items.length; li++) {
              await pg.query(
                "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, NULL) " +
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                [key + ':' + li, String(items[li])]
              );
              stats.strings++;
            }
          }
        }

        processed++;
        if (processed % 100 === 0) {
          log('  progress: ' + processed + '/' + totalKeys);
        }
      } catch (e) {
        stats.errors++;
        log('  error on key ' + key + ': ' + (e.message || e));
      }
    }
  } while (cursor !== 0 && cursor !== '0');

  log('Upstash -> ' + label + ' complete: strings=' + stats.strings + ' hashes=' + stats.hashes + ' sets=' + stats.sets + ' zsets=' + stats.zsets + ' errors=' + stats.errors);
  return stats;
}

async function syncPgToPg(sourcePool, sourceLabel, targetPool, targetLabel) {
  log('\n=== Syncing ' + sourceLabel + ' -> ' + targetLabel + ' ===');

  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };

  try {
    var stringsRes = await sourcePool.query("SELECT key, value, expires_at FROM kv_strings WHERE expires_at IS NULL OR expires_at >= NOW()");
    log('kv_strings: ' + stringsRes.rows.length + ' rows');
    for (var i = 0; i < stringsRes.rows.length; i++) {
      var r = stringsRes.rows[i];
      try {
        await targetPool.query(
          "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
          [r.key, r.value, r.expires_at]
        );
        stats.strings++;
      } catch (e) {
        stats.errors++;
        log('  string error: ' + r.key + ' -> ' + e.message);
      }
    }
    log('  strings: ' + stats.strings + ' written');
  } catch (e) {
    log('  kv_strings query error: ' + e.message);
  }

  try {
    var hashesRes = await sourcePool.query("SELECT key, field, value FROM kv_hashes");
    log('kv_hashes: ' + hashesRes.rows.length + ' rows');
    for (var h = 0; h < hashesRes.rows.length; h++) {
      var hr = hashesRes.rows[h];
      try {
        await targetPool.query(
          "INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value",
          [hr.key, hr.field, hr.value]
        );
        stats.hashes++;
      } catch (e) {
        stats.errors++;
        log('  hash error: ' + hr.key + ':' + hr.field + ' -> ' + e.message);
      }
    }
    log('  hashes: ' + stats.hashes + ' written');
  } catch (e) {
    log('  kv_hashes query error: ' + e.message);
  }

  try {
    var setsRes = await sourcePool.query("SELECT key, member FROM kv_sets");
    log('kv_sets: ' + setsRes.rows.length + ' rows');
    for (var s = 0; s < setsRes.rows.length; s++) {
      var sr = setsRes.rows[s];
      try {
        await targetPool.query(
          "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [sr.key, sr.member]
        );
        stats.sets++;
      } catch (e) {
        stats.errors++;
        log('  set error: ' + sr.key + ':' + sr.member + ' -> ' + e.message);
      }
    }
    log('  sets: ' + stats.sets + ' written');
  } catch (e) {
    log('  kv_sets query error: ' + e.message);
  }

  try {
    var zsetsRes = await sourcePool.query("SELECT key, member, score FROM kv_zsets");
    log('kv_zsets: ' + zsetsRes.rows.length + ' rows');
    for (var z = 0; z < zsetsRes.rows.length; z++) {
      var zr = zsetsRes.rows[z];
      try {
        await targetPool.query(
          "INSERT INTO kv_zsets (key, member, score) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key, member) DO UPDATE SET score = EXCLUDED.score",
          [zr.key, zr.member, zr.score]
        );
        stats.zsets++;
      } catch (e) {
        stats.errors++;
        log('  zset error: ' + zr.key + ':' + zr.member + ' -> ' + e.message);
      }
    }
    log('  zsets: ' + stats.zsets + ' written');
  } catch (e) {
    log('  kv_zsets query error: ' + e.message);
  }

  log(sourceLabel + ' -> ' + targetLabel + ' complete: strings=' + stats.strings + ' hashes=' + stats.hashes + ' sets=' + stats.sets + ' zsets=' + stats.zsets + ' errors=' + stats.errors);
  return stats;
}

async function syncPgToUpstash(pool, label, upstash) {
  log('\n=== Syncing ' + label + ' -> Upstash ===');

  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };

  try {
    var stringsRes = await pool.query("SELECT key, value FROM kv_strings WHERE expires_at IS NULL OR expires_at >= NOW()");
    log('kv_strings: ' + stringsRes.rows.length + ' rows');
    for (var i = 0; i < stringsRes.rows.length; i++) {
      var r = stringsRes.rows[i];
      try {
        await upstash.set(r.key, r.value);
        stats.strings++;
      } catch (e) {
        stats.errors++;
        log('  string error: ' + r.key + ' -> ' + e.message);
      }
      if (i % 100 === 0) log('  strings progress: ' + i + '/' + stringsRes.rows.length);
    }
    log('  strings: ' + stats.strings + ' written');
  } catch (e) {
    log('  kv_strings query error: ' + e.message);
  }

  try {
    var hashesRes = await pool.query("SELECT key, field, value FROM kv_hashes");
    log('kv_hashes: ' + hashesRes.rows.length + ' rows');
    for (var h = 0; h < hashesRes.rows.length; h++) {
      var hr = hashesRes.rows[h];
      try {
        await upstash.hset(hr.key, hr.field, hr.value);
        stats.hashes++;
      } catch (e) {
        stats.errors++;
        log('  hash error: ' + hr.key + ':' + hr.field + ' -> ' + e.message);
      }
      if (h % 100 === 0) log('  hashes progress: ' + h + '/' + hashesRes.rows.length);
    }
    log('  hashes: ' + stats.hashes + ' written');
  } catch (e) {
    log('  kv_hashes query error: ' + e.message);
  }

  try {
    var setsRes = await pool.query("SELECT key, member FROM kv_sets");
    log('kv_sets: ' + setsRes.rows.length + ' rows');
    for (var s = 0; s < setsRes.rows.length; s++) {
      var sr = setsRes.rows[s];
      try {
        await upstash.sadd(sr.key, sr.member);
        stats.sets++;
      } catch (e) {
        stats.errors++;
        log('  set error: ' + sr.key + ':' + sr.member + ' -> ' + e.message);
      }
      if (s % 100 === 0) log('  sets progress: ' + s + '/' + setsRes.rows.length);
    }
    log('  sets: ' + stats.sets + ' written');
  } catch (e) {
    log('  kv_sets query error: ' + e.message);
  }

  try {
    var zsetsRes = await pool.query("SELECT key, member, score FROM kv_zsets");
    log('kv_zsets: ' + zsetsRes.rows.length + ' rows');
    for (var z = 0; z < zsetsRes.rows.length; z++) {
      var zr = zsetsRes.rows[z];
      try {
        await upstash.zadd(zr.key, zr.score, zr.member);
        stats.zsets++;
      } catch (e) {
        stats.errors++;
        log('  zset error: ' + zr.key + ':' + zr.member + ' -> ' + e.message);
      }
      if (z % 100 === 0) log('  zsets progress: ' + z + '/' + zsetsRes.rows.length);
    }
    log('  zsets: ' + stats.zsets + ' written');
  } catch (e) {
    log('  kv_zsets query error: ' + e.message);
  }

  log(label + ' -> Upstash complete: strings=' + stats.strings + ' hashes=' + stats.hashes + ' sets=' + stats.sets + ' zsets=' + stats.zsets + ' errors=' + stats.errors);
  return stats;
}

async function ensureTables(pool, label) {
  log('Ensuring tables exist in ' + label + '...');
  var sql = `
    CREATE TABLE IF NOT EXISTS kv_strings (
      key TEXT PRIMARY KEY,
      value TEXT,
      expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS kv_hashes (
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (key, field)
    );
    CREATE TABLE IF NOT EXISTS kv_sets (
      key TEXT NOT NULL,
      member TEXT NOT NULL,
      PRIMARY KEY (key, member)
    );
    CREATE TABLE IF NOT EXISTS kv_zsets (
      key TEXT NOT NULL,
      member TEXT NOT NULL,
      score DOUBLE PRECISION DEFAULT 0,
      PRIMARY KEY (key, member)
    );
  `;
  await pool.query(sql);
  log('Tables ready in ' + label);
}

async function main() {
  log('=== Three-Database Sync Tool ===');
  log('Time: ' + new Date().toISOString());
  log('');

  var upstash = getUpstashClient();
  var supabasePool = getPgPool('Ev_POSTGRES_URL', 'Supabase');
  var neonPool = getPgPool('POSTGRES_URL', 'Neon');

  log('\n--- Step 1: Diagnose all databases ---\n');

  var upstashDiag = await diagnoseUpstash(upstash);
  var supabaseDiag = await diagnosePg(supabasePool, 'Supabase');
  var neonDiag = await diagnosePg(neonPool, 'Neon');

  log('\n--- Step 2: Determine data source ---\n');

  var upstashHasData = upstashDiag.ok && upstashDiag.keys > 0;
  var supabaseHasData = supabaseDiag.ok && (supabaseDiag.strings > 0 || supabaseDiag.sets > 0);
  var neonHasData = neonDiag.ok && (neonDiag.strings > 0 || neonDiag.sets > 0);

  log('Upstash has data: ' + upstashHasData + ' (' + (upstashDiag.keys || 0) + ' keys)');
  log('Supabase has data: ' + supabaseHasData + ' (strings=' + supabaseDiag.strings + ' sets=' + supabaseDiag.sets + ')');
  log('Neon has data: ' + neonHasData + ' (strings=' + neonDiag.strings + ' sets=' + neonDiag.sets + ')');

  if (!upstashHasData && !supabaseHasData && !neonHasData) {
    log('\n*** ALL DATABASES ARE EMPTY. No data to sync. ***');
    log('You may need to restore from a backup or re-activate devices.');
    fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), LOG.join('\n'));
    return;
  }

  if (upstashHasData) {
    if (supabasePool) {
      await ensureTables(supabasePool, 'Supabase');
      await syncUpstashToPg(upstash, supabasePool, 'Supabase');
    }
    if (neonPool) {
      await ensureTables(neonPool, 'Neon');
      await syncUpstashToPg(upstash, neonPool, 'Neon');
    }
  } else {
    var sourcePool = null;
    var sourceLabel = '';

    if (supabaseHasData) {
      sourcePool = supabasePool;
      sourceLabel = 'Supabase';
    } else if (neonHasData) {
      sourcePool = neonPool;
      sourceLabel = 'Neon';
    }

    if (sourcePool) {
      if (upstash) {
        await syncPgToUpstash(sourcePool, sourceLabel, upstash);
      }

      if (supabasePool && sourceLabel !== 'Supabase') {
        await ensureTables(supabasePool, 'Supabase');
        await syncPgToPg(sourcePool, sourceLabel, supabasePool, 'Supabase');
      }

      if (neonPool && sourceLabel !== 'Neon') {
        await ensureTables(neonPool, 'Neon');
        await syncPgToPg(sourcePool, sourceLabel, neonPool, 'Neon');
      }
    }
  }

  log('\n--- Step 3: Final verification ---\n');
  await diagnoseUpstash(upstash);
  if (supabasePool) await diagnosePg(supabasePool, 'Supabase');
  if (neonPool) await diagnosePg(neonPool, 'Neon');

  log('\n=== All syncs complete ===');

  if (supabasePool) await supabasePool.end();
  if (neonPool) await neonPool.end();

  fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), LOG.join('\n'));
}

main().then(function() {
  console.log('Done.');
  process.exit(0);
}).catch(function(e) {
  console.error('Fatal error:', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});