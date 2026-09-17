// GET /api/message-delivery/query
// Query message delivery records for admin panel
// Query params: status, type, source, code, limit, offset

var md = require("../../lib/message-delivery");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

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
};