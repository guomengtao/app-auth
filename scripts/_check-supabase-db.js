var https = require("https");

function callApi(path) {
  return new Promise(function (resolve, reject) {
    var options = {
      hostname: "localhost",
      port: 3000,
      path: path,
      method: "GET",
      headers: { "Content-Type": "application/json" },
    };
    var req = require("http").request(options, function (res) {
      var body = "";
      res.on("data", function (d) { body += d; });
      res.on("end", function () {
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ raw: body.substring(0, 500) }); }
      });
    });
    req.on("error", function(e) {
      console.log("Local server not running:", e.message);
      console.log("Run: npx vercel dev");
      process.exit(1);
    });
    req.end();
  });
}

async function main() {
  console.log("Trying local Vercel dev server...");
  var r = await callApi("/api/admin/health?section=dbstatus");
  console.log(JSON.stringify(r, null, 2));
}

main().catch(function (e) { console.error("Error:", e.message); process.exit(1); });