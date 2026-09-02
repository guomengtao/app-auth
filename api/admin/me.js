var { parseCookies, verify } = require("../../lib/auth");

module.exports = async (req, res) => {
  var action = req.query && req.query.action;

  if (action === "logout") {
    res.setHeader("Set-Cookie", [
      "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "_vercel_jwt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    ]);

    if (req.method === "GET") {
      var redirectTo = req.query && req.query.redirect
        ? decodeURIComponent(req.query.redirect)
        : "/login_aXs12.html?logout=1";
      res.writeHead(302, { Location: redirectTo });
      return res.end();
    }

    return res.json({ success: true });
  }

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