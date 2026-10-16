// Vercel Edge Middleware（框架无关型，使用标准 Web Request/Response API）
// 作用：未登录访问 /admin/* 任意页面 → 307 跳转到登录页 /login_aXs12.html
// 登录页位于根目录（/login_aXs12.html），不在 /admin/ 下，天然豁免。
//
// ⚠️ Edge runtime 无 Node 的 crypto.createHmac，故用 Web Crypto (crypto.subtle) 重写 HS256 验签。
// 与 lib/auth.js 的 verify 保持一致的语义：HS256 + payload.exp 必须存在且未过期。

export const config = {
  matcher: "/admin/:path*",
};

// base64url → Uint8Array
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// base64url → UTF-8 字符串（用于解析 payload JSON）
function b64urlToString(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function verifyJwtEdge(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (e) {
    return null;
  }

  const data = new TextEncoder().encode(h + "." + p);
  const sigBytes = b64urlToBytes(sig);

  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, sigBytes, data);
  } catch (e) {
    return null;
  }
  if (!ok) return null;

  try {
    const payload = JSON.parse(b64urlToString(p));
    // exp 缺失或已过期 → 视为无效（与 lib/auth.js 对齐）
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export default async function middleware(request) {
  const secret = process.env.JWT_SECRET;
  // 框架无关型 Edge 中间件拿到的是标准 Web Request，没有 NextRequest 的 .cookies，
  // 需自行从 Cookie 头解析（否则 request.cookies 为 undefined → 500）。
  const ck = request.headers.get("cookie") || "";
  const token = (ck.match(/(?:^|;\s*)token=([^;]*)/) || [])[1];

  if (token && (await verifyJwtEdge(token.value, secret))) {
    // 已登录：放行（fetch(request) 将请求继续发往原目标，静态/函数皆可）
    return fetch(request);
  }

  // 未登录或 token 无效：跳登录页
  return Response.redirect(new URL("/login_aXs12.html", request.url), 307);
}
