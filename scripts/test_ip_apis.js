var https = require("https");

// Quick test of 4 IP geolocation APIs used in prod
// Usage: node scripts/test_ip_apis.js [ip-address]

var TEST_IP = process.argv[2] || "8.8.8.8";

var APIS = [
  { name: "ip-api.com", url: "http://ip-api.com/json/" + TEST_IP + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query" },
  { name: "api.ip.sb",   url: "https://api.ip.sb/geoip/" + TEST_IP },
  { name: "ipinfo.io",   url: "https://ipinfo.io/" + TEST_IP + "/json" },
  { name: "ipwhois.app", url: "https://ipwhois.app/json/" + TEST_IP },
];

function fetchJson(url) {
  return new Promise(function(resolve) {
    var mod = url.startsWith("https") ? https : require("http");
    mod.get(url, { timeout: 5000 }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, body: data.substring(0, 200) }); }
      });
    }).on("error", function(e) { resolve({ ok: false, error: e.message }); });
  });
}

async function main() {
  console.log("Testing IP: " + TEST_IP + "\n");
  for (var i = 0; i < APIS.length; i++) {
    var api = APIS[i];
    var start = Date.now();
    var r = await fetchJson(api.url);
    var ms = Date.now() - start;
    var status = r.ok ? "OK " : "ERR";
    console.log(status + " " + String(ms).padEnd(5) + "ms " + api.name);
    if (r.ok) {
      var o = r.body;
      console.log("  " + [o.country||o.country_code, o.regionName||o.region, o.city, o.isp, o.org, o.as||("AS"+o.asn)].filter(Boolean).join(" | "));
    } else {
      console.log("  " + (r.error || r.body));
    }
  }
  console.log("\nDone.");
}
main().catch(console.error);