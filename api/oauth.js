var crypto = require("crypto");
var https = require("https");
var { sign, parseCookies } = require("../lib/auth");

var VERCEL_OAUTH_CLIENT_ID = process.env.VERCEL_OAUTH_CLIENT_ID || "";
var VERCEL_OAUTH_CLIENT_SECRET = process.env.VERCEL_OAUTH_CLIENT_SECRET || "";
var ADMIN_EMAIL = process.env.ADMIN_EMAIL || "guomengtao@gmail.com";
var REDIRECT_URI = "https://app-auth.gudq.com/api/oauth";

/**
 * 只允许站内相对路径，防止开放重定向（`//evil.com`、`/\evil.com`、http(s):// 一律拒绝）。
 * 用途：设备授权页 `/ev-login?c=...` 在未登录时会先跳 OAuth，登录后需要回到这一页。
 */
function safeNext(next) {
  if (!next || typeof next !== "string") return "";
  if (next.charAt(0) !== "/") return "";
  if (next.charAt(1) === "/" || next.charAt(1) === "\\") return "";
  if (next.indexOf("\\") >= 0) return "";
  return next.slice(0, 200);
}

function postForm(url, body) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var data = new URLSearchParams(body).toString();
    var options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(new Error("Failed to parse response"));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, token) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(new Error("Failed to parse response"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function handleCallback(req, res) {
  var code = req.query && req.query.code;
  var error = req.query && req.query.error;

  if (error) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=access_denied" });
    return res.end();
  }

  if (!code) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=no_code" });
    return res.end();
  }

  if (!VERCEL_OAUTH_CLIENT_ID || !VERCEL_OAUTH_CLIENT_SECRET) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_not_configured" });
    return res.end();
  }

  try {
    var cookies = parseCookies(req.headers.cookie || "");
    var codeVerifier = cookies["oauth_code_verifier"] || "";

    var tokenRes = await postForm("https://api.vercel.com/login/oauth/token", {
      client_id: VERCEL_OAUTH_CLIENT_ID,
      client_secret: VERCEL_OAUTH_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier
    });

    if (!tokenRes || !tokenRes.access_token) {
      var errMsg = (tokenRes && tokenRes.error) ? tokenRes.error : "unknown";
      var errDesc = (tokenRes && tokenRes.error_description) ? encodeURIComponent(tokenRes.error_description) : "";
      console.error("Token exchange failed:", JSON.stringify(tokenRes));
      res.writeHead(302, { Location: "/login_aXs12.html?error=token_exchange_failed&detail=" + errMsg + (errDesc ? "&desc=" + errDesc : "") });
      return res.end();
    }

    var accessToken = tokenRes.access_token;

    var userRes = await getJson("https://api.vercel.com/login/oauth/userinfo", accessToken);

    if (!userRes || !userRes.email) {
      res.writeHead(302, { Location: "/login_aXs12.html?error=user_fetch_failed" });
      return res.end();
    }

    var email = userRes.email || "";

    if (email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      res.writeHead(302, { Location: "/login_aXs12.html?error=not_admin" });
      return res.end();
    }

    var jwt = sign({
      email: email,
      name: userRes.name || "",
      username: userRes.preferred_username || userRes.nickname || "",
      provider: "vercel_oauth",
      iat: Date.now(),
      exp: Date.now() + 24 * 60 * 60 * 1000
    });

    var cookieValue = "token=" + jwt + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (24 * 60 * 60);
    // 支持登录后回到原页面（设备授权页 /ev-login 会用）；没带 next 时行为与以前完全一致
    var nextPath = safeNext(parseCookies(req.headers.cookie || "")["oauth_next"]);
    res.writeHead(302, {
      Location: nextPath || "/admin_Dx23.html",
      "Set-Cookie": [
        cookieValue,
        "oauth_next=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      ]
    });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_error" });
    res.end();
  }
}

function handleLogin(req, res) {
  var clientId = VERCEL_OAUTH_CLIENT_ID;

  if (!clientId) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_not_configured" });
    return res.end();
  }

  var state = crypto.randomBytes(16).toString("hex");

  var codeVerifier = crypto.randomBytes(32).toString("base64url");
  var codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  var params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  var authorizeUrl = "https://vercel.com/oauth/authorize?" + params.toString();

  var loginCookies = [
    "oauth_code_verifier=" + codeVerifier + "; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
  ];
  // 登录后要回到哪一页（仅站内路径）。设备授权页依赖它，否则登录完会被丢到后台首页。
  var next = safeNext(req.query && req.query.next);
  if (next) {
    loginCookies.push("oauth_next=" + encodeURIComponent(next) +
      "; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600");
  }

  res.writeHead(302, {
    Location: authorizeUrl,
    "Set-Cookie": loginCookies
  });
  res.end();
}

module.exports = async function (req, res) {
  var code = req.query && req.query.code;
  var error = req.query && req.query.error;

  if (code || error) {
    return handleCallback(req, res);
  }

  return handleLogin(req, res);
};