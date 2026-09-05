var redis = require("../../lib/redis");
var afdianApi = require("../../lib/afdian-api");
var afdianProcessor = require("../../lib/afdian-processor");
var { requireAuth } = require("../../lib/auth");

async function processBatchOrders(orders) {
  var newOrders = 0;
  var processedCount = 0;
  var skippedCount = 0;
  var errorCount = 0;

  console.log("[afdian:sync] processBatchOrders start, total orders:", orders.length);

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    var outTradeNo = order.out_trade_no;
    if (!outTradeNo) {
      console.log("[afdian:sync]   order[" + i + "] skip: no out_trade_no");
      continue;
    }

    console.log("[afdian:sync]   order[" + i + "] out_trade_no=" + outTradeNo + " status=" + order.status + " plan_id=" + (order.plan_id || "N/A") + " month=" + (order.month || "N/A"));

    var existingRaw = await redis.get("afdian:order:" + outTradeNo);
    if (existingRaw) {
      var existing = afdianProcessor.parseRedisValue(existingRaw);
      console.log("[afdian:sync]     existing in Redis: processed=" + (existing && existing.processed) + " reason=" + (existing && existing.reason));
      if (existing && existing.processed) {
        console.log("[afdian:sync]     -> already processed, skip");
        continue;
      }
    } else {
      console.log("[afdian:sync]     not in Redis, new order");
    }

    try {
      var result = await afdianProcessor.processOrder(order);
      console.log("[afdian:sync]     processOrder result: success=" + result.success + " already_processed=" + result.already_processed + " skipped=" + result.skipped + " reason=" + (result.reason || "N/A") + " error=" + (result.error || "N/A"));
      if (result.success && !result.already_processed && !result.skipped) {
        processedCount++;
        console.log("[afdian:sync]     -> processed OK, activation_code=" + (result.activation_code || "N/A"));
      } else if (result.already_processed) {
        console.log("[afdian:sync]     -> already_processed, skip counting");
        continue;
      } else if (result.skipped) {
        skippedCount++;
        console.log("[afdian:sync]     -> skipped: " + (result.reason || "unknown"));
      } else {
        errorCount++;
        console.log("[afdian:sync]     -> error: " + (result.error || "unknown"));
      }
      newOrders++;
    } catch (e) {
      console.error("[afdian:sync]     processOrder EXCEPTION for " + outTradeNo + ":", e.message, e.stack);
      errorCount++;
      newOrders++;
    }
  }

  console.log("[afdian:sync] processBatchOrders done: new=" + newOrders + " processed=" + processedCount + " skipped=" + skippedCount + " errors=" + errorCount);
  return { newOrders: newOrders, processed: processedCount, skipped: skippedCount, errors: errorCount };
}

