const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");

module.exports = async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { cursor, product_id } = req.query;
    const count = Math.min(parseInt(req.query.count) || 50, 200);

    const [nextCursor, keys] = await redis.sscan("auth:activation_codes", cursor || 0, {
      count,
    });

    let records = [];
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      keys.forEach((code) => pipeline.get(`auth:activation:${code}`));
      const results = await pipeline.exec();
      records = results
        .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
        .filter(Boolean);
    }

    if (product_id) {
      records = records.filter((r) => r.product_id === product_id);
    }

    records.sort((a, b) => b.generated_at - a.generated_at);

    return res.json({
      success: true,
      records,
      cursor: nextCursor,
      hasMore: nextCursor !== 0,
    });
  } catch (error) {
    console.error("Records error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};