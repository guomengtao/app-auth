// lib/message-delivery.js - Message delivery tracking for EvNotifier
// Records every pushed message lifecycle: pending -> published -> delivered -> confirmed

var pg = require("./postgres");
var crypto = require("crypto");

var TABLE = "message_delivery";

function generateUUID() {
  return crypto.randomUUID();
}

function escapeLiteral(str) {
  if (!str) return "NULL";
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function toPgLiteral(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  return escapeLiteral(val);
}

// Create a new message delivery record
// 返回 { messageId, seq }：seq = 表自增 id，全局单调，客户端用它做补拉水位线（见
// tools/ev-notifier/离线补拉与已读系统设计.md）。调用方请按对象取值，不要假定是字符串。
async function createMessageDelivery({ messageType, payload, source, channel, targetClient, relatedCode, relatedDevice, messageId }) {
  var mid = messageId || generateUUID();
  var now = new Date().toISOString();
  var payloadJson = JSON.stringify(payload || {}).replace(/'/g, "''");

  var sql = "INSERT INTO " + TABLE + " (message_id, message_type, payload, source, channel, target_client, created_at, status, related_code, related_device) VALUES (" +
    escapeLiteral(mid) + ", " +
    escapeLiteral(messageType) + ", " +
    "'" + payloadJson + "'::jsonb, " +
    escapeLiteral(source) + ", " +
    escapeLiteral(channel || "auth:push_channel") + ", " +
    toPgLiteral(targetClient) + ", " +
    escapeLiteral(now) + ", " +
    "'pending', " +
    toPgLiteral(relatedCode) + ", " +
    toPgLiteral(relatedDevice) +
    ") RETURNING id";

  try {
    var r = await pg.query(sql);
    var seq = (r && r.rows && r.rows[0] && r.rows[0].id) || null;
    return { messageId: mid, seq: seq };
  } catch (e) {
    console.error("[message-delivery] create failed:", e.message || e);
    return null;
  }
}

// 当前最大 seq（新客户端首次上线用：直接跳到水位线，避免重放历史）
async function getMaxSeq() {
  var sql = "SELECT COALESCE(MAX(id), 0) AS max_seq FROM " + TABLE;
  try {
    var r = await pg.query(sql);
    var v = r && r.rows && r.rows[0] && r.rows[0].max_seq;
    return parseInt(v || 0, 10);
  } catch (e) {
    console.error("[message-delivery] getMaxSeq failed:", e.message || e);
    return 0;
  }
}

// 游标式增量拉取：只按 id 排序，绝不用 created_at（时钟偏移/同毫秒会造成错位与漏读）
// retentionHours 只做上界保护（超过保留期的老消息不再补），不参与排序与游标推进。
async function getSince(afterSeq, limit, retentionHours) {
  afterSeq = parseInt(afterSeq || 0, 10) || 0;
  limit = parseInt(limit || 200, 10) || 200;
  if (limit > 500) limit = 500;
  var rh = parseInt(retentionHours || 336, 10) || 336;
  var sql = "SELECT id AS seq, message_id, message_type, payload, created_at FROM " + TABLE +
    " WHERE id > " + afterSeq +
    " AND created_at > NOW() - INTERVAL '" + rh + " hours'" +
    " ORDER BY id ASC LIMIT " + limit;
  try {
    var r = await pg.query(sql);
    return r.rows || [];
  } catch (e) {
    console.error("[message-delivery] getSince failed:", e.message || e);
    return [];
  }
}

// Mark message as published (pushed to Redis PUB/SUB)
async function markPublished(messageId) {
  if (!messageId) return;
  var now = new Date().toISOString();
  var sql = "UPDATE " + TABLE + " SET status = 'published', published_at = " + escapeLiteral(now) + " WHERE message_id = " + escapeLiteral(messageId) + " AND status = 'pending'";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markPublished failed:", e.message || e);
  }
}

// Mark message as delivered (EvNotifier confirmed reception)
// ⚠️ 历史 bug：WHERE 只允许 status='published'。若 markPublished 被 Vercel 冻结截断，记录卡在
//    pending，客户端回调 delivered 就 0 行生效 → 永远留在 undelivered 列表被反复重放。
//    放宽到 IN ('pending','published')，允许跳过中间态。
async function markDelivered(messageId, clientId) {
  if (!messageId) return;
  var now = new Date().toISOString();
  var sql = "UPDATE " + TABLE + " SET status = 'delivered', delivered_at = " + escapeLiteral(now);
  if (clientId) sql += ", target_client = " + escapeLiteral(clientId);
  sql += " WHERE message_id = " + escapeLiteral(messageId) + " AND status IN ('pending', 'published')";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markDelivered failed:", e.message || e);
  }
}