module.exports = async (req, res) => {
  var action = req.query && req.query.action;
  console.log("[afdian:sync] ========== request start, action=" + (action || "sync") + " ==========");

  if (action === "list") {
    console.log("[afdian:sync] list mode: checking auth...");
    var auth = requireAuth(req);
    if (!auth.authorized) {
      console.log("[afdian:sync] list mode: auth failed");
      return res.status(auth.status).json({ success: false, error: auth.error });
    }
    console.log("[afdian:sync] list mode: auth OK");

    try {
      console.log("[afdian:sync] list mode: fetching last_sync from Redis...");
      var lastSyncRaw = await redis.get("afdian:last_sync");
      var lastSync = lastSyncRaw ? parseInt(lastSyncRaw, 10) : null;
      console.log("[afdian:sync] list mode: last_sync=" + (lastSync ? new Date(lastSync).toISOString() : "null"));

      console.log("[afdian:sync] list mode: fetching afdian:processed set...");
      var processedSet = await redis.smembers("afdian:processed");
      console.log("[afdian:sync] list mode: processedSet size=" + (processedSet ? processedSet.length : 0));

      var processedOrders = [];

      for (var i = 0; i < processedSet.length; i++) {
        var orderRaw = await redis.get("afdian:order:" + processedSet[i]);
        if (orderRaw) {
          var parsed = afdianProcessor.parseRedisValue(orderRaw);
          if (parsed) {
            processedOrders.push(parsed);
          }
        }
      }

      processedOrders.sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      });

      var planMap = afdianProcessor.getPlanProductMap();
      console.log("[afdian:sync] list mode: done, orders=" + processedOrders.length + " planMapKeys=" + Object.keys(planMap).length);

      return res.status(200).json({
        success: true,
        last_sync: lastSync,
        plan_map: planMap,
        orders: processedOrders,
        total: processedOrders.length,
      });
    } catch (e) {
      console.error("[afdian:sync] list mode: EXCEPTION:", e.message, e.stack);
      return res.status(500).json({
        success: false,
        error: (e && e.message) || "Unknown error",
      });
    }
  }

  if (action === "update-redeem") {
    console.log("[afdian:sync] update-redeem mode: checking auth...");
    var auth = requireAuth(req);
    if (!auth.authorized) {
      console.log("[afdian:sync] update-redeem mode: auth failed");
      return res.status(auth.status).json({ success: false, error: auth.error });
    }
    console.log("[afdian:sync] update-redeem mode: auth OK");

    var outTradeNo = (req.body && req.body.out_trade_no) || (req.query && req.query.out_trade_no);
    var redeemCode = (req.body && req.body.redeem_code) || (req.query && req.query.redeem_code);

    if (!outTradeNo || !redeemCode) {
      return res.status(400).json({ success: false, error: "Missing out_trade_no or redeem_code" });
    }

    redeemCode = String(redeemCode).toUpperCase().trim();

    try {
      var orderRaw = await redis.get("afdian:order:" + outTradeNo);
      if (!orderRaw) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      var order = afdianProcessor.parseRedisValue(orderRaw);
      if (!order) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      order.redeem_code = redeemCode;
      order.updated_at = Date.now();

      var activationCode = null;
      var redeemRaw = await redis.get("auth:redeem:" + redeemCode);
      if (redeemRaw) {
        var redeemData = afdianProcessor.parseRedisValue(redeemRaw);
        if (redeemData && redeemData.generated_activation_code) {
          activationCode = redeemData.generated_activation_code;
          order.activation_code = activationCode;
        }
      }

      await redis.set("afdian:order:" + outTradeNo, JSON.stringify(order));

      console.log("[afdian:sync] update-redeem: out_trade_no=" + outTradeNo + " redeem_code=" + redeemCode + " activation_code=" + (activationCode || "null"));
      return res.status(200).json({
        success: true,
        out_trade_no: outTradeNo,
        redeem_code: redeemCode,
        activation_code: activationCode,
      });
    } catch (e) {
      console.error("[afdian:sync] update-redeem EXCEPTION:", e.message, e.stack);
      return res.status(500).json({ success: false, error: (e && e.message) || "Unknown error" });
    }
  }

  if (action === "lookup-activation") {
    var redeemCode = (req.query && req.query.redeem_code) || "";

    if (!redeemCode) {
      return res.status(400).json({ success: false, error: "Missing redeem_code" });
    }

    redeemCode = String(redeemCode).toUpperCase().trim();

    try {
      var redeemRaw = await redis.get("auth:redeem:" + redeemCode);
      if (!redeemRaw) {
        return res.status(404).json({ success: false, error: "Redeem code not found: " + redeemCode });
      }

      var redeemData = afdianProcessor.parseRedisValue(redeemRaw);
      var activationCode = redeemData && redeemData.generated_activation_code || null;

      console.log("[afdian:sync] lookup-activation: redeem_code=" + redeemCode + " activation_code=" + (activationCode || "null"));
      return res.status(200).json({
        success: true,
        redeem_code: redeemCode,
        activation_code: activationCode,
      });
    } catch (e) {
      console.error("[afdian:sync] lookup-activation EXCEPTION:", e.message, e.stack);
      return res.status(500).json({ success: false, error: (e && e.message) || "Unknown error" });
    }
  }

  console.log("[afdian:sync] sync mode: checking if Afdian API is configured...");
  if (!afdianApi.isConfigured()) {
    console.log("[afdian:sync] sync mode: Afdian API NOT configured (AFDIAN_USER_ID or AFDIAN_TOKEN missing)");
    return res.status(200).json({ success: true, message: "Afdian API not configured, skipped", new_orders: 0 });
  }
  console.log("[afdian:sync] sync mode: Afdian API IS configured");

  try {
    var page = 1;
    var totalNew = 0;
    var totalProcessed = 0;
    var totalSkipped = 0;
    var totalErrors = 0;
    var maxPages = 2;
    var apiErrors = 0;

    console.log("[afdian:sync] sync mode: starting page loop, maxPages=" + maxPages);

    while (page <= maxPages) {
      console.log("[afdian:sync] sync mode: --- page " + page + "/" + maxPages + " ---");
      var result;
      try {
        console.log("[afdian:sync] sync mode: calling afdianApi.queryOrders(" + page + ")...");
        result = await afdianApi.queryOrders(page);
        console.log("[afdian:sync] sync mode: afdianApi.queryOrders(" + page + ") returned ec=" + (result ? result.ec : "null"));
      } catch (e) {
        console.error("[afdian:sync] sync mode: afdianApi.queryOrders(" + page + ") EXCEPTION:", e.message, e.stack);
        apiErrors++;
        if (page === 1) {
          return res.status(502).json({
            success: false,
            error: "Afdian API unreachable: " + (e.message || "Unknown error"),
          });
        }
        break;
      }

      if (result.ec !== 200) {
        console.error("[afdian:sync] sync mode: Afdian API returned ec=" + result.ec + " em=" + (result.em || ""));
        if (page === 1) {
          return res.status(502).json({
            success: false,
            error: "Afdian API error: ec=" + (result.ec || "unknown") + ", em=" + (result.em || ""),
          });
        }
        break;
      }

      var data = result.data;
      if (!data || !data.list || data.list.length === 0) {
        console.log("[afdian:sync] sync mode: page " + page + " has no orders, breaking loop");
        break;
      }

      console.log("[afdian:sync] sync mode: page " + page + " has " + data.list.length + " orders, processing batch...");
      var batchResult = await processBatchOrders(data.list);
      totalNew += batchResult.newOrders;
      totalProcessed += batchResult.processed;
      totalSkipped += batchResult.skipped;
      totalErrors += batchResult.errors;
      console.log("[afdian:sync] sync mode: page " + page + " batch done: new=" + batchResult.newOrders + " processed=" + batchResult.processed + " skipped=" + batchResult.skipped + " errors=" + batchResult.errors);

      if (data.list.length < 50) {
        console.log("[afdian:sync] sync mode: page " + page + " has < 50 orders, last page, breaking loop");
        break;
      }
      page++;
    }

    console.log("[afdian:sync] sync mode: saving last_sync timestamp...");
    await redis.set("afdian:last_sync", String(Date.now()));

    console.log("[afdian:sync] sync mode: DONE. total new=" + totalNew + " processed=" + totalProcessed + " skipped=" + totalSkipped + " errors=" + totalErrors);
    return res.status(200).json({
      success: true,
      new_orders: totalNew,
      processed: totalProcessed,
      skipped: totalSkipped,
      errors: totalErrors,
      synced_at: Date.now(),
    });
  } catch (e) {
    console.error("[afdian:sync] sync mode: FATAL EXCEPTION:", e.message, e.stack);
    return res.status(500).json({
      success: false,
      error: (e && e.message) || "Unknown error",
    });
  }
};