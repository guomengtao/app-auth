const ALLOWED_EMAIL = "guomengtao@gmail.com";

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = cookieHeader.split(";").reduce((acc, c) => {
    const [key, ...val] = c.trim().split("=");
    if (key) acc[key] = val.join("=");
    return acc;
  }, {});
  return cookies[name] || null;
}

function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

function requireVercelAdmin(req, res) {
  const jwt = getCookie(req, "_vercel_jwt");

  if (!jwt) {
    res.status(401).json({ error: "请通过 Vercel 认证登录" });
    return false;
  }

  const payload = decodeJwtPayload(jwt);

  if (!payload || !payload.email) {
    res.status(401).json({ error: "无法验证 Vercel 身份" });
    return false;
  }

  if (payload.email.toLowerCase() !== ALLOWED_EMAIL) {
    res.status(403).json({ error: "仅限 guomengtao@gmail.com 访问" });
    return false;
  }

  return true;
}

module.exports = { requireVercelAdmin, getCookie, decodeJwtPayload };