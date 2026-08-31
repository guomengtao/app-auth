var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId } = require("../lib/validate");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var { deviceId, redeemCode } = req.body || {};

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

    var info = typeof codeData === "string" ? JSON.parse(codeData) : codeData;

    if (info.used) {
      if (info.used_device_id === deviceHash) {
        var activationCode = crypto.generateActivationCode(
          info.product_id,
          device,
          info.duration_months,
          code
        );
        info.generated_activation_code = activationCode;
        await redis.set("auth:redeem:" + code, JSON.stringify(info));
        await redis.set("auth:device:" + deviceHash, activationCode);
        return res.json({ success: true, activationCode: activationCode });
      }
      return res.status(400).json({
        success: false,
        error: "This redeem code has been used by another device",
      });
    }

    var activationCode = crypto.generateActivationCode(
      info.product_id,
      device,
      info.duration_months,
      code
    );

    var updated = {
      code: info.code,
      product_id: info.product_id,
      duration_months: info.duration_months,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      created_at: info.created_at,
      used_at: Date.now(),
    };
    await redis.set("auth:redeem:" + code, JSON.stringify(updated));

    var record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      product_id: info.product_id,
      duration_months: info.duration_months,
      redeem_code: code,
      generated_at: Date.now(),
    };
    await redis.set("auth:activation:" + activationCode, JSON.stringify(record));
    await redis.sadd("auth:activation_codes", activationCode);

    await redis.set("auth:device:" + deviceHash, activationCode);

    return res.json({ success: true, activationCode: activationCode });
  } catch (error) {
    console.error("Activate error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};