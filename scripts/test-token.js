var fs = require('fs');
var path = require('path');

try {
  var envLocal = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  var lines = envLocal.split('\n');
  var token = '';
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('VERCEL_TOKEN=')) {
      token = lines[i].replace('VERCEL_TOKEN=', '').replace(/["']/g, '').trim();
      break;
    }
  }
  
  var envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  var envLines = envFile.split('\n');
  var dbProvider = 'supabase';
  var evPostgresUrl = '';
  var evPostgresUrlNonPooling = '';
  for (var j = 0; j < envLines.length; j++) {
    if (envLines[j].startsWith('DB_PROVIDER=')) dbProvider = envLines[j].replace('DB_PROVIDER=', '').replace(/["']/g, '').trim();
    if (envLines[j].startsWith('Ev_POSTGRES_URL=')) evPostgresUrl = envLines[j].replace('Ev_POSTGRES_URL=', '').replace(/^["']|["']$/g, '').trim();
    if (envLines[j].startsWith('Ev_POSTGRES_URL_NON_POOLING=')) evPostgresUrlNonPooling = envLines[j].replace('Ev_POSTGRES_URL_NON_POOLING=', '').replace(/^["']|["']$/g, '').trim();
  }

  var out = 'TOKEN_LEN=' + token.length + '\n';
  out += 'DB_PROVIDER=' + dbProvider + '\n';
  out += 'Ev_POSTGRES_URL_LEN=' + evPostgresUrl.length + '\n';
  out += 'Ev_POSTGRES_URL_NON_POOLING_LEN=' + evPostgresUrlNonPooling.length + '\n';
  
  fs.writeFileSync(path.join(__dirname, '..', 'vercel_env_result.txt'), out);
} catch(e) {
  fs.writeFileSync(path.join(__dirname, '..', 'vercel_env_result.txt'), 'ERROR: ' + e.message + '\n' + e.stack);
}