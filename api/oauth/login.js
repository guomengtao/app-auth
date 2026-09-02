var crypto = require("crypto");

module.exports = async function (req, res) {
  var clientId = process.env.VERCEL_OAUTH_CLIENT_ID || "";

  if (!clientId) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_not_configured" });
    return res.end();
  }

  var redirectUri = "https://app-auth.gudq.com/api/oauth/callback";
  var state = crypto.randomBytes(16).toString("hex");

  var params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: state
  });

  var authorizeUrl = "https://vercel.com/oauth/authorize?" + params.toString();

  res.writeHead(302, { Location: authorizeUrl });
  res.end();
};