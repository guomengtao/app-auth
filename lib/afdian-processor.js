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

// 爱发电时间字段可能是秒级数字、毫秒数字或字符串 → 统一成毫秒；拿不到返回 0
function parseAfdianTime(v) {
  if (!v) return 0;
  var n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    var d = new Date(v);
    var t = d.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return String(Math.floor(n)).length <= 10 ? Math.floor(n) * 1000 : Math.floor(n);
}

// 从付款备注里识别设备 ID：支持裸 16~64 位 hex，以及 deviceId=xxx / #[Dd]evice[:=]xxx 写法
function extractDeviceIdFromRemark(remark) {
  var s = String(remark || "").trim();
  if (!s) return "";
  var m = s.match(/(?:deviceid|device|d)\s*[:=]\s*([0-9A-Za-z]{4,64})/i);
  if (m && m[1]) return m[1];
  var m2 = s.match(/\b[0-9a-fA-F]{16,64}\b/);
  if (m2 && m2[0]) return m2[0];
  return "";
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

    console.log("[afdian:processor]   months=99 (permanent)");

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

    var now = Date.now();

    // ⚠️ 全链路追踪需要「真实支付时间」，而 order 里的 created_at 是本系统首次处理成功的时间，
    //    两者可能差好几分钟（cron 每 3 小时才同步一次）→ 用它算「浏览→支付」会严重失真。
    var paidAt = parseAfdianTime(order.create_time || order.created_at || order.pay_time || order.paid_at);
    // 用户把 deviceId 填进付款备注时可以把它变成「订单 ↔ 设备」的硬凭据（访问侧唯一的桥）
    var orderRemark = String(order.remark || "");
    var orderDeviceId = extractDeviceIdFromRemark(orderRemark);
    if (orderDeviceId) {
      console.log("[afdian:processor]   remark contains deviceId:", orderDeviceId.slice(0, 8) + "…");
    }

    console.log("[afdian:processor]   saving redeem code to Redis...");

    var redeemData = {
      code: redeemCode,
      product_id: productId,
      duration_months: 99,
      used: false,
      used_device_id: null,
      generated_activation_code: null,
      created_at: now,
      used_at: null,
      source: "afdian",
      user_name: order.user_name || "",
      out_trade_no: outTradeNo,
      paid_at: paidAt || null,
      device_id: orderDeviceId || null,
    };

    await redis.set("auth:redeem:" + redeemCode, JSON.stringify(redeemData));
    await redis.sadd("auth:redeem_codes", redeemCode);
    console.log("[afdian:processor]   redeem code saved to Redis: " + redeemCode);

    var orderRecord = {
      out_trade_no: outTradeNo,
      user_id: order.user_id,
      user_name: order.user_name || "",
      plan_id: planId,
      plan_title: order.plan_title || "",
      product_id: productId,
      months: 99,
      total_amount: order.total_amount,
      redeem_code: redeemCode,
      processed: true,
      created_at: now,
      paid_at: paidAt || null,          // 爱发电真实下单/支付时间（原 created_at 是本系统处理时间）
      remark: orderRemark || "",
      device_id: orderDeviceId || null, // 备注里带的设备 ID（有则是订单↔访问的硬凭据）
    };

    var dmResult = { sent: 0, error: null };

    if (afdianApi.isConfigured() && order.user_id) {
      var dmKey = "afdian:dm_sent:" + outTradeNo;
      var dmSentCountRaw = await redis.get(dmKey);
      var dmSentCount = parseInt(dmSentCountRaw, 10) || 0;

      if (dmSentCount >= 3) {
        console.log("[afdian:processor]   All DMs already sent for this order (dedup), skip");
        dmResult = { sent: 3, skipped: true, reason: "already_sent" };
      } else {
        var productName = productData.name || productId;
        var dmErrors = [];

        if (dmSentCount < 1) {
          try {
            var msg1 = "🎉 感谢您赞助 " + productName + " 永久高级版！\n\n您的兑换码：" + redeemCode;
            console.log("[afdian:processor]   sending DM #1 to user " + order.user_id + "...");
            var resp1 = await afdianApi.sendMessage(order.user_id, msg1);
            if (resp1 && resp1.ec === 200) {
              dmSentCount = 1;
              await redis.set(dmKey, String(dmSentCount));
              orderRecord.dm_sent = true;
              orderRecord.dm_sent_at = new Date().toISOString();
              await logDmSend("system", order.user_id, order.user_name || "", msg1, true, null, resp1.em || "ok");
              console.log("[afdian:processor]   DM #1 sent successfully");
            } else {
              var err1 = "ec=" + (resp1 && resp1.ec) + " em=" + (resp1 && resp1.em);
              dmErrors.push("DM #1: " + err1);
              await logDmSend("system", order.user_id, order.user_name || "", msg1, false, err1, null);
              console.log("[afdian:processor]   DM #1 failed:", dmErrors[dmErrors.length - 1]);
            }
          } catch (e) {
            dmErrors.push("DM #1: " + e.message);
            await logDmSend("system", order.user_id, order.user_name || "", msg1, false, e.message, null);
            console.log("[afdian:processor]   DM #1 error:", e.message);
          }
        }

        if (dmSentCount >= 1 && dmSentCount < 2) {
          try {
            var msg2 = "如有疑问欢迎回复~ 祝使用愉快！";
            console.log("[afdian:processor]   sending DM #2 to user " + order.user_id + "...");
            var resp2 = await afdianApi.sendMessage(order.user_id, msg2);
            if (resp2 && resp2.ec === 200) {
              dmSentCount = 2;
              await redis.set(dmKey, String(dmSentCount));
              await logDmSend("system", order.user_id, order.user_name || "", msg2, true, null, resp2.em || "ok");
              console.log("[afdian:processor]   DM #2 sent successfully");
            } else {
              var err2 = "ec=" + (resp2 && resp2.ec) + " em=" + (resp2 && resp2.em);
              dmErrors.push("DM #2: " + err2);
              await logDmSend("system", order.user_id, order.user_name || "", msg2, false, err2, null);
              console.log("[afdian:processor]   DM #2 failed:", dmErrors[dmErrors.length - 1]);
            }
          } catch (e) {
            dmErrors.push("DM #2: " + e.message);
            await logDmSend("system", order.user_id, order.user_name || "", msg2, false, e.message, null);
            console.log("[afdian:processor]   DM #2 error:", e.message);
          }
        }

        if (dmSentCount >= 2 && dmSentCount < 3) {
          try {
            var msg3 = "安装步骤指导：https://app-auth.gudq.com/user-guide.html?ev";
            console.log("[afdian:processor]   sending DM #3 to user " + order.user_id + "...");
            var resp3 = await afdianApi.sendMessage(order.user_id, msg3);
            if (resp3 && resp3.ec === 200) {
              dmSentCount = 3;
              await redis.set(dmKey, String(dmSentCount));
              await logDmSend("system", order.user_id, order.user_name || "", msg3, true, null, resp3.em || "ok");
              console.log("[afdian:processor]   DM #3 sent successfully");
            } else {
              var err3 = "ec=" + (resp3 && resp3.ec) + " em=" + (resp3 && resp3.em);
              dmErrors.push("DM #3: " + err3);
              await logDmSend("system", order.user_id, order.user_name || "", msg3, false, err3, null);
              console.log("[afdian:processor]   DM #3 failed:", dmErrors[dmErrors.length - 1]);
            }
          } catch (e) {
            dmErrors.push("DM #3: " + e.message);
            await logDmSend("system", order.user_id, order.user_name || "", msg3, false, e.message, null);
            console.log("[afdian:processor]   DM #3 error:", e.message);
          }
        }

        if (dmErrors.length > 0) {
          orderRecord.dm_error = dmErrors.join("; ");
          dmResult = { sent: dmSentCount, error: dmErrors.join("; ") };
        } else {
          dmResult = { sent: dmSentCount };
        }
      }
    } else {
      console.log("[afdian:processor]   DM skipped: apiConfigured=" + afdianApi.isConfigured() + " hasUserId=" + !!order.user_id);
    }

    await redis.set("afdian:order:" + outTradeNo, JSON.stringify(orderRecord));
    await redis.sadd("afdian:processed", outTradeNo);
    // 统一事件流：支付订单 + 发放兑换码两个节点（dedupe_key 保证回填/重跑不重复）
    try {
      var tracking = require("./tracking");
      await tracking.record({
        ts: Number(orderRecord.paid_at) || now,
        kind: "order",
        deviceId: orderDeviceId || "",
        redeemCode: redeemCode,
        outTradeNo: outTradeNo,
        channel: "",
        payload: {
          user_name: orderRecord.user_name || "", amount: orderRecord.total_amount || "",
          plan_title: orderRecord.plan_title || "", product_id: productId,
          paid_at: orderRecord.paid_at || null, processed_at: now,
        },
        dedupeKey: "or:" + outTradeNo,
      });
      await tracking.record({
        ts: Number(redeemData.paid_at) || now,
        kind: "redeem",
        deviceId: orderDeviceId || "",
        redeemCode: redeemCode,
        outTradeNo: outTradeNo,
        channel: "",
        payload: { source: "afdian", product_id: productId, months: 99 },
        dedupeKey: "rd:" + redeemCode,
      });
    } catch (te) {
      console.warn("[afdian:processor] tracking event failed (non-blocking):", te && te.message);
    }
    console.log("[afdian:processor]   Redis save complete, order marked as processed");

    console.log("[afdian:processor] processOrder SUCCESS: out_trade_no=" + outTradeNo + " redeem_code=" + redeemCode + " dm_sent=" + dmResult.sent);
    return {
      success: true,
      out_trade_no: outTradeNo,
      redeem_code: redeemCode,
      product_id: productId,
      months: 99,
      dm_sent: dmResult.sent,
      dm_error: dmResult.error || null,
      // 全链路追踪需要的补充字段（调用方会一起放进 new_order 推送 payload）
      paid_at: paidAt || null,
      device_id: orderDeviceId || null,
      remark: orderRemark || "",
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
  logDmSend: logDmSend,
  parseAfdianTime: parseAfdianTime,
  extractDeviceIdFromRemark: extractDeviceIdFromRemark,
};

async function logDmSend(source, userId, userName, content, success, error, response) {
  try {
    var entry = {
      time: new Date().toISOString(),
      source: source,
      user_id: userId || "",
      user_name: userName || "",
      content: content || "",
      success: !!success,
      error: error || null,
      response: response || null,
    };
    await redis.lpush("afdian:dm_logs", JSON.stringify(entry));
    await redis.ltrim("afdian:dm_logs", 0, 199);
    console.log("[afdian:processor] DM log saved: source=" + source + " user=" + userId + " success=" + success);
  } catch (e) {
    console.error("[afdian:processor] DM log save failed:", e.message);
  }
}