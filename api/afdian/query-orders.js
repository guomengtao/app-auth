var redis = require("../../lib/redis");
var afdianApi = require("../../lib/afdian-api");

async function processBatchOrders(orders) {
  var newOrders = 0;
  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    var outTradeNo = order.out_trade_no;
    if (!outTradeNo) continue;

    var existing = await redis.get("afdian:order:" + outTradeNo);
    if (existing) continue;

    if (order.status !== 2) {
      await redis.set("afdian:order:" + outTradeNo, JSON.stringify({
        out_trade_no: outTradeNo,
        status: order.status,
        processed: false,
        reason: "status_not_completed",
        created_at: Date.now(),
        source: "api_poll",
      }));
      newOrders++;
      continue;
    }

    var orderRecord = {
      out_trade_no: outTradeNo,
      user_id: order.user_id || "",
      plan_id: order.plan_id || "",
      product_type: order.product_type || 0,
      month: order.month || 1,
      total_amount: order.total_amount || "0.00",
      status: order.status,
      processed: false,
      reason: "pending_webhook_retry",
      created_at: Date.now(),
      source: "api_poll",
      raw_order: order,
    };

    await redis.set("afdian:order:" + outTradeNo, JSON.stringify(orderRecord));
    newOrders++;
  }
  return newOrders;
}

module.exports = async (req, res) => {
  if (!afdianApi.isConfigured()) {
    return res.status(200).json({ success: true, message: "Afdian API not configured, skipped", new_orders: 0 });
  }

  try {
    var page = 1;
    var totalNew = 0;
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

      var newCount = await processBatchOrders(data.list);
      totalNew += newCount;

      if (data.list.length < 50) {
        break;
      }
      page++;
    }

    await redis.set("afdian:last_sync", String(Date.now()));

    return res.status(200).json({
      success: true,
      new_orders: totalNew,
      synced_at: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: (e && e.message) || "Unknown error",
    });
  }
};