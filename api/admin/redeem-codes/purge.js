var redis = require("../../../lib/redis");
var { requireAuth } = require("../../../lib/auth");

function normalizeSscanResult(result) {
  if (Array.isArray(result)) {
    return { cursor: String(result[0] == null ? "0" : result[0]), keys: Array.isArray(result[1]) ? result[1] : [] };
  }
  if (result && typeof result === "object") {
    return { cursor: String(result.cursor == null ? "0" : result.cursor), keys: Array.isArray(result.keys) ? result.keys : [] };
  }
  return { cursor: "0", keys: [] };
}

async function scanAllRedeemCodes() {
  var allKeys = [];
  var cursor = "0";
  var guard = 0;
  do {
    var raw = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
    var parsed = normalizeSscanResult(raw);
    cursor = parsed.cursor;
    if (parsed.keys.length) allKeys = allKeys.concat(parsed.keys);
    guard++;
  } while (cursor !== "0" && guard < 500);
  return allKeys;
}

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try { cur = JSON.parse(cur); } catch (e) { return null; }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var scope = String(req.query.scope || "").trim();
    var productId = String(req.query.product_id || "").trim();

    if (!scope || (scope !== "used" && scope !== "unused")) {
      return res.status(400).json({ success: false, error: "scope must be 'used' or 'unused'" });
    }

    var allCodes = await scanAllRedeemCodes();
    var toDelete = [];
    var batchSize = 100;

    for (var i = 0; i < allCodes.length; i += batchSize) {
      var batch = allCodes.slice(i, i + batchSize);
      var pipeline = redis.pipeline();
      batch.forEach(function (code) { pipeline.get("auth:redeem:" + code); });
      var values = await pipeline.exec();
      if (!Array.isArray(values)) values = [];
      values.forEach(function (val, idx) {
        var data = parseRedisJson(val);
        if (!data) return;
        if (productId && data.product_id !== productId) return;
        if (scope === "used" && !data.used) return;
        if (scope === "unused" && data.used) return;
        toDelete.push(batch[idx]);
      });
    }

    if (toDelete.length === 0) {
      return res.json({ success: true, deleted: 0, scope: scope, product_id: productId || null });
    }

    var delPipeline = redis.pipeline();
    toDelete.forEach(function (code) {
      delPipeline.del("auth:redeem:" + code);
      delPipeline.srem("auth:redeem_codes", code);
    });
    await delPipeline.exec();

    try { await redis.del("auth:counter:used_redeem_codes"); } catch (e) {}

    return res.json({
      success: true,
      deleted: toDelete.length,
      scope: scope,
      product_id: productId || null,
    });
  } catch (error) {
    console.error("Purge redeem codes error:", error && error.message ? error.message : error, error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};