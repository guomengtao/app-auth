module.exports = async (req, res) => {
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
};