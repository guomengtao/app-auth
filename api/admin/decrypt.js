var { requireAuth } = require("../../lib/auth");
var { decryptActivationCode } = require("../../lib/crypto");

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var { code } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ success: false, error: "Please enter activation code" });
    }

    var result = decryptActivationCode(code.trim());
    return res.json({ success: true, result: result });
  } catch (error) {
    console.error("Decrypt error:", error);
    return res.status(500).json({ success: false, error: "Decrypt failed" });
  }
};