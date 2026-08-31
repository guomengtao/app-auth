var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId } = require("../lib/validate");

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

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try {
      cur = JSON.parse(cur);
    } catch (e) {
      break;
    }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

function normalizeProductId(productId) {
  var n = parseInt(productId, 10);
  if (!Number.isFinite(n) || n < 0 || n > 99) return null;
  return crypto.pad2(n);
}

function normalizeMonths(months) {
  var n = parseInt(months, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return n;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var body = parseBody(req);
    var deviceId = body.deviceId;
    var redeemCode = body.redeemCode;

    var deviceCheck = validateDeviceId(deviceId);
    if (!deviceCheck.valid) {
      return res.status(400).json({ success: false, error: deviceCheck.error });
    }

    var codeCheck = validateRedeemCode(redeemCode);
    if (!codeCheck.valid) {
      return res.status(400).json({ success: false, error: codeCheck.error });
    }

    var code = codeCheck.value;
    var device = deviceCheck.value;
    var deviceHash = crypto.sha256(device);

    var codeData = await redis.get("auth:redeem:" + code);
    if (!codeData) {
      return res.status(400).json({ success: false, error: "Invalid redeem code" });
    }

    var info = parseRedisJson(codeData);
    if (!info) {
      console.error("Activate: invalid redeem payload", typeof codeData, codeData);
      return res.status(500).json({ success: false, error: "Redeem code data corrupted, contact admin" });
    }

    var productId = normalizeProductId(info.product_id);
    var months = normalizeMonths(info.duration_months);
    if (!productId || !months) {
      console.error("Activate: bad product/duration", info.product_id, info.duration_months);
      return res.status(500).json({
        success: false,
        error: "Redeem code config invalid (bad product or duration), contact admin",
      });
    }

    if (info.used) {
      if (info.used_device_id === deviceHash) {
        var activationCodeReuse = crypto.generateActivationCode(
          productId,
          device,
          months,
          code
        );
        info.generated_activation_code = activationCodeReuse;
        info.product_id = productId;
        info.duration_months = months;
        await Promise.all([
          redis.set("auth:redeem:" + code, JSON.stringify(info)),
          redis.set("auth:device:" + deviceHash, activationCodeReuse)
        ]);
        return res.json({ success: true, activationCode: activationCodeReuse });
      }
      return res.status(400).json({
        success: false,
        error: "Redeem code already used by another device",
      });
    }

    var activationCode = crypto.generateActivationCode(
      productId,
      device,
      months,
      code
    );

    var updated = {
      code: info.code || code,
      product_id: productId,
      duration_months: months,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      created_at: info.created_at || Date.now(),
      used_at: Date.now(),
    };

    var record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      device_id: device,
      product_id: productId,
      duration_months: months,
      redeem_code: code,
      generated_at: Date.now(),
    };

    var USED_COUNTER_KEY = "auth:counter:used_redeem_codes";
    await Promise.all([
      redis.set("auth:redeem:" + code, JSON.stringify(updated)),
      redis.set("auth:activation:" + activationCode, JSON.stringify(record)),
      redis.sadd("auth:activation_codes", activationCode),
      redis.set("auth:device:" + deviceHash, activationCode),
      redis.incr(USED_COUNTER_KEY).catch(function () {}),
    ]);

    return res.json({ success: true, activationCode: activationCode });
  } catch (error) {
    console.error("Activate error:", error && error.message ? error.message : error, error);
    var msg = "Internal server error, please try again later";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Server database (Postgres) not configured, contact admin";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND|Unauthorized|401|403/i.test(String(error.message || ""))) {
      msg = "Server database connection failed, try again later or contact admin";
    }
    return res.status(500).json({ success: false, error: msg });
  }
};