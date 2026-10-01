// api/feedback/index.js — 帮助与反馈「留言板」提交接口
//
// POST /api/feedback
//   body(JSON): {
//     src("watch"|"app"|"web"), app_version, device_model, channel, page,
//     type, content, contact_type, contact, images[dataURL...], hp(蜜罐,必须为空)
//   }
//   ← { ok, id }
//
// 设计要点：
//   · 图片：前端已压缩（webp ≤960px、硬上限 150KB/张、≤3 张），以 dataURL 直接入
//     Postgres jsonb —— 零新增依赖、零 Vercel Blob 配置；量大再迁 Blob（迁移点单一）
//   · 限流：同 IP 每天最多 5 条 —— lib/redis 日级 key，与全站北京时间口径一致
//   · 蜜罐：字段 hp 有值 = 机器人 → 返回假成功但不入库
//   · 通知：lib/notify.pushNotification best-effort，失败不影响提交
//   · 建表：懒建（CREATE TABLE IF NOT EXISTS），与 lib/quota.js 同模式

var postgres = require("../../lib/postgres");
var redis = require("../../lib/redis");
var rateLimit = require("../../lib/rate-limit");
var notify = require("../../lib/notify");

var DAILY_MAX = 5;                // 同 IP 每自然日（北京时间）提交上限
var MAX_CONTENT = 2000;           // 描述长度上限
var MAX_IMAGES = 3;               // 截图张数上限
var MAX_IMG_DATAURL = 200 * 1024; // 单张 dataURL 上限（压缩后 ~80KB，余量防误判）
var MAX_TEXT = 120;               // 联系方式/类型/版本等文本字段上限

var TYPES = ["界面问题", "功能异常", "功能建议", "字体/显示", "同步问题", "其他"];

function str(v, max) {
  var s = (v == null ? "" : String(v)).trim();
  return s.slice(0, max || MAX_TEXT);
}

function typeOk(t) {
  for (var i = 0; i < TYPES.length; i++) {
    if (TYPES[i] === t) return true;
  }
  return false;
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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }

  var body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  // 蜜罐：机器人填了就假装成功（不入库、不通知）
  if (str(body.hp, 40)) { res.status(200).json({ ok: true, id: null }); return; }

  // 限流：先过分钟级全局护栏，再过日级配额（redis 不可用则降级放行，靠校验兜底）
  try {
    var rl = await rateLimit.checkIpRateLimit(req);
    if (rl.blocked) {
      res.status(429).json({ ok: false, error: rl.reason || "请求过于频繁" });
      return;
    }
  } catch (e) { /* non-blocking */ }

  var ip = rateLimit.getClientIp(req);
  var ipHash = rateLimit.hashKey(ip);
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

  // 字段校验与规整
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

  // 图片：dataURL 数组，张数/大小/格式三重校验
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

  var client = postgres;
  if (!client || !client.query) {
    res.status(503).json({ ok: false, error: "留言通道暂不可用，请到 QQ 群反馈" });
    return;
  }

  try {
    await ensureTable(client);
    var r = await client.query(
      "INSERT INTO feedback (src, app_version, device_model, channel, page, type, content," +
      " contact_type, contact, images, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)" +
      " RETURNING id",
      [rec.src, rec.app_version, rec.device_model, rec.channel, rec.page, rec.type,
       rec.content, rec.contact_type, rec.contact,
       JSON.stringify(cleanImages), ipHash]
    );
    var id = (r.rows && r.rows[0] && r.rows[0].id) || null;

    // 通知：best-effort（失败不影响提交结果）
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
};
