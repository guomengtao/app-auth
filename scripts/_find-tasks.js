var fs = require("fs");
var path = require("path");
function loadEnv(f) {
  try {
    var t = fs.readFileSync(f, "utf8");
    t.split("\n").forEach(function (l) {
      l = l.trim();
      if (!l || l.startsWith("#")) return;
      var i = l.indexOf("=");
      if (i < 0) return;
      var k = l.slice(0, i).trim();
      var v = l.slice(i + 1).trim().replace(/^"|"$/g, "");
      process.env[k] = v;
    });
  } catch (e) {}
}
loadEnv(path.join(__dirname, "..", ".env"));
loadEnv(path.join(__dirname, "..", ".env.local"));
var pg = require("/Users/Banner/Documents/guomengtao/ev/app-auth/.vercel/output/functions/api/activate.func/node_modules/pg");
var Pool = pg.Pool || pg;
var url = (process.env.Ev_POSTGRES_URL_NON_POOLING || process.env.Ev_POSTGRES_URL)
  .replace(/\?sslmode=[^&]*/, "").replace(/&sslmode=[^&]*/, "").replace(/\?supa=.*/, "");
if (url.indexOf("?") < 0) url = url.split("?")[0];
var p = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    var r = await p.query(
      "SELECT id, title, status, project, source FROM evops_tasks WHERE title ILIKE $1 ORDER BY created_at DESC LIMIT 20",
      ["%推送验证%"]);
    console.log("== tasks matching 推送验证 ==");
    if (!r.rows.length) console.log("  (none)");
    r.rows.forEach(function (x) { console.log(" - " + x.id + " | " + x.title + " | status=" + x.status + " | src=" + x.source + " | " + x.project); });
    var r2 = await p.query("SELECT id, title, status FROM evops_tasks ORDER BY updated_at DESC LIMIT 8");
    console.log("== recent tasks ==");
    r2.rows.forEach(function (x) { console.log(" - " + x.id + " | " + x.title + " | status=" + x.status); });
  } catch (e) { console.log("ERR: " + e.message); }
  await p.end();
})();