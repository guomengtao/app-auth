var { parseCookies } = require("../../lib/auth");

module.exports = async (req, res) => {
  var cookies = parseCookies(req.headers.cookie || "");
  var vercelJwt = cookies["_vercel_jwt"];

  if (vercelJwt) {
    try {
      var parts = vercelJwt.split(".");
      if (parts.length === 3) {
        var payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return res.json({
          success: true,
          email: payload.email || "",
          name: payload.name || "",
          provider: "vercel"
        });
      }
    } catch (e) {}
  }

  var token = cookies["token"];
  if (token) {
    try {
      var parts = token.split(".");
      if (parts.length === 3) {
        var payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return res.json({
          success: true,
          email: payload.username || "",
          provider: "password"
        });
      }
    } catch (e) {}
  }

  return res.status(401).json({ success: false, error: "Not authenticated" });
};