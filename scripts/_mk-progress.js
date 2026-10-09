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
    var id = "evtask-progress-" + Date.now();
    var progress = {
      steps: [
        { no: 1, name: "需求分析与方案设计",  status: "done",        note: "完成可行性分析文档",                  at: new Date().toISOString() },
        { no: 2, name: "数据库模型与进度字段", status: "in_progress", note: "复用 extra.progress，无需改表",        at: new Date().toISOString() },
        { no: 3, name: "手机列表进度条",      status: "planned",     note: "",                                       at: null },
        { no: 4, name: "详情进度区",          status: "planned",     note: "",                                       at: null },
        { no: 5, name: "真机实时验收",        status: "planned",     note: "",                                       at: null }
      ],
      current_no: 2,
      note: "当前在 2/5 数据库模型与进度字段，进度40%",
      pct: 40
    };
    var extra = JSON.stringify({ progress: progress });
    var r = await p.query(
      "INSERT INTO evops_tasks (id, project, title, type, description, status, owner, source, priority, extra) " +
      "VALUES ($1, 'evops-android', $2, 'feature', $3, 'in_progress', 'aitest', 'register', 'P1', $4)",
      [id, "[多步骤进度演示] 任务进度实时更新", "多步骤任务进度增强：large task set steps + current step + pct, task list realtime refresh", extra]);
    console.log("INSERTED id=" + id + " rows=" + r.rowCount);
    var r2 = await p.query("SELECT id, title, status, extra FROM evops_tasks WHERE id=$1", [id]);
    if (r2.rows.length) {
      console.log("title=" + r2.rows[0].title);
      console.log("extra=" + String(r2.rows[0].extra).slice(0, 120));
    }
  } catch (e) { console.log("ERR: " + e.message); }
  await p.end();
})();