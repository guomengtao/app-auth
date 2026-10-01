// api/admin/catalog.js — admin 管理接口聚合分派器
//
// 背景：Vercel Hobby 计划单部署上限 12 个 Serverless Functions。
// 原 go-links / products 两个独立函数合并到此（逻辑本体在 lib/admin-go-links.js /
// lib/admin-products.js，零改动搬运），旧 URL 经 vercel.json rewrites 保持兼容：
//   /api/admin/go-links*   → /api/admin/catalog?kind=go
//   /api/admin/products*   → /api/admin/catalog?kind=products
// 前端（admin_Dx23.html）零改动。

var goLinks = require("../../lib/admin-go-links.js");
var products = require("../../lib/admin-products.js");
var health = require("../../lib/admin-health.js");

module.exports = async (req, res) => {
  var kind = (req.query && req.query.kind) || "";
  if (kind === "go") return goLinks(req, res);
  if (kind === "products") return products(req, res);
  if (kind === "health") return health(req, res);
  return res.status(404).json({ success: false, error: "unknown kind: " + kind });
};
