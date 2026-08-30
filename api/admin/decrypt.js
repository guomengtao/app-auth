const { requireAuth } = require("../../lib/auth");
const { decryptActivationCode } = require("../../lib/crypto");

module.exports = async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ success: false, error: "请输入激活码" });
    }

    const result = decryptActivationCode(code.trim());
    return res.json({ success: true, result });
  } catch (error) {
    console.error("Decrypt error:", error);
    return res.status(500).json({ success: false, error: "解密失败" });
  }
};