var fs = require('fs');
var path = require('path');

var envLocal = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
var dotenv = {};
envLocal.split('\n').forEach(function(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  var eq = line.indexOf('=');
  if (eq === -1) return;
  var key = line.substring(0, eq).trim();
  var val = line.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
  dotenv[key] = val;
});

var envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
envFile.split('\n').forEach(function(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  var eq = line.indexOf('=');
  if (eq === -1) return;
  var key = line.substring(0, eq).trim();
  var val = line.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
  if (!dotenv[key]) dotenv[key] = val;
});

var TOKEN = dotenv['VERCEL_TOKEN'];
var TEAM_ID = dotenv['VERCEL_TEAM_ID'] || 'team_NlGg4KgQ8EpymjNpTJdHAm40';
var PROJECT_ID = 'prj_38KILM45GYljAPTu4ufzTHCRnAnR';

if (!TOKEN) {
  fs.writeFileSync(path.join(__dirname, '..', 'vercel_env_result.txt'), 'ERROR: VERCEL_TOKEN not found in .env.local');
  process.exit(1);
}

var API_BASE = 'https://api.vercel.com/v9/projects/' + PROJECT_ID + '/env';
var queryParams = '?teamId=' + TEAM_ID;

var envVars = [
  { key: 'DB_PROVIDER', value: dotenv['DB_PROVIDER'] || 'supabase', type: 'plain', target: ['production'] },
  { key: 'Ev_POSTGRES_URL', value: dotenv['Ev_POSTGRES_URL'] || '', type: 'secret', target: ['production'] },
  { key: 'Ev_POSTGRES_URL_NON_POOLING', value: dotenv['Ev_POSTGRES_URL_NON_POOLING'] || '', type: 'secret', target: ['production'] },
];

async function addEnvVar(envVar) {
  var url = API_BASE + queryParams;
  var body = JSON.stringify({
    key: envVar.key,
    value: envVar.value,
    type: envVar.type,
    target: envVar.target
  });
  var resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json'
    },
    body: body
  });
  var data = await resp.json();
  if (!resp.ok) {
    throw new Error(envVar.key + ': ' + resp.status + ' ' + JSON.stringify(data));
  }
  return { key: envVar.key, created: true, id: data.id };
}

async function run() {
  var results = [];
  for (var i = 0; i < envVars.length; i++) {
    var v = envVars[i];
    if (!v.value) {
      results.push({ key: v.key, error: 'EMPTY_VALUE' });
      continue;
    }
    try {
      var r = await addEnvVar(v);
      results.push(r);
    } catch(e) {
      results.push({ key: v.key, error: e.message });
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'vercel_env_result.txt'), JSON.stringify(results, null, 2));
  process.exit(0);
}

run().catch(function(e) {
  fs.writeFileSync(path.join(__dirname, '..', 'vercel_env_result.txt'), 'FATAL: ' + e.message);
  process.exit(1);
});