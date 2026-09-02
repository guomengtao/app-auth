var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var afdianProcessor = require("../../lib/afdian-processor");

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
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
};