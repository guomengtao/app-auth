const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ids = await redis.lrange("messages:list", 0, 49);

    if (!ids || ids.length === 0) {
      return res.status(200).json({ messages: [] });
    }

    const keys = ids.map((id) => `msg:${id}`);
    const rawMessages = await redis.mget(...keys);

    const messages = rawMessages
      .filter(Boolean)
      .map((raw) => JSON.parse(raw))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ messages });
  } catch (error) {
    console.error("Fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
};