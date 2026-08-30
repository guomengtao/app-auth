const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");
const { generateRedeemCode } = require("../../lib/crypto");
const { validateDuration, validateCount } = require("../../lib/validate");

module.exports = async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    if (req.method === "GET") {
      const { cursor, used, product_id } = req.query;
      const count = Math.min(parseInt(req.query.count) || 50, 200);

      const [nextCursor, keys] = await redis.sscan("auth:redeem_codes", cursor || 0, {
        count,
      });

      let codes = [];
      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        keys.forEach((code) => pipeline.get(`auth:redeem:${code}`));
        const results = await pipeline.exec();
        codes = results
          .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
          .filter(Boolean);
      }

      if (used !== undefined) {
        const isUsed = used === "true";
        codes = codes.filter((c) => c.used === isUsed);
      }
      if (product_id) {
        codes = codes.filter((c) => c.product_id === product_id);
      }

      return res.json({
        success: true,
        codes,
        cursor: nextCursor,
        hasMore: nextCursor !== 0,
      });
    }

    if (req.method === "POST") {
      const { product_id, duration_days, count } = req.body || {};

      if (!product_id || typeof product_id !== "string") {
        return res.status(400).json({ success: false, error: "Product ID is required" });
      }

      const durCheck = validateDuration(duration_days);
      if (!durCheck.valid) {
        return res.status(400).json({ success: false, error: durCheck.error });
      }

      const countCheck = validateCount(count || 1);
      if (!countCheck.valid) {
        return res.status(400).json({ success: false, error: countCheck.error });
      }

      const productExists = product_id === "0000" ? true : await redis.hexists("auth:products", product_id);
      if (!productExists) {
        return res.status(400).json({ success: false, error: "Product not found" });
      }

      const generated = [];
      const pipeline = redis.pipeline();

      for (let i = 0; i < countCheck.value; i++) {
        const code = generateRedeemCode();
        const exists = await redis.exists(`auth:redeem:${code}`);
        if (exists) {
          i--;
          continue;
        }

        const data = {
          code,
          product_id,
          duration_days: durCheck.value,
          used: false,
          used_device_id: null,
          generated_activation_code: null,
          created_at: Date.now(),
          used_at: null,
          expire_at: null,
        };

        pipeline.set(`auth:redeem:${code}`, JSON.stringify(data));
        pipeline.sadd("auth:redeem_codes", code);
        generated.push(data);
      }

      await pipeline.exec();

      return res.json({ success: true, codes: generated });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Redeem codes error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};