var https = require('https');

var VERCEL_TOKEN = 'napi_mxdmqxg5u9j40t8lj1gocxtb4ls6qmx1qul3cjeh6035y41uhvaqw1e9sbnr3nu8';
var PROJECT_ID = 'prj_38KILM45GYljAPTu4ufzTHCRnAnR';
var TEAM_ID = 'team_NlGg4KgQ8EpymjNpTJdHAm40';

var url = '/v9/projects/' + PROJECT_ID + '/env?teamId=' + TEAM_ID;

var options = {
  hostname: 'api.vercel.com',
  path: url,
  method: 'GET',
  headers: {
    'Authorization': 'Bearer ' + VERCEL_TOKEN
  }
};

var req = https.request(options, function(res) {
  var data = '';
  res.on('data', function(chunk) { data += chunk; });
  res.on('end', function() {
    try {
      var result = JSON.parse(data);
      if (result.envs) {
        var supabaseKeys = result.envs.filter(function(e) {
          return e.key && (e.key.startsWith('Ev_') || e.key.startsWith('NEXT_PUBLIC_Ev_') || e.key === 'DB_PROVIDER');
        });
        console.log('Total env vars: ' + result.envs.length);
        console.log('Supabase-related env vars found: ' + supabaseKeys.length);
        supabaseKeys.forEach(function(e) {
          console.log('  ' + e.key + ' (' + e.type + ') -> ' + (e.value ? e.value.substring(0, 30) + '...' : '[hidden]'));
        });
      } else {
        console.log('API response: ' + data.substring(0, 500));
      }
    } catch(e) {
      console.log('Parse error: ' + e.message);
      console.log('Raw: ' + data.substring(0, 500));
    }
  });
});

req.on('error', function(e) {
  console.error('Request error: ' + e.message);
  process.exit(1);
});

req.end();