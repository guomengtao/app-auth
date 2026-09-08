var fs = require('fs');
var path = require('path');

var out = [];

try {
  require('dotenv').config();
  require('dotenv').config({ path: '.env.local', override: false });
  out.push('dotenv loaded OK');
} catch(e) {
  out.push('dotenv error: ' + e.message);
}

var supabaseUrl = process.env.Ev_POSTGRES_URL || '';
var neonUrl = process.env.POSTGRES_URL || '';
var upstashUrl = process.env.KV_REST_API_URL || '';
var upstashToken = process.env.KV_REST_API_TOKEN || '';

out.push('DB_PROVIDER=' + (process.env.DB_PROVIDER || '(not set)'));
out.push('Ev_POSTGRES_URL=' + (supabaseUrl ? 'SET' : 'NOT SET'));
out.push('POSTGRES_URL=' + (neonUrl ? 'SET' : 'NOT SET'));

var outFile = path.join(__dirname, '..', 'db_check_result.txt');

async function countDb(pool, label, tables) {
  var total = 0;
  var results = {};
  for (var i = 0; i < tables.length; i++) {
    var r = await pool.query('SELECT COUNT(*)::int AS c FROM ' + tables[i]);
    var c = r.rows[0].c;
    results[tables[i]] = c;
    total += c;
  }
  out.push(label + ' total: ' + total + ' (' + JSON.stringify(results) + ')');
  return total;
}

async function run() {
  var { Pool } = require('pg');
  var tables = ['kv_strings', 'kv_hashes', 'kv_sets', 'kv_zsets'];

  if (supabaseUrl) {
    try {
      out.push('Connecting Supabase...');
      var supabasePool = new Pool({ connectionString: supabaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, max: 1 });
      await countDb(supabasePool, 'SUPABASE', tables);
      await supabasePool.end();
    } catch(e) {
      out.push('SUPABASE ERROR: ' + e.message);
    }
  } else {
    out.push('SUPABASE: URL not set');
  }

  if (neonUrl) {
    try {
      out.push('Connecting Neon...');
      var neonPool = new Pool({ connectionString: neonUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, max: 1 });
      await countDb(neonPool, 'NEON', tables);
      await neonPool.end();
    } catch(e) {
      out.push('NEON ERROR: ' + e.message);
    }
  } else {
    out.push('NEON: URL not set');
  }

  if (upstashUrl && upstashToken) {
    try {
      out.push('Connecting Upstash...');
      var r = await fetch(upstashUrl + '/dbsize', {
        headers: { Authorization: 'Bearer ' + upstashToken },
        signal: AbortSignal.timeout(10000)
      });
      var d = await r.json();
      out.push('UPSTASH DBSIZE: ' + (d.result !== undefined ? d.result : JSON.stringify(d)));
    } catch(e) {
      out.push('UPSTASH ERROR: ' + e.message);
    }
  }

  out.push('DONE');
  fs.writeFileSync(outFile, out.join('\n'));
  process.exit(0);
}

run().catch(function(e) {
  out.push('FATAL: ' + e.message + '\n' + (e.stack || ''));
  fs.writeFileSync(outFile, out.join('\n'));
  process.exit(1);
});

setTimeout(function() {
  out.push('TIMEOUT after 30s');
  fs.writeFileSync(outFile, out.join('\n'));
  process.exit(1);
}, 30000);