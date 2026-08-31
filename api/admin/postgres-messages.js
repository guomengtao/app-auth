const postgres = require("../../lib/postgres");
const { requireAuth } = require("../../lib/auth");

function generateUuid() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

function validateMessageInput(body) {
  var errors = [];
  var result = {
    title: "",
    content: "",
    message_type: "info",
    priority: 0,
    is_active: true,
  };

  if (!body) {
    errors.push("Request body is required");
    return { valid: false, errors, data: result };
  }

  if (body.title !== undefined && body.title !== null) {
    result.title = String(body.title).trim();
    if (result.title.length > 255) {
      errors.push("Title must be 255 characters or less");
    }
  }

  var content = body.content !== undefined ? String(body.content) : "";
  result.content = content.trim();
  if (!result.content) {
    errors.push("Content is required");
  }
  if (result.content.length > 10000) {
    errors.push("Content must be 10000 characters or less");
  }

  var allowedTypes = ["info", "warning", "success", "error", "announcement"];
  if (body.message_type) {
    var t = String(body.message_type).toLowerCase();
    if (allowedTypes.indexOf(t) !== -1) {
      result.message_type = t;
    } else {
      errors.push("Invalid message type. Allowed: " + allowedTypes.join(", "));
    }
  }

  if (body.priority !== undefined && body.priority !== null && body.priority !== "") {
    var p = parseInt(body.priority, 10);
    if (Number.isFinite(p)) {
      result.priority = Math.max(0, Math.min(10, p));
    }
  }

  if (body.is_active !== undefined) {
    result.is_active = body.is_active === true || body.is_active === "true" || body.is_active === 1;
  }

  return {
    valid: errors.length === 0,
    errors,
    data: result,
  };
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res
      .status(auth.status || 401)
      .json({ success: false, error: auth.error || "Not authenticated" });
  }

  if (!postgres.isConfigured()) {
    return res.status(500).json({
      success: false,
      error: "Postgres is not configured. Set POSTGRES_URL environment variable.",
    });
  }

  try {
    await postgres.ensureMessagesTable();
  } catch (initErr) {
    console.error("Postgres init error:", initErr);
    return res.status(500).json({
      success: false,
      error: "Failed to initialize database: " + (initErr.message || initErr),
    });
  }

  if (req.method === "GET") {
    return handleGet(req, res, auth);
  }

  if (req.method === "POST") {
    return handlePost(req, res, auth);
  }

  if (req.method === "DELETE") {
    return handleDelete(req, res, auth);
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};

async function handleGet(req, res, auth) {
  try {
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

    var result = await postgres.query(
      `SELECT id, uuid, title, content, message_type, priority, is_active,
              created_by, created_at, updated_at
       FROM admin_messages
       ORDER BY priority DESC, created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    var countResult = await postgres.query("SELECT COUNT(*)::int AS total FROM admin_messages");
    var total = countResult && countResult.rows && countResult.rows[0] ? countResult.rows[0].total : 0;

    return res.status(200).json({
      success: true,
      messages: result.rows || [],
      total: total,
      limit: limit,
      offset: offset,
    });
  } catch (error) {
    console.error("Postgres messages fetch error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch messages: " + (error.message || error),
    });
  }
}

async function handlePost(req, res, auth) {
  try {
    var validation = validateMessageInput(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.errors.join("; "),
      });
    }

    var data = validation.data;
    var uuid = generateUuid();

    var result = await postgres.query(
      `INSERT INTO admin_messages
         (uuid, title, content, message_type, priority, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, uuid, title, content, message_type, priority, is_active,
                 created_by, created_at, updated_at`,
      [
        uuid,
        data.title || null,
        data.content,
        data.message_type,
        data.priority,
        data.is_active,
        auth.username || "system",
      ]
    );

    var created = result.rows && result.rows[0] ? result.rows[0] : null;
    if (!created) {
      return res.status(500).json({
        success: false,
        error: "Failed to create message record",
      });
    }

    return res.status(200).json({
      success: true,
      message: created,
    });
  } catch (error) {
    console.error("Postgres create message error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create message: " + (error.message || error),
    });
  }
}

async function handleDelete(req, res, auth) {
  try {
    var id = null;
    var uuid = null;

    if (req.query) {
      if (req.query.id !== undefined) id = parseInt(req.query.id, 10);
      if (req.query.uuid !== undefined) uuid = String(req.query.uuid).trim();
    }
    if (req.body) {
      if (id === null && req.body.id !== undefined) id = parseInt(req.body.id, 10);
      if (!uuid && req.body.uuid !== undefined) uuid = String(req.body.uuid).trim();
    }

    if (!Number.isFinite(id) && !uuid) {
      return res.status(400).json({
        success: false,
        error: "Message id or uuid is required for deletion",
      });
    }

    var result;
    if (Number.isFinite(id)) {
      result = await postgres.query("DELETE FROM admin_messages WHERE id = $1 RETURNING id", [id]);
    } else {
      result = await postgres.query("DELETE FROM admin_messages WHERE uuid = $1 RETURNING id", [uuid]);
    }

    var deleted = result.rows && result.rows.length > 0;
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    return res.status(200).json({
      success: true,
      deleted: true,
    });
  } catch (error) {
    console.error("Postgres delete message error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete message: " + (error.message || error),
    });
  }
}