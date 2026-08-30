const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

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

    await redis.set(`msg:${id}`, JSON.stringify(entry));
    await redis.lpush("messages:list", id);

    return res.status(200).json({ success: true, entry });
  } catch (error) {
    console.error("Publish error:", error);
    return res.status(500).json({ error: "Failed to publish message" });
  }
};