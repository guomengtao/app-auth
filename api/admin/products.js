var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var { validateProductName } = require("../../lib/validate");
var { pad2 } = require("../../lib/crypto");

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return body;
}

function parseProductValue(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (e) {
      return { name: val, description: "", created_at: null, _raw: true };
    }
  }
  return null;
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    if (req.method === "GET") {
      var raw = await redis.hgetall("auth:products");
      var products = [];
      if (raw && typeof raw === "object") {
        Object.keys(raw).forEach(function (id) {
          var data = parseProductValue(raw[id]);
          if (data) {
            products.push({ id: id, name: data.name || id, description: data.description || "", created_at: data.created_at || 0 });
          }
        });
      }
      products.sort(function (a, b) {
        return String(a.id).localeCompare(String(b.id));
      });
      return res.json({ success: true, products: products });
    }

    if (req.method === "POST") {
      var body = parseBody(req);
      var name = body.name;
      var description = body.description;

      var nameCheck = validateProductName(name);
      if (!nameCheck.valid) {
        return res.status(400).json({ success: false, error: nameCheck.error });
      }

      var counter = await redis.incr("auth:product_counter");
      if (counter > 99) {
        return res.status(400).json({ success: false, error: "Product limit reached (max 99)" });
      }
      var id = pad2(counter);
      var product = {
        name: nameCheck.value,
        description: (description || "").trim(),
        created_at: Date.now(),
      };

      await redis.hset("auth:products", { [id]: JSON.stringify(product) });
      try {
        await redis.sadd("auth:product_ids", id);
      } catch (e) {
        console.error("product_ids sadd failed:", e);
      }

      return res.json({ success: true, product: { id: id, ...product } });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Products error:", error && error.message ? error.message : error, error);
    var msg = "Internal server error";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Postgres not configured. Please set POSTGRES_URL environment variable in Vercel settings";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND|Unauthorized|401|403/i.test(String(error.message || ""))) {
      msg = "Postgres connection failed. Check POSTGRES_URL environment variable";
    }
    return res.status(500).json({ success: false, error: msg });
  }
};