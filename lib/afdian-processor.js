var redis = require("./redis");
var crypto = require("./crypto");
var afdianApi = require("./afdian-api");
var notify = require("./notify");

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

// ---------------------------------------------------------------------------
// P1（§4.1）：订单侧的「用户独立识别码」与「渠道」
// ---------------------------------------------------------------------------

// 用户独立识别码：od- + <订单号派生短码>。
// 「订单已经收到」→ 这里可以确定性生成，无需用户登录。
// 纯数字订单号取末 10 位转 base36（订单号末位最随机，且不依赖 BigInt）；
// 含非数字时退化为多项式哈希。**只作短句柄**，完整订单号另有 `o=` 参数承载。
function orderUid(outTradeNo) {
  var s = String(outTradeNo || "").trim();
  if (!s) return "";
  var digits = s.replace(/\D/g, "");
  var base;
  if (digits.length >= 10) {
    // 末 12 位在 Number 的安全整数范围内（≤ 1e12 < 2^53），不同订单号末 12 位不同 → 不撞码。
    // padStart 只是为了短号也好看（如 …00009 → 000009），不影响唯一性。
    base = Number(digits.slice(-12)).toString(36);
    while (base.length < 6) base = "0" + base;
  } else {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % 2147483647;
    }
    base = h.toString(36);
  }
  return "od-" + base.slice(-8);
}

// 订单渠道（优先级见 §4.1）：
//   1) 备注里的 deviceId → 该设备最近一次带渠道的访问（确定性凭据，主力）
//   2) 订单 IP（爱发电回调通常没有；有才用）在支付前 24h 内的渠道
//   3) 兜底 afdian-dm（私信来源）
async function resolveOrderChannel(order, deviceId, paidAt) {
  var tracking = require("./tracking");
  if (deviceId) {
    var byDevice = await tracking.latestChannelForDevice(deviceId);
    if (byDevice) return { channel: byDevice, basis: "remark-device" };
  }
  var ip = String((order && (order.client_ip || order.ip)) || "").trim();
  if (ip) {
    var byIp = await tracking.latestChannelForIp(ip, paidAt || Date.now(), 24 * 3600 * 1000);
    if (byIp) return { channel: byIp, basis: "same-ip-24h" };
  }
  return { channel: "afdian-dm", basis: "fallback" };
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
      // 2026-10-06：这里原本是「静默跳过」——买家付了钱、既拿不到兑换码也收不到私信，
      // 而线上只留一行 console.log，没人会知道。实测已有一笔受害者订单躺了 5 年
      // （out_trade_no=202106232138371083454010626，plan_id=a45353328af911eb973052540025c377）。
      // 现在补一条主动告警：让 AFDIAN_PLAN_MAP 漏配变成「会被发现」而不是「等买家来问」。
      try {
        await notify.pushNotification("afdian_no_mapping", {
          out_trade_no: outTradeNo,
          plan_id: planId,
          product_type: order.product_type,
          total_amount: order.total_amount || "",
          user_id: order.user_id || "",
          reason: "AFDIAN_PLAN_MAP 未覆盖该 plan_id，付款未自动发码，请补配后重跑发码",
        });
      } catch (e) {
        console.error("[afdian:processor] no-mapping alert failed:", e && e.message);
      }
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

    // P1（§4.1）：用户独立识别码 + 订单渠道。
    // 渠道反查要查库，失败一律降级为兜底值，**绝不影响发码/发私信**。
    var orderUidCode = orderUid(outTradeNo);
    var channelInfo = { channel: "afdian-dm", basis: "fallback" };
    try {
      channelInfo = await resolveOrderChannel(order, orderDeviceId, paidAt);
    } catch (ce) {
      console.log("[afdian:processor]   channel resolve failed (non-blocking):", ce && ce.message);
    }
    var orderChannel = channelInfo.channel || "afdian-dm";
    console.log("[afdian:processor]   uid=" + orderUidCode + " channel=" + orderChannel + " basis=" + channelInfo.basis);

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
      // P1（§4.1）：兑换码记录里也存一份 → 激活时能直接读出「码 ↔ 订单 ↔ 渠道」，
      // 不必再从跟踪事件里反查（老码没有这两个字段，读取侧按缺省处理）。
      uid: orderUidCode,
      channel: orderChannel,
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
      // P1（§4.1）：订单侧追踪字段
      uid: orderUidCode,                // 用户独立识别码（od-xxxxxxxx）
      channel: orderChannel,            // 订单渠道（带优先级的反查结果）
      channel_basis: channelInfo.basis, // 渠道来源依据，便于后台核对（remark-device / same-ip-24h / fallback）
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
            // P1（§4.1）：激活链接带 u（用户识别码）/ o（订单号）/ c（渠道）/ g（分组）
            // ⚠️ 只**追加**参数，`code` 的位置与语义完全不变 —— 已发出去的旧链接（只带 code）继续可用。
            var activateUrl =
              "https://app-auth.gudq.com/deep-link-test.html?code=" + encodeURIComponent(redeemCode) +
              "&u=" + encodeURIComponent(orderUidCode) +
              "&o=" + encodeURIComponent(outTradeNo) +
              "&c=" + encodeURIComponent(orderChannel) +
              "&g=activate";
            var msg1 = "🎉 感谢您赞助 " + productName + " 永久高级版！\n\n您的激活链接（点开自动激活）：" + activateUrl;
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
            // P1（§4.2）：指导页带同一套溯源参数（`?ev` 是原有的裸参数，保留不动）
            var guideUrl =
              "https://app-auth.gudq.com/user-guide.html?ev" +
              "&u=" + encodeURIComponent(orderUidCode) +
              "&c=" + encodeURIComponent(orderChannel) +
              "&g=guide";
            var msg3 = "安装步骤指导：" + guideUrl;
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
        client: "server",   // 爱发电是服务端回调，没有客户端身份（deviceId 来自备注反查）
        redeemCode: redeemCode,
        outTradeNo: outTradeNo,
        channel: orderChannel,
        payload: {
          user_name: orderRecord.user_name || "", amount: orderRecord.total_amount || "",
          plan_title: orderRecord.plan_title || "", product_id: productId,
          paid_at: orderRecord.paid_at || null, processed_at: now,
          uid: orderUidCode, channel_basis: channelInfo.basis,
        },
        dedupeKey: "or:" + outTradeNo,
      });
      await tracking.record({
        ts: Number(redeemData.paid_at) || now,
        kind: "redeem",
        deviceId: orderDeviceId || "",
        client: "server",
        redeemCode: redeemCode,
        outTradeNo: outTradeNo,
        channel: orderChannel,
        payload: { source: "afdian", product_id: productId, months: 99, uid: orderUidCode },
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
  // P1（§4.1）—— 导出供自测与后台复用
  orderUid: orderUid,
  resolveOrderChannel: resolveOrderChannel,
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