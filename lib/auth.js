const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "jwt-secret-change-me";
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

function sign(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verify(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }

    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${parts[0]}.${parts[1]}`)
      .digest("base64url");

    if (parts[2] !== expectedSig) return null;

    return payload;
  } catch {
    return null;
  }
}

function createToken(username) {
  return sign({
    username,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY,
  });
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  cookieHeader.split(";").forEach((pair) => {
    const [key, ...val] = pair.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(val.join("="));
  });
  return cookies;
}

function requireAuth(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.token;

  if (!token) {
    return { authorized: false, error: "Not authenticated", status: 401 };
  }

  const payload = verify(token);
  if (!payload) {
    return { authorized: false, error: "Invalid or expired token", status: 401 };
  }

  return { authorized: true, username: payload.username };
}

module.exports = {
  sign,
  verify,
  createToken,
  parseCookies,
  requireAuth,
};