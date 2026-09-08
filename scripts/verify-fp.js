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
  // Test collation difference
  var testSql = "SELECT 'auth:activation:' AS a UNION ALL SELECT 'auth:activation_failure:' UNION ALL SELECT 'auth:activation:0' ORDER BY 1";
  var st = await src.query(testSql);
  var nt = await tgt.query(testSql);
  console.log('=== Collation test ===');
  console.log('Supabase ORDER BY without COLLATE:');
  for (var r of st.rows) console.log('  ' + r.a);
  console.log('Neon ORDER BY without COLLATE:');
  for (var r of nt.rows) console.log('  ' + r.a);

  var testSqlC = "SELECT * FROM (SELECT 'auth:activation:' AS a UNION ALL SELECT 'auth:activation_failure:' UNION ALL SELECT 'auth:activation:0') AS sub ORDER BY a COLLATE \"C\"";
  var stc = await src.query(testSqlC);
  var ntc = await tgt.query(testSqlC);
  console.log('\nSupabase ORDER BY COLLATE "C":');
  for (var r of stc.rows) console.log('  ' + r.a);
  console.log('Neon ORDER BY COLLATE "C":');
  for (var r of ntc.rows) console.log('  ' + r.a);

  // Fingerprint with COLLATE "C"
  console.log('\n=== Fingerprint with COLLATE "C" ===');
  var fpQuery = "SELECT MD5(string_agg(src, '' ORDER BY src COLLATE \"C\")) AS fp FROM (" +
    "SELECT key || ':' || COALESCE(value,'') AS src FROM kv_strings WHERE key NOT LIKE 'auth:db:%' AND key NOT LIKE 'auth:cron:%' " +
    "UNION ALL SELECT key || ':' || field || ':' || COALESCE(value,'') FROM kv_hashes " +
    "UNION ALL SELECT key || ':' || member FROM kv_sets " +
    "UNION ALL SELECT key || ':' || member || ':' || score FROM kv_zsets" +
    ") AS all_src";

  var sfp = await src.query(fpQuery);
  var nfp = await tgt.query(fpQuery);
  var match = sfp.rows[0].fp === nfp.rows[0].fp;
  console.log('Supabase: ' + sfp.rows[0].fp);
  console.log('Neon:     ' + nfp.rows[0].fp);
  console.log('Match: ' + (match ? 'YES' : 'NO'));

  await src.end();
  await tgt.end();
}

main().catch(function(e) { console.error('Error:', e); process.exit(1); });