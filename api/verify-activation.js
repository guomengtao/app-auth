var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var rateLimit = require("../lib/rate-limit");

function parseQueryCode(req) {
  var raw = String((req.query && req.query.code) || (req.body && req.body.code) || "").replace(/\s/g, "");
  if (!raw) return "";
  return raw;
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  var ipCheck = await rateLimit.checkIpRateLimit(req);
  if (ipCheck && ipCheck.blocked) {
    return res.status(429).json({ success: false, error: ipCheck.reason || "Rate limited" });
  }

  var code = parseQueryCode(req);

  if (!code || !/^\d{18}$/.test(code)) {
    return res.status(400).json({
      success: true,
      valid: false,
      reason: "invalid_format",
      message: "Activation code must be 18 digits"
    });
  }

  var recordRaw = await redis.get("auth:activation:" + code);

  if (!recordRaw) {
    return res.status(200).json({
      success: true,
      valid: false,
      reason: "not_found",
      message: "Activation code does not exist"
    });
  }

  var record;
  try {
    record = typeof recordRaw === "string" ? JSON.parse(recordRaw) : recordRaw;
  } catch (e) {
    return res.status(500).json({ success: false, error: "Failed to parse activation record" });
  }

  var now = Date.now();
  var expiresAt = record.expires_at || null;
  var productId = record.product_id || "";
  var months = record.duration_months || 0;

  if (expiresAt && Number(expiresAt) < now) {
    return res.status(200).json({
      success: true,
      valid: false,
      reason: "expired",
      productId: productId,
      months: months,
      message: "Activation code has expired"
    });
  }

  return res.status(200).json({
    success: true,
    valid: true,
    productId: productId,
    months: months,
    permanent: months === 99,
    expiresAt: expiresAt,
    message: "Activation code is valid"
  });
}

module.exports = handler;