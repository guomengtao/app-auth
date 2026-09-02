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
  if (req.method !== "POST") {
    return res.status(405).json({ ec: 405, em: "Method not allowed" });
  }

  try {
    var body = parseBody(req);

    if (!body || !body.data || !body.data.order) {
      return res.status(200).json({ ec: 200, em: "" });
    }

    var order = body.data.order;
    var sign = body.data.sign;

    if (sign) {
      var signStr = (order.out_trade_no || "") +
        (order.user_id || "") +
        (order.plan_id || "") +
        (order.total_amount || "0.00");
      var valid = afdianSign.verifyWebhookSignSimple(signStr, sign);
      if (!valid) {
        return res.status(200).json({ ec: 200, em: "sign_verify_failed" });
      }
    }

    var result = await afdianProcessor.processOrder(order);

    return res.status(200).json({ ec: 200, em: "" });
  } catch (e) {
    return res.status(200).json({ ec: 200, em: "" });
  }
};