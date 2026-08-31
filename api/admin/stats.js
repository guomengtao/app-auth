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
    let cursor = "0";
    let guard = 0;
    do {
      const codes = await redis.sscan("auth:redeem_codes", cursor, { count: 200 });
      const nextCursor = Array.isArray(codes) ? String(codes[0] ?? "0") : String(codes?.cursor ?? "0");
      const keys = Array.isArray(codes) ? (codes[1] || []) : (codes?.keys || []);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        keys.forEach((code) => pipeline.get(`auth:redeem:${code}`));
        const results = await pipeline.exec();
        usedCount += (results || []).filter((r) => {
          let data = r;
          if (typeof data === "string") {
            try { data = JSON.parse(data); } catch (e) { return false; }
          }
          return data && data.used;
        }).length;
      }
      guard++;
    } while (cursor !== "0" && guard < 500);

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