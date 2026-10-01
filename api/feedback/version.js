// api/feedback/version.js — 三平台最新版本聚合（帮助与反馈页「版本提示条」用）
//
// GET /api/feedback/version
//   ← { ok, updatedAt, watch:{version,notes,url}, apk:{version,notes,url} }
//
// 数据源：data/releases.json（一处手动维护；后续可接自动构建回写）。
// 静态读 + no-store；不查库、零额度消耗。

const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  try {
    const file = path.join(process.cwd(), "data", "releases.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    res.status(200).json(Object.assign({ ok: true }, data));
  } catch (e) {
    res.status(500).json({ ok: false, error: "releases.json read failed" });
  }
};
