const redis = require("../lib/redis");
const { generateActivationCode, sha256 } = require("../lib/crypto");
const { validateRedeemCode, validateDeviceId } = require("../lib/validate");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { deviceId, redeemCode } = req.body || {};

    const deviceCheck = validateDeviceId(deviceId);
    if (!deviceCheck.valid) {
      return res.status(400).json({ success: false, error: deviceCheck.error });
    }

    const codeCheck = validateRedeemCode(redeemCode);
    if (!codeCheck.valid) {
      return res.status(400).json({ success: false, error: codeCheck.error });
    }

    const code = codeCheck.value;
    const deviceHash = sha256(deviceCheck.value);

    const codeData = await redis.get(`auth:redeem:${code}`);
    if (!codeData) {
      return res.status(400).json({ success: false, error: "无效兑换码" });
    }

    const info = typeof codeData === "string" ? JSON.parse(codeData) : codeData;

    if (info.used) {
      if (info.used_device_id === deviceHash) {
        const activationCode = generateActivationCode(info.product_id, deviceCheck.value, info.duration_days, code);
        info.generated_activation_code = activationCode;
        await redis.set(`auth:redeem:${code}`, JSON.stringify(info));
        await redis.set(`auth:device:${deviceHash}`, activationCode);
        return res.json({ success: true, activationCode });
      }
      return res.status(400).json({
        success: false,
        error: "该兑换码已被其他设备使用",
      });
    }

    const activationCode = generateActivationCode(info.product_id, deviceCheck.value, info.duration_days, code);

    const updated = {
      ...info,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      used_at: Date.now(),
    };
    await redis.set(`auth:redeem:${code}`, JSON.stringify(updated));

    const record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      product_id: info.product_id,
      duration_days: info.duration_days,
      generated_at: Date.now(),
      expires_at:
        info.duration_days === 9999
          ? null
          : Date.now() + info.duration_days * 24 * 60 * 60 * 1000,
    };
    await redis.set(`auth:activation:${activationCode}`, JSON.stringify(record));
    await redis.sadd("auth:activation_codes", activationCode);

    await redis.set(`auth:device:${deviceHash}`, activationCode);

    return res.json({ success: true, activationCode });
  } catch (error) {
    console.error("Activate error:", error);
    return res.status(500).json({ success: false, error: "服务器内部错误" });
  }
};