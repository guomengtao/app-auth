var redis = require("../../lib/redis");
var afdianApi = require("../../lib/afdian-api");
var afdianProcessor = require("../../lib/afdian-processor");
var { requireAuth } = require("../../lib/auth");

async function processBatchOrders(orders) {
  var newOrders = 0;
  var processedCount = 0;
  var skippedCount = 0;
  var errorCount = 0;

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    var outTradeNo = order.out_trade_no;
    if (!outTradeNo) continue;

    var existingRaw = await redis.get("afdian:order:" + outTradeNo);
    if (existingRaw) {
      var existing = afdianProcessor.parseRedisValue(existingRaw);
      if (existing && existing.processed) {
        continue;
      }
    }

    try {
      var result = await afdianProcessor.processOrder(order);
      if (result.success && !result.already_processed && !result.skipped) {
        processedCount++;
      } else if (result.already_processed) {
        continue;
      } else if (result.skipped) {
        skippedCount++;
      } else {
        errorCount++;
      }
      newOrders++;
    } catch (e) {
      console.error("processOrder failed for " + outTradeNo + ":", e.message);
      errorCount++;
      newOrders++;
    }
  }

  return { newOrders: newOrders, processed: processedCount, skipped: skippedCount, errors: errorCount };
}

module.exports = async (req, res) => {
  var action = req.query && req.query.action;

  if (action === "list") {
    var auth = requireAuth(req);
    if (!auth.authorized) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    try {
      var lastSyncRaw = await redis.get("afdian:last_sync");
      var lastSync = lastSyncRaw ? parseInt(lastSyncRaw, 10) : null;

      var processedSet = await redis.smembers("afdian:processed");
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

      return res.status(200).json({
        success: true,
        last_sync: lastSync,
        plan_map: planMap,
        orders: processedOrders,
        total: processedOrders.length,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: (e && e.message) || "Unknown error",
      });
    }
  }

  if (!afdianApi.isConfigured()) {
    return res.status(200).json({ success: true, message: "Afdian API not configured, skipped", new_orders: 0 });
  }

  try {
    var page = 1;
    var totalNew = 0;
    var totalProcessed = 0;
    var totalSkipped = 0;
    var totalErrors = 0;
    var maxPages = 2;
    var apiErrors = 0;

    while (page <= maxPages) {
      var result;
      try {
        result = await afdianApi.queryOrders(page);
      } catch (e) {
        console.error("Afdian API query failed for page " + page + ":", e.message);
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
        console.error("Afdian API returned ec=" + result.ec + " for page " + page);
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
        break;
      }

      var batchResult = await processBatchOrders(data.list);
      totalNew += batchResult.newOrders;
      totalProcessed += batchResult.processed;
      totalSkipped += batchResult.skipped;
      totalErrors += batchResult.errors;

      if (data.list.length < 50) {
        break;
      }
      page++;
    }

    await redis.set("afdian:last_sync", String(Date.now()));

    return res.status(200).json({
      success: true,
      new_orders: totalNew,
      processed: totalProcessed,
      skipped: totalSkipped,
      errors: totalErrors,
      synced_at: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: (e && e.message) || "Unknown error",
    });
  }
};