// Mark message as confirmed (user saw/read the notification)
// 同样放宽门禁：read 回执可能在 delivered 回调丢失/乱序时先到。
async function markConfirmed(messageId) {
  if (!messageId) return;
  var now = new Date().toISOString();
  var sql = "UPDATE " + TABLE + " SET status = 'confirmed', confirmed_at = " + escapeLiteral(now) +
    " WHERE message_id = " + escapeLiteral(messageId) + " AND status IN ('pending', 'published', 'delivered')";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markConfirmed failed:", e.message || e);
  }
}

// 批量回执：离线补拉一次可能几十上百条，逐条 POST 会打爆连接数
async function markDeliveredBatch(messageIds, clientId) {
  var ids = (messageIds || []).filter(function(x) { return !!x; });
  if (!ids.length) return 0;
  var now = new Date().toISOString();
  var inList = ids.map(function(x) { return escapeLiteral(x); }).join(", ");
  var sql = "UPDATE " + TABLE + " SET status = 'delivered', delivered_at = " + escapeLiteral(now);
  if (clientId) sql += ", target_client = " + escapeLiteral(clientId);
  sql += " WHERE message_id IN (" + inList + ") AND status IN ('pending', 'published')";
  try {
    var r = await pg.query(sql);
    return (r && r.rowCount) || 0;
  } catch (e) {
    console.error("[message-delivery] markDeliveredBatch failed:", e.message || e);
    return 0;
  }
}

async function markConfirmedBatch(messageIds) {
  var ids = (messageIds || []).filter(function(x) { return !!x; });
  if (!ids.length) return 0;
  var now = new Date().toISOString();
  var inList = ids.map(function(x) { return escapeLiteral(x); }).join(", ");
  var sql = "UPDATE " + TABLE + " SET status = 'confirmed', confirmed_at = " + escapeLiteral(now) +
    " WHERE message_id IN (" + inList + ") AND status IN ('pending', 'published', 'delivered')";
  try {
    var r = await pg.query(sql);
    return (r && r.rowCount) || 0;
  } catch (e) {
    console.error("[message-delivery] markConfirmedBatch failed:", e.message || e);
    return 0;
  }
}

// Mark message as failed
async function markFailed(messageId, error) {
  if (!messageId) return;
  var sql = "UPDATE " + TABLE + " SET status = 'failed', error_message = " + escapeLiteral(String(error || "Unknown error")) + " WHERE message_id = " + escapeLiteral(messageId) + " AND status IN ('pending', 'published')";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markFailed failed:", e.message || e);
  }
}

// Get undelivered messages within a time range (for recovery/re-push)
async function getUndelivered(hours) {
  hours = hours || 168;
  var sql = "SELECT * FROM " + TABLE + " WHERE status IN ('pending', 'published', 'failed') AND created_at > NOW() - INTERVAL '" + hours + " hours' ORDER BY created_at";
  try {
    var r = await pg.query(sql);
    return r.rows || [];
  } catch (e) {
    console.error("[message-delivery] getUndelivered failed:", e.message || e);
    return [];
  }
}

