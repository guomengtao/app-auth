var { requireAuth } = require("../../lib/auth");
var rateLimit = require("../../lib/rate-limit");

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  var body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  var deviceId = body.deviceId;
  if (!deviceId) {
    return res.status(400).json({ success: false, error: "deviceId is required" });
  }

  try {
    await rateLimit.clearDeviceRateLimit(deviceId);
    return res.json({ success: true, message: "Device rate limit cleared" });
  } catch (e) {
    console.error("[clear-rate-limit]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
};