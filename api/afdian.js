// api/afdian.js — 爱发电接口聚合分派器（原 query-orders.js + webhook.js 合并）
//
// 背景：Vercel Hobby 计划单部署 12 个 Serverless Functions 上限，函数数须收敛。
// 逻辑本体在 lib/afdian-query-orders.js / lib/afdian-webhook.js（零改动搬运），
// 旧 URL 经 vercel.json rewrites 保持兼容（爱发电后台 webhook 配置与 crons 均无需改动）：
//   /api/afdian/webhook*       → /api/afdian?kind=webhook
//   /api/afdian/query-orders*  → /api/afdian?kind=query
// 分派规则：优先 kind 参数；无 kind 时按 method 推断（POST=webhook，GET=query）。

var queryOrders = require("../lib/afdian-query-orders.js");
var webhook = require("../lib/afdian-webhook.js");

module.exports = async (req, res) => {
  var kind = (req.query && req.query.kind) || "";
  if (kind === "webhook") return webhook(req, res);
  if (kind === "query") return queryOrders(req, res);
  if (req.method === "POST") return webhook(req, res);
  return queryOrders(req, res);
};
