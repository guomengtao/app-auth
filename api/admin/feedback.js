// api/admin/feedback.js — 帮助与反馈「留言板」后台管理接口
//
// 全部接口需管理员鉴权（token cookie，lib/auth.requireAuth）——
// feedback 表含用户联系方式，属敏感数据，GET 也必须登录（与 review.js 的公开 GET 不同）。
//
// 接口：
//   GET  /api/admin/feedback?status=new|processing|resolved|wontfix&limit=50
//        ← { success, items:[{id, created_at, src, app_version, device_model, channel,
//             page, type, content, contact_type, contact, images[], status, admin_note}] }
//   PUT  /api/admin/feedback   body { id, status?, admin_note? }
//        状态流转：new → processing → resolved | wontfix
//   DELETE /api/admin/feedback?id=   删除一条（垃圾/误提交）
//
// 数据：Postgres feedback 表（api/feedback/index.js 懒建）。

var postgres = require("../../lib/postgres");
var { requireAuth } = require("../../lib/auth");

var ALLOWED_STATUS = ["new", "processing", "resolved", "wontfix"];

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return body;
}

function ok(res, payload) {
  return res.status(200).json(Object.assign({ success: true }, payload || {}));
}

function bad(res, msg, status) {
  return res.status(status || 400).json({ success: false, error: msg });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  var auth = requireAuth(req);
  if (!auth.authorized) {
    return bad(res, auth.error || "Not authenticated", auth.status || 401);
  }

  var client = postgres;
  if (!client || !client.query) {
    return bad(res, "postgres not configured", 503);
  }

  try {
    if (req.method === "GET") {
      var status = String(req.query.status || "").trim();
      var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      var params = [];
      var where = "";
      if (status && ALLOWED_STATUS.indexOf(status) >= 0) {
        params.push(status);
        where = " WHERE status = $" + params.length;
      }
      params.push(limit);
      var r = await client.query(
        "SELECT id, created_at, src, app_version, device_model, channel, page, type," +
        " content, contact_type, contact, images, status, admin_note" +
        " FROM feedback" + where +
        " ORDER BY id DESC LIMIT $" + params.length,
        params
      );
      return ok(res, { items: r.rows || [] });
    }

    if (req.method === "PUT") {
      var body = parseBody(req);
      var id = parseInt(body.id, 10);
      if (!id) return bad(res, "缺少 id");
      var sets = [];
      var vals = [];
      if (body.status != null) {
        var st = String(body.status).trim();
        if (ALLOWED_STATUS.indexOf(st) < 0) return bad(res, "非法状态: " + st);
        vals.push(st);
        sets.push("status = $" + vals.length);
      }
      if (body.admin_note != null) {
        vals.push(String(body.admin_note).slice(0, 500));
        sets.push("admin_note = $" + vals.length);
      }
      if (!sets.length) return bad(res, "没有要更新的字段");
      vals.push(id);
      await client.query(
        "UPDATE feedback SET " + sets.join(", ") + " WHERE id = $" + vals.length,
        vals
      );
      return ok(res, { id: id });
    }

    if (req.method === "DELETE") {
      var delId = parseInt(req.query.id, 10);
      if (!delId) return bad(res, "缺少 id");
      await client.query("DELETE FROM feedback WHERE id = $1", [delId]);
      return ok(res, { id: delId });
    }

    return bad(res, "method not allowed", 405);
  } catch (e) {
    console.error("[admin/feedback]", e && e.message);
    return bad(res, "server error: " + (e && e.message), 500);
  }
};
