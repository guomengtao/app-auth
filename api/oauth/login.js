var crypto = require("crypto");

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

module.exports = async function (req, res) {
  var clientId = process.env.VERCEL_OAUTH_CLIENT_ID || "";

  if (!clientId) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_not_configured" });
    return res.end();
  }

  var redirectUri = "https://app-auth.gudq.com/api/oauth/callback";
  var state = crypto.randomBytes(16).toString("hex");

  var codeVerifier = crypto.randomBytes(32).toString("base64url");
  var codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  var params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  var authorizeUrl = "https://vercel.com/oauth/authorize?" + params.toString();

  res.writeHead(302, {
    Location: authorizeUrl,
    "Set-Cookie": "oauth_code_verifier=" + codeVerifier + "; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
  });
  res.end();
};