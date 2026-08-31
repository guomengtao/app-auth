var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId } = require("../lib/validate");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "请求方法不允许" });
  }

  try {
    var { deviceId, redeemCode } = req.body || {};

    var deviceCheck = validateDeviceId(deviceId);
    if (!deviceCheck.valid) {
      return res.status(400).json({ success: false, error: deviceCheck.error });
    }

    var codeCheck = validateRedeemCode(redeemCode);
    if (!codeCheck.valid) {
      var errMsg = codeCheck.error;
      if (errMsg.indexOf("Redeem code is required") >= 0) errMsg = "请输入兑换码";
      else if (errMsg.indexOf("Redeem code must be") >= 0) errMsg = "兑换码必须为4位大写字母或数字（A-Z, 0-9）";
      return res.status(400).json({ success: false, error: errMsg });
    }

    var code = codeCheck.value;
    var device = deviceCheck.value;
    var deviceHash = crypto.sha256(device);

    var codeData = await redis.get("auth:redeem:" + code);
    if (!codeData) {
      return res.status(400).json({ success: false, error: "兑换码无效，请检查后重试" });
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
        error: "该兑换码已被其他设备激活使用",
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
    return res.status(500).json({ success: false, error: "服务器内部错误，请稍后重试" });
  }
};