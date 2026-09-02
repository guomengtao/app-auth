var redis = require("../../lib/redis");
var crypto = require("../../lib/crypto");
var afdianSign = require("../../lib/afdian-sign");
var afdianApi = require("../../lib/afdian-api");

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

function parseRedisValue(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function getPlanProductMap() {
  var mapStr = process.env.AFDIAN_PLAN_MAP || "{}";
  try {
    return JSON.parse(mapStr);
  } catch (e) {
    return {};
  }
}

async function processOrder(order) {
  var outTradeNo = order.out_trade_no;
  if (!outTradeNo) {
    return { success: false, error: "Missing out_trade_no" };
  }

  var existing = await redis.get("afdian:order:" + outTradeNo);
  if (existing) {
    return { success: true, already_processed: true, out_trade_no: outTradeNo };
  }

  if (order.status !== 2) {
    await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
      out_trade_no: outTradeNo,
      status: order.status,
      processed: false,
      reason: "status_not_completed",
      created_at: Date.now(),
    }));
    return { success: true, skipped: true, reason: "status_not_completed" };
  }

  var planMap = getPlanProductMap();
  var planId = order.plan_id || "";
  var productId = planMap[planId];

  if (!productId && order.product_type === 1) {
    var skuDetail = order.sku_detail || [];
    for (var i = 0; i < skuDetail.length; i++) {
      var skuId = skuDetail[i].sku_id;
      if (planMap[skuId]) {
        productId = planMap[skuId];
        break;
      }
    }
  }

  if (!productId) {
    await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
      out_trade_no: outTradeNo,
      plan_id: planId,
      product_type: order.product_type,
      processed: false,
      reason: "no_product_mapping",
      created_at: Date.now(),
    }));
    return { success: true, skipped: true, reason: "no_product_mapping", plan_id: planId };
  }

  var productRaw = await redis.hget("auth:products", productId);
  var productData = parseRedisValue(productRaw);
  if (!productData) {
    await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
      out_trade_no: outTradeNo,
      product_id: productId,
      processed: false,
      reason: "product_not_found",
      created_at: Date.now(),
    }));
    return { success: true, skipped: true, reason: "product_not_found" };
  }

  var months = order.month || 1;
  var deviceId = "afdian_" + order.user_id;
  var deviceHash = crypto.sha256(deviceId);

  var redeemCode = null;
  for (var retry = 0; retry < 3; retry++) {
    var candidate = crypto.generateRedeemCode();
    var exists = await redis.get("auth:redeem:" + candidate);
    if (!exists) {
      redeemCode = candidate;
      break;
    }
  }
  if (!redeemCode) {
    return { success: false, error: "Unable to generate unique redeem code" };
  }

  var activationCode = crypto.generateActivationCode(productId, deviceId, months, redeemCode);

  var now = Date.now();
  var expiresAt = null;
  if (months !== 99) {
    var d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() + months);
    expiresAt = d.getTime();
  }

  var redeemData = {
    code: redeemCode,
    product_id: productId,
    duration_months: months,
    used: true,
    used_device_id: deviceHash,
    generated_activation_code: activationCode,
    created_at: now,
    used_at: now,
    source: "afdian",
  };

  var recordData = {
    activation_code: activationCode,
    device_id_hash: deviceHash,
    device_id: deviceId,
    product_id: productId,
    duration_months: months,
    redeem_code: redeemCode,
    created_at: now,
    expires_at: expiresAt,
    source: "afdian",
    afdian_order_no: outTradeNo,
  };

  var recordKey = "auth:activation:" + activationCode;

  await redis.set("auth:redeem:" + redeemCode, JSON.stringify(redeemData));
  await redis.set(recordKey, JSON.stringify(recordData));
  await redis.sadd("auth:activation_codes", activationCode);

  var orderRecord = {
    out_trade_no: outTradeNo,
    user_id: order.user_id,
    plan_id: planId,
    product_id: productId,
    months: months,
    total_amount: order.total_amount,
    activation_code: activationCode,
    redeem_code: redeemCode,
    processed: true,
    created_at: now,
  };

  await redis.set("afdian:order:" + outTradeNo, JSON.stringify(orderRecord));
  await redis.sadd("afdian:processed", outTradeNo);

  if (afdianApi.isConfigured() && order.user_id) {
    try {
      var msg = "Thank you for your support! Your activation code: " + activationCode + "\n" +
        "Product: " + (productData.name || productId) + "\n" +
        "Duration: " + (months === 99 ? "Permanent" : months + " month(s)") + "\n" +
        "Device ID: " + deviceId;
      await afdianApi.sendMessage(order.user_id, msg);
    } catch (e) {
      // DM send failure is non-critical
    }
  }

  return {
    success: true,
    out_trade_no: outTradeNo,
    activation_code: activationCode,
    product_id: productId,
    months: months,
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ec: 405, em: "Method not allowed" });
  }

  try {
    var body = parseBody(req);

    if (!body || !body.data || !body.data.order) {
      return res.status(200).json({ ec: 200, em: "" });
    }

    var order = body.data.order;
    var sign = body.data.sign;

    if (sign) {
      var signStr = (order.out_trade_no || "") +
        (order.user_id || "") +
        (order.plan_id || "") +
        (order.total_amount || "0.00");
      var valid = afdianSign.verifyWebhookSignSimple(signStr, sign);
      if (!valid) {
        return res.status(200).json({ ec: 200, em: "sign_verify_failed" });
      }
    }

    var result = await processOrder(order);

    return res.status(200).json({ ec: 200, em: "" });
  } catch (e) {
    return res.status(200).json({ ec: 200, em: "" });
  }
};