// lib/identity.js — 身份校正（人工合并 / 拆分）
//
// 为什么需要它：自动关联再聪明也会出错——
//   · 同一个人在电脑浏览器上浏览、在手表上激活（没有 deviceId）→ 漏合并；
//   · 不同用户共用同一模拟器 deviceId / 同一出口 IP → 误合并。
// 这两类只能靠人工拍板，拍板结果落库，让后续每次解析都遵守。
//
// op:
//   merge = 把 A 与 B 视为同一个用户（强规则，优先级高于所有自动证据）
//   split = 禁止把 A 与 B 合并（优先级同样最高，会剔除自动关联出来的事件）
//
// kind: device（deviceId 全文）/ ip / redeem（兑换码）/ order（订单号）

var pg = require("./postgres");

var ensurePromise = null;

var CREATE_SQL = [
  "create table if not exists identity_overrides (",
  "  id bigserial primary key,",
  "  kind varchar(16) not null,",
  "  value_a varchar(128) not null,",
  "  value_b varchar(128) not null,",
  "  op varchar(8) not null,",
  "  note text not null default '',",
  "  created_at timestamptz not null default now()",
  ")",
].join(" ");

function ensureTable() {
  if (!ensurePromise) {
    ensurePromise = (async function () {
      await pg.query(CREATE_SQL);
      await pg.query("create index if not exists idx_io_values on identity_overrides(value_a, value_b)");
      console.log("[identity] table ready");
    })().catch(function (e) {
      console.warn("[identity] ensure table failed:", e && e.message);
      ensurePromise = null;
      throw e;
    });
  }
  return ensurePromise;
}

function norm(v) { return String(v || "").trim(); }

async function list() {
  try {
    await ensureTable();
    var r = await pg.query(
      "select id, kind, value_a, value_b, op, note, created_at " +
        "from identity_overrides order by created_at desc limit 200"
    );
    return (r.rows || []).map(function (row) {
      return {
        id: String(row.id),
        kind: row.kind,
        value_a: row.value_a,
        value_b: row.value_b,
        op: row.op,
        note: row.note || "",
        created_at: row.created_at ? new Date(row.created_at).getTime() : 0,
      };
    });
  } catch (e) {
    console.warn("[identity] list failed:", e && e.message);
    return [];
  }
}

async function add(entry) {
  await ensureTable();
  var kind = String(entry.kind || "device").slice(0, 16);
  var a = norm(entry.value_a).slice(0, 128);
  var b = norm(entry.value_b).slice(0, 128);
  var op = String(entry.op || "merge").slice(0, 8);
  if (!a || !b) return { success: false, error: "缺少 A / B 值" };
  if (a === b) return { success: false, error: "A 与 B 不能相同" };
  if (op !== "merge" && op !== "split") return { success: false, error: "op 只能是 merge / split" };
  await pg.query(
    "insert into identity_overrides (kind, value_a, value_b, op, note) values ($1,$2,$3,$4,$5)",
    [kind, a, b, op, String(entry.note || "").slice(0, 500)]
  );
  return { success: true };
}

async function remove(id) {
  await ensureTable();
  await pg.query("delete from identity_overrides where id = $1", [String(id)]);
  return { success: true };
}

// 找出与 value 相关的规则（双向）：返回 [{ kind, other, op }]
async function rulesFor(value) {
  var v = norm(value);
  if (!v) return [];
  try {
    await ensureTable();
    var r = await pg.query(
      "select kind, value_a, value_b, op from identity_overrides where value_a = $1 or value_b = $1",
      [v]
    );
    return (r.rows || []).map(function (row) {
      return {
        kind: row.kind,
        other: row.value_a === v ? row.value_b : row.value_a,
        op: row.op,
      };
    });
  } catch (e) {
    console.warn("[identity] rulesFor failed:", e && e.message);
    return [];
  }
}

module.exports = {
  ensureTable: ensureTable,
  list: list,
  add: add,
  remove: remove,
  rulesFor: rulesFor,
};
