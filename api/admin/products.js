var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var { validateProductName } = require("../../lib/validate");
var { pad2 } = require("../../lib/crypto");

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    if (req.method === "GET") {
      var raw = await redis.hgetall("auth:products");
      var products = raw
        ? Object.entries(raw).map(function ([id, val]) {
            var data = typeof val === "string" ? JSON.parse(val) : val;
            return { id: id, ...data };
          })
        : [];
      return res.json({ success: true, products: products });
    }

    if (req.method === "POST") {
      var { name, description } = req.body || {};

      var nameCheck = validateProductName(name);
      if (!nameCheck.valid) {
        return res.status(400).json({ success: false, error: nameCheck.error });
      }

      var counter = await redis.incr("auth:product_counter");
      if (counter > 99) {
        return res.status(400).json({ success: false, error: "Maximum 99 products reached" });
      }
      var id = pad2(counter);
      var product = {
        name: nameCheck.value,
        description: (description || "").trim(),
        created_at: Date.now(),
      };

      await redis.hset("auth:products", { [id]: JSON.stringify(product) });
      await redis.sadd("auth:product_ids", id);

      return res.json({ success: true, product: { id: id, ...product } });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Products error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};