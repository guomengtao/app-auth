/**
 * lib/pay-store.js —— 零操作激活通道：Supabase 事件推送 + 一次性码存取
 *
 * 依赖 P1 建的两张表（scripts/setup-activation-realtime.sql）：
 *   activation_events   只放 sid/status/ts，anon 可读，App 用 Realtime 订阅
 *   activation_codes    放 18 位码，anon 全拒，只经服务端一次取走
 *
 * 复用 lib/postgres.js 的既有连接（实测可见这两张表），**不新增凭据、不新增依赖**。
 * 所有方法失败时抛错，由调用方 try/catch；绝不静默吞掉（便于 webhook 日志定位）。
 */
var pg = require("./postgres");

var EVENT_RETENTION_MS = 60 * 60 * 1000;  // 1 小时；业务写入时顺带清理，不引入定时任务

/**
 * 写一条状态事件。供 App 的 WSS 订阅消费。
 * 顺带清理过期事件行（项目禁用 automation，故随业务写入清理）。
 */
async function emit(sid, status) {
  await pg.query(
    "insert into public.activation_events (sid, status, ts) values ($1, $2, $3)",
    [String(sid), String(status), Date.now()]
  );
  await pg.query(
    "delete from public.activation_events where ts < $1",
    [Date.now() - EVENT_RETENTION_MS]
  );
}

/**
 * 支付成功落库：写好待取码 + 推 paid 事件（幂等，重复 webhook 不重复发码）。
 * @param {Object} o {sid, code18, deviceKey, nodeId, expires}
 * @returns {Promise<{ok:boolean, duplicate?:boolean}>}
 */
async function markPaid(o) {
  var sid = String(o.sid || "");
  if (!sid || !o.code18) return { ok: false, reason: "missing_sid_or_code" };

  var existing = await pg.query(
    "select sid from public.activation_codes where sid = $1", [sid]);
  if (existing.rows && existing.rows.length) {
    return { ok: true, duplicate: true };
  }

  await pg.query(
    "insert into public.activation_codes (sid, code18, device_key, node_id, expires) " +
    "values ($1, $2, $3, $4, $5) on conflict (sid) do nothing",
    [sid, String(o.code18), o.deviceKey || null, o.nodeId || null, Number(o.expires) || (Date.now() + 900000)]
  );
  await emit(sid, "paid");
  return { ok: true, duplicate: false };
}

/**
 * 一次性取码：读出即删，第二次取返回 null。
 * 仅由服务端 /api/pay-session?pickup=1 调用；anon 对码表无权限。
 */
async function pickup(sid) {
  var r = await pg.query(
    "select code18, device_key, node_id, expires from public.activation_codes where sid = $1",
    [String(sid || "")]);
  var row = r.rows && r.rows[0];
  if (!row) return null;
  if (Number(row.expires) && Number(row.expires) < Date.now()) {
    await pg.query("delete from public.activation_codes where sid = $1", [String(sid)]);
    return null;
  }
  await pg.query("delete from public.activation_codes where sid = $1", [String(sid)]);
  return {
    code18: row.code18,
    deviceKey: row.device_key,
    nodeId: row.node_id
  };
}

/** 诊断用：事件表行数（不暴露给外网接口） */
async function eventCount() {
  var r = await pg.query("select count(*)::int as c from public.activation_events");
  return (r.rows && r.rows[0] && r.rows[0].c) || 0;
}

module.exports = {
  emit: emit,
  markPaid: markPaid,
  pickup: pickup,
  eventCount: eventCount
};
