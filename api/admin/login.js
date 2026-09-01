var { createToken } = require("../../lib/auth");

var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  var body = req.body;
  if (!body || !body.password) {
    return res.status(400).json({ success: false, error: "Password is required" });
  }

  if (body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  var token = createToken("guomengtao@gmail.com");

  res.setHeader(
    "Set-Cookie",
    "token=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (24 * 60 * 60)
  );

  return res.json({ success: true, username: "guomengtao@gmail.com" });
};