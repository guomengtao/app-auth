var afdianApi = require("../../lib/afdian-api");
var { requireAuth } = require("../../lib/auth");

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return body;
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!afdianApi.isConfigured()) {
    return res.status(400).json({ success: false, error: "Afdian API not configured" });
  }

  try {
    var body = parseBody(req);
    var userId = body.user_id;
    var content = body.content;

    if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Message content is required" });
    }
    if (content.length > 500) {
      return res.status(400).json({ success: false, error: "Message too long (max 500 characters)" });
    }

    var result = await afdianApi.sendMessage(userId.trim(), content.trim());

    if (result.ec === 200) {
      return res.status(200).json({ success: true, message: "Message sent successfully" });
    }

    return res.status(200).json({
      success: false,
      error: result.em || "Unknown Afdian API error",
      afdian_ec: result.ec,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: (e && e.message) || "Failed to send message",
    });
  }
};