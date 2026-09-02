var https = require("https");
var { sign, parseCookies } = require("../../lib/auth");

var VERCEL_OAUTH_CLIENT_ID = process.env.VERCEL_OAUTH_CLIENT_ID || "";
var VERCEL_OAUTH_CLIENT_SECRET = process.env.VERCEL_OAUTH_CLIENT_SECRET || "";
var ADMIN_EMAIL = process.env.ADMIN_EMAIL || "guomengtao@gmail.com";

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

var REDIRECT_URI = "https://app-auth.gudq.com/api/oauth/callback";

module.exports = async function (req, res) {
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
    var tokenRes = await postForm("https://api.vercel.com/login/oauth/token", {
      client_id: VERCEL_OAUTH_CLIENT_ID,
      client_secret: VERCEL_OAUTH_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI
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
    res.writeHead(302, {
      Location: "/admin_Dx23.html",
      "Set-Cookie": cookieValue
    });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: "/login_aXs12.html?error=oauth_error" });
    res.end();
  }
};