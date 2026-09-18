// api/admin/go-links.js — 跳转下载链接后台 CRUD
//
// 数据模型：HASH go:mapping
//   field: slug
//   value: JSON {target_url, enabled, name_zh, name_en, note, created_at, updated_at}
//
// 接口：
//   GET    /api/admin/go-links                  列出全部
//   GET    /api/admin/go-links?slug=<slug>      取单条（含 target_url，仅后台可见）
//   GET    /api/admin/go-links?action=stats     统计：今日总点击 / 7 天走势 / 最近 100 条
//   POST   /api/admin/go-links                  新建（body: {slug, name_zh, name_en, target_url, note}）
//   PUT    /api/admin/go-links                  更新（body: {slug, ...其他字段}）
//   DELETE /api/admin/go-links?slug=<slug>      删除单条（仅清配置；统计保留）
//
// 所有写操作要求管理员鉴权。

var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");

var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return body;
}

function ok(res, payload) {
  return res.json({ success: true, ...(payload || {}) });
}

function bad(res, msg, status) {
  return res.status(status || 400).json({ success: false, error: msg });
}

function todayKey(ts) {
  var d = new Date(ts || Date.now());
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, "0");
  var day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function normalizeSlug(raw) {
  var s = String(raw || "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) return null;
  return s;
}

function validateTargetUrl(raw) {
  var s = String(raw || "").trim();
  if (s.length < 4 || s.length > 1024) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

function summarize(entry) {
  if (!entry) return null;
  return {
    slug: entry.slug,
    name_zh: entry.name_zh || "",
    name_en: entry.name_en || "",
    target_url: entry.target_url || "",
    enabled: entry.enabled !== false,
    note: entry.note || "",
    created_at: entry.created_at || 0,
    updated_at: entry.updated_at || 0,
  };
}

// --- 列出全部 ---------------------------------------------------------------

async function listAll() {
  var raw = await redis.hgetall("go:mapping");
  var items = [];
  if (raw && typeof raw === "object") {
    Object.keys(raw).forEach(function (slug) {
      try {
        var entry = JSON.parse(raw[slug]);
        entry.slug = slug;
        items.push(summarize(entry));
      } catch (e) {
        // skip corrupted entry
      }
    });
  }
  items.sort(function (a, b) {
    return (a.slug || "").localeCompare(b.slug || "");
  });
  return items;
}

// --- 统计 -------------------------------------------------------------------

async function collectStats() {
  var now = Date.now();
  var today = todayKey(now);
  var pipeline = redis.pipeline();
  pipeline.get("stats:go:" + today);
  for (var i = 0; i < 7; i++) {
    var d = new Date(now - i * 24 * 60 * 60 * 1000);
    pipeline.get("stats:go:" + todayKey(d.getTime()));
  }
  var results = await pipeline.exec();
  var todayCount = parseInt(results[0] || "0", 10) || 0;
  var daily = [];
  for (var j = 0; j < 7; j++) {
    var dd = new Date(now - j * 24 * 60 * 60 * 1000);
    var label = todayKey(dd.getTime());
    var n = parseInt(results[j + 1] || "0", 10) || 0;
    daily.unshift({ date: label, clicks: n });
  }

  var recent = [];
  try {
    var rawList = await redis.lrange("stats:go:recent", 0, 99);
    (rawList || []).forEach(function (s) {
      try {
        var o = JSON.parse(s);
        if (o && typeof o === "object") recent.push(o);
      } catch (e) {}
    });
  } catch (e) {}

  return {
    today_clicks: todayCount,
    daily: daily,
    recent: recent,
  };
}

// --- handler ----------------------------------------------------------------

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  try {
    var method = req.method;

    if (method === "GET") {
      if (req.query.slug) {
        var slug = normalizeSlug(req.query.slug);
        if (!slug) return bad(res, "Invalid slug");
        var raw = await redis.hget("go:mapping", slug);
        if (!raw) return res.status(404).json({ success: false, error: "Slug not found" });
        var entry;
        try { entry = JSON.parse(raw); } catch (e) { return bad(res, "Corrupted entry"); }
        entry.slug = slug;
        return ok(res, { item: summarize(entry) });
      }

      if (req.query.action === "stats") {
        var stats = await collectStats();
        return ok(res, { stats: stats });
      }

      var items = await listAll();
      return ok(res, { items: items, total: items.length });
    }

    if (method === "POST") {
      var body = parseBody(req);
      var slug = normalizeSlug(body.slug);
      if (!slug) return bad(res, "slug 必须为 1-64 位，仅含 a-z, 0-9, 中划线，且不能以中划线开头/结尾");

      var target = validateTargetUrl(body.target_url);
      if (!target) return bad(res, "target_url 必须以 http:// 或 https:// 开头，长度 4~1024");

      var existing = await redis.hget("go:mapping", slug);
      if (existing) return bad(res, "slug 已存在，请改用更新接口", 409);

      var now = Date.now();
      var newEntry = {
        target_url: target,
        enabled: body.enabled !== false,
        name_zh: String(body.name_zh || "").slice(0, 80),
        name_en: String(body.name_en || "").slice(0, 80),
        note: String(body.note || "").slice(0, 200),
        created_at: now,
        updated_at: now,
      };
      await redis.hset("go:mapping", { [slug]: JSON.stringify(newEntry) });
      return ok(res, { slug: slug, item: summarize(Object.assign({}, newEntry, { slug: slug })) });
    }

    if (method === "PUT") {
      var pbody = parseBody(req);
      var pslug = normalizeSlug(pbody.slug);
      if (!pslug) return bad(res, "slug 无效");

      var pRaw = await redis.hget("go:mapping", pslug);
      if (!pRaw) return res.status(404).json({ success: false, error: "Slug not found" });
      var pEntry;
      try { pEntry = JSON.parse(pRaw); } catch (e) { return bad(res, "Corrupted entry"); }

      if (typeof pbody.name_zh === "string") pEntry.name_zh = pbody.name_zh.slice(0, 80);
      if (typeof pbody.name_en === "string") pEntry.name_en = pbody.name_en.slice(0, 80);
      if (typeof pbody.note === "string") pEntry.note = pbody.note.slice(0, 200);
      if (typeof pbody.enabled === "boolean") pEntry.enabled = pbody.enabled;

      if (pbody.target_url != null) {
        var pTarget = validateTargetUrl(pbody.target_url);
        if (!pTarget) return bad(res, "target_url 必须以 http:// 或 https:// 开头，长度 4~1024");
        pEntry.target_url = pTarget;
      }

      pEntry.updated_at = Date.now();
      await redis.hset("go:mapping", { [pslug]: JSON.stringify(pEntry) });
      return ok(res, { slug: pslug, item: summarize(Object.assign({}, pEntry, { slug: pslug })) });
    }

    if (method === "DELETE") {
      var dslug = normalizeSlug(req.query.dslug || req.query.slug);
      if (!dslug) return bad(res, "slug is required");
      var exists = await redis.hget("go:mapping", dslug);
      if (!exists) return res.status(404).json({ success: false, error: "Slug not found" });
      var removed = await redis.hdel("go:mapping", dslug);
      return ok(res, { slug: dslug, removed: removed });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[go-links] handler error:", e && e.message ? e.message : e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
};