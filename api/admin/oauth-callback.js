const { createToken } = require("../../lib/auth");

const ALLOWED_EMAIL = "guomengtao@gmail.com";

module.exports = async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send("OAuth not configured");
  }

  try {
    const redirectUri = (process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : "http://localhost:3000") + "/api/admin/oauth-callback";

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      return res.status(400).send("GitHub auth failed: " + (tokenData.error_description || tokenData.error));
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + tokenData.access_token,
        "User-Agent": "app-auth",
      },
    });
    const userData = await userRes.json();

    if (userData.email && userData.email.toLowerCase() === ALLOWED_EMAIL) {
      const token = createToken(userData.email);
      res.setHeader("Set-Cookie", "token=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
      return res.redirect(302, "/admin.html");
    }

    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: "Bearer " + tokenData.access_token,
        "User-Agent": "app-auth",
      },
    });
    const emails = await emailRes.json();

    const primaryEmail = Array.isArray(emails)
      ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
      : null;

    if (primaryEmail && primaryEmail.email.toLowerCase() === ALLOWED_EMAIL) {
      const token = createToken(primaryEmail.email);
      res.setHeader("Set-Cookie", "token=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
      return res.redirect(302, "/admin.html");
    }

    return res.status(403).send("Access denied. Only guomengtao@gmail.com is allowed.");
  } catch (error) {
    console.error("OAuth callback error:", error);
    return res.status(500).send("OAuth error");
  }
};