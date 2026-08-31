const postgres = require("../lib/postgres");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!postgres.isConfigured()) {
    return res.status(500).json({
      error: "Postgres is not configured. Set POSTGRES_URL environment variable.",
      messages: [],
    });
  }

  try {
    await postgres.ensureMessagesTable();

    var limit = 50;
    var offset = 0;
    if (req.query && req.query.limit) {
      var l = parseInt(req.query.limit, 10);
      if (Number.isFinite(l) && l > 0) limit = Math.min(200, l);
    }
    if (req.query && req.query.offset) {
      var o = parseInt(req.query.offset, 10);
      if (Number.isFinite(o) && o > 0) offset = o;
    }

    var queryOpts = [limit, offset];
    var whereClauses = ["is_active = TRUE"];
    var whereSql = "WHERE " + whereClauses.join(" AND ");

    var result = await postgres.query(
      `SELECT uuid, title, content, message_type, priority, created_at
       FROM admin_messages
       ${whereSql}
       ORDER BY priority DESC, created_at DESC
       LIMIT $1 OFFSET $2`,
      queryOpts
    );

    var messages = (result.rows || []).map(function (row) {
      return {
        id: row.uuid,
        title: row.title || "",
        content: row.content || "",
        message_type: row.message_type || "info",
        priority: typeof row.priority === "number" ? row.priority : 0,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      };
    });

    return res.status(200).json({ messages: messages });
  } catch (error) {
    console.error("Postgres public messages fetch error:", error);
    return res.status(500).json({
      error: "Failed to fetch messages: " + (error.message || error),
      messages: [],
    });
  }
};