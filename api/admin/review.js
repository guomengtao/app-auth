// api/admin/review.js — pages.html 逐页截图档案「审核结果」存取
//
// 数据模型：HASH review:pages
//   field:  <pageId>|<shotFile>
//   value:  JSON { pageId, shotFile, issues[], box{x,y,w,h}, note, action, reviewer, updated_at, history[] }
//
// 接口：
//   GET    /api/admin/review                        公开：列出全部（AI 用 web_fetch 读取对接）
//   GET    /api/admin/review?pageId=<id>            公开：按页过滤
//   GET    /api/admin/review?action=pending         公开：仅未修复（action != resolved / delete）
//   POST   /api/admin/review                        公开+限频：提交/更新一条审核结果（同 field 覆盖，历史保留 3 条）
//   DELETE /api/admin/review?pageId=&shotFile=      需管理员：删除一条
//
// 安全：GET 公开（内容为页面问题标注，无敏感数据）；POST 公开但做字段长度校验 + IP 限频；
//       DELETE 涉及数据破坏，要求管理员鉴权（requireAuth）。

var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");

var HASH_KEY = "review:pages";
var MAX_HISTORY = 3;

var ALLOWED_ACTIONS = ["fix", "recapture", "delete", "resolved"];
var ALLOWED_ISSUES = [
  "文字遮挡", "文字省略", "标题显示不全", "布局错位",
  "按钮过小", "越界裁切", "对齐偏移", "颜色对比", "其他",
];

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

// 简单 IP 限频：每 IP 每分钟最多 12 条（内存计数，冷启动重置即可接受）
var rateMap = {};
function rateLimited(ip) {
  var now = Date.now();
  var win = rateMap[ip];
  if (!win || now - win.start > 60000) {
    rateMap[ip] = { start: now, count: 1 };
    return false;
  }
  win.count++;
  return win.count > 12;
}

function clamp01(v) {
  var n = Number(v);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}

function normalizeBox(raw) {
  if (!raw || typeof raw !== "object") return null;
  var x = clamp01(raw.x), y = clamp01(raw.y), w = clamp01(raw.w), h = clamp01(raw.h);
  if (x == null || y == null || w == null || h == null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function normalizeIssues(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  raw.forEach(function (s) {
    var t = String(s || "").trim().slice(0, 30);
    if (t && out.indexOf(t) === -1 && ALLOWED_ISSUES.indexOf(t) !== -1) out.push(t);
  });
  return out.slice(0, 8);
}

function field(pageId, shotFile) {
  return String(pageId) + "|" + String(shotFile);
}

function summarize(entry) {
  if (!entry) return null;
  return {
    pageId: entry.pageId,
    shotFile: entry.shotFile,
    issues: entry.issues || [],
    box: entry.box || null,
    note: entry.note || "",
    action: entry.action || "fix",
    reviewer: entry.reviewer || "",
    updated_at: entry.updated_at || 0,
  };
}

async function listAll(pageIdFilter, pendingOnly) {
  var raw = await redis.hgetall(HASH_KEY);
  var items = [];
  if (raw && typeof raw === "object") {
    Object.keys(raw).forEach(function (f) {
      try {
        var entry = JSON.parse(raw[f]);
        entry.key = f;
        if (pageIdFilter && entry.pageId !== pageIdFilter) return;
        if (pendingOnly && (entry.action === "resolved" || entry.action === "delete")) return;
        items.push(summarize(entry));
      } catch (e) {
        // skip corrupted entry
      }
    });
  }
  items.sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); });
  return items;
}

module.exports = async (req, res) => {
  try {
    var method = req.method;

    // ── GET：公开读取（AI 对接通道）─────────────────────────────
    if (method === "GET") {
      var pageIdFilter = (req.query.pageId || "").toString().slice(0, 64);
      var pendingOnly = req.query.action === "pending";
      var items = await listAll(pageIdFilter || null, pendingOnly);
      return ok(res, { items: items, total: items.length });
    }

    // ── POST：公开提交（限频 + 严格校验）────────────────────────
    if (method === "POST") {
      var ip = "";
      try {
        ip = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "")
          .split(",")[0].trim().slice(0, 60);
      } catch (e) {}
      if (rateLimited(ip || "anon")) {
        return res.status(429).json({ success: false, error: "提交过于频繁，请稍后再试" });
      }

      var body = parseBody(req);
      var pageId = String(body.pageId || "").trim().slice(0, 64);
      var shotFile = String(body.shotFile || "").trim().slice(0, 120);
      if (!pageId || !shotFile) return bad(res, "pageId 与 shotFile 必填");

      var issues = normalizeIssues(body.issues);
      var box = normalizeBox(body.box);
      var note = String(body.note || "").slice(0, 300);
      var action = ALLOWED_ACTIONS.indexOf(body.action) !== -1 ? body.action : "fix";

      // fix 需要至少一项内容；recapture / delete 是快捷标记，允许全空
      if (action === "fix" && !issues.length && !note && !box) {
        return bad(res, "至少提供一项：issues / box / note");
      }

      var f = field(pageId, shotFile);
      var now = Date.now();
      var existing = null;
      try {
        var prevRaw = await redis.hget(HASH_KEY, f);
        if (prevRaw) existing = JSON.parse(prevRaw);
      } catch (e) {}

      var history = (existing && existing.history) || [];
      if (existing) {
        history.unshift(summarize(existing));
        history = history.slice(0, MAX_HISTORY);
      }

      var entry = {
        pageId: pageId,
        shotFile: shotFile,
        issues: issues,
        box: box,
        note: note,
        action: action,
        reviewer: String(body.reviewer || "").slice(0, 40) || "用户",
        updated_at: now,
        history: history,
      };
      await redis.hset(HASH_KEY, { [f]: JSON.stringify(entry) });
      return ok(res, { item: summarize(entry) });
    }

    // ── DELETE：管理员删除 ──────────────────────────────────────
    if (method === "DELETE") {
      var auth = requireAuth(req);
      if (!auth.authorized) {
        return res.status(auth.status).json({ success: false, error: auth.error });
      }
      var dPage = (req.query.pageId || "").toString().slice(0, 64);
      var dShot = (req.query.shotFile || "").toString().slice(0, 120);
      if (!dPage || !dShot) return bad(res, "pageId 与 shotFile 必填");
      await redis.hdel(HASH_KEY, field(dPage, dShot));
      return ok(res, { deleted: field(dPage, dShot) });
    }

    return bad(res, "Method not allowed", 405);
  } catch (e) {
    console.error("[review] error:", e.message || e);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
};
