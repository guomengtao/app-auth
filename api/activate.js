var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId } = require("../lib/validate");
var quota = require("../lib/quota");
var rateLimit = require("../lib/rate-limit");
var notify = require("../lib/notify");

var VISITOR_TTL = 7 * 24 * 60 * 60;

function visitorHashKey(str) {
  if (!str) return "unknown";
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function visitorTodayKey(ts) {
  var d = new Date(ts || Date.now());
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, "0");
  var day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

async function handleVisitorTrack(req, res) {
  try {
    var ipCheck = await rateLimit.checkIpRateLimit(req);
    if (ipCheck.blocked) {
      return res.status(429).json({ success: false, error: ipCheck.reason });
    }
    var body = parseBody(req);
    var path = String(body.path || (req.query && req.query.path) || "/");
    var ua = String((req.headers && req.headers["user-agent"]) || "unknown");
    var ref = String(body.ref || (req.query && req.query.ref) || "");
    var ts = Date.now();
    var dateKey = visitorTodayKey(ts);
    var ip = rateLimit.getClientIp(req);
    var vHash = visitorHashKey(ip + "|" + ua.slice(0, 120));
    var uvKey = "stats:uv:" + dateKey;
    var pvKey = "stats:pv:" + dateKey;
    var pagesKey = "stats:pages:" + dateKey;
    var recentKey = "stats:recent";
    var trimmedPath = path.length > 120 ? path.slice(0, 120) : path;
    var isNew = await redis.sadd(uvKey, vHash);
    if (isNew === 1) { await redis.pexpire(uvKey, VISITOR_TTL * 1000).catch(function () {}); }
    await redis.incr(pvKey);
    await redis.pexpire(pvKey, VISITOR_TTL * 1000).catch(function () {});
    var curScore = 0;
    try {
      var zr = await redis.zrange(pagesKey, 0, -1, { withScores: true });
      for (var zi = 0; zi < zr.length; zi += 2) {
        if (zr[zi] === trimmedPath) { curScore = parseFloat(zr[zi + 1]) || 0; break; }
      }
    } catch (e) {}
    await redis.zadd(pagesKey, curScore + 1, trimmedPath);
    await redis.pexpire(pagesKey, VISITOR_TTL * 1000).catch(function () {});
    await redis.lpush(recentKey, JSON.stringify({
      h: vHash.slice(0, 8),
      p: trimmedPath,
      u: ua.slice(0, 80),
      r: ref.slice(0, 80),
      t: ts,
      c: String(req.headers["x-vercel-ip-country"] || "").slice(0, 8),
      rg: String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16),
      ci: String(req.headers["x-vercel-ip-city"] || "").slice(0, 40),
      tz: String(req.headers["x-vercel-ip-timezone"] || "").slice(0, 40),
    }));
    await redis.ltrim(recentKey, 0, 99);
    await redis.pexpire(recentKey, VISITOR_TTL * 1000).catch(function () {});
    return res.json({ success: true, isNewVisitor: isNew === 1 });
  } catch (e) {
    console.error("[visitor/track]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return body;
}

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try {
      cur = JSON.parse(cur);
    } catch (e) {
      break;
    }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

function normalizeProductId(productId) {
  var n = parseInt(productId, 10);
  if (!Number.isFinite(n) || n < 0 || n > 99) return null;
  return crypto.pad2(n);
}

function normalizeMonths(months) {
  var n = parseInt(months, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return n;
}

function saveFailureRecord(reason, deviceId, redeemCode, productId, months, visitorInfo, deviceInfo) {
  var now = Date.now();
  var rnd = Math.random().toString(36).slice(2, 6);
  var key = "auth:activation_failure:" + now + ":" + rnd;
  var record = {
    status: "failure",
    reason: reason,
    device_id: deviceId || "",
    device_id_full: deviceId || "",
    redeem_code: redeemCode || "",
    product_id: productId || "",
    duration_months: months || "",
    generated_at: now,
    device_info: deviceInfo || null,
    visitor_info: visitorInfo || null,
  };
  return Promise.all([
    redis.set(key, JSON.stringify(record)),
    redis.sadd("auth:activation_failures", key),
  ]).catch(function (e) {
    console.error("[activate] Failed to save failure record:", e.message);
  });
}

function buildNotificationStatus(result) {
  if (result && result.sent) return "sent";
  if (result && result.error) return "email_failed";
  return "skipped";
}

module.exports = async (req, res) => {
  if (req.query && req.query.section === "visitor-track") {
    return handleVisitorTrack(req, res);
  }

  try { quota.bumpQuotaTick("/api/activate"); } catch (_) {}
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Request method not supported" });
  }

  var body = parseBody(req);
  var rawDeviceId = body.deviceId;
  var rawRedeemCode = body.redeemCode;
  var deviceInfo = body.deviceInfo || null;
  var visitorInfo = notify.collectRequestInfo(req);

  var ipCheck = await rateLimit.checkIpRateLimit(req);
  if (ipCheck.blocked) {
    saveFailureRecord(ipCheck.reason, rawDeviceId, rawRedeemCode, "", "", visitorInfo, deviceInfo);
    var ipNotifyResult = await notify.sendActivationFailure(req, {
      reason: ipCheck.reason,
      redeemCode: rawRedeemCode || "",
      deviceId: rawDeviceId || "",
      productId: "",
      months: "",
      source: "user",
    }).catch(function () {});
    res.setHeader("Retry-After", Math.ceil(ipCheck.retryAfterMs / 1000));
    return res.status(429).json({ success: false, error: ipCheck.reason, debug: { visitor: visitorInfo, notification: buildNotificationStatus(ipNotifyResult), reason: ipCheck.reason } });
  }

  try {
    var deviceId = rawDeviceId;
    var redeemCode = rawRedeemCode;

    var deviceCheck = validateDeviceId(deviceId);
    var device = deviceCheck.value;
    if (!deviceCheck.valid) {
      saveFailureRecord(deviceCheck.error, deviceId, redeemCode, "", "", visitorInfo, deviceInfo);
      var deviceNotifyResult = await notify.sendActivationFailure(req, {
        reason: deviceCheck.error,
        redeemCode: redeemCode || "",
        deviceId: deviceId || "",
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: deviceCheck.error, debug: { visitor: visitorInfo, notification: buildNotificationStatus(deviceNotifyResult), reason: deviceCheck.error } });
    }

    var codeCheck = validateRedeemCode(redeemCode);
    if (!codeCheck.valid) {
      saveFailureRecord(codeCheck.error, device, redeemCode, "", "", visitorInfo, deviceInfo);
      var codeNotifyResult = await notify.sendActivationFailure(req, {
        reason: codeCheck.error,
        redeemCode: redeemCode || "",
        deviceId: deviceCheck.value || "",
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: codeCheck.error, debug: { visitor: visitorInfo, notification: buildNotificationStatus(codeNotifyResult), reason: codeCheck.error } });
    }

    var code = codeCheck.value;

    var deviceCheck2 = await rateLimit.checkDeviceRateLimit(device);
    if (deviceCheck2.blocked) {
      saveFailureRecord(deviceCheck2.reason, device, code, "", "", visitorInfo, deviceInfo);
      var device2NotifyResult = await notify.sendActivationFailure(req, {
        reason: deviceCheck2.reason,
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      res.setHeader("Retry-After", Math.ceil(deviceCheck2.retryAfterMs / 1000));
      return res.status(429).json({ success: false, error: deviceCheck2.reason, debug: { visitor: visitorInfo, notification: buildNotificationStatus(device2NotifyResult), reason: deviceCheck2.reason } });
    }

    var deviceHash = crypto.sha256(device);

    var codeData = await redis.get("auth:redeem:" + code);
    if (!codeData) {
      saveFailureRecord("兑换码不存在", device, code, "", "", visitorInfo, deviceInfo);
      var codeNotFoundResult = await notify.sendActivationFailure(req, {
        reason: "兑换码不存在或尚未同步到服务器",
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: "兑换码不存在或尚未同步到服务器，请在管理后台同步后重试", debug: { visitor: visitorInfo, notification: buildNotificationStatus(codeNotFoundResult), reason: "兑换码不存在" } });
    }

    var info = parseRedisJson(codeData);
    if (!info) {
      saveFailureRecord("兑换码数据已损坏", device, code, "", "", visitorInfo, deviceInfo);
      var corruptNotifyResult = await notify.sendActivationFailure(req, {
        reason: "兑换码数据已损坏",
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      console.error("Activate: invalid redeem payload", typeof codeData, codeData);
      return res.status(500).json({ success: false, error: "兑换码数据已损坏，请联系管理员", debug: { visitor: visitorInfo, notification: buildNotificationStatus(corruptNotifyResult), reason: "兑换码数据已损坏" } });
    }

    var productId = normalizeProductId(info.product_id);
    var months = normalizeMonths(info.duration_months);
    if (!productId || !months) {
      saveFailureRecord("兑换码配置异常（商品或时长无效）", device, code, info.product_id || "", info.duration_months || "", visitorInfo, deviceInfo);
      var configNotifyResult = await notify.sendActivationFailure(req, {
        reason: "兑换码配置异常（商品或时长无效）",
        redeemCode: code,
        deviceId: device,
        productId: info.product_id || "",
        months: info.duration_months || "",
        source: "user",
      }).catch(function () {});
      console.error("Activate: bad product/duration", info.product_id, info.duration_months);
      return res.status(500).json({
        success: false,
        error: "兑换码配置异常（商品或时长无效），请联系管理员",
        debug: { visitor: visitorInfo, notification: buildNotificationStatus(configNotifyResult), reason: "兑换码配置异常" },
      });
    }

    if (info.used) {
      if (info.used_device_id === deviceHash) {
        var activationCodeReuse = crypto.generateActivationCode(
          productId,
          device,
          months,
          code
        );
        var reuseNow = Date.now();
        var reuseExpires = null;
        if (months !== 99) {
          var existingRecordRaw = await redis.get("auth:activation:" + activationCodeReuse);
          var existing = parseRedisJson(existingRecordRaw);
          var baseTs = reuseNow;
          if (existing && existing.expires_at && Number(existing.expires_at) > baseTs) {
            baseTs = Number(existing.expires_at);
          }
          var rd = new Date(baseTs);
          rd.setUTCMonth(rd.getUTCMonth() + months);
          reuseExpires = rd.getTime();
        }
        var mergedRecord = null;
        if (activationCodeReuse) {
          var _existingRaw = await redis.get("auth:activation:" + activationCodeReuse);
          var _existing = parseRedisJson(_existingRaw) || {};
          mergedRecord = Object.assign({}, _existing, {
            activation_code: activationCodeReuse,
            device_id_hash: deviceHash,
            device_id: device,
            device_id_full: rawDeviceId,
            product_id: productId,
            duration_months: months,
            redeem_code: code,
            generated_at: _existing.generated_at || reuseNow,
            expires_at: reuseExpires,
            device_info: deviceInfo || _existing.device_info || null,
            visitor_info: visitorInfo,
          });
        }
        info.generated_activation_code = activationCodeReuse;
        info.product_id = productId;
        info.duration_months = months;
        info.used_at = reuseNow;
        var reusePipeline = redis.pipeline();
        reusePipeline.set("auth:redeem:" + code, JSON.stringify(info));
        reusePipeline.set("auth:device:" + deviceHash, activationCodeReuse);
        if (mergedRecord) {
          reusePipeline.set("auth:activation:" + activationCodeReuse, JSON.stringify(mergedRecord));
          reusePipeline.sadd("auth:activation_codes", activationCodeReuse);
        }
        await reusePipeline.exec();

        notify.sendActivationNotification(req, {
          redeemCode: code,
          activationCode: activationCodeReuse,
          productId: productId,
          deviceId: device,
          months: months,
          deviceInfo: deviceInfo,
          source: "user-reuse",
        }).catch(function (e) {
          console.error("[activate] Notification failed:", e.message);
        });

        return res.json({ success: true, activationCode: activationCodeReuse, debug: { visitor: visitorInfo, notification: "success", productId: productId, months: months } });
      }
      saveFailureRecord("该兑换码已被其他设备使用过", device, code, productId, months, visitorInfo, deviceInfo);
      var alreadyUsedNotifyResult = await notify.sendActivationFailure(req, {
        reason: "该兑换码已被其他设备使用过，无法重复激活。如需解绑请联系作者（QQ群/微信）",
        redeemCode: code,
        deviceId: device,
        productId: productId,
        months: months,
        source: "user",
      }).catch(function () {});
      return res.status(400).json({
        success: false,
        error: "该兑换码已被其他设备使用过，无法重复激活。如需解绑请联系作者（QQ群/微信）",
        debug: { visitor: visitorInfo, notification: buildNotificationStatus(alreadyUsedNotifyResult), reason: "该兑换码已被其他设备使用过" },
      });
    }

    var activationCode = crypto.generateActivationCode(
      productId,
      device,
      months,
      code
    );

    var now = Date.now();
    var expiresAt = null;
    if (months !== 99) {
      var d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + months);
      expiresAt = d.getTime();
    }

    var updated = {
      code: info.code || code,
      product_id: productId,
      duration_months: months,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      created_at: info.created_at || now,
      used_at: now,
    };

    var record = {
      activation_code: activationCode,
      device_id_hash: deviceHash,
      device_id: device,
      device_id_full: rawDeviceId,
      product_id: productId,
      duration_months: months,
      redeem_code: code,
      generated_at: now,
      expires_at: expiresAt,
      device_info: deviceInfo || null,
      visitor_info: visitorInfo,
    };

    var USED_COUNTER_KEY = "auth:counter:used_redeem_codes";
    var writePipeline = redis.pipeline();
    writePipeline.set("auth:redeem:" + code, JSON.stringify(updated));
    writePipeline.set("auth:activation:" + activationCode, JSON.stringify(record));
    writePipeline.sadd("auth:activation_codes", activationCode);
    writePipeline.set("auth:device:" + deviceHash, activationCode);
    writePipeline.incr(USED_COUNTER_KEY);
    var writeResults = await writePipeline.exec();
    var writeFailed = writeResults.some(function (r) { return r === null; });
    if (writeFailed) {
      console.error("activate.js pipeline had failures:", writeResults);
    }
    console.log("✅ Activate success:", {
      redeemCode: code,
      activationCode: activationCode,
      productId: productId,
      deviceHash: deviceHash.slice(0, 8) + "...",
      months: months,
    });

    var notifyResult = null;
    try {
      notifyResult = await notify.sendActivationNotification(req, {
        redeemCode: code,
        activationCode: activationCode,
        productId: productId,
        deviceId: device,
        months: months,
        deviceInfo: deviceInfo,
        source: "user",
      });
    } catch (e) {
      console.error("[activate] Notification failed:", e.message);
      notifyResult = { sent: false, error: e.message };
    }

    notify.pushNotification("new_activation", {
      redeem_code: code,
      activation_code: activationCode,
      product_id: productId,
      device_id: device,
      months: months,
      source: "user",
      ip: visitorInfo ? visitorInfo.ip : "",
      user_agent: visitorInfo ? visitorInfo.userAgent : "",
    }).catch(function () {});

    return res.json({ success: true, activationCode: activationCode, debug: { visitor: visitorInfo, notification: (notifyResult && notifyResult.sent) ? "sent" : "failed", productId: productId, months: months } });
  } catch (error) {
    console.error("Activate error:", error && error.message ? error.message : error, error);
    var msg = "服务器内部错误，请稍后重试";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "服务器数据库未配置，请联系管理员（缺少 POSTGRES_URL 环境变量）";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND|Unauthorized|401|403/i.test(String(error.message || ""))) {
      msg = "服务器数据库连接失败，请稍后重试或联系管理员";
    }
    saveFailureRecord(msg, rawDeviceId, rawRedeemCode, "", "", visitorInfo, deviceInfo);
    var catchNotifyResult = await notify.sendActivationFailure(req, {
      reason: msg,
      redeemCode: rawRedeemCode || "",
      deviceId: rawDeviceId || "",
      productId: "",
      months: "",
      source: "user",
    }).catch(function () {});

    notify.pushNotification("activation_failure", {
      reason: msg,
      redeem_code: rawRedeemCode || "",
      device_id: rawDeviceId || "",
      source: "user",
      ip: visitorInfo ? visitorInfo.ip : "",
      user_agent: visitorInfo ? visitorInfo.userAgent : "",
    }).catch(function () {});

    return res.status(500).json({ success: false, error: msg, debug: { visitor: visitorInfo, notification: buildNotificationStatus(catchNotifyResult), reason: msg } });
  }
};