// 只取「卡在 pending」的：记录建了、但推送链（XADD / markPublished）被 Vercel 冻结截断 → 通知其实没发出去。
// 不包含 published（可能 notifier 已收到，重发会重复提醒）。
async function getStuckPending(hours) {
  hours = hours || 72;
  var sql = "SELECT * FROM " + TABLE + " WHERE status = 'pending' AND created_at > NOW() - INTERVAL '" + hours + " hours' ORDER BY created_at";
  try {
    var r = await pg.query(sql);
    return r.rows || [];
  } catch (e) {
    console.error("[message-delivery] getStuckPending failed:", e.message || e);
    return [];
  }
}

// Get message delivery status by ID
async function getByMessageId(messageId) {
  if (!messageId) return null;
  var sql = "SELECT * FROM " + TABLE + " WHERE message_id = " + escapeLiteral(messageId);
  try {
    var r = await pg.query(sql);
    return (r.rows && r.rows.length > 0) ? r.rows[0] : null;
  } catch (e) {
    console.error("[message-delivery] getByMessageId failed:", e.message || e);
    return null;
  }
}

// Query messages with filters (for admin panel)
async function queryMessages({ status, type, source, code, limit, offset }) {
  limit = limit || 50;
  offset = offset || 0;
  var conditions = [];
  if (status) conditions.push("status = " + escapeLiteral(status));
  if (type) conditions.push("message_type = " + escapeLiteral(type));
  if (source) conditions.push("source = " + escapeLiteral(source));
  if (code) conditions.push("related_code = " + escapeLiteral(code));

  var where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  var sql = "SELECT * FROM " + TABLE + " " + where + " ORDER BY created_at DESC LIMIT " + limit + " OFFSET " + offset;
  var countSql = "SELECT COUNT(*) as total FROM " + TABLE + " " + where;

  try {
    var [rowsResult, countResult] = await Promise.all([
      pg.query(sql),
      pg.query(countSql)
    ]);
    return {
      rows: rowsResult.rows || [],
      total: parseInt((countResult.rows && countResult.rows[0] && countResult.rows[0].total) || 0, 10)
    };
  } catch (e) {
    console.error("[message-delivery] queryMessages failed:", e.message || e);
    return { rows: [], total: 0 };
  }
}

// Get delivery stats
async function getStats() {
  var sql = "SELECT status, COUNT(*) as cnt FROM " + TABLE + " WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY status";
  var totalSql = "SELECT COUNT(*) as cnt FROM " + TABLE + " WHERE created_at > NOW() - INTERVAL '7 days'";
  try {
    var [rowsResult, totalResult] = await Promise.all([
      pg.query(sql),
      pg.query(totalSql)
    ]);
    var stats = { pending: 0, published: 0, delivered: 0, confirmed: 0, failed: 0 };
    (rowsResult.rows || []).forEach(function(r) { stats[r.status] = parseInt(r.cnt, 10); });
    stats.total = parseInt((totalResult.rows && totalResult.rows[0] && totalResult.rows[0].cnt) || 0, 10);
    return stats;
  } catch (e) {
    console.error("[message-delivery] getStats failed:", e.message || e);
    return { pending: 0, published: 0, delivered: 0, confirmed: 0, failed: 0, total: 0 };
  }
}

// Clean up old records (keep 30 days)
async function cleanOld(days) {
  days = days || 30;
  var sql = "DELETE FROM " + TABLE + " WHERE created_at < NOW() - INTERVAL '" + days + " days'";
  try {
    var r = await pg.query(sql);
    console.log("[message-delivery] cleaned " + (r.rowCount || 0) + " old records (" + days + " days)");
    return r.rowCount || 0;
  } catch (e) {
    console.error("[message-delivery] cleanOld failed:", e.message || e);
    return 0;
  }
}

module.exports = {
  createMessageDelivery,
  markPublished,
  markDelivered,
  markConfirmed,
  markDeliveredBatch,
  markConfirmedBatch,
  markFailed,
  getMaxSeq,
  getSince,
  getUndelivered,
  getStuckPending,
  getByMessageId,
  queryMessages,
  getStats,
  cleanOld
};