var https = require("https");
var afdianSign = require("./afdian-sign");

var AFDIAN_API_BASE = "ifdian.net";
var AFDIAN_USER_ID = process.env.AFDIAN_USER_ID || "";
var AFDIAN_TOKEN = process.env.AFDIAN_TOKEN || "";

function isConfigured() {
  return !!(AFDIAN_USER_ID && AFDIAN_TOKEN);
}

function apiRequest(path, params) {
  return new Promise(function (resolve, reject) {
    if (!isConfigured()) {
      return reject(new Error("Afdian API not configured: AFDIAN_USER_ID and AFDIAN_TOKEN required"));
    }

    var ts = Math.floor(Date.now() / 1000);
    var body = afdianSign.buildApiRequestBody(AFDIAN_USER_ID, AFDIAN_TOKEN, params, ts);
    var postData = JSON.stringify(body);

    var options = {
      hostname: AFDIAN_API_BASE,
      path: path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 8000,
    };

    var req = https.request(options, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          var json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error("Failed to parse Afdian API response: " + data.substring(0, 200)));
        }
      });
    });

    req.on("error", function (e) {
      reject(e);
    });

    req.on("timeout", function () {
      req.destroy();
      reject(new Error("Afdian API request timeout"));
    });

    req.write(postData);
    req.end();
  });
}

async function queryOrders(page) {
  var p = page || 1;
  return apiRequest("/api/open/query-order", { page: p });
}

async function queryOrderByTradeNo(outTradeNo) {
  return apiRequest("/api/open/query-order", { out_trade_no: outTradeNo });
}

async function querySponsors(page) {
  var p = page || 1;
  return apiRequest("/api/open/query-sponsor", { page: p });
}

async function sendMessage(recipientUserId, content) {
  return apiRequest("/api/open/send-msg", {
    recipient: recipientUserId,
    content: content,
  });
}

async function ping() {
  return apiRequest("/api/open/ping", { a: 1 });
}

module.exports = {
  isConfigured: isConfigured,
  apiRequest: apiRequest,
  queryOrders: queryOrders,
  queryOrderByTradeNo: queryOrderByTradeNo,
  querySponsors: querySponsors,
  sendMessage: sendMessage,
  ping: ping,
};