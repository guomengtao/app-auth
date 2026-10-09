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
    var id = (process.argv[2] || "").trim();
    if (!id) {
      var r0 = await p.query(
        "SELECT id FROM evops_tasks WHERE extra::text ILIKE $1 ORDER BY created_at DESC LIMIT 1",
        ["%progress%"]
      );
      if (r0.rows.length) id = r0.rows[0].id;
    }
    if (!id) { console.log("ERR: no progress task found"); await p.end(); return; }

    var r = await p.query("SELECT extra, title FROM evops_tasks WHERE id=$1", [id]);
    if (!r.rows.length) { console.log("ERR: task not found"); await p.end(); return; }
    var row = r.rows[0];
    var extra = (typeof row.extra === "object" && row.extra) || {};
    if (typeof extra === "string") extra = JSON.parse(extra);
    var prog = extra.progress;
    var newCur = (prog.current_no || 1) + 1;
    var steps = prog.steps || [];
    if (newCur > steps.length) { console.log("CLAMP: already at last step"); await p.end(); return; }

    prog.current_no = newCur;
    prog.pct = Math.round(newCur * 100 / steps.length);
    prog.note = steps[newCur - 1] ? (steps[newCur - 1].name + " 进行中，进度" + prog.pct + "%") : "";
    if (prog.note === "") prog.note = "推进到第" + newCur + "/" + steps.length + "步";
    steps[newCur - 1].status = "in_progress";
    if (steps[newCur - 2]) steps[newCur - 2].status = "done";
    steps[newCur - 1].at = new Date().toISOString();
    extra.progress = prog;
    var extraStr = JSON.stringify(extra);
    var up = await p.query("UPDATE evops_tasks SET extra=$1, updated_at=now() WHERE id=$2", [extraStr, id]);
    console.log("UPDATED id=" + id + " rows=" + up.rowCount);
    console.log("current_no=" + newCur + "/" + steps.length + " pct=" + prog.pct + "% note=" + prog.note);

    var r2 = await p.query("SELECT id, title FROM evops_tasks WHERE id=$1", [id]);
    if (r2.rows.length) console.log("title=" + r2.rows[0].title);
  } catch (e) { console.log("ERR: " + e.message); }
  await p.end();
})();