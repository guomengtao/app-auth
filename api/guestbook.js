// api/guestbook.js — 留言板：公开投稿 + 公开留言墙 + 鉴权后台管理
//
// 接口：
//   POST /api/guestbook   公开：投稿（匿名可投，蜜罐/限流/图片校验，落库 status='pending' 待审核）
//   GET  /api/guestbook   公开：留言墙（仅返回 status='approved'）；管理员带登录态可 ?status= 过滤全量
//   PUT  /api/guestbook   鉴权：状态流转（pending→approved/hidden）/ 备注
//   DELETE /api/guestbook 鉴权：删除（?id=）
//
// 前端：guestbook.html（投稿+留言墙）；admin/admin-guestbook.html（管理）。
// 复用：lib/postgres（建表+读写）、lib/rate-limit（限流）、lib/auth.requireAuth（后台鉴权）。
// 图片：dataURL 直入 jsonb（前端已压缩，同 api/feedback.js §6.1）。

var postgres = require("../lib/postgres");
var rateLimit = require("../lib/rate-limit");
var { requireAuth } = require("../lib/auth");

var DAILY_MAX = 10;
var MAX_NAME = 40;
var MAX_CONTENT = 2000;
var MAX_IMAGES = 3;
var MAX_IMG_DATAURL = 200 * 1024;
var ALLOWED_STATUS = ["pending", "approved", "hidden"];

function str(v, max) {
  var s = (v == null ? "" : String(v)).trim();
  return s.slice(0, max || MAX_CONTENT);
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
    "CREATE TABLE IF NOT EXISTS guestbook (" +
    "id BIGSERIAL PRIMARY KEY," +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "name TEXT NOT NULL DEFAULT '匿名'," +
    "content TEXT NOT NULL," +
    "images JSONB NOT NULL DEFAULT '[]'::jsonb," +
    "status TEXT NOT NULL DEFAULT 'pending'," +
    "admin_note TEXT," +
    "ip_hash TEXT)"
  );
}

// ======================= POST：投稿（公开） =======================

async function submit(req, res) {
  var body = parseBody(req);

  // 蜜罐：机器人填了就假装成功（不入库）
  if (str(body.hp, 40)) { res.status(200).json({ ok: true, id: null }); return; }

  // 限流：分钟级全局护栏 + 日级 10 条/IP（redis 不可用则降级放行）
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
    var dKey = "guestbook:daily:" + dayKey + ":" + ipHash;
    var n = await redisIncr(dKey);
    if (n === 1) {
      try { await redisPexpire(dKey, 36 * 3600 * 1000); } catch (e) {}
    }
    if (n > DAILY_MAX) {
      res.status(429).json({ ok: false, error: "今天留言已达上限（10 条/天），明天再来" });
      return;
    }
  } catch (e) { /* non-blocking */ }

  var content = str(body.content, MAX_CONTENT);
  if (!content) { res.status(400).json({ ok: false, error: "请填写留言内容" }); return; }
  var name = str(body.name, MAX_NAME) || "匿名";

  var images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) {
    res.status(400).json({ ok: false, error: "图片最多 " + MAX_IMAGES + " 张" });
    return;
  }
  var cleanImages = [];
  for (var i = 0; i < images.length; i++) {
    var im = String(images[i] || "");
    if (!im) continue;
    if (im.length > MAX_IMG_DATAURL) {
      res.status(400).json({ ok: false, error: "第 " + (i + 1) + " 张图片过大，请重新截图后提交" });
      return;
    }
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(im)) {
      res.status(400).json({ ok: false, error: "图片格式不支持（需 webp/png/jpeg）" });
      return;
    }
    cleanImages.push(im);
  }

  try {
    await ensureTable(postgres);
    var r = await postgres.query(
      "INSERT INTO guestbook (name, content, images, ip_hash) VALUES ($1,$2,$3::jsonb,$4) RETURNING id",
      [name, content, JSON.stringify(cleanImages), ipHash]
    );
    var id = (r.rows && r.rows[0] && r.rows[0].id) || null;
    res.status(200).json({ ok: true, id: id });
  } catch (e) {
    console.error("[guestbook] insert failed:", e && e.message);
    res.status(500).json({ ok: false, error: "提交失败，请稍后再试" });
  }
}

// redis 轻封装（不可用则降级）
var redis;
try { redis = require("../lib/redis"); } catch (e) { redis = null; }
async function redisIncr(k) {
  if (redis && redis.incr) return await redis.incr(k);
  return 1;
}
async function redisPexpire(k, ms) {
  if (redis && redis.pexpire) return await redis.pexpire(k, ms);
}

// ======================= GET：留言墙（公开，仅 approved） =======================

async function publicList(req, res) {
  var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    var r = await postgres.query(
      "SELECT id, created_at, name, content, images FROM guestbook WHERE status='approved' ORDER BY id DESC LIMIT $1",
      [limit]
    );
    res.status(200).json({ success: true, items: r.rows || [] });
  } catch (e) {
    console.error("[guestbook] publicList failed:", e && e.message);
    res.status(500).json({ success: false, error: "加载失败" });
  }
}

// ======================= GET/PUT/DELETE：后台管理（鉴权） =======================

async function adminList(req, res) {
  var status = String(req.query.status || "").trim();
  var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  var params = [];
  var where = "";
  if (status && ALLOWED_STATUS.indexOf(status) >= 0) {
    params.push(status);
    where = " WHERE status = $" + params.length;
  }
  params.push(limit);
  try {
    var r = await postgres.query(
      "SELECT id, created_at, name, content, images, status, admin_note FROM guestbook" + where +
      " ORDER BY id DESC LIMIT $" + params.length,
      params
    );
    res.status(200).json({ success: true, items: r.rows || [] });
  } catch (e) {
    console.error("[guestbook] adminList failed:", e && e.message);
    res.status(500).json({ success: false, error: "加载失败" });
  }
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
    "UPDATE guestbook SET " + sets.join(", ") + " WHERE id = $" + vals.length,
    vals
  );
  res.status(200).json({ success: true, id: id });
}

async function adminDelete(req, res) {
  var id = parseInt(req.query.id, 10);
  if (!id) { res.status(400).json({ success: false, error: "缺少 id" }); return; }
  await postgres.query("DELETE FROM guestbook WHERE id = $1", [id]);
  res.status(200).json({ success: true, id: id });
}

// ======================= 入口分派 =======================

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // 投稿：公开，无需登录
  if (req.method === "POST") { await submit(req, res); return; }

  // 列表：公开=仅已公开；管理员=全量可过滤
  if (req.method === "GET") {
    var auth = requireAuth(req);
    if (auth.authorized) { await adminList(req, res); return; }
    await publicList(req, res); return;
  }

  // 改/删：必须管理员
  var auth2 = requireAuth(req);
  if (!auth2.authorized) {
    res.status(auth2.status || 401).json({ success: false, error: auth2.error || "Not authenticated" });
    return;
  }
  try {
    if (req.method === "PUT") { await adminUpdate(req, res); return; }
    if (req.method === "DELETE") { await adminDelete(req, res); return; }
    res.status(405).json({ success: false, error: "method not allowed" });
  } catch (e) {
    console.error("[guestbook/admin]", e && e.message);
    res.status(500).json({ success: false, error: "server error: " + (e && e.message) });
  }
};
