var fs = require('fs');
var path = require('path');

function loadEnv(filePath) {
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

loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '..', '.env.local'));

var Pool = require('pg').Pool;

var supabaseUrl = process.env.Ev_POSTGRES_URL || '';
var neonUrl = process.env.POSTGRES_URL || '';

var src = new Pool({ connectionString: supabaseUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 3, ssl: { rejectUnauthorized: false } });
var tgt = new Pool({ connectionString: neonUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 3, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== Full cleanup (source=Supabase, target=Neon) ===\n');

  // Show before
  for (var tbl of ['kv_strings','kv_hashes','kv_sets','kv_zsets']) {
    var sr = await src.query('SELECT COUNT(*) AS c FROM ' + tbl);
    var tr = await tgt.query('SELECT COUNT(*) AS c FROM ' + tbl);
    console.log('Before: ' + tbl + ': src=' + sr.rows[0].c + ' tgt=' + tr.rows[0].c);
  }

  var total = 0;

  // 1. kv_strings orphans
  console.log('\n--- kv_strings orphan cleanup ---');
  var srcKeys = await src.query('SELECT key FROM kv_strings');
  var tgtKeys = await tgt.query('SELECT key FROM kv_strings');
  var srcSet = new Set();
  for (var r of srcKeys.rows) srcSet.add(r.key);
  for (var r of tgtKeys.rows) {
    if (!srcSet.has(r.key)) {
      await tgt.query('DELETE FROM kv_strings WHERE key = $1', [r.key]);
      console.log('  DELETED: ' + r.key);
      total++;
    }
  }

  // 2. kv_hashes, kv_sets, kv_zsets orphans
  var tables = [
    { name: 'kv_sets', k: 'key', m: 'member' },
    { name: 'kv_zsets', k: 'key', m: 'member' },
    { name: 'kv_hashes', k: 'key', m: 'field' },
  ];
  for (var ot of tables) {
    console.log('\n--- ' + ot.name + ' orphan cleanup ---');
    var sr = await src.query('SELECT ' + ot.k + ', ' + ot.m + ' FROM ' + ot.name);
    var tr = await tgt.query('SELECT ' + ot.k + ', ' + ot.m + ' FROM ' + ot.name);
    var s = new Set();
    for (var r of sr.rows) s.add(String(r[ot.k]) + '||' + String(r[ot.m]));
    for (var r of tr.rows) {
      if (!s.has(String(r[ot.k]) + '||' + String(r[ot.m]))) {
        await tgt.query('DELETE FROM ' + ot.name + ' WHERE ' + ot.k + '=$1 AND ' + ot.m + '=$2', [r[ot.k], r[ot.m]]);
        console.log('  DELETED: ' + ot.name + ' ' + r[ot.k] + ' / ' + r[ot.m]);
        total++;
      }
    }
  }

  console.log('\nTotal cleaned: ' + total);

  // Show after
  console.log('\n=== After cleanup ===');
  for (var tbl of ['kv_strings','kv_hashes','kv_sets','kv_zsets']) {
    var sr = await src.query('SELECT COUNT(*) AS c FROM ' + tbl);
    var tr = await tgt.query('SELECT COUNT(*) AS c FROM ' + tbl);
    console.log(tbl + ': src=' + sr.rows[0].c + ' tgt=' + tr.rows[0].c);
  }

  // Verify fingerprint
  var fpQuery = "SELECT MD5(string_agg(src, '' ORDER BY src)) AS fp FROM (" +
    "SELECT key || ':' || COALESCE(value,'') AS src FROM kv_strings WHERE key NOT LIKE 'auth:db:%' AND key NOT LIKE 'auth:cron:%' " +
    "UNION ALL SELECT key || ':' || field || ':' || COALESCE(value,'') FROM kv_hashes " +
    "UNION ALL SELECT key || ':' || member FROM kv_sets " +
    "UNION ALL SELECT key || ':' || member || ':' || score FROM kv_zsets" +
    ") AS all_src";

  var sfp = await src.query(fpQuery);
  var nfp = await tgt.query(fpQuery);
  console.log('\nFingerprint:');
  console.log('  Supabase: ' + sfp.rows[0].fp);
  console.log('  Neon:     ' + nfp.rows[0].fp);
  console.log('  Match: ' + (sfp.rows[0].fp === nfp.rows[0].fp ? 'YES' : 'NO'));

  await src.end();
  await tgt.end();
  console.log('Done.');
}

main().catch(function(e) { console.error('Error:', e); process.exit(1); });