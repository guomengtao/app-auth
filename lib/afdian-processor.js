var redis = require("./redis");
var crypto = require("./crypto");
var afdianApi = require("./afdian-api");

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
    console.log("[afdian:processor] processOrder: missing out_trade_no");
    return { success: false, error: "Missing out_trade_no" };
  }

  console.log("[afdian:processor] processOrder start: out_trade_no=" + outTradeNo + " status=" + order.status + " plan_id=" + (order.plan_id || "N/A"));

  try {
    console.log("[afdian:processor]   checking existing Redis record...");
    var existingRaw = await redis.get("afdian:order:" + outTradeNo);
    var existing = parseRedisValue(existingRaw);
    if (existing && existing.processed) {
      console.log("[afdian:processor]   already processed in Redis, skip");
      return { success: true, already_processed: true, out_trade_no: outTradeNo };
    }
    console.log("[afdian:processor]   existing=" + (existing ? JSON.stringify(existing).substring(0, 100) : "null"));

    if (order.status !== 2) {
      console.log("[afdian:processor]   order status is " + order.status + " (not 2=completed), saving as skipped");
      await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
        out_trade_no: outTradeNo,
        status: order.status,
        processed: false,
        reason: "status_not_completed",
        created_at: Date.now(),
      }));
      return { success: true, skipped: true, reason: "status_not_completed" };
    }

    console.log("[afdian:processor]   order status=2 (completed), looking up plan->product mapping...");
    var planMap = getPlanProductMap();
    console.log("[afdian:processor]   planMap keys:", Object.keys(planMap));
    var planId = order.plan_id || "";
    var productId = planMap[planId];
    console.log("[afdian:processor]   planId=" + planId + " -> productId=" + (productId || "NOT FOUND"));

    if (!productId && order.product_type === 1) {
      console.log("[afdian:processor]   trying SKU fallback, product_type=1, sku_detail=" + JSON.stringify(order.sku_detail || []));
      var skuDetail = order.sku_detail || [];
      for (var i = 0; i < skuDetail.length; i++) {
        var skuId = skuDetail[i].sku_id;
        if (planMap[skuId]) {
          productId = planMap[skuId];
          console.log("[afdian:processor]   SKU fallback found: skuId=" + skuId + " -> productId=" + productId);
          break;
        }
      }
    }

    if (!productId) {
      console.log("[afdian:processor]   NO product mapping found, saving as skipped");
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

    console.log("[afdian:processor]   productId=" + productId + ", checking product exists in Redis...");
    var productRaw = await redis.hget("auth:products", productId);
    var productData = parseRedisValue(productRaw);
    if (!productData) {
      console.log("[afdian:processor]   product " + productId + " NOT found in auth:products, saving as skipped");
      await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
        out_trade_no: outTradeNo,
        product_id: productId,
        processed: false,
        reason: "product_not_found",
        created_at: Date.now(),
      }));
      return { success: true, skipped: true, reason: "product_not_found" };
    }
    console.log("[afdian:processor]   product found: name=" + (productData.name || "N/A"));

    var months = order.month || 1;
    var deviceId = "afdian_" + order.user_id;
    var deviceHash = crypto.sha256(deviceId);
    console.log("[afdian:processor]   months=" + months + " deviceId=" + deviceId + " deviceHash=" + deviceHash.substring(0, 16) + "...");

    console.log("[afdian:processor]   generating redeem code...");
    var redeemCode = null;
    for (var retry = 0; retry < 3; retry++) {
      var candidate = crypto.generateRedeemCode();
      var exists = await redis.get("auth:redeem:" + candidate);
      if (!exists) {
        redeemCode = candidate;
        break;
      }
      console.log("[afdian:processor]   redeem code collision: " + candidate + ", retry " + (retry + 1));
    }
    if (!redeemCode) {
      console.log("[afdian:processor]   FAILED to generate unique redeem code after 3 retries");
      return { success: false, error: "Unable to generate unique redeem code" };
    }
    console.log("[afdian:processor]   redeem code generated: " + redeemCode);

    console.log("[afdian:processor]   generating activation code...");
    var activationCode = crypto.generateActivationCode(productId, deviceId, months, redeemCode);
    console.log("[afdian:processor]   activation code generated: " + activationCode);

    var now = Date.now();
    var expiresAt = null;
    if (months !== 99) {
      var d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + months);
      expiresAt = d.getTime();
    }

    console.log("[afdian:processor]   saving to Redis: redeem=" + redeemCode + " activation=" + activationCode);

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
      user_name: order.user_name || "",
      plan_id: planId,
      plan_title: order.plan_title || "",
      product_id: productId,
      months: months,
      total_amount: order.total_amount,
      activation_code: activationCode,
      redeem_code: redeemCode,
      raw_order: order,
      processed: true,
      created_at: now,
    };

    await redis.set("afdian:order:" + outTradeNo, JSON.stringify(orderRecord));
    await redis.sadd("afdian:processed", outTradeNo);
    console.log("[afdian:processor]   Redis save complete, order marked as processed");

    if (afdianApi.isConfigured() && order.user_id) {
      try {
        console.log("[afdian:processor]   sending DM to user " + order.user_id + "...");
        var msg = "Thank you for your support! Your activation code: " + activationCode + "\n" +
          "Product: " + (productData.name || productId) + "\n" +
          "Duration: " + (months === 99 ? "Permanent" : months + " month(s)") + "\n" +
          "Device ID: " + deviceId;
        await afdianApi.sendMessage(order.user_id, msg);
        console.log("[afdian:processor]   DM sent successfully");
      } catch (e) {
        console.log("[afdian:processor]   DM send failed (non-critical):", e.message);
      }
    } else {
      console.log("[afdian:processor]   DM skipped: apiConfigured=" + afdianApi.isConfigured() + " hasUserId=" + !!order.user_id);
    }

    console.log("[afdian:processor] processOrder SUCCESS: out_trade_no=" + outTradeNo + " activation_code=" + activationCode);
    return {
      success: true,
      out_trade_no: outTradeNo,
      activation_code: activationCode,
      product_id: productId,
      months: months,
    };
  } catch (e) {
    console.error("[afdian:processor] processOrder EXCEPTION for " + outTradeNo + ":", e.message, e.stack);
    return { success: false, error: (e && e.message) || "Unknown error", out_trade_no: outTradeNo };
  }
}

module.exports = {
  processOrder: processOrder,
  getPlanProductMap: getPlanProductMap,
  parseRedisValue: parseRedisValue,
};