var redis = require("../../lib/redis");
var crypto = require("../../lib/crypto");
var { requireAuth } = require("../../lib/auth");
var { validateDeviceId } = require("../../lib/validate");
var notify = require("../../lib/notify");
var pushNotify = require("../../lib/push-notify");

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

function parseRedisValue(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (e) {
      return null;
    }
  }
  return null;
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

function saveFailureRecord(reason, deviceId, productId, months, visitorInfo) {
  var now = Date.now();
  var rnd = Math.random().toString(36).slice(2, 6);
  var key = "auth:activation_failure:" + now + ":" + rnd;
  var record = {
    status: "failure",
    reason: reason,
    device_id: deviceId || "",
    device_id_full: deviceId || "",
    redeem_code: "",
    product_id: productId || "",
    duration_months: months || "",
    generated_at: now,
    source: "admin-direct",
    device_info: null,
    visitor_info: visitorInfo || null,
  };
  return Promise.all([
    redis.set(key, JSON.stringify(record)),
    redis.sadd("auth:activation_failures", key),
  ]).catch(function (e) {
    console.error("[direct-activate] Failed to save failure record:", e.message);
  });
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var body = parseBody(req);
    var deviceId = body.deviceId;
    var productIds = body.productIds;
    var months = body.months;
    var visitorInfo = notify.collectRequestInfo(req);

    var deviceCheck = validateDeviceId(deviceId);
    if (!deviceCheck.valid) {
      saveFailureRecord(deviceCheck.error, deviceId, "", months, visitorInfo);
      notify.sendActivationFailure(req, {
        reason: deviceCheck.error,
        redeemCode: "",
        deviceId: deviceId || "",
        productId: "",
        months: months || "",
        source: "admin-direct",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: deviceCheck.error });
    }
    var device = deviceCheck.value;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      saveFailureRecord("Please select at least one product", device, "", months, visitorInfo);
      notify.sendActivationFailure(req, {
        reason: "Please select at least one product",
        redeemCode: "",
        deviceId: device,
        productId: "",
        months: months || "",
        source: "admin-direct",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: "Please select at least one product" });
    }
    if (productIds.length > 20) {
      saveFailureRecord("Too many products selected (max 20)", device, "", months, visitorInfo);
      notify.sendActivationFailure(req, {
        reason: "Too many products selected (max 20)",
        redeemCode: "",
        deviceId: device,
        productId: "",
        months: months || "",
        source: "admin-direct",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: "Too many products selected (max 20)" });
    }

    var m = normalizeMonths(months);
    if (!m) {
      saveFailureRecord("Months must be 1-99", device, "", months, visitorInfo);
      notify.sendActivationFailure(req, {
        reason: "Months must be 1-99",
        redeemCode: "",
        deviceId: device,
        productId: "",
        months: months || "",
        source: "admin-direct",
      }).catch(function () {});
      return res.status(400).json({ success: false, error: "Months must be 1-99" });
    }

    var productKeys = [];
    for (var i = 0; i < productIds.length; i++) {
      var pid = normalizeProductId(productIds[i]);
      if (!pid) {
        saveFailureRecord("Invalid product ID: " + productIds[i], device, productIds[i] || "", m, visitorInfo);
        notify.sendActivationFailure(req, {
          reason: "Invalid product ID: " + productIds[i],
          redeemCode: "",
          deviceId: device,
          productId: productIds[i] || "",
          months: m,
          source: "admin-direct",
        }).catch(function () {});
        return res.status(400).json({ success: false, error: "Invalid product ID: " + productIds[i] });
      }
      productKeys.push(pid);
    }

    var allRaw = await redis.hgetall("auth:products");
    var productNames = {};
    var productLookup = {};
    for (var j = 0; j < productIds.length; j++) {
      var pid = normalizeProductId(productIds[j]);
      var raw = allRaw && allRaw[pid] ? allRaw[pid] : null;
      var data = parseRedisValue(raw);
      if (!data) {
        saveFailureRecord("Product not found: " + productIds[j], device, productIds[j] || "", m, visitorInfo);
        notify.sendActivationFailure(req, {
          reason: "Product not found: " + productIds[j],
          redeemCode: "",
          deviceId: device,
          productId: productIds[j] || "",
          months: m,
          source: "admin-direct",
        }).catch(function () {});
        return res.status(400).json({ success: false, error: "Product not found: " + productIds[j] });
      }
      productNames[pid] = data.name || pid;
      productLookup[pid] = data;
    }

    var deviceHash = crypto.sha256(device);
    var now = Date.now();
    var results = [];
    var saveTasks = [];

    for (var k = 0; k < productIds.length; k++) {
      var productId = normalizeProductId(productIds[k]);

      var redeemCode = null;
      for (var retry = 0; retry < 3; retry++) {
        var candidate = crypto.generateRedeemCode();
        var exists = await redis.get("auth:redeem:" + candidate);
        if (!exists) {
          redeemCode = candidate;
          break;
        }
      }
      if (!redeemCode) {
        saveFailureRecord("Unable to generate unique redeem code", device, productId, m, visitorInfo);
        notify.sendActivationFailure(req, {
          reason: "Unable to generate unique redeem code, please retry",
          redeemCode: "",
          deviceId: device,
          productId: productId,
          months: m,
          source: "admin-direct",
        }).catch(function () {});
        return res.status(500).json({ success: false, error: "Unable to generate unique redeem code, please retry" });
      }

      var activationCode = crypto.generateActivationCode(productId, device, m, redeemCode);

      var expiresAt = null;
      if (m !== 99) {
        var d = new Date(now);
        d.setUTCMonth(d.getUTCMonth() + m);
        expiresAt = d.getTime();
      }

      var redeemData = {
        code: redeemCode,
        product_id: productId,
        duration_months: m,
        used: true,
        used_device_id: deviceHash,
        generated_activation_code: activationCode,
        created_at: now,
        used_at: now,
        source: "direct",
      };

      var recordData = {
        activation_code: activationCode,
        device_id_hash: deviceHash,
        device_id: device,
        device_id_full: device,
        product_id: productId,
        duration_months: m,
        redeem_code: redeemCode,
        generated_at: now,
        expires_at: expiresAt,
        source: "direct",
        device_info: null,
        visitor_info: notify.collectRequestInfo(req),
      };

      saveTasks.push(redis.set("auth:redeem:" + redeemCode, JSON.stringify(redeemData)));
      saveTasks.push(redis.set("auth:activation:" + activationCode, JSON.stringify(recordData)));
      saveTasks.push(redis.sadd("auth:redeem_codes", redeemCode).catch(function () {}));
      saveTasks.push(redis.sadd("auth:activation_codes", activationCode).catch(function () {}));
      saveTasks.push(redis.set("auth:device:" + deviceHash, activationCode));

      results.push({
        productId: productId,
        productName: productNames[productId],
        activationCode: activationCode,
        redeemCode: redeemCode,
        deviceId: device,
        months: m,
        expiresAt: expiresAt,
      });
    }

    await Promise.all(saveTasks);
    for (var n = 0; n < results.length; n++) {
      var r = results[n];
      try {
        await notify.sendActivationNotification(req, {
          redeemCode: r.redeemCode,
          activationCode: r.activationCode,
          productId: r.productId,
          deviceId: r.deviceId,
          months: r.months,
          source: "admin-direct"
        });
      } catch (e) {
        console.error("[direct-activate] Notification failed:", e.message);
      }
      try {
        pushNotify.pushNotification('new_activation', {
          activation_code: r.activationCode,
          redeem_code: r.redeemCode,
          device_id: r.deviceId,
          product_id: r.productId,
          product_name: r.productName || '',
          months: r.months,
          source: 'admin-direct',
          time: Date.now(),
        });
      } catch (_) {}
    }
    return res.json({ success: true, results: results });
  } catch (error) {
    console.error("Direct-activate error:", error);
    saveFailureRecord(error && error.message ? error.message : "Internal server error", deviceId, "", months, visitorInfo);
    notify.sendActivationFailure(req, {
      reason: error && error.message ? error.message : "Internal server error",
      redeemCode: "",
      deviceId: "",
      productId: "",
      months: "",
      source: "admin-direct",
    }).catch(function () {});
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};