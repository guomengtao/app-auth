const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");
const { validateProductName } = require("../../lib/validate");
const { pad4 } = require("../../lib/crypto");

module.exports = async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    if (req.method === "GET") {
      const raw = await redis.hgetall("auth:products");
      const products = raw
        ? Object.entries(raw).map(([id, val]) => {
            const data = typeof val === "string" ? JSON.parse(val) : val;
            return { id, ...data };
          })
        : [];
      return res.json({ success: true, products });
    }

    if (req.method === "POST") {
      const { name, description } = req.body || {};

      const nameCheck = validateProductName(name);
      if (!nameCheck.valid) {
        return res.status(400).json({ success: false, error: nameCheck.error });
      }

      const counter = await redis.incr("auth:product_counter");
      const id = pad4(counter);
      const product = {
        name: nameCheck.value,
        description: (description || "").trim(),
        created_at: Date.now(),
      };

      await redis.hset("auth:products", { [id]: JSON.stringify(product) });
      await redis.sadd("auth:product_ids", id);

      return res.json({ success: true, product: { id, ...product } });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Products error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};