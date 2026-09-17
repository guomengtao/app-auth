// api/message-delivery.js
// GET  - query message delivery records (admin panel)
// POST - EvNotifier callback (delivered/confirmed)

var md = require("../lib/message-delivery");

module.exports = async function handler(req, res) {
  if (req.method === "POST") {
    return handleCallback(req, res);
  }
  if (req.method === "GET") {
    return handleQuery(req, res);
  }
  return res.status(405).json({ success: false, error: "Method not allowed" });
};

// POST: EvNotifier callback
async function handleCallback(req, res) {
  var { message_id, event, client_id, received_at } = req.body || {};

  if (!message_id || !event) {
    return res.status(400).json({ success: false, error: "Missing required fields: message_id, event" });
  }

  if (event !== "delivered" && event !== "confirmed") {
    return res.status(400).json({ success: false, error: "Invalid event. Must be 'delivered' or 'confirmed'" });
  }

  try {
    if (event === "delivered") {
      await md.markDelivered(message_id, client_id || null);
    } else if (event === "confirmed") {
      await md.markConfirmed(message_id);
    }

    return res.json({ success: true, message_id: message_id, event: event });
  } catch (e) {
    console.error("[message-delivery:callback] error:", e.message || e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}

// GET: query/stats
async function handleQuery(req, res) {
  try {
    var { status, type, source, code, limit, offset, action } = req.query;

    if (action === "stats") {
      var stats = await md.getStats();
      return res.json({ success: true, stats: stats });
    }

    if (action === "undelivered") {
      var hours = parseInt(req.query.hours || "24", 10);
      var messages = await md.getUndelivered(hours);
      return res.json({ success: true, messages: messages });
    }

    var result = await md.queryMessages({
      status: status || null,
      type: type || null,
      source: source || null,
      code: code || null,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0
    });

    return res.json({ success: true, rows: result.rows, total: result.total });
  } catch (e) {
    console.error("[message-delivery:query] error:", e.message || e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}