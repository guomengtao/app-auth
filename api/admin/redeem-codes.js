var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var { generateRedeemCode } = require("../../lib/crypto");
var { validateCount, validateDuration } = require("../../lib/validate");

function matchCode(data, filterProductId, filterUsed, filterDuration) {
  if (filterProductId && data.product_id !== filterProductId) return false;
  if (filterUsed === "1" && !data.used) return false;
  if (filterUsed === "0" && data.used) return false;
  if (filterDuration && String(data.duration_months) !== filterDuration) return false;
  return true;
}

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try {
      cur = JSON.parse(cur);
    } catch (e) {
      return null;
    }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

function normalizeSscanResult(result) {
  // Upstash may return [cursor, keys] or { cursor, keys }
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] == null ? "0" : result[0]),
      keys: Array.isArray(result[1]) ? result[1] : [],
    };
  }
  if (result && typeof result === "object") {
    return {
      cursor: String(result.cursor == null ? "0" : result.cursor),
      keys: Array.isArray(result.keys) ? result.keys : [],
    };
  }
  return { cursor: "0", keys: [] };
}

async function scanAllRedeemCodes() {
  var allKeys = [];
  var cursor = "0";
  var guard = 0;
  do {
    var raw = await redis.sscan("auth:redeem_codes", cursor, { count: 200 });
    var parsed = normalizeSscanResult(raw);
    cursor = parsed.cursor;
    if (parsed.keys.length) {
      allKeys = allKeys.concat(parsed.keys);
    }
    guard++;
  } while (cursor !== "0" && guard < 500);
  return allKeys;
}

async function fetchRedeemRecords(keys) {
  var records = [];
  if (!keys || keys.length === 0) return records;

  var batchSize = 80;
  for (var i = 0; i < keys.length; i += batchSize) {
    var batch = keys.slice(i, i + batchSize);
    var values;
    try {
      var pipeline = redis.pipeline();
      batch.forEach(function (code) {
        pipeline.get("auth:redeem:" + code);
      });
      values = await pipeline.exec();
    } catch (e) {
      console.error("fetchRedeemRecords batch failed:", e);
      throw e;
    }

    if (!Array.isArray(values)) values = [];
    values.forEach(function (val, idx) {
      var data = parseRedisJson(val);
      if (!data) return;
      if (!data.code) data.code = batch[idx];
      records.push(data);
    });
  }
  return records;
}

async function listFilteredCodes(filterProductId, filterUsed, filterDuration) {
  var keys = await scanAllRedeemCodes();
  var allCodes = await fetchRedeemRecords(keys);
  return allCodes.filter(function (data) {
    return matchCode(data, filterProductId, filterUsed, filterDuration);
  });
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    if (req.method === "GET") {
      var exportAll = req.query.export;
      var filterProductId = req.query.product_id;
      var filterUsed = req.query.used;
      var filterDuration = req.query.duration_months;

      var filtered = await listFilteredCodes(filterProductId, filterUsed, filterDuration);
      filtered.sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      });

      if (exportAll === "1") {
        return res.json({
          success: true,
          codes: filtered,
          total: filtered.length,
        });
      }

      var page = parseInt(req.query.page, 10) || 1;
      var limit = parseInt(req.query.limit, 10) || 20;
      if (page < 1) page = 1;
      if (limit < 1) limit = 20;
      if (limit > 500) limit = 500;
      var offset = (page - 1) * limit;
      var pageCodes = filtered.slice(offset, offset + limit);

      return res.json({
        success: true,
        codes: pageCodes,
        total: filtered.length,
        page: page,
        limit: limit,
      });
    }

    if (req.method === "POST") {
      var body = req.body || {};
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = {};
        }
      }
      var productId = body.productId;
      var count = body.count;
      var durationMonths = body.durationMonths;

      if (!productId || typeof productId !== "string") {
        return res.status(400).json({ success: false, error: "Product ID is required" });
      }

      var productData = await redis.hget("auth:products", productId);
      if (!productData) {
        return res.status(400).json({ success: false, error: "Product not found" });
      }

      var countCheck = validateCount(count);
      if (!countCheck.valid) {
        return res.status(400).json({ success: false, error: countCheck.error });
      }

      var durationCheck = validateDuration(durationMonths);
      if (!durationCheck.valid) {
        return res.status(400).json({ success: false, error: durationCheck.error });
      }

      var numCodes = countCheck.value;
      var months = durationCheck.value;
      var generated = [];

      for (var i = 0; i < numCodes; i++) {
        var code = generateRedeemCode();

        var existing = await redis.get("auth:redeem:" + code);
        var retries = 0;
        while (existing && retries < 10) {
          code = generateRedeemCode();
          existing = await redis.get("auth:redeem:" + code);
          retries++;
        }
        if (existing) {
          continue;
        }

        var record = {
          code: code,
          product_id: productId,
          duration_months: months,
          used: false,
          used_device_id: null,
          generated_activation_code: null,
          created_at: Date.now(),
          used_at: null,
        };

        await redis.set("auth:redeem:" + code, JSON.stringify(record));
        await redis.sadd("auth:redeem_codes", code);
        generated.push(code);
      }

      return res.json({
        success: true,
        codes: generated,
        count: generated.length,
      });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Redeem codes error:", error && error.message ? error.message : error, error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
