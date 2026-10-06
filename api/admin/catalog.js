// api/admin/catalog.js
var goLinks = require("../../lib/admin-go-links.js");
var products = require("../../lib/admin-products.js");
var health = require("../../lib/admin-health.js");
var bandbbs = require("../../lib/bandbbs.js");

module.exports = async (req, res) => {
  var kind = (req.query && req.query.kind) || "";
  if (kind === "go") return goLinks(req, res);
  if (kind === "products") return products(req, res);
  if (kind === "health") return health(req, res);
  if (kind === "bandbbs") return handleBandBBS(req, res);
  return res.status(404).json({ success: false, error: "unknown kind: " + kind });
};

async function handleBandBBS(req, res) {
  var query = (req && req.query) || {};
  var body = (req && req.body) || {};
  var op = query.op || "stats";

  var isCronCall = (query.cron === "1" || query.cron === "true");
  var cronSecret = process.env.CRON_SECRET || "";

  if (op === "send-dm" || op === "config-save" || op === "config-delete" || op === "poll" || op === "single-poll") {
    // Allow cron calls with valid CRON_SECRET
    if (isCronCall && cronSecret) {
      var cronAuth = req.headers.authorization || req.headers.Authorization || "";
      if (cronAuth !== "Bearer " + cronSecret) {
        return res.status(401).json({ success: false, error: "unauthorized cron" });
      }
    } else {
      try {
        var auth = require("../../lib/auth");
        var a = auth.requireAuth(req);
        if (!a || !a.authorized) return res.status(401).json({ success: false, error: "unauthorized" });
      } catch (e) {}
    }
  }

  try {
    var redis, result, ids, rid, title;
    switch (op) {
      case "stats":
        result = await bandbbs.getStats(require("../../lib/redis"));
        return res.json({ success: true, data: result });
      case "poll":
        ids = null;
        if (query.resources) ids = String(query.resources).split(",").filter(function(s) { return s; });
        result = await bandbbs.pollAndReward(require("../../lib/redis"), ids, { mode: isCronCall ? "cron" : "manual" });
        return res.json(result);
      case "single-poll":
        rid = query.resourceId || "";
        if (!rid) return res.status(400).json({ success: false, error: "missing resourceId" });
        result = await bandbbs.pollResource(require("../../lib/redis"), rid);
        return res.json(result);
      case "resource-detail":
        rid = query.resourceId || "";
        if (!rid) return res.status(400).json({ success: false, error: "missing resourceId" });
        result = await bandbbs.getResourceDetail(require("../../lib/redis"), rid);
        return res.json(result);
      case "poll-logs":
        result = await bandbbs.getPollLogs(require("../../lib/redis"), parseInt(query.limit, 10) || 50);
        return res.json({ success: true, data: result });
      case "send-dm":
        if (!body.recipient || !body.title || !body.message) {
          return res.status(400).json({ success: false, error: "missing recipient/title/message" });
        }
        result = await bandbbs.sendDm(body.recipient, body.title, body.message);
        return res.json(result);
      case "config":
        result = await bandbbs.getConfig(require("../../lib/redis"));
        return res.json({ success: true, data: result });
      case "config-save":
        rid = query.resourceId || body.resourceId || "";
        title = body.title || "";
        if (!rid) return res.status(400).json({ success: false, error: "missing resourceId" });
        result = await bandbbs.saveConfig(require("../../lib/redis"), rid, { title: title, enabled: true });
        return res.json({ success: true, data: result });
      case "config-delete":
        rid = query.resourceId || "";
        if (!rid) return res.status(400).json({ success: false, error: "missing resourceId" });
        await bandbbs.deleteConfig(require("../../lib/redis"), rid);
        return res.json({ success: true });
      default:
        return res.status(400).json({ success: false, error: "unknown op: " + op });
    }
  } catch (e) {
    console.error("[bandbbs] error:", e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}