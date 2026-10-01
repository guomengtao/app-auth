// api/feedback.js — 帮助与反馈：提交（公开）+ 后台管理（鉴权）聚合函数
//
// 合并自原 api/feedback/index.js（提交）与 api/admin/feedback.js（管理），
// 背景：Vercel Hobby 计划单部署 12 个 Serverless Functions 上限，函数数须收敛。
//
// 接口：
//   POST /api/feedback   公开：提交留言（限流/蜜罐/校验/通知）
//   GET  /api/feedback   鉴权：后台列表（?status=&limit=）
//   PUT  /api/feedback   鉴权：状态流转 / 备注
//   DELETE /api/feedback 鉴权：删除（?id=）
//
// 前端：feedback.html（提交）；admin-feedback.html（管理）。
// 图片：dataURL 直入 jsonb（前端已压缩，见方案 docs/帮助与反馈栏目方案.md §6.1）。

var postgres = require("../lib/postgres");
var redis = require("../lib/redis");
var rateLimit = require("../lib/rate-limit");
var notify = require("../lib/notify");
var { requireAuth } = require("../lib/auth");

var DAILY_MAX = 5;
var MAX_CONTENT = 2000;
var MAX_IMAGES = 3;
var MAX_IMG_DATAURL = 200 * 1024;
var MAX_TEXT = 120;

var TYPES = ["界面问题", "功能异常", "功能建议", "字体/显示", "同步问题", "其他"];
var ALLOWED_STATUS = ["new", "processing", "resolved", "wontfix"];

function str(v, max) {
  var s = (v == null ? "" : String(v)).trim();
  return s.slice(0, max || MAX_TEXT);
}

function typeOk(t) {
  return TYPES.indexOf(t) >= 0;
}

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return body;
}

function ensureTable(client) {
  return client.query(
    "CREATE TABLE IF NOT EXISTS feedback (" +
    "id BIGSERIAL PRIMARY KEY," +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "src TEXT, app_version TEXT, device_model TEXT, channel TEXT," +
    "page TEXT, type TEXT, content TEXT," +
    "contact_type TEXT, contact TEXT," +
    "images JSONB NOT NULL DEFAULT '[]'::jsonb," +
    "status TEXT NOT NULL DEFAULT 'new'," +
    "admin_note TEXT," +
    "ip_hash TEXT)"
  );
}

// ======================= POST：提交（公开） =======================

async function submit(req, res) {
  var body = parseBody(req);

  // 蜜罐：机器人填了就假装成功（不入库、不通知）
  if (str(body.hp, 40)) { res.status(200).json({ ok: true, id: null }); return; }

  // 限流：分钟级全局护栏 + 日级 5 条/IP（redis 不可用则降级放行）
  try {
    var rl = await rateLimit.checkIpRateLimit(req);
    if (rl.blocked) {
      res.status(429).json({ ok: false, error: rl.reason || "请求过于频繁" });
      return;
    }
  } catch (e) { /* non-blocking */ }

  var ip = rateLimit.getClientIp(req);
  var crypto = require("crypto");
  var ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
  var dayKey = rateLimit.beijingDateKey(Date.now());
  try {
    var dKey = "feedback:daily:" + dayKey + ":" + ipHash;
    var n = await redis.incr(dKey);
    if (n === 1) {
      await redis.pexpire(dKey, 36 * 3600 * 1000).catch(function () {});
    }
    if (n > DAILY_MAX) {
      res.status(429).json({ ok: false, error: "今天提交的反馈已达上限（5 条/天），明天再来或到 QQ 群交流" });
      return;
    }
  } catch (e) { /* non-blocking */ }

  var content = str(body.content, MAX_CONTENT);
  if (!content) { res.status(400).json({ ok: false, error: "请填写问题描述" }); return; }

  var t = str(body.type, MAX_TEXT);
  var rec = {
    src: str(body.src, 20) || "web",
    app_version: str(body.app_version, 40) || "unknown",
    device_model: str(body.device_model, 60) || "unknown",
    channel: str(body.channel, 40) || "unknown",
    page: str(body.page, 80),
    type: typeOk(t) ? t : "其他",
    content: content,
    contact_type: str(body.contact_type, 20),
    contact: str(body.contact, 120)
  };
  if (rec.contact && !rec.contact_type) rec.contact_type = "其他";

  var images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) {
    res.status(400).json({ ok: false, error: "截图最多 " + MAX_IMAGES + " 张" });
    return;
  }
  var cleanImages = [];
  for (var i = 0; i < images.length; i++) {
    var im = String(images[i] || "");
    if (!im) continue;
    if (im.length > MAX_IMG_DATAURL) {
      res.status(400).json({ ok: false, error: "第 " + (i + 1) + " 张截图过大，请重新截图后提交" });
      return;
    }
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(im)) {
      res.status(400).json({ ok: false, error: "截图格式不支持" });
      return;
    }
    cleanImages.push(im);
  }

  try {
    await ensureTable(postgres);
    var r = await postgres.query(
      "INSERT INTO feedback (src, app_version, device_model, channel, page, type, content," +
      " contact_type, contact, images, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)" +
      " RETURNING id",
      [rec.src, rec.app_version, rec.device_model, rec.channel, rec.page, rec.type,
       rec.content, rec.contact_type, rec.contact,
       JSON.stringify(cleanImages), ipHash]
    );
    var id = (r.rows && r.rows[0] && r.rows[0].id) || null;

    try {
      notify.pushNotification("feedback", {
        feedback_id: id,
        src: rec.src,
        app_version: rec.app_version,
        device_model: rec.device_model,
        type: rec.type,
        content: rec.content,
        contact: rec.contact ? (rec.contact_type + ":" + rec.contact) : "匿名",
        image_count: cleanImages.length
      });
    } catch (e) { /* non-blocking */ }

    res.status(200).json({ ok: true, id: id });
  } catch (e) {
    console.error("[feedback] insert failed:", e && e.message);
    res.status(500).json({ ok: false, error: "提交失败，请稍后再试或到 QQ 群反馈" });
  }
}

