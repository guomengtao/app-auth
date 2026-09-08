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

var supabase = new Pool({ connectionString: supabaseUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 3, ssl: { rejectUnauthorized: false } });
var neon = new Pool({ connectionString: neonUrl.replace('sslmode=require', 'sslmode=no-verify'), max: 3, ssl: { rejectUnauthorized: false } });

async function main() {
  // Compare kv_strings
  console.log('=== kv_strings diff ===');
  var ss = await supabase.query('SELECT key, value FROM kv_strings ORDER BY key');
  var ns = await neon.query('SELECT key, value FROM kv_strings ORDER BY key');
  var sMap = {};
  for (var r of ss.rows) sMap[r.key] = r.value;
  for (var r of ns.rows) {
    if (!sMap[r.key]) {
      console.log('  Only in Neon: key=' + r.key);
    } else if (sMap[r.key] !== r.value) {
      console.log('  Value diff: key=' + r.key);
      console.log('    Supabase: ' + (sMap[r.key] || '').substring(0, 100));
      console.log('    Neon:     ' + (r.value || '').substring(0, 100));
    }
  }
  for (var r of ss.rows) {
    var nv = null;
    for (var nr of ns.rows) { if (nr.key === r.key) { nv = nr.value; break; } }
    if (!nv) console.log('  Only in Supabase: key=' + r.key);
  }

  // Compare kv_hashes
  console.log('\n=== kv_hashes diff ===');
  var sh = await supabase.query('SELECT key, field, value FROM kv_hashes ORDER BY key, field');
  var nh = await neon.query('SELECT key, field, value FROM kv_hashes ORDER BY key, field');
  var shMap = {};
  for (var r of sh.rows) shMap[r.key + '||' + r.field] = r.value;
  for (var r of nh.rows) {
    var k = r.key + '||' + r.field;
    if (!shMap[k]) {
      console.log('  Only in Neon: key=' + r.key + ' field=' + r.field);
    } else if (shMap[k] !== r.value) {
      console.log('  Value diff: key=' + r.key + ' field=' + r.field);
      console.log('    Supabase: ' + (shMap[k] || ''));
      console.log('    Neon:     ' + (r.value || ''));
    }
  }
  for (var r of sh.rows) {
    var k = r.key + '||' + r.field;
    if (!nh.rows.some(function(nr) { return nr.key + '||' + nr.field === k; })) {
      console.log('  Only in Supabase: key=' + r.key + ' field=' + r.field);
    }
  }

  // Compare kv_zsets
  console.log('\n=== kv_zsets diff ===');
  var sz = await supabase.query('SELECT key, member, score FROM kv_zsets ORDER BY key, member');
  var nz = await neon.query('SELECT key, member, score FROM kv_zsets ORDER BY key, member');
  var szMap = {};
  for (var r of sz.rows) szMap[r.key + '||' + r.member] = r.score;
  for (var r of nz.rows) {
    var k = r.key + '||' + r.member;
    if (!szMap[k]) {
      console.log('  Only in Neon: key=' + r.key + ' member=' + r.member);
    } else if (Number(szMap[k]) !== Number(r.score)) {
      console.log('  Score diff: key=' + r.key + ' member=' + r.member + ' supabase=' + szMap[k] + ' neon=' + r.score);
    }
  }
  for (var r of sz.rows) {
    var k = r.key + '||' + r.member;
    if (!nz.rows.some(function(nr) { return nr.key + '||' + nr.member === k; })) {
      console.log('  Only in Supabase: key=' + r.key + ' member=' + r.member);
    }
  }

  // Compare kv_sets (check for any differences even though counts match)
  console.log('\n=== kv_sets diff ===');
  var ss2 = await supabase.query('SELECT key, member FROM kv_sets ORDER BY key, member');
  var ns2 = await neon.query('SELECT key, member FROM kv_sets ORDER BY key, member');
  var ss2Map = new Set();
  for (var r of ss2.rows) ss2Map.add(r.key + '||' + r.member);
  for (var r of ns2.rows) {
    if (!ss2Map.has(r.key + '||' + r.member)) {
      console.log('  Only in Neon: key=' + r.key + ' member=' + r.member);
    }
  }
  for (var r of ss2.rows) {
    if (!ns2.rows.some(function(nr) { return nr.key === r.key && nr.member === r.member; })) {
      console.log('  Only in Supabase: key=' + r.key + ' member=' + r.member);
    }
  }
  console.log('\nDone.');
  await supabase.end();
  await neon.end();
}

main().catch(function(e) {
  console.error('Error:', e.message || e);
  process.exit(1);
});