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
    ")";

  try {
    await pg.query(sql);
    return mid;
  } catch (e) {
    console.error("[message-delivery] create failed:", e.message || e);
    return null;
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
async function markDelivered(messageId, clientId) {
  if (!messageId) return;
  var now = new Date().toISOString();
  var sql = "UPDATE " + TABLE + " SET status = 'delivered', delivered_at = " + escapeLiteral(now);
  if (clientId) sql += ", target_client = " + escapeLiteral(clientId);
  sql += " WHERE message_id = " + escapeLiteral(messageId) + " AND status = 'published'";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markDelivered failed:", e.message || e);
  }
}

// Mark message as confirmed (user saw/clicked the notification)
async function markConfirmed(messageId) {
  if (!messageId) return;
  var now = new Date().toISOString();
  var sql = "UPDATE " + TABLE + " SET status = 'confirmed', confirmed_at = " + escapeLiteral(now) + " WHERE message_id = " + escapeLiteral(messageId) + " AND status = 'delivered'";
  try {
    await pg.query(sql);
  } catch (e) {
    console.error("[message-delivery] markConfirmed failed:", e.message || e);
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
  markFailed,
  getUndelivered,
  getStuckPending,
  getByMessageId,
  queryMessages,
  getStats,
  cleanOld
};