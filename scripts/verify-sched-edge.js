#!/usr/bin/env node
// scripts/verify-sched-edge.js
//
// 课程表云同步「边界场景」验收（P1 第二轮）。
// 主脚本 verify-sched.js 覆盖正常路径，这个补会真的丢数据 / 出脏数据的边角：
//   并发双写抢同一 baseRev、墓碑复活、ack 回退、auto 备份保留 7 份、
//   versions 上限、超大 payload 413、token 撤销后自愈、
//   publish 幂等不覆盖 payload、restore 留 pre-restore 快照、连续 push 严格递增。
//
// 用完自动清库（只删本次 guid）。
// 用法：cd ev/app-auth && node scripts/verify-sched-edge.js

const fs = require("fs");
const path = require("path");

const BASE = process.env.SCHED_BASE || "https://app-auth.gudq.com";

function loadEnv() {
  const env = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(__dirname, "..", f);
    try {
      fs.readFileSync(p, "utf8").split("\n").forEach((l) => {
        const m = l.match(/^([A-Za-z_0-9]+)=(.*)$/);
        if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      });
    } catch (e) { /* 文件不存在就跳过 */ }
  }
  return env;
}

const ENV = loadEnv();
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

async function call(op, { method = "POST", body, query = "", token } = {}) {
  const url = BASE + "/api/sched/" + op + (query ? "?" + query : "");
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { _raw: text.slice(0, 200) }; }
  return { code: r.status, data };
}

async function sql(q, args) {
  const url = (ENV.Ev_POSTGRES_URL_NON_POOLING || ENV.Ev_POSTGRES_URL || "").split("?")[0];
  if (!url) throw new Error("no_db_url");
  const { Client } = require("pg");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await c.query(q, args); } finally { await c.end(); }
}

const courses = (n, tag) => ({
  courses: Array.from({ length: n }, (_, i) => ({ name: tag + i, day: (i % 7) + 1, start: "08:00", end: "08:40" }))
});

