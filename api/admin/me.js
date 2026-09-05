var { parseCookies, verify } = require("../../lib/auth");
var notify = require("../../lib/notify");

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

  if (req.method === "POST" && (action === "test-email" || (req.body && typeof req.body === "object" && req.body.action === "test-email"))) {
    var body = parseBody(req);
    var smtpSettings = body.action === "test-email" ? body : {};
    try {
      var result = await notify.sendTestEmail(smtpSettings);
      if (result.success) {
        return res.json(result);
      } else {
        return res.status(500).json(result);
      }
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message || "Failed to send test email" });
    }
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