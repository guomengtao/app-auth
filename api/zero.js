/**
 * 零操作激活通道 · 统一入口（2026-11-05）
 *
 * 为什么合成一个函数：Vercel Hobby 计划单次部署最多 12 个 Serverless Functions，
 * 原先拆成 api/device.js + api/pay-session.js 会顶到 13 个，整次部署被平台拒绝
 * （报错 "No more than 12 Serverless Functions can be added to a Deployment"）。
 * 因此两个 handler 的实现移到 lib/（不计入函数数），这里只做分派。
 *
 *   GET  /api/zero?op=device&key=<MAC>&nodeId=&deviceId=   查已购（已购则幂等签码）
 *   POST /api/zero?op=device   {action:"bind", ...}        激活成功后绑定设备索引
 *   POST /api/zero?op=session  {deviceKey,nodeId,deviceId} 建支付会话 → {sid,payUrl}
 *   GET  /api/zero?op=session&sid=&pickup=1                一次取码
 *
 * 对外契约与原 /api/device、/api/pay-session 完全一致，只是路径与 op 变了。
 */
var deviceApi = require("../lib/device-api");
var sessionApi = require("../lib/pay-session-api");

module.exports = async (req, res) => {
  var q = req.query || {};
  var op = String(q.op || "").toLowerCase();
  if (op === "device") return deviceApi(req, res);
  if (op === "session") return sessionApi(req, res);
  return res.status(400).json({ success: false, error: "unknown_op", op: op });
};
