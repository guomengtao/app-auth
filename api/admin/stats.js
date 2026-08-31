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
    const [totalProducts, totalRedeemCodes, totalActivations] = await Promise.all([
      redis.hlen("auth:products"),
      redis.scard("auth:redeem_codes"),
      redis.scard("auth:activation_codes"),
    ]);

    let usedCount = 0;
    let cursor = 0;
    do {
      const codes = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
      cursor = codes[0];
      if (codes[1].length > 0) {
        const pipeline = redis.pipeline();
        codes[1].forEach((code) => pipeline.get(`auth:redeem:${code}`));
        const results = await pipeline.exec();
        usedCount += results.filter((r) => {
          const data = typeof r === "string" ? JSON.parse(r) : r;
          return data && data.used;
        }).length;
      }
    } while (cursor !== 0);

    return res.json({
      success: true,
      stats: {
        totalProducts,
        totalRedeemCodes,
        usedRedeemCodes: usedCount,
        unusedRedeemCodes: totalRedeemCodes - usedCount,
        totalActivations,
      },
    });
  } catch (error) {
    console.error("Stats error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};