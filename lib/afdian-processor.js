var redis = require("./redis");
var crypto = require("./crypto");
var afdianApi = require("./afdian-api");
var afdianDm = require("./afdian-dm");
var notify = require("./notify");

// 私信即时发送的时间预算：处理（DB + 渠道反查）已耗时超过它，就直接留给队列重试，
// 避免「webhook 已经跑了 8 秒，再花 8 秒发私信」把函数顶到平台上限。
var INLINE_DM_BUDGET_MS = 20000;

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
  var procStartedAt = Date.now();

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

    // ── 私信阶段（顺序即安全边界，详见 lib/afdian-dm.js 头注释）────────────────
    // 旧版在这里同步连发 3 条，且排在订单落库**之前**：函数一旦被掐断，钱付了、码生成了、
    // 记录没写，买家什么也拿不到；三条 2 秒内连发还会被爱发电吞掉前两条（10-26 实证）。
    // 现在：合并成 1 条 → 先入队 → 再落库 → 最后才发送。
    var dmResult = { sent: 0, error: null };
    var dmJob = null;

    if (afdianApi.isConfigured() && order.user_id) {
      var dmCounterKey = "afdian:dm_sent:" + outTradeNo;
      var dmSentCount = 0;
      try {
        dmSentCount = parseInt(await redis.get(dmCounterKey), 10) || 0;
      } catch (de) {
        console.log("[afdian:processor]   DM progress read failed (assume 0):", de && de.message);
      }

      if (dmSentCount >= 3) {
        console.log("[afdian:processor]   All 3 DMs already sent for this order (dedup), skip");
        dmResult = { sent: 3, skipped: true, reason: "already_sent" };
        orderRecord.dm_sent = true;
      } else {
        var productName = productData.name || productId;
        // P1（§4.1/§4.2）：激活链接带 u（用户识别码）/ o（订单号）/ c（渠道）/ g（分组）
        // ⚠️ 只**追加**参数，`code` 的位置与语义完全不变 —— 已发出去的旧链接（只带 code）继续可用。
        var activateUrl =
          "https://app-auth.gudq.com/deep-link-test.html?code=" + encodeURIComponent(redeemCode) +
          "&u=" + encodeURIComponent(orderUidCode) +
          "&o=" + encodeURIComponent(outTradeNo) +
          "&c=" + encodeURIComponent(orderChannel) +
          "&g=activate";
        var guideUrl =
          "https://app-auth.gudq.com/user-guide.html?ev" +
          "&u=" + encodeURIComponent(orderUidCode) +
          "&c=" + encodeURIComponent(orderChannel) +
          "&g=guide";
        dmJob = afdianDm.buildOrderJob({
          out_trade_no: outTradeNo,
          user_id: order.user_id,
          user_name: order.user_name || "",
          product_name: productName,
          code: redeemCode,
          activate_url: activateUrl,
          guide_url: guideUrl,
          source: "afdian",
          sent_count: dmSentCount,   // 断点续发：已发过的条数不再重发
        });
        try {
          await afdianDm.enqueue(dmJob);
          orderRecord.dm_queued = true;
          orderRecord.dm_sent_count = dmSentCount;
          console.log("[afdian:processor]   3 DMs queued (resume from #" + (dmSentCount + 1) + ")");
        } catch (qe) {
          // 入队失败也不能拦着发码：退化成「只发送、不重试」
          console.error("[afdian:processor]   DM enqueue failed (will still try inline):", qe && qe.message);
        }
      }
    } else {
      console.log("[afdian:processor]   DM skipped: apiConfigured=" + afdianApi.isConfigured() + " hasUserId=" + !!order.user_id);
    }

    // ⚠️ 订单记录与 processed 标记必须在动私信之前落库：私信再慢也不连累发码
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

    // 订单已落库，到这里才真正发私信：预算内即时发一条，超预算/失败就留给队列重试。
    // 无论这里发生什么，订单、兑换码、processed 标记都已经是安全状态。
    if (dmJob) {
      var elapsedMs = Date.now() - procStartedAt;
      var dmBudgetMs = INLINE_DM_BUDGET_MS - elapsedMs;
      if (dmBudgetMs <= 8000) {
        console.log("[afdian:processor]   DM deferred to queue: processing already took " + elapsedMs + "ms");
        dmResult = { sent: dmJob.sent_count || 0, queued: true, error: null };
        orderRecord.dm_sent = false;
      } else {
        var dmSend = await afdianDm.attemptNow(dmJob, { budgetMs: dmBudgetMs });
        var doneCount = dmSend.sent_count || 0;
        var allDone = doneCount >= 3;
        dmResult = { sent: doneCount, queued: !allDone, error: dmSend.error || null };
        orderRecord.dm_sent = allDone;
        orderRecord.dm_sent_count = doneCount;
        if (allDone) {
          orderRecord.dm_sent_at = new Date().toISOString();
          delete orderRecord.dm_queued;
          delete orderRecord.dm_error;
          console.log("[afdian:processor]   all 3 DMs sent");
        } else {
          orderRecord.dm_error = dmSend.error || (dmSend.deferred ? "deferred_budget" : "unknown");
          console.log("[afdian:processor]   DM progress " + doneCount + "/3, left in queue for retry" + (dmSend.error ? " (" + dmSend.error + ")" : ""));
        }
      }
      // 无论即时发成功、失败还是延后，都把私信状态回写到订单记录（后台排查靠它）
      try {
        await redis.set("afdian:order:" + outTradeNo, JSON.stringify(orderRecord));
      } catch (ue) {
        console.error("[afdian:processor]   order record dm status update failed:", ue && ue.message);
      }
    }

    console.log("[afdian:processor] processOrder SUCCESS: out_trade_no=" + outTradeNo + " redeem_code=" + redeemCode + " dm_sent=" + dmResult.sent + (dmResult.queued ? " dm_queued=true" : ""));
    return {
      success: true,
      out_trade_no: outTradeNo,
      redeem_code: redeemCode,
      product_id: productId,
      months: 99,
      dm_sent: dmResult.sent,
      dm_queued: !!dmResult.queued,
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
  logDmSend: afdianDm.logDmSend,
  parseAfdianTime: parseAfdianTime,
  extractDeviceIdFromRemark: extractDeviceIdFromRemark,
  // P1（§4.1）—— 导出供自测与后台复用
  orderUid: orderUid,
  resolveOrderChannel: resolveOrderChannel,
};

// 私信日志统一由 lib/afdian-dm.js 维护（module.exports 已指向它，外部调用方无需改动）