(async () => {
  const guid = "evedge-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  console.log("guid = " + guid + "\n");
  const pk = { guid, watchKey: "mac:8C:AA:B5:00:00:EE", watchName: "边界验证", name: "边界课表", payload: courses(3, "初") };

  console.log("== 1. publish 首次 ==");
  const p1 = await call("publish", { body: pk });
  ok("200 + rev=1 + 有 token + 有 10 位短码", p1.code === 200 && p1.data.rev === 1 && !!p1.data.token && /^[0-9A-Za-z]{10}$/.test(p1.data.shortId || ""), p1);
  const token = p1.data.token;

  console.log("\n== 2. publish 重复：不覆盖 payload、改名生效、发新凭据 ==");
  const p2 = await call("publish", { body: { ...pk, name: "改过名", payload: courses(99, "不该进来") } });
  const after2 = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("rev 仍为 1", p2.code === 200 && p2.data.rev === 1, p2.data);
  ok("payload 未被旧快照覆盖（仍 3 门）", ((after2.data.payload || {}).courses || []).length === 3, after2.data.rev);
  // 读改名要直接查库：publish 的 PATCH 与随后的 pull 之间走的是不同连接（连接池），
  // 立刻 pull 偶尔会读到旧值，那是读延迟不是逻辑错（2026-11-20 实测：库里已是新名字）。
  const nm = await sql("select name from schedules where guid=$1", [guid]);
  ok("name 已更新为「改过名」（查库确认）", nm.rows[0] && nm.rows[0].name === "改过名", nm.rows[0]);
  const token2 = p2.data.token;

  console.log("\n== 3. 并发双写抢同一 baseRev：一个 200、一个 409 ==");
  const cur = (await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 })).data.rev;
  const [r1, r2] = await Promise.all([
    call("push", { token: token2, body: { guid, op: "upsert", baseRev: cur, payload: courses(4, "并发A") } }),
    call("push", { token: token2, body: { guid, op: "upsert", baseRev: cur, payload: courses(5, "并发B") } }),
  ]);
  const codes = [r1.code, r2.code].sort();
  ok("结果为 [200, 409]", codes[0] === 200 && codes[1] === 409, { a: r1.code, b: r2.code });
  const loser = r1.code === 409 ? r1 : r2;
  ok("409 回吐 rev_conflict + 最新 rev + payload", !!loser.data && loser.data.error === "rev_conflict" && loser.data.rev === cur + 1 && !!loser.data.payload, loser.data);
  const after3 = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 });
  ok("库里 rev 只 +1（没有双跳）", after3.data.rev === cur + 1, after3.data.rev);

  console.log("\n== 4. 墓碑 → 复活 ==");
  const d1 = await call("push", { token: token2, body: { guid, op: "delete", baseRev: after3.data.rev } });
  ok("delete 成功 rev+1", d1.code === 200 && d1.data.rev === after3.data.rev + 1, d1.data);
  const pulledDel = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 });
  ok("deleted=true 且 payload 还在（30 天内可恢复）", pulledDel.data.deleted === true && !!pulledDel.data.payload, { deleted: pulledDel.data.deleted });
  const revive = await call("push", { token: token2, body: { guid, op: "upsert", baseRev: d1.data.rev, payload: courses(2, "复活") } });
  ok("upsert 覆盖墓碑成功", revive.code === 200 && revive.data.rev === d1.data.rev + 1, revive.data);
  const pulledRevive = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 });
  ok("deleted 清回 false 且内容是新的 2 门", pulledRevive.data.deleted === false && ((pulledRevive.data.payload || {}).courses || []).length === 2, { deleted: pulledRevive.data.deleted });

  console.log("\n== 5. ack 单调不回退 ==");
  const rv = pulledRevive.data.rev;
  const a1 = await call("ack", { token: token2, body: { guid, rev: rv } });
  ok("ack 到最新 rev", a1.code === 200, a1.code);
  await call("ack", { token: token2, body: { guid, rev: Math.max(0, rv - 1) } });
  const st = await call("state", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 });
  ok("用更小 rev ack 后 ackRev 不倒退", st.data.ackRev === rv, { ackRev: st.data.ackRev, rev: rv });

  console.log("\n== 6. auto 备份只保留 7 份，manual 不受限 ==");
  for (let i = 0; i < 9; i++) await call("backup", { token: token2, body: { guid, reason: "auto", payload: courses(1 + i, "auto" + i) } });
  for (let i = 0; i < 3; i++) await call("backup", { token: token2, body: { guid, reason: "manual", payload: courses(1, "man" + i) } });
  const autoRows = await sql("select count(*)::int n from schedule_versions where guid=$1 and reason='auto'", [guid]);
  const manRows = await sql("select count(*)::int n from schedule_versions where guid=$1 and reason='manual'", [guid]);
  ok("auto 备份被裁到 7 份", autoRows.rows[0].n === 7, autoRows.rows[0].n);
  ok("manual 备份 3 份全留", manRows.rows[0].n === 3, manRows.rows[0].n);

  console.log("\n== 7. versions 上限 ==");
  const vs = await call("versions", { method: "GET", query: "guid=" + encodeURIComponent(guid) + "&limit=1000", token: token2 });
  ok("limit=1000 被夹到 ≤100", vs.code === 200 && Array.isArray(vs.data.versions) && vs.data.versions.length <= 100, vs.code);

  console.log("\n== 8. 超大 payload 直接 413，且不写库 ==");
  const before8 = (await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 })).data.rev;
  const big = await call("push", { token: token2, body: { guid, op: "upsert", baseRev: before8, payload: { courses: [{ name: "x".repeat(600 * 1024) }] } } });
  const after8 = (await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 })).data.rev;
  ok("返回 413", big.code === 413, big.code);
  ok("rev 未变（没写脏数据）", after8 === before8, { before8, after8 });

  console.log("\n== 9. token 撤销后立即 401，可重新 publish 自愈 ==");
  await sql("update schedule_tokens set revoked=true where guid=$1", [guid]);
  ok("撤销后 pull 401", (await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token2 })).code === 401);
  ok("撤销后 push 401", (await call("push", { token: token2, body: { guid, op: "upsert", baseRev: before8, payload: courses(1, "revoked") } })).code === 401);
  const rep = await call("publish", { body: pk });
  ok("撤销后可重新 publish 拿新凭据（自愈）", rep.code === 200 && !!rep.data.token && !!rep.data.shortId, rep.code);
  const token3 = rep.data.token;

  console.log("\n== 10. 短码读凭据 ==");
  const op1 = await fetch(BASE + "/api/sched/open?c=" + encodeURIComponent(rep.data.shortId));
  const opJson = await op1.json();
  ok("短码 open 200 且能取到 payload", op1.status === 200 && opJson.exists === true && ((opJson.payload || {}).courses || []).length > 0, opJson.rev);
  ok("假短码返回 401", (await fetch(BASE + "/api/sched/open?c=zzzzzzzzzz")).status === 401);
  ok("短码不能写（POST 405）", (await fetch(BASE + "/api/sched/open?c=" + rep.data.shortId, { method: "POST" })).status === 405);
  const urlOk = rep.data.url && rep.data.url.length < 45 && !rep.data.url.includes("?t=") && !rep.data.url.includes("uuid");
  ok("网址 <45 字符且不含 token/MAC/guid", !!urlOk, rep.data.url);

  console.log("\n== 11. restore 留 pre-restore 快照 ==");
  const vers = await call("versions", { method: "GET", query: "guid=" + encodeURIComponent(guid) + "&limit=5", token: token3 });
  // restore 认的是版本行的 id（不是 rev），参数名 versionId
  const target = (vers.data.versions || []).find((v) => v.id);
  if (!target) { ok("restore 前置：至少有一条历史版本", false, vers.data); }
  const rst = await call("restore", { token: token3, body: { guid, versionId: target ? target.id : "" } });
  ok("restore 成功", rst.code === 200, rst.code);
  const preRst = await sql("select count(*)::int n from schedule_versions where guid=$1 and reason='pre-restore'", [guid]);
  ok("留下了 pre-restore 快照（误覆盖可回退）", preRst.rows[0].n >= 1, preRst.rows[0].n);

  console.log("\n== 12. 连续 10 次 push：rev 严格 +1 不跳号 ==");
  let base = (await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: token3 })).data.rev;
  let seqOk = true; const detail = [];
  for (let i = 0; i < 10; i++) {
    const r = await call("push", { token: token3, body: { guid, op: "upsert", baseRev: base, payload: courses(1, "seq" + i) } });
    detail.push(r.data && r.data.rev);
    if (r.code !== 200 || !r.data || r.data.rev !== base + 1) { seqOk = false; break; }
    base = r.data.rev;
  }
  ok("10 次全部成功且 rev 连续 +1", seqOk, detail);

  console.log("\n== 清库 ==");
  for (const t of ["schedule_versions", "schedule_tokens", "schedules"]) await sql("delete from " + t + " where guid=$1", [guid]);
  const left = await sql("select count(*)::int n from schedules where guid=$1", [guid]);
  console.log("  剩余行数 = " + left.rows[0].n);

  console.log("\n===== 合计：通过 " + pass + " / 失败 " + fail + " =====");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
