/**
 * api/device.js —— 零操作激活通道 G1：凭 MAC / nodeId 查已购并现场签码
 *
 * GET /api/device?key=<12hex MAC>&nodeId=<数字>&deviceId=<当前设备ID>
 *
 * 用途：用户重置手环后 deviceId 变了，旧 18 位码失效。此接口用不变的 MAC/nodeId
 *       确认「这台设备买过」，再用**当前** deviceId 现场签一张新码（不消耗兑换码、
 *       不占 NA 额度、不修改任何 auth:* 既有记录）。
 *
 * 兼容性：全新接口，不参与老 APK 的任何调用链；总开关 EV_ZERO_ACTIVATE=0 即整体停用。
 */
var cryptoLib = require("./crypto");
var deviceKey = require("./device-key");
var redis = require("./redis");

function enabled() {
  return process.env.EV_ZERO_ACTIVATE !== "0";
}

module.exports = async (req, res) => {
  try {
    if (!enabled()) {
      return res.status(200).json({ success: false, owned: false, reason: "unsupported" });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }
    var q = req.query || {};
    var body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    // ── POST action=bind：新 APK 在激活成功后主动上报 MAC/nodeId 建立归属 ──
    // 刻意不改动 api/activate.js 的任何成功分支（C1：已有验证链路零改动）。
    // 老 APK 不会调本动作，行为完全不受影响。
    // 校验：必须给出真实存在的 4 位兑换码，防止凭空绑定任意 MAC。
    if (req.method === "POST" && String(body.action || "") === "bind") {
      var bindCode = String(body.redeemCode || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(bindCode)) {
        return res.status(400).json({ success: false, bound: false, error: "invalid_redeem_code" });
      }
      var codeRec = deviceKey.safeParse(await redis.get("auth:redeem:" + bindCode));
      if (!codeRec) {
        return res.status(200).json({ success: true, bound: false, reason: "unknown_redeem_code" });
      }
      var bindResult = await deviceKey.bind({
        deviceKey: body.deviceKey || body.key,
        nodeId: body.nodeId,
        redeemCode: bindCode,
        productId: Number(body.productId || codeRec.product_id) || 1,
        months: Number(body.months || codeRec.months) || 99,
        source: "apk-bind"
      });
      return res.status(200).json(Object.assign({ success: true }, bindResult));
    }

    var rawKey = q.key || q.deviceKey || body.deviceKey || body.key || "";
    var rawNode = q.nodeId || body.nodeId || "";
    var rawDeviceId = q.deviceId || body.deviceId || "";

    var rec = await deviceKey.lookup(rawKey, rawNode);
    if (!rec) {
      return res.status(200).json({ success: true, owned: false });
    }

    // 已购但没带当前 deviceId：不能签码（码内设备段必须匹配本机）
    var did = deviceKey.normalizeDeviceId(rawDeviceId);
    if (!did) {
      return res.status(200).json({
        success: true, owned: true, activationCode: "", reason: "need_device_id",
        boundDeviceKey: rec.deviceKey || ""
      });
    }

    var productId = Number(rec.productId) || 0;
    var months = Number(rec.months) || 0;
    var redeemCode = String(rec.redeemCode || "").toUpperCase();
    if (!productId || !months || !/^[A-Z0-9]{4}$/.test(redeemCode)) {
      return res.status(200).json({
        success: true, owned: true, activationCode: "", reason: "bad_grant_record"
      });
    }

    // 复用既有码算法，零改动：产品(2)+兑换码(4)+月数(2)+设备段(4) → 18 位纯数字
    var code18 = cryptoLib.generateActivationCode(productId, did, months, redeemCode);

    // 幂等：为这张码补一条服务端激活记录，保持与既有查询链路一致（只加不改）
    var recordKey = "auth:activation:" + code18;
    var prev = await redis.get(recordKey);
    if (!prev) {
      await redis.set(recordKey, JSON.stringify({
        activation_code: code18,
        generated_at: Date.now(),
        first_activated_at: Date.now(),
        redeem_code: redeemCode,
        device_id: did,
        product_id: productId,
        months: months,
        source: "zero-restore",
        activation_seq: 1
      }));
    }

    return res.status(200).json({
      success: true,
      owned: true,
      activationCode: code18,
      reason: "restored",
      boundDeviceKey: rec.deviceKey || ""
    });
  } catch (e) {
    console.error("[zero:device] error:", e && e.message);
    return res.status(200).json({ success: false, owned: false, reason: "internal_error" });
  }
};