// ======================= GET/PUT/DELETE：后台管理（鉴权） =======================

async function adminList(req, res) {
  var status = String(req.query.status || "").trim();
  var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  var params = [];
  var where = "";
  if (status && ALLOWED_STATUS.indexOf(status) >= 0) {
    params.push(status);
    where = " WHERE status = $" + params.length;
  }
  params.push(limit);
  var r = await postgres.query(
    "SELECT id, created_at, src, app_version, device_model, channel, page, type," +
    " content, contact_type, contact, images, status, admin_note" +
    " FROM feedback" + where +
    " ORDER BY id DESC LIMIT $" + params.length,
    params
  );
  res.status(200).json({ success: true, items: r.rows || [] });
}

async function adminUpdate(req, res) {
  var body = parseBody(req);
  var id = parseInt(body.id, 10);
  if (!id) { res.status(400).json({ success: false, error: "缺少 id" }); return; }
  var sets = [];
  var vals = [];
  if (body.status != null) {
    var st = String(body.status).trim();
    if (ALLOWED_STATUS.indexOf(st) < 0) {
      res.status(400).json({ success: false, error: "非法状态: " + st });
      return;
    }
    vals.push(st);
    sets.push("status = $" + vals.length);
  }
  if (body.admin_note != null) {
    vals.push(String(body.admin_note).slice(0, 500));
    sets.push("admin_note = $" + vals.length);
  }
  if (!sets.length) { res.status(400).json({ success: false, error: "没有要更新的字段" }); return; }
  vals.push(id);
  await postgres.query(
    "UPDATE feedback SET " + sets.join(", ") + " WHERE id = $" + vals.length,
    vals
  );
  res.status(200).json({ success: true, id: id });
}

async function adminDelete(req, res) {
  var id = parseInt(req.query.id, 10);
  if (!id) { res.status(400).json({ success: false, error: "缺少 id" }); return; }
  await postgres.query("DELETE FROM feedback WHERE id = $1", [id]);
  res.status(200).json({ success: true, id: id });
}

// ======================= ack：APK 推送回执（原 api/notify/ack 并入） =======================

async function pushAck(req, res) {
  var body = parseBody(req);
  var messageId = body.messageId || "";
  var deviceId = body.deviceId || "";
  if (!messageId) {
    res.status(400).json({ success: false, error: "Missing messageId" });
    return;
  }
  try {
    var md = require("./lib/message-delivery");
    if (md && md.ackDelivery) {
      await md.ackDelivery(messageId, deviceId);
    }
    res.status(200).json({ success: true });
  } catch (e) {
    console.error("[feedback/ack]", e && e.message);
    res.status(500).json({ success: false, error: "ack failed" });
  }
}

// ======================= 入口分派 =======================

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // 原 /api/notify/ack（APK 推送回执）经 rewrite 并入，kind=ack 分派
  if ((req.query && req.query.kind) === "ack" && req.method === "POST") {
    await pushAck(req, res);
    return;
  }

  if (req.method === "POST") { await submit(req, res); return; }

  // 管理（鉴权）：GET 列表 / PUT 状态与备注 / DELETE 删除
  var auth = requireAuth(req);
  if (!auth.authorized) {
    res.status(auth.status || 401).json({ success: false, error: auth.error || "Not authenticated" });
    return;
  }

  try {
    if (req.method === "GET") { await adminList(req, res); return; }
    if (req.method === "PUT") { await adminUpdate(req, res); return; }
    if (req.method === "DELETE") { await adminDelete(req, res); return; }
    res.status(405).json({ success: false, error: "method not allowed" });
  } catch (e) {
    console.error("[feedback/admin]", e && e.message);
    res.status(500).json({ success: false, error: "server error: " + (e && e.message) });
  }
};
