var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var { generateRedeemCode } = require("../../lib/crypto");
var { validateCount, validateDuration } = require("../../lib/validate");

function matchCode(data, filterProductId, filterUsed, filterDuration) {
  if (filterProductId && data.product_id !== filterProductId) return false;
  if (filterUsed === "true" && !data.used) return false;
  if (filterUsed === "false" && data.used) return false;
  if (filterDuration && String(data.duration_months) !== filterDuration) return false;
  return true;
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

      if (exportAll === "1") {
        var allMemberKeys = [];
        var memberCursor = 0;
        do {
          var memberResult = await redis.sscan("auth:redeem_codes", memberCursor, { count: 200 });
          memberCursor = memberResult[0];
          allMemberKeys = allMemberKeys.concat(memberResult[1]);
        } while (memberCursor !== 0);

        var codes = [];
        if (allMemberKeys.length > 0) {
          var pipeline = redis.pipeline();
          allMemberKeys.forEach(function (code) {
            pipeline.get("auth:redeem:" + code);
          });
          var values = await pipeline.exec();
          values.forEach(function (val) {
            if (val) {
              var data = typeof val === "string" ? JSON.parse(val) : val;
              if (matchCode(data, filterProductId, filterUsed, filterDuration)) {
                codes.push(data);
              }
            }
          });
        }

        return res.json({
          success: true,
          codes: codes,
          total: codes.length,
        });
      }

      var page = parseInt(req.query.page) || 1;
      var limit = parseInt(req.query.limit) || 20;
      var offset = (page - 1) * limit;

      var allMemberKeys = [];
      var memberCursor = 0;
      do {
        var memberResult = await redis.sscan("auth:redeem_codes", memberCursor, { count: 200 });
        memberCursor = memberResult[0];
        allMemberKeys = allMemberKeys.concat(memberResult[1]);
      } while (memberCursor !== 0);

      var allCodes = [];
      if (allMemberKeys.length > 0) {
        var pipeline = redis.pipeline();
        allMemberKeys.forEach(function (code) {
          pipeline.get("auth:redeem:" + code);
        });
        var values = await pipeline.exec();
        values.forEach(function (val) {
          if (val) {
            var data = typeof val === "string" ? JSON.parse(val) : val;
            if (matchCode(data, filterProductId, filterUsed, filterDuration)) {
              allCodes.push(data);
            }
          }
        });
      }

      allCodes.sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      });

      var total = allCodes.length;
      var pageCodes = allCodes.slice(offset, offset + limit);

      return res.json({
        success: true,
        codes: pageCodes,
        total: total,
        page: page,
        limit: limit,
      });
    }

    if (req.method === "POST") {
      var { productId, count, durationMonths } = req.body || {};

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
    console.error("Redeem codes error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};