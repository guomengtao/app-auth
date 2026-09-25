const crypto = require("crypto");

var JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[auth] JWT_SECRET not configured, using random secret (tokens will not survive cold starts)");
}
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

    // exp 必须存在且未过期。以前是 `if (payload.exp && ...)` —— 缺 exp 的 token 会永不过期，
    // 而 resolve 后本服务签发的所有 token 都带 exp（createToken / api/oauth.js），所以收紧是安全的。
    if (!payload.exp || Date.now() > payload.exp) {
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

var ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "guomengtao@gmail.com").toLowerCase();

function requireAuth(req) {
  // 防御：req / req.headers 缺失时应返回 401 而不是抛 TypeError（否则变成 500）
  var cookies = parseCookies((req && req.headers && req.headers.cookie) || "");

  // ⚠️ 绝不要信任 `_vercel_jwt`。
  //
  // 它是 Vercel 平台自己种的 cookie，签名密钥在平台侧、我们拿不到 —— 所以对它的正确选择
  // 只有「不信」，没有「验签」这条路。历史实现只做了 base64 解码就放行，等于：
  // 任何人不带任何密钥，把 {"email":"<ADMIN_EMAIL>"} 做一次 base64 拼成三段串就能登录后台。
  // 2026-09-26 实测确认：伪造该 cookie 后 `section=stats` 返回 200 与真实业务数据。
  // 详见 `tools/ev-notifier/后台登录鉴权改造方案.md` §1。
  //
  // 唯一可信凭据：本服务自签的 `token` cookie（HMAC-SHA256 验签 + 邮箱白名单 + provider 校验）。
  var token = cookies["token"];
  if (token) {
    var payload = verify(token);
    if (payload && payload.email && payload.email.toLowerCase() === ADMIN_EMAIL) {
      if (payload.provider === "vercel_oauth") {
        return { authorized: true, username: payload.email };
      }
    }
  }

  return { authorized: false, error: "Not authenticated", status: 401 };
}

module.exports = {
  sign,
  verify,
  createToken,
  parseCookies,
  requireAuth,
};