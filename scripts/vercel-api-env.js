var https = require('https');

var VERCEL_TOKEN = process.env.VERCEL_TOKEN || 'YOUR_VERCEL_TOKEN';
var PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'YOUR_PROJECT_ID';
var TEAM_ID = process.env.VERCEL_TEAM_ID || 'YOUR_TEAM_ID';

var envVars = [
  { key: 'DB_PROVIDER', value: process.env.DB_PROVIDER || 'supabase', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'NEXT_PUBLIC_Ev_SUPABASE_URL', value: process.env.NEXT_PUBLIC_Ev_SUPABASE_URL || 'YOUR_SUPABASE_URL', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'NEXT_PUBLIC_Ev_SUPABASE_ANON_KEY', value: process.env.NEXT_PUBLIC_Ev_SUPABASE_ANON_KEY || 'YOUR_ANON_KEY', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_DATABASE', value: process.env.Ev_POSTGRES_DATABASE || 'postgres', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_HOST', value: process.env.Ev_POSTGRES_HOST || 'YOUR_DB_HOST', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_PASSWORD', value: process.env.Ev_POSTGRES_PASSWORD || 'YOUR_DB_PASSWORD', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_USER', value: process.env.Ev_POSTGRES_USER || 'postgres', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_URL', value: process.env.Ev_POSTGRES_URL || 'YOUR_POSTGRES_URL', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_URL_NON_POOLING', value: process.env.Ev_POSTGRES_URL_NON_POOLING || 'YOUR_POSTGRES_URL_NON_POOLING', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_POSTGRES_PRISMA_URL', value: process.env.Ev_POSTGRES_PRISMA_URL || 'YOUR_PRISMA_URL', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_SUPABASE_PUBLISHABLE_KEY', value: process.env.Ev_SUPABASE_PUBLISHABLE_KEY || 'YOUR_PUBLISHABLE_KEY', type: 'plain', target: ['production', 'preview', 'development'] },
  { key: 'Ev_SUPABASE_SECRET_KEY', value: process.env.Ev_SUPABASE_SECRET_KEY || 'YOUR_SECRET_KEY', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_SUPABASE_SERVICE_ROLE_KEY', value: process.env.Ev_SUPABASE_SERVICE_ROLE_KEY || 'YOUR_SERVICE_ROLE_KEY', type: 'secret', target: ['production', 'preview', 'development'] },
  { key: 'Ev_SUPABASE_JWT_SECRET', value: process.env.Ev_SUPABASE_JWT_SECRET || 'YOUR_JWT_SECRET', type: 'secret', target: ['production', 'preview', 'development'] }
];

function addEnvVar(envVar) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(envVar);
    var url = '/v9/projects/' + PROJECT_ID + '/env?teamId=' + TEAM_ID;

    var options = {
      hostname: 'api.vercel.com',
      path: url,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + VERCEL_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('OK: ' + envVar.key);
          resolve();
        } else {
          console.log('FAIL: ' + envVar.key + ' (status ' + res.statusCode + '): ' + data.substring(0, 200));
          resolve();
        }
      });
    });

    req.on('error', function(e) {
      console.log('ERROR: ' + envVar.key + ' -> ' + e.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

async function addAll() {
  for (var i = 0; i < envVars.length; i++) {
    await addEnvVar(envVars[i]);
  }
  console.log('');
  console.log('Done! Added ' + envVars.length + ' env vars to Vercel.');
}

addAll().catch(function(e) {
  console.error('Fatal: ' + (e.message || e));
  process.exit(1);
});