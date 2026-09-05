var afdianSign = require("../../lib/afdian-sign");
var afdianProcessor = require("../../lib/afdian-processor");

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

    if (sign) {
      var signStr = (order.out_trade_no || "") +
        (order.user_id || "") +
        (order.plan_id || "") +
        (order.total_amount || "0.00");
      var valid = afdianSign.verifyWebhookSignSimple(signStr, sign);
      console.log("[afdian:webhook] sign verification: " + (valid ? "PASSED" : "FAILED"));
      if (!valid) {
        console.log("[afdian:webhook] sign verify failed, signStr=" + signStr);
        return res.status(200).json({ ec: 200, em: "sign_verify_failed" });
      }
    } else {
      console.log("[afdian:webhook] no sign provided, skipping verification");
    }

    console.log("[afdian:webhook] calling afdianProcessor.processOrder...");
    var result = await afdianProcessor.processOrder(order);
    console.log("[afdian:webhook] processOrder result: success=" + result.success + " skipped=" + (result.skipped || false) + " already_processed=" + (result.already_processed || false));

    return res.status(200).json({ ec: 200, em: "" });
  } catch (e) {
    console.error("[afdian:webhook] EXCEPTION:", e.message, e.stack);
    return res.status(200).json({ ec: 200, em: "" });
  }
};