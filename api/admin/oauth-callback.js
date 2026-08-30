const { createToken } = require("../../lib/auth");

const ALLOWED_EMAIL = "guomengtao@gmail.com";

module.exports = async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send("Vercel OAuth not configured");
  }

  try {
    const redirectUri = (process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : "http://localhost:3000") + "/api/admin/oauth-callback";

    const tokenRes = await fetch("https://api.vercel.com/v2/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      return res.status(400).send("Vercel auth failed: " + (tokenData.error_description || tokenData.error));
    }

    const userRes = await fetch("https://api.vercel.com/v2/user", {
      headers: {
        Authorization: "Bearer " + tokenData.access_token,
      },
    });
    const userData = await userRes.json();

    if (!userData.user || !userData.user.email) {
      return res.status(400).send("Unable to get user email from Vercel");
    }

    const email = userData.user.email.toLowerCase();

    if (email !== ALLOWED_EMAIL) {
      return res.status(403).send("Access denied. Only " + ALLOWED_EMAIL + " is allowed. Your email: " + email);
    }

    const token = createToken(email);
    res.setHeader("Set-Cookie", "token=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
    return res.redirect(302, "/admin.html");
  } catch (error) {
    console.error("Vercel OAuth callback error:", error);
    return res.status(500).send("OAuth error");
  }
};