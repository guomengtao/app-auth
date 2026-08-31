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
    return res.status(405).json({ success: false, error: "请求方法不允许" });
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

    var info = parseRedisJson(codeData);
    if (!info) {
      console.error("Activate: invalid redeem payload", typeof codeData, codeData);
      return res.status(500).json({ success: false, error: "兑换码数据异常，请联系管理员" });
    }

    var productId = normalizeProductId(info.product_id);
    var months = normalizeMonths(info.duration_months);
    if (!productId || !months) {
      console.error("Activate: bad product/duration", info.product_id, info.duration_months);
      return res.status(500).json({
        success: false,
        error: "兑换码配置异常（产品或有效期无效），请联系管理员",
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
        await redis.set("auth:redeem:" + code, JSON.stringify(info));
        await redis.set("auth:device:" + deviceHash, activationCodeReuse);
        return res.json({ success: true, activationCode: activationCodeReuse });
      }
      return res.status(400).json({
        success: false,
        error: "该兑换码已被其他设备激活使用",
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
    await redis.set("auth:redeem:" + code, JSON.stringify(updated));

    var record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      product_id: productId,
      duration_months: months,
      redeem_code: code,
      generated_at: Date.now(),
    };
    await redis.set("auth:activation:" + activationCode, JSON.stringify(record));
    await redis.sadd("auth:activation_codes", activationCode);

    await redis.set("auth:device:" + deviceHash, activationCode);

    return res.json({ success: true, activationCode: activationCode });
  } catch (error) {
    console.error("Activate error:", error && error.message ? error.message : error, error);
    return res.status(500).json({ success: false, error: "服务器内部错误，请稍后重试" });
  }
};