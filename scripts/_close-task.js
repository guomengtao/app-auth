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
    var id = "realtime-test-1791270799";
    var r = await p.query(
      "UPDATE evops_tasks SET status='done', close_reason='fixed', closed_note='验证实时关闭推送', updated_at=now() WHERE id=$1",
      [id]);
    console.log("UPDATED id=" + id + " rows=" + r.rowCount);
    var r2 = await p.query("SELECT id, title, status FROM evops_tasks WHERE id=$1", [id]);
    if (r2.rows.length) console.log("now: " + r2.rows[0].status + " | " + r2.rows[0].title);
  } catch (e) { console.log("ERR: " + e.message); }
  await p.end();
})();