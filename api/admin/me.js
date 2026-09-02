var { parseCookies, verify } = require("../../lib/auth");

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
    var payload = verify(token);
    if (payload) {
      return res.json({
        success: true,
        email: payload.email || payload.username || "",
        name: payload.name || "",
        provider: payload.provider || "token"
      });
    }
  }

  return res.status(401).json({ success: false, error: "Not authenticated" });
};