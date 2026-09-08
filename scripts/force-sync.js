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

var src = new Pool({ connectionString: supabaseUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 5, ssl: { rejectUnauthorized: false } });
var tgt = new Pool({ connectionString: neonUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 5, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== Force Sync: Supabase -> Neon ===\n');

  // Step 1: Clear all tables in Neon
  console.log('Step 1: Clearing all tables in Neon...');
  await tgt.query('DELETE FROM kv_strings');
  await tgt.query('DELETE FROM kv_hashes');
  await tgt.query('DELETE FROM kv_sets');
  await tgt.query('DELETE FROM kv_zsets');
  console.log('  All tables cleared.\n');

  // Step 2: Copy all data from Supabase to Neon
  console.log('Step 2: Copying data from Supabase to Neon...');

  // kv_strings
  var strRows = await src.query('SELECT key, value, expires_at FROM kv_strings');
  console.log('  kv_strings: ' + strRows.rows.length + ' rows');
  for (var i = 0; i < strRows.rows.length; i++) {
    var r = strRows.rows[i];
    await tgt.query(
      'INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, $3)',
      [r.key, r.value, r.expires_at]
    );
  }
  console.log('  kv_strings: done');

  // kv_hashes
  var hashRows = await src.query('SELECT key, field, value FROM kv_hashes');
  console.log('  kv_hashes: ' + hashRows.rows.length + ' rows');
  for (var j = 0; j < hashRows.rows.length; j++) {
    var h = hashRows.rows[j];
    await tgt.query(
      'INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3)',
      [h.key, h.field, h.value]
    );
  }
  console.log('  kv_hashes: done');

  // kv_sets
  var setRows = await src.query('SELECT key, member FROM kv_sets');
  console.log('  kv_sets: ' + setRows.rows.length + ' rows');
  for (var k = 0; k < setRows.rows.length; k++) {
    var s = setRows.rows[k];
    await tgt.query(
      'INSERT INTO kv_sets (key, member) VALUES ($1, $2)',
      [s.key, s.member]
    );
  }
  console.log('  kv_sets: done');

  // kv_zsets
  var zsetRows = await src.query('SELECT key, member, score FROM kv_zsets');
  console.log('  kv_zsets: ' + zsetRows.rows.length + ' rows');
  for (var z = 0; z < zsetRows.rows.length; z++) {
    var zr = zsetRows.rows[z];
    await tgt.query(
      'INSERT INTO kv_zsets (key, member, score) VALUES ($1, $2, $3)',
      [zr.key, zr.member, zr.score]
    );
  }
  console.log('  kv_zsets: done\n');

  // Step 3: Verify counts
  console.log('Step 3: Verifying counts...');
  var sc = await src.query('SELECT (SELECT COUNT(*) FROM kv_strings) AS s, (SELECT COUNT(*) FROM kv_hashes) AS h, (SELECT COUNT(*) FROM kv_sets) AS ss, (SELECT COUNT(*) FROM kv_zsets) AS zs');
  var tc = await tgt.query('SELECT (SELECT COUNT(*) FROM kv_strings) AS s, (SELECT COUNT(*) FROM kv_hashes) AS h, (SELECT COUNT(*) FROM kv_sets) AS ss, (SELECT COUNT(*) FROM kv_zsets) AS zs');
  console.log('  Supabase: strings=' + sc.rows[0].s + ' hashes=' + sc.rows[0].h + ' sets=' + sc.rows[0].ss + ' zsets=' + sc.rows[0].zs);
  console.log('  Neon:     strings=' + tc.rows[0].s + ' hashes=' + tc.rows[0].h + ' sets=' + tc.rows[0].ss + ' zsets=' + tc.rows[0].zs);

  // Step 4: Verify fingerprints
  console.log('\nStep 4: Verifying fingerprints...');
  var fpQuery = "SELECT MD5(string_agg(src, '' ORDER BY src COLLATE \"C\")) AS fp FROM (" +
    "SELECT key || ':' || COALESCE(value,'') AS src FROM kv_strings WHERE key NOT LIKE 'auth:db:%' AND key NOT LIKE 'auth:cron:%' " +
    "UNION ALL SELECT key || ':' || field || ':' || COALESCE(value,'') FROM kv_hashes " +
    "UNION ALL SELECT key || ':' || member FROM kv_sets " +
    "UNION ALL SELECT key || ':' || member || ':' || score FROM kv_zsets" +
    ") AS all_src";

  var sfp = await src.query(fpQuery);
  var nfp = await tgt.query(fpQuery);
  var match = sfp.rows[0].fp === nfp.rows[0].fp;
  console.log('  Supabase: ' + sfp.rows[0].fp);
  console.log('  Neon:     ' + nfp.rows[0].fp);
  console.log('  Match: ' + (match ? 'YES' : 'NO'));

  if (!match) {
    // Find the diff
    console.log('\n  Finding differences...');
    var queries = [
      { name: 'kv_strings', sql: "SELECT key || ':' || COALESCE(value,'') AS src FROM kv_strings WHERE key NOT LIKE 'auth:db:%' AND key NOT LIKE 'auth:cron:%'" },
      { name: 'kv_hashes', sql: "SELECT key || ':' || field || ':' || COALESCE(value,'') AS src FROM kv_hashes" },
      { name: 'kv_sets', sql: "SELECT key || ':' || member AS src FROM kv_sets" },
      { name: 'kv_zsets', sql: "SELECT key || ':' || member || ':' || score AS src FROM kv_zsets" },
    ];
    for (var q of queries) {
      var ss = await src.query(q.sql + ' ORDER BY src');
      var ns = await tgt.query(q.sql + ' ORDER BY src');
      for (var i = 0; i < Math.max(ss.rows.length, ns.rows.length); i++) {
        var sv = i < ss.rows.length ? ss.rows[i].src : 'MISSING';
        var nv = i < ns.rows.length ? ns.rows[i].src : 'MISSING';
        if (sv !== nv) {
          console.log('  ' + q.name + ' diff at row ' + i + ':');
          console.log('    Supabase: ' + sv.substring(0, 120));
          console.log('    Neon:     ' + nv.substring(0, 120));
          break;
        }
      }
    }
  }

  await src.end();
  await tgt.end();
  console.log('\nDone.');
}

main().catch(function(e) { console.error('Error:', e); process.exit(1); });