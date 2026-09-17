// POST /api/message-delivery/callback
// EvNotifier calls this to confirm message delivery/confirmation
// Request: { message_id, event: "delivered"|"confirmed", client_id?, received_at? }

var md = require("../../lib/message-delivery");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

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
    console.error("[callback] error:", e.message || e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
};