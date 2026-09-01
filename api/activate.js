var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId } = require("../lib/validate");
var quota = require("../lib/quota");

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
  try { quota.bumpQuotaTick("/api/activate"); } catch (_) {}
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "请求方式不正确" });
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
      return res.status(400).json({ success: false, error: "兑换码不存在或尚未同步到服务器，请在管理后台同步后重试" });
    }

    var info = parseRedisJson(codeData);
    if (!info) {
      console.error("Activate: invalid redeem payload", typeof codeData, codeData);
      return res.status(500).json({ success: false, error: "兑换码数据已损坏，请联系管理员" });
    }

    var productId = normalizeProductId(info.product_id);
    var months = normalizeMonths(info.duration_months);
    if (!productId || !months) {
      console.error("Activate: bad product/duration", info.product_id, info.duration_months);
      return res.status(500).json({
        success: false,
        error: "兑换码配置异常（商品或时长无效），请联系管理员",
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
        var reuseNow = Date.now();
        var reuseExpires = null;
        if (months !== 99) {
          var existingRecordRaw = await redis.get("auth:activation:" + activationCodeReuse);
          var existing = parseRedisJson(existingRecordRaw);
          var baseTs = reuseNow;
          if (existing && existing.expires_at && Number(existing.expires_at) > baseTs) {
            baseTs = Number(existing.expires_at);
          }
          var rd = new Date(baseTs);
          rd.setUTCMonth(rd.getUTCMonth() + months);
          reuseExpires = rd.getTime();
        }
        var mergedRecord = null;
        if (activationCodeReuse) {
          var _existingRaw = await redis.get("auth:activation:" + activationCodeReuse);
          var _existing = parseRedisJson(_existingRaw) || {};
          mergedRecord = Object.assign({}, _existing, {
            activation_code: activationCodeReuse,
            device_id_hash: deviceHash,
            device_id: device,
            product_id: productId,
            duration_months: months,
            redeem_code: code,
            generated_at: _existing.generated_at || reuseNow,
            expires_at: reuseExpires,
          });
        }
        info.generated_activation_code = activationCodeReuse;
        info.product_id = productId;
        info.duration_months = months;
        info.used_at = reuseNow;
        var tasks = [
          redis.set("auth:redeem:" + code, JSON.stringify(info)),
          redis.set("auth:device:" + deviceHash, activationCodeReuse),
        ];
        if (mergedRecord) {
          tasks.push(redis.set("auth:activation:" + activationCodeReuse, JSON.stringify(mergedRecord)));
          tasks.push(redis.sadd("auth:activation_codes", activationCodeReuse).catch(function () {}));
        }
        await Promise.all(tasks);
        return res.json({ success: true, activationCode: activationCodeReuse });
      }
      return res.status(400).json({
        success: false,
        error: "该兑换码已被其他设备使用过，无法重复激活",
      });
    }

    var activationCode = crypto.generateActivationCode(
      productId,
      device,
      months,
      code
    );

    var now = Date.now();
    var expiresAt = null;
    if (months !== 99) {
      var d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + months);
      expiresAt = d.getTime();
    }

    var updated = {
      code: info.code || code,
      product_id: productId,
      duration_months: months,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      created_at: info.created_at || now,
      used_at: now,
    };

    var record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      device_id: device,
      product_id: productId,
      duration_months: months,
      redeem_code: code,
      generated_at: now,
      expires_at: expiresAt,
    };

    var USED_COUNTER_KEY = "auth:counter:used_redeem_codes";
    await Promise.all([
      redis.set("auth:redeem:" + code, JSON.stringify(updated)),
      redis.set("auth:activation:" + activationCode, JSON.stringify(record)),
      redis.sadd("auth:activation_codes", activationCode),
      redis.set("auth:device:" + deviceHash, activationCode),
      redis.incr(USED_COUNTER_KEY).catch(function () {}),
    ]);
    console.log("✅ Activate success:", {
      redeemCode: code,
      activationCode: activationCode,
      productId: productId,
      deviceHash: deviceHash.slice(0, 8) + "...",
      months: months,
    });

    return res.json({ success: true, activationCode: activationCode });
  } catch (error) {
    console.error("Activate error:", error && error.message ? error.message : error, error);
    var msg = "服务器内部错误，请稍后重试";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "服务器数据库未配置，请联系管理员（缺少 POSTGRES_URL 环境变量）";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND|Unauthorized|401|403/i.test(String(error.message || ""))) {
      msg = "服务器数据库连接失败，请稍后重试或联系管理员";
    }
    return res.status(500).json({ success: false, error: msg });
  }
};