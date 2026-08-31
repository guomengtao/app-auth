const redis = require("../lib/redis");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const entry = {
      id,
      message: message.trim(),
      createdAt: new Date().toISOString(),
    };

    await Promise.all([
      redis.set(`msg:${id}`, JSON.stringify(entry)),
      redis.lpush("messages:list", id),
    ]);

    return res.status(200).json({ success: true, entry });
  } catch (error) {
    console.error("Publish error:", error);
    var msg = "Failed to publish message";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Server database (Postgres) not configured, contact admin";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND/i.test(String(error.message || ""))) {
      msg = "Server database connection failed, try again later or contact admin";
    }
    return res.status(500).json({ error: msg });
  }
};