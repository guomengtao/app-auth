#!/usr/bin/env node
// scripts/verify-sched.js
//
// 课程表云同步服务端验收脚本（P1）。
// 打线上 https://app-auth.gudq.com/api/sched/*，把服务端的关键假设逐条验证一遍：
//   publish 幂等 / rev 递增 / 旧 baseRev 必 409 / pull 带 deleted 标记 /
//   墓碑不物理删 payload / 从未上传过的表 delete 不报错也不建脏行 /
//   backup 写版本 / versions 可读。
//
// 用完自动清库（只删本次 guid 前缀的记录），不污染真实数据。
//
// 用法：cd ev/app-auth && node scripts/verify-sched.js

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
  else { fail++; console.log("  ❌ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
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

/** 部署有延迟：首次 publish 若是 404，等一轮再试 */
async function waitReady(guid, payload) {
  for (let i = 1; i <= 8; i++) {
    const r = await call("publish", { body: { guid, watchKey: "A4:C1:38:00:00:AA", watchName: "验证用", name: "验收课表", payload } });
    if (r.code !== 404) return r;
    console.log(`  … 第 ${i} 次探测仍 404（部署中），10 秒后重试`);
    await new Promise((res) => setTimeout(res, 10000));
  }
  return { code: 404, data: { error: "still_404_after_wait" } };
}

/** 模拟「云端行真的不见了」：直接物理删掉 schedules 行（绕过墓碑），验证缺失≠删除 */
async function pgDeleteRow(guid) {
  const url = (ENV.Ev_POSTGRES_URL_NON_POOLING || ENV.Ev_POSTGRES_URL || "").split("?")[0];
  if (!url) throw new Error("no_db_url");
  const { Client } = require("pg");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("delete from schedules where guid = $1", [guid]);
  await c.end();
}

async function cleanup(pgGuid) {
  const url = (ENV.Ev_POSTGRES_URL_NON_POOLING || ENV.Ev_POSTGRES_URL || "").split("?")[0];
  if (!url) { console.log("  ⚠️ 无直连串，跳过清库（请手工删 guid=" + pgGuid + "）"); return; }
  const { Client } = require("pg");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const t of ["schedule_versions", "schedule_tokens", "schedules"]) {
    await c.query("delete from " + t + " where guid like $1", ["%" + pgGuid + "%"]);
  }
  const left = await c.query("select count(*) n from schedules where guid like $1", ["%" + pgGuid + "%"]);
  await c.end();
  console.log("  🧹 清库完成，残留行数 = " + left.rows[0].n);
}

(async () => {
  const stamp = Date.now().toString(36);
  const guid = "evtest-" + stamp;
  const payload1 = { courses: [{ id: "c1", name: "语文", day: 1, start: "08:00", end: "08:40" }] };
  const payload2 = { courses: [{ id: "c1", name: "语文(改)", day: 1, start: "08:00", end: "08:40" }, { id: "c2", name: "数学", day: 2, start: "09:00", end: "09:40" }] };

  console.log("\n== 1. publish（首次） ==");
  const p1 = await waitReady(guid, payload1);
  ok("HTTP 200", p1.code === 200, p1);
  ok("返回 rev=1", p1.data && p1.data.rev === 1, p1.data);
  ok("返回 token", !!(p1.data && p1.data.token), p1.data);
  ok("返回可复制 url", !!(p1.data && p1.data.url), p1.data);
  const token = p1.data && p1.data.token;

  console.log("\n== 2. publish（重复，幂等且不覆盖 payload） ==");
  const p2 = await call("publish", { body: { guid, watchKey: "A4:C1:38:00:00:AA", watchName: "验证用", name: "改名后", payload: payload2 } });
  ok("HTTP 200 且 rev 仍是 1（不递增、不覆盖）", p2.code === 200 && p2.data.rev === 1, p2.data);
  ok("发了新 token", !!(p2.data && p2.data.token) && p2.data.token !== token, p2.data);

  console.log("\n== 3. 未带 token 的读接口必须 401 ==");
  const noAuth = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid) });
  ok("pull 无 token → 401", noAuth.code === 401, noAuth);

  const badAuth = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token: "deadbeef" });
  ok("pull 假 token → 401", badAuth.code === 401, badAuth);

  console.log("\n== 4. push（baseRev=1，正常递增） ==");
  const u1 = await call("push", { body: { guid, op: "upsert", baseRev: 1, payload: payload2 }, token });
  ok("HTTP 200 且 rev=2", u1.code === 200 && u1.data.rev === 2, u1);

  console.log("\n== 5. push（用旧 baseRev=1，必须 409 并回吐最新 payload） ==");
  const u2 = await call("push", { body: { guid, op: "upsert", baseRev: 1, payload: payload1 }, token });
  ok("HTTP 409", u2.code === 409, u2);
  ok("回吐 rev=2 与云端 payload（不是本地的）", u2.data && u2.data.rev === 2 && JSON.stringify(u2.data.payload).includes("数学"), u2.data);

  console.log("\n== 6. pull（内容与 rev 对齐） ==");
  const pr = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("HTTP 200 / exists / rev=2", pr.code === 200 && pr.data.exists === true && pr.data.rev === 2, pr.data);
  ok("payload 是第二次写入的（含数学）", JSON.stringify(pr.data.payload).includes("数学"), pr.data.payload);
  ok("deleted=false", pr.data.deleted === false, pr.data);

  console.log("\n== 7. backup + versions ==");
  const bk = await call("backup", { body: { guid, reason: "manual" }, token });
  ok("backup 200 且有 id", bk.code === 200 && bk.data.id != null, bk);
  const vs = await call("versions", { method: "GET", query: "guid=" + encodeURIComponent(guid) + "&limit=20", token });
  ok("versions 至少 1 条且带 reason=manual", vs.code === 200 && Array.isArray(vs.data.versions) && vs.data.versions.length >= 1 && vs.data.versions[0].reason === "manual", vs);

  console.log("\n== 8. 墓碑：delete 只标记，不物理删 payload ==");
  const d1 = await call("push", { body: { guid, op: "delete", baseRev: 2 }, token });
  ok("delete 后 rev=3", d1.code === 200 && d1.data.rev === 3, d1);
  const pr2 = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("deleted=true", pr2.data && pr2.data.deleted === true, pr2.data);
  ok("payload 仍在（可 30 天内恢复）", pr2.data && JSON.stringify(pr2.data.payload).includes("数学"), pr2.data.payload);

  console.log("\n== 9. 未注册 guid：无 token 一律 401（不能凭 guid 猜着写） ==");
  const ghostGuid = guid + "-ghost";
  const d2 = await call("push", { body: { guid: ghostGuid, op: "delete", baseRev: 0 }, token });
  ok("陌生 guid + 他人 token → 401（token 与 guid 绑定）", d2.code === 401, d2);

  console.log("\n== 10. state（三级回执字段齐全） ==");
  const st = await call("state", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("state 返回 rev/ackRev/publicRead", st.code === 200 && st.data.rev === 3 && st.data.ackRev === 0 && st.data.publicRead === false, st.data);

  console.log("\n== 11. ack + share ==");
  const ak = await call("ack", { body: { guid, rev: 3 }, token });
  ok("ack 200", ak.code === 200, ak);
  const st2 = await call("state", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("ackRev 追到 3", st2.data.ackRev === 3, st2.data);
  const sh = await call("share", { body: { guid, publicRead: true }, token });
  ok("share 开启后返回只读 url", sh.code === 200 && !!sh.data.url, sh);

  console.log("\n== 12. restore（回到 manual 备份） ==");
  const rs = await call("restore", { body: { guid, versionId: String(bk.data.id) }, token });
  ok("restore 后 rev=4 且 deleted 被清", rs.code === 200 && rs.data.rev === 4, rs);
  const pr3 = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("恢复后 deleted=false", pr3.data.deleted === false, pr3.data);

  console.log("\n== 13. 云端行被物理删掉后：delete 不得建脏行、pull 不得装作空表 ==");
  await pgDeleteRow(guid);
  const d3 = await call("push", { body: { guid, op: "delete", baseRev: 4 }, token });
  ok("云端无行 + delete → 200 noop=never_uploaded（绝不创建墓碑行）", d3.code === 200 && d3.data.noop === "never_uploaded", d3);
  const pr4 = await call("pull", { method: "GET", query: "guid=" + encodeURIComponent(guid), token });
  ok("pull 明确 exists=false（不是 404、不是空 payload 冒充）", pr4.code === 200 && pr4.data.exists === false, pr4.data);
  const d4 = await call("push", { body: { guid, op: "upsert", baseRev: 0, payload: payload1 }, token });
  ok("云端无行 + upsert(baseRev=0) → 以本地为真源重建 rev=1", d4.code === 200 && d4.data.rev === 1, d4);

  console.log("\n== 清库 ==");
  await cleanup(guid);

  console.log("\n================ 结果 ================");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("脚本异常：", e && e.message);
  process.exit(2);
});
