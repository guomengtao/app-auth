// lib/vercel-auth.js
//
// ⚠️ 这个模块**当前没有任何调用点**（全仓 grep 只有它自己），保留只是为了兼容将来可能的使用。
//
// 它原来的实现与 `lib/auth.js` 有同一个严重问题：直接信任 Vercel 平台种的 `_vercel_jwt`
// cookie —— 只 base64 解码 payload、从不验签，导致任何人不带密钥就能伪造身份。
// 详见 `tools/ev-notifier/后台登录鉴权改造方案.md` §1。
//
// 现在改为**委托** `lib/auth.js` 的 requireAuth()，保证只有一条鉴权实现、不会再出现第二份
// 可被绕过的分支。`requireVercelAdmin(req, res)` 的旧签名与 401/403 行为保持不变。

var { requireAuth } = require("./auth");

function requireVercelAdmin(req, res) {
  var auth = requireAuth(req);
  if (auth.authorized) return true;
  res.status(auth.status || 401).json({ error: auth.error || "Not authenticated" });
  return false;
}

module.exports = { requireVercelAdmin, requireAuth };
