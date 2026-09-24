var afdianSign = require("../../lib/afdian-sign");
var afdianProcessor = require("../../lib/afdian-processor");
var quota = require("../../lib/quota");
var { pushNotification } = require("../../lib/notify");

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return body;
}

module.exports = async (req, res) => {
  try { quota.bumpQuotaTick("/api/afdian/webhook"); } catch (_) {}
  console.log("[afdian:webhook] ========== webhook received, method=" + req.method + " ==========");

  if (req.method !== "POST") {
    console.log("[afdian:webhook] method not allowed: " + req.method);
    return res.status(405).json({ ec: 405, em: "Method not allowed" });
  }

  try {
    var body = parseBody(req);
    console.log("[afdian:webhook] body ec=" + (body.ec || "null") + " hasData=" + !!(body.data) + " hasOrder=" + !!(body.data && body.data.order));

    if (!body || !body.data || !body.data.order) {
      console.log("[afdian:webhook] no order data in body, returning 200");
      return res.status(200).json({ ec: 200, em: "" });
    }

    var order = body.data.order;
    var sign = body.data.sign;

    console.log("[afdian:webhook] order: out_trade_no=" + order.out_trade_no + " status=" + order.status + " plan_id=" + (order.plan_id || "N/A") + " month=" + (order.month || "N/A"));

    if (!sign) {
      console.log("[afdian:webhook] REJECTED: no sign provided, rejecting request");
      return res.status(400).json({ ec: 400, em: "sign_required" });
    }
    var signStr = (order.out_trade_no || "") +
      (order.user_id || "") +
      (order.plan_id || "") +
      (order.total_amount || "0.00");
    var valid = afdianSign.verifyWebhookSignSimple(signStr, sign);
    console.log("[afdian:webhook] sign verification: " + (valid ? "PASSED" : "FAILED"));
    if (!valid) {
      console.log("[afdian:webhook] REJECTED: sign verify failed, signStr=" + signStr);
      return res.status(400).json({ ec: 400, em: "sign_verify_failed" });
    }

    console.log("[afdian:webhook] calling afdianProcessor.processOrder...");
    var result = await afdianProcessor.processOrder(order);
    console.log("[afdian:webhook] processOrder result: success=" + result.success + " skipped=" + (result.skipped || false) + " already_processed=" + (result.already_processed || false));

    // Push notification to EvNotifier via PUB/SUB broadcast
    if (result.success && !result.already_processed && !result.skipped) {
      try {
        var amountStr = order.total_amount || "0";
        var amountCents = Math.round(parseFloat(amountStr) * 100);
        await pushNotification("new_order", {
          out_trade_no: order.out_trade_no,
          user_name: order.user_name || order.user_id || "",
          plan_title: order.plan_title || "",
          plan_id: order.plan_id || "",
          month: order.month || 1,
          total_amount: amountCents,
          activation_code: result.activation_code || "",
          redeem_code: result.redeem_code || "",
          // 全链路追踪：真实支付时间 + 备注里的设备 ID（订单 ↔ 访问侧的桥）
          paid_at: result.paid_at || null,
          device_id: result.device_id || "",
          remark: result.remark || "",
        });
        console.log("[afdian:webhook] pushNotification sent OK");
      } catch (e) {
        console.error("[afdian:webhook] pushNotification failed:", e.message);
      }
    }

    return res.status(200).json({ ec: 200, em: "" });
  } catch (e) {
    console.error("[afdian:webhook] EXCEPTION:", e.message, e.stack);
    return res.status(500).json({ ec: 500, em: "internal_error" });
  }
};