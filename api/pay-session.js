/**
 * api/pay-session.js —— 零操作激活通道 G2：建会话 / 一次性取码
 *
 * POST /api/pay-session   {deviceKey, nodeId, deviceId} → {sid, payUrl, expiresIn}
 * GET  /api/pay-session?sid=xxx                       → 会话状态
 * GET  /api/pay-session?sid=xxx&pickup=1              → 一次性取走 18 位码
 *
 * 关键设计：
 *   - deviceKey(MAC) / nodeId 由 App 通过**服务端接口**上报，落在会话记录里；
 *     **绝不写进 remark**（MAC 可预测，写进 URL 等于把身份公开）。
 *   - 爱发电链接只带 12 位 CSPRNG 随机 sid：`remark=EV-<sid>&custom_order_id=<sid>`。
 *     sid 的不可预测性本身即取码凭证。
 *   - payUrl 用项目在用的真实商品页，不是 /order/create?plan_id=。
 *   - pickup 是「收到 Realtime paid 事件后的一次性动作」或用户手动点刷新，
 *     **不是轮询**，对 Redis 无重复消耗。
 */
var deviceKey = require("../lib/device-key");
var payStore = require("../lib/pay-store");

var DEFAULT_ITEM_URL = "https://ifdian.net/item/54100fe4a1e011f1a3f452540025c377";

function enabled() {
  return process.env.EV_ZERO_ACTIVATE !== "0";
}
function itemUrl() {
  return String(process.env.EV_AFDIAN_ITEM_URL || DEFAULT_ITEM_URL).trim();
}
function buildPayUrl(sid) {
  var u = itemUrl();
  return u + (u.indexOf("?") >= 0 ? "&" : "?") +
    "remark=EV-" + encodeURIComponent(sid) +
    "&custom_order_id=" + encodeURIComponent(sid);
}

module.exports = async (req, res) => {
  try {
    if (!enabled()) {
      return res.status(200).json({ success: false, status: "unsupported" });
    }

    // ── 建会话 ────────────────────────────────────────────────
    if (req.method === "POST") {
      var body = req.body || {};
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      var mac = deviceKey.normalizeMac(body.deviceKey || body.key);
      var nid = deviceKey.normalizeNodeId(body.nodeId);
      var did = deviceKey.normalizeDeviceId(body.deviceId);
      if (!mac && !nid) {
        return res.status(400).json({ success: false, error: "device_key_required" });
      }
      var sid = deviceKey.newSid();
      await deviceKey.saveSession(sid, {
        sid: sid,
        deviceKey: mac,
        nodeId: nid,
        deviceId: did,
        status: "waiting",
        createdAt: Date.now(),
        channel: "apk-zero"
      });
      return res.status(200).json({
        success: true,
        sid: sid,
        payUrl: buildPayUrl(sid),
        expiresIn: deviceKey.SESSION_TTL_SEC
      });
    }

    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    var q = req.query || {};
    var reqSid = deviceKey.normalizeSid(q.sid || q.id);
    if (!reqSid) {
      return res.status(400).json({ success: false, error: "invalid_sid" });
    }
    var sess = await deviceKey.getSession(reqSid);
    if (!sess) {
      return res.status(200).json({ success: true, status: "expired" });
    }

    // ── 一次性取码 ────────────────────────────────────────────
    if (String(q.pickup || "") === "1") {
      var picked = await payStore.pickup(reqSid);
      if (!picked) {
        return res.status(200).json({
          success: true, status: sess.status === "paid" ? "already_picked" : "waiting"
        });
      }
      await deviceKey.updateSession(reqSid, { status: "delivered", deliveredAt: Date.now() });
      return res.status(200).json({
        success: true,
        status: "paid",
        activationCode: picked.code18,
        deviceKey: picked.deviceKey || sess.deviceKey || ""
      });
    }

    return res.status(200).json({
      success: true,
      status: sess.status,
      expiresIn: deviceKey.SESSION_TTL_SEC
    });
  } catch (e) {
    console.error("[zero:pay-session] error:", e && e.message);
    return res.status(200).json({ success: false, status: "internal_error" });
  }
};
