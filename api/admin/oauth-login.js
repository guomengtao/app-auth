module.exports = async (req, res) => {
  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;

  if (!clientId) {
    return res.status(500).send("Vercel OAuth not configured. Set VERCEL_OAUTH_CLIENT_ID env var.");
  }

  const redirectUri = (process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "http://localhost:3000") + "/api/admin/oauth-callback";

  const url = "https://vercel.com/oauth/authorize" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=user:email";

  res.redirect(302, url);
};