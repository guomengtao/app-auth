var fs = require('fs');
var path = require('path');

try {
  require('dotenv').config();
  require('dotenv').config({ path: '.env.local', override: false });
} catch(e) {
  fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), 'dotenv error: ' + (e.message || e));
  process.exit(1);
}

var EvPgUrl = process.env.Ev_POSTGRES_URL;
var NeonPgUrl = process.env.POSTGRES_URL;

var log = [];
log.push('Ev_POSTGRES_URL: ' + (EvPgUrl ? 'SET' : 'NOT SET'));
log.push('POSTGRES_URL: ' + (NeonPgUrl ? 'SET' : 'NOT SET'));

if (!EvPgUrl || !NeonPgUrl) {
  log.push('ERROR: Missing required env vars');
  fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), log.join('\n'));
  process.exit(1);
}

var Pool = require('pg').Pool;

function getSupabasePg() {
  var url = EvPgUrl ||
    process.env.Ev_POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_POSTGRES_URL ||
    process.env.Ev_POSTGRES_PRISMA_URL;
  url = url.replace(/&supa=base-pooler\.x/, "").replace(/\?sslmode=require/, "?sslmode=verify-full");
  log.push('Supabase URL: ' + url.replace(/:[^:@]+@/, ':****@'));
  return new Pool({ connectionString: url, max: 5, ssl: { rejectUnauthorized: false } });
}

function getNeonPg() {
  var url = NeonPgUrl ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;
  log.push('Neon URL: ' + url.replace(/:[^:@]+@/, ':****@'));
  return new Pool({ connectionString: url, max: 5 });
}

async function createTables(supabasePg) {
  log.push('Creating tables in Supabase...');
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
  await supabasePg.query(sql);
  log.push('Tables created successfully.');
}

async function syncData(neonPg, supabasePg) {
  log.push('=== Syncing Neon -> Supabase ===');
  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };

  try {
    var stringsRes = await neonPg.query("SELECT key, value, expires_at FROM kv_strings");
    log.push('kv_strings: ' + stringsRes.rows.length + ' rows');
    for (var i = 0; i < stringsRes.rows.length; i++) {
      var r = stringsRes.rows[i];
      try {
        await supabasePg.query(
          "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
          [r.key, r.value, r.expires_at]
        );
        stats.strings++;
      } catch (e) {
        stats.errors++;
        log.push('  string error: ' + r.key + ' -> ' + e.message);
      }
    }
    log.push('  strings: ' + stats.strings + ' written');
  } catch (e) {
    log.push('  kv_strings query error: ' + e.message);
  }

  try {
    var hashesRes = await neonPg.query("SELECT key, field, value FROM kv_hashes");
    log.push('kv_hashes: ' + hashesRes.rows.length + ' rows');
    for (var h = 0; h < hashesRes.rows.length; h++) {
      var hr = hashesRes.rows[h];
      try {
        await supabasePg.query(
          "INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value",
          [hr.key, hr.field, hr.value]
        );
        stats.hashes++;
      } catch (e) {
        stats.errors++;
        log.push('  hash error: ' + hr.key + ':' + hr.field + ' -> ' + e.message);
      }
    }
    log.push('  hashes: ' + stats.hashes + ' written');
  } catch (e) {
    log.push('  kv_hashes query error: ' + e.message);
  }

  try {
    var setsRes = await neonPg.query("SELECT key, member FROM kv_sets");
    log.push('kv_sets: ' + setsRes.rows.length + ' rows');
    for (var s = 0; s < setsRes.rows.length; s++) {
      var sr = setsRes.rows[s];
      try {
        await supabasePg.query(
          "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [sr.key, sr.member]
        );
        stats.sets++;
      } catch (e) {
        stats.errors++;
        log.push('  set error: ' + sr.key + ':' + sr.member + ' -> ' + e.message);
      }
    }
    log.push('  sets: ' + stats.sets + ' written');
  } catch (e) {
    log.push('  kv_sets query error: ' + e.message);
  }

  try {
    var zsetsRes = await neonPg.query("SELECT key, member, score FROM kv_zsets");
    log.push('kv_zsets: ' + zsetsRes.rows.length + ' rows');
    for (var z = 0; z < zsetsRes.rows.length; z++) {
      var zr = zsetsRes.rows[z];
      try {
        await supabasePg.query(
          "INSERT INTO kv_zsets (key, member, score) VALUES ($1, $2, $3) " +
          "ON CONFLICT (key, member) DO UPDATE SET score = EXCLUDED.score",
          [zr.key, zr.member, zr.score]
        );
        stats.zsets++;
      } catch (e) {
        stats.errors++;
        log.push('  zset error: ' + zr.key + ':' + zr.member + ' -> ' + e.message);
      }
    }
    log.push('  zsets: ' + stats.zsets + ' written');
  } catch (e) {
    log.push('  kv_zsets query error: ' + e.message);
  }

  log.push('=== Sync Complete ===');
  log.push('  strings: ' + stats.strings);
  log.push('  hashes:  ' + stats.hashes);
  log.push('  sets:    ' + stats.sets);
  log.push('  zsets:   ' + stats.zsets);
  log.push('  errors:  ' + stats.errors);
}

async function main() {
  var supabasePg = getSupabasePg();
  var neonPg = getNeonPg();

  await createTables(supabasePg);
  await syncData(neonPg, supabasePg);

  await supabasePg.end();
  await neonPg.end();

  log.push('DONE');
  fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), log.join('\n'));
  console.log(log.join('\n'));
}

main().catch(function(e) {
  log.push('Fatal: ' + (e.message || e));
  if (e.stack) log.push(e.stack);
  fs.writeFileSync(path.join(__dirname, '_sync_log.txt'), log.join('\n'));
  console.error(log.join('\n'));
  process.exit(1);
});