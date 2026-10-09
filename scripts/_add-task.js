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
    var id = "evtask-demo-realtime-" + Date.now();
    var nowStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    var r = await p.query(
      "INSERT INTO evops_tasks (id, project, title, type, description, status, owner, source, priority) " +
      "VALUES ($1, '测试', $2, 'bug', $3, 'in_progress', 'aitest', 'register', 'P2')",
      [id, "[实时新增] 自动刷新验证 " + nowStr, "由验证脚本新建，用于确认插入方向实时自动刷新"]);
    console.log("INSERTED id=" + id + " rows=" + r.rowCount);
    var r2 = await p.query("SELECT id, title, status FROM evops_tasks WHERE id=$1", [id]);
    if (r2.rows.length) console.log("added: " + r2.rows[0].title + " | " + r2.rows[0].status);
  } catch (e) { console.log("ERR: " + e.message); }
  await p.end();
})();