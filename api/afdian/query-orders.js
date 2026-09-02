var redis = require("../../lib/redis");
var afdianApi = require("../../lib/afdian-api");
var afdianProcessor = require("../../lib/afdian-processor");

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

    var result = await afdianProcessor.processOrder(order);
    if (result.success && !result.already_processed && !result.skipped) {
      processedCount++;
    } else if (result.skipped) {
      skippedCount++;
    } else if (!result.success) {
      errorCount++;
    }
    newOrders++;
  }

  return { newOrders: newOrders, processed: processedCount, skipped: skippedCount, errors: errorCount };
}

module.exports = async (req, res) => {
  if (!afdianApi.isConfigured()) {
    return res.status(200).json({ success: true, message: "Afdian API not configured, skipped", new_orders: 0 });
  }

  try {
    var page = 1;
    var totalNew = 0;
    var totalProcessed = 0;
    var totalSkipped = 0;
    var totalErrors = 0;
    var maxPages = 3;

    while (page <= maxPages) {
      var result = await afdianApi.queryOrders(page);

      if (result.ec !== 200) {
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