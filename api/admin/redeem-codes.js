var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var crypto = require("../../lib/crypto");
var { generateRedeemCode } = crypto;
var { validateCount, validateDuration, validateDeviceId } = require("../../lib/validate");
var notify = require("../../lib/notify");

function matchCode(data, filterProductId, filterUsed, filterDuration) {
  if (filterProductId && data.product_id !== filterProductId) return false;
  if (filterUsed === "1" && !data.used) return false;
  if (filterUsed === "0" && data.used) return false;
  if (filterDuration && String(data.duration_months) !== filterDuration) return false;
  return true;
}

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try {
      cur = JSON.parse(cur);
    } catch (e) {
      return null;
    }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

function normalizeSscanResult(result) {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] == null ? "0" : result[0]),
      keys: Array.isArray(result[1]) ? result[1] : [],
    };
  }
  if (result && typeof result === "object") {
    return {
      cursor: String(result.cursor == null ? "0" : result.cursor),
      keys: Array.isArray(result.keys) ? result.keys : [],
    };
  }
  return { cursor: "0", keys: [] };
}

async function scanAllRedeemCodes() {
  var allKeys = [];
  var cursor = "0";
  var guard = 0;
  do {
    var raw = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
    var parsed = normalizeSscanResult(raw);
    cursor = parsed.cursor;
    if (parsed.keys.length) {
      allKeys = allKeys.concat(parsed.keys);
    }
    guard++;
  } while (cursor !== "0" && guard < 500);
  return allKeys;
}

async function fetchRedeemRecords(keys) {
  var records = [];
  if (!keys || keys.length === 0) return records;

  var batchSize = 100;
  for (var i = 0; i < keys.length; i += batchSize) {
    var batch = keys.slice(i, i + batchSize);
    var values;
    try {
      var pipeline = redis.pipeline();
      batch.forEach(function (code) {
        pipeline.get("auth:redeem:" + code);
      });
      values = await pipeline.exec();
    } catch (e) {
      console.error("fetchRedeemRecords batch failed:", e);
      throw e;
    }

    if (!Array.isArray(values)) values = [];
    values.forEach(function (val, idx) {
      var data = parseRedisJson(val);
      if (!data) return;
      if (!data.code) data.code = batch[idx];
      records.push(data);
    });
  }
  return records;
}

async function listFilteredCodes(filterProductId, filterUsed, filterDuration) {
  var keys = await scanAllRedeemCodes();
  var allCodes = await fetchRedeemRecords(keys);
  return allCodes.filter(function (data) {
    return matchCode(data, filterProductId, filterUsed, filterDuration);
  });
}

function generateUniqueCodes(count) {
  var codes = new Set();
  var attempts = 0;
  var maxAttempts = count * 20;
  while (codes.size < count && attempts < maxAttempts) {
    codes.add(generateRedeemCode());
    attempts++;
  }
  return Array.from(codes);
}

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return body;
}

function parseRedisValue(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch (e) { return null; }
  }
  return null;
}

function normalizeProductId2(productId) {
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

  try {
    if (req.method === "POST" && req.query.action === "direct-activate") {
      var body = parseBody(req);
      var deviceId = body.deviceId;
      var productIds = body.productIds;
      var months = body.months;
      var visitorInfo = notify.collectRequestInfo(req);

      var deviceCheck = validateDeviceId(deviceId);
      if (!deviceCheck.valid) {
        saveFailureRecord(deviceCheck.error, deviceId, "", months, visitorInfo);
        notify.sendActivationFailure(req, {
          reason: deviceCheck.error, redeemCode: "", deviceId: deviceId || "",
          productId: "", months: months || "", source: "admin-direct",
        }).catch(function () {});
        return res.status(400).json({ success: false, error: deviceCheck.error });
      }
      var device = deviceCheck.value;

      if (!Array.isArray(productIds) || productIds.length === 0) {
        saveFailureRecord("Please select at least one product", device, "", months, visitorInfo);
        return res.status(400).json({ success: false, error: "Please select at least one product" });
      }
      if (productIds.length > 20) {
        saveFailureRecord("Too many products selected (max 20)", device, "", months, visitorInfo);
        return res.status(400).json({ success: false, error: "Too many products selected (max 20)" });
      }

      var m = normalizeMonths(months);
      if (!m) {
        saveFailureRecord("Months must be 1-99", device, "", months, visitorInfo);
        return res.status(400).json({ success: false, error: "Months must be 1-99" });
      }

      var productKeys = [];
      for (var i = 0; i < productIds.length; i++) {
        var pid = normalizeProductId2(productIds[i]);
        if (!pid) {
          saveFailureRecord("Invalid product ID: " + productIds[i], device, productIds[i] || "", m, visitorInfo);
          return res.status(400).json({ success: false, error: "Invalid product ID: " + productIds[i] });
        }
        productKeys.push(pid);
      }

      var allRaw = await redis.hgetall("auth:products");
      var productNames = {};
      var productLookup = {};
      for (var j = 0; j < productIds.length; j++) {
        var pid2 = normalizeProductId2(productIds[j]);
        var raw = allRaw && allRaw[pid2] ? allRaw[pid2] : null;
        var data = parseRedisValue(raw);
        if (!data) {
          saveFailureRecord("Product not found: " + productIds[j], device, productIds[j] || "", m, visitorInfo);
          return res.status(400).json({ success: false, error: "Product not found: " + productIds[j] });
        }
        productNames[pid2] = data.name || pid2;
        productLookup[pid2] = data;
      }

      var deviceHash = crypto.sha256(device);
      var now = Date.now();
      var results = [];
      var saveTasks = [];

      for (var k = 0; k < productIds.length; k++) {
        var productId = normalizeProductId2(productIds[k]);

        var redeemCode = null;
        for (var retry = 0; retry < 3; retry++) {
          var candidate = crypto.generateRedeemCode();
          var exists = await redis.get("auth:redeem:" + candidate);
          if (!exists) { redeemCode = candidate; break; }
        }
        if (!redeemCode) {
          saveFailureRecord("Unable to generate unique redeem code", device, productId, m, visitorInfo);
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
          code: redeemCode, product_id: productId, duration_months: m,
          used: true, used_device_id: deviceHash,
          generated_activation_code: activationCode,
          created_at: now, used_at: now, source: "direct",
        };

        var recordData = {
          activation_code: activationCode, device_id_hash: deviceHash,
          device_id: device, device_id_full: device,
          product_id: productId, duration_months: m,
          redeem_code: redeemCode, generated_at: now,
          expires_at: expiresAt, source: "direct",
          device_info: null, visitor_info: notify.collectRequestInfo(req),
        };

        saveTasks.push(redis.set("auth:redeem:" + redeemCode, JSON.stringify(redeemData)));
        saveTasks.push(redis.set("auth:activation:" + activationCode, JSON.stringify(recordData)));
        saveTasks.push(redis.sadd("auth:redeem_codes", redeemCode).catch(function () {}));
        saveTasks.push(redis.sadd("auth:activation_codes", activationCode).catch(function () {}));
        saveTasks.push(redis.set("auth:device:" + deviceHash, activationCode));

        results.push({
          productId: productId, productName: productNames[productId],
          activationCode: activationCode, redeemCode: redeemCode,
          deviceId: device, months: m, expiresAt: expiresAt,
        });
      }

      await Promise.all(saveTasks);
      for (var n = 0; n < results.length; n++) {
        var r = results[n];
        try {
          await notify.sendActivationNotification(req, {
            redeemCode: r.redeemCode, activationCode: r.activationCode,
            productId: r.productId, deviceId: r.deviceId,
            months: r.months, source: "admin-direct"
          });
        } catch (e) { console.error("[direct-activate] Notification failed:", e.message); }
      }
      return res.json({ success: true, results: results });
    }

    if (req.method === "POST" && req.query.action === "unbind") {
      var unbindBody = parseBody(req);
      var unbindCode = String(unbindBody.code || req.query.code || "").trim().toUpperCase();
      if (!unbindCode) {
        return res.status(400).json({ success: false, error: "Code is required" });
      }
      var existingRecord = await redis.get("auth:redeem:" + unbindCode);
      if (!existingRecord) {
        return res.status(404).json({ success: false, error: "Redeem code not found" });
      }
      var recordData = null;
      try { recordData = JSON.parse(existingRecord); } catch (e) { recordData = null; }
      if (!recordData || typeof recordData !== "object") {
        return res.status(400).json({ success: false, error: "Invalid redeem code record" });
      }
      if (!recordData.used) {
        return res.status(200).json({ success: true, code: unbindCode, message: "Already unbound", wasUsed: false });
      }
      var oldDevice = recordData.used_device_id || "unknown";
      recordData.used = false;
      delete recordData.used_at;
      delete recordData.used_device_id;
      delete recordData.generated_activation_code;
      await redis.set("auth:redeem:" + unbindCode, JSON.stringify(recordData));
      try { await redis.del("auth:counter:used_redeem_codes"); } catch (e) {}
      return res.json({ success: true, code: unbindCode, message: "Unbound from device " + oldDevice });
    }

    if (req.method === "GET") {
      var exportAll = req.query.export;
      var filterProductId = req.query.product_id;
      var filterUsed = req.query.used;
      var filterDuration = req.query.duration_months;

      var filtered = await listFilteredCodes(filterProductId, filterUsed, filterDuration);
      filtered.sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      });

      if (exportAll === "1") {
        return res.json({
          success: true,
          codes: filtered,
          total: filtered.length,
        });
      }

      var page = parseInt(req.query.page, 10) || 1;
      var limit = parseInt(req.query.limit, 10) || 20;
      if (page < 1) page = 1;
      if (limit < 1) limit = 20;
      if (limit > 500) limit = 500;
      var offset = (page - 1) * limit;
      var pageCodes = filtered.slice(offset, offset + limit);

      return res.json({
        success: true,
        codes: pageCodes,
        total: filtered.length,
        page: page,
        limit: limit,
      });
    }

    if (req.method === "POST") {
      if (req.query.action === "purge") {
        var scope = String(req.query.scope || "").trim();
        var productId = String(req.query.product_id || "").trim();
        if (!scope || (scope !== "used" && scope !== "unused")) {
          return res.status(400).json({ success: false, error: "scope must be 'used' or 'unused'" });
        }
        var allCodes = [];
        var cursor = "0";
        var guard = 0;
        do {
          var raw = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
          var parsed;
          if (Array.isArray(raw)) {
            parsed = { cursor: String(raw[0] == null ? "0" : raw[0]), keys: Array.isArray(raw[1]) ? raw[1] : [] };
          } else if (raw && typeof raw === "object") {
            parsed = { cursor: String(raw.cursor == null ? "0" : raw.cursor), keys: Array.isArray(raw.keys) ? raw.keys : [] };
          } else {
            parsed = { cursor: "0", keys: [] };
          }
          cursor = parsed.cursor;
          if (parsed.keys.length) allCodes = allCodes.concat(parsed.keys);
          guard++;
        } while (cursor !== "0" && guard < 500);
        var toDelete = [];
        var batchSize = 100;
        for (var i = 0; i < allCodes.length; i += batchSize) {
          var batch = allCodes.slice(i, i + batchSize);
          var pipeline = redis.pipeline();
          batch.forEach(function (c) { pipeline.get("auth:redeem:" + c); });
          var values = await pipeline.exec();
          if (!Array.isArray(values)) values = [];
          values.forEach(function (val, idx) {
            var data = val;
            for (var k = 0; typeof data === "string" && k < 3; k++) {
              try { data = JSON.parse(data); } catch (e) { data = null; break; }
            }
            if (!data || typeof data !== "object") return;
            if (productId && data.product_id !== productId) return;
            if (scope === "used" && !data.used) return;
            if (scope === "unused" && data.used) return;
            toDelete.push(batch[idx]);
          });
        }
        if (toDelete.length === 0) {
          return res.json({ success: true, deleted: 0, scope: scope, product_id: productId || null });
        }
        var delPipeline = redis.pipeline();
        toDelete.forEach(function (c) {
          delPipeline.del("auth:redeem:" + c);
          delPipeline.srem("auth:redeem_codes", c);
        });
        await delPipeline.exec();
        try { await redis.del("auth:counter:used_redeem_codes"); } catch (e) {}
        return res.json({ success: true, deleted: toDelete.length, scope: scope, product_id: productId || null });
      }

      var body = req.body || {};
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = {};
        }
      }
      var productId = body.productId;
      var count = body.count;
      var durationMonths = body.durationMonths;

      if (!productId || typeof productId !== "string") {
        return res.status(400).json({ success: false, error: "Product ID is required" });
      }

      var productData = await redis.hget("auth:products", productId);
      if (!productData) {
        return res.status(400).json({ success: false, error: "Product not found" });
      }

      var countCheck = validateCount(count);
      if (!countCheck.valid) {
        return res.status(400).json({ success: false, error: countCheck.error });
      }

      var durationCheck = validateDuration(durationMonths);
      if (!durationCheck.valid) {
        return res.status(400).json({ success: false, error: durationCheck.error });
      }

      var numCodes = countCheck.value;
      var months = durationCheck.value;

      var candidateCodes = generateUniqueCodes(numCodes + Math.floor(numCodes * 0.2) + 10);
      var checkPipeline = redis.pipeline();
      candidateCodes.forEach(function (code) {
        checkPipeline.get("auth:redeem:" + code);
      });
      var checkResults = await checkPipeline.exec();

      var availableCodes = [];
      checkResults.forEach(function (val, idx) {
        if (!val && availableCodes.length < numCodes) {
          availableCodes.push(candidateCodes[idx]);
        }
      });

      var now = Date.now();
      var generated = [];
      var writePipeline = redis.pipeline();

      availableCodes.forEach(function (code) {
        var record = {
          code: code,
          product_id: productId,
          duration_months: months,
          used: false,
          used_device_id: null,
          generated_activation_code: null,
          created_at: now,
          used_at: null,
        };
        writePipeline.set("auth:redeem:" + code, JSON.stringify(record));
        writePipeline.sadd("auth:redeem_codes", code);
        generated.push(code);
      });

      await writePipeline.exec();

      try {
        await redis.del("auth:counter:used_redeem_codes");
      } catch (e) {
        console.error("Failed to invalidate used count cache:", e);
      }

      return res.json({
        success: true,
        codes: generated,
        count: generated.length,
      });
    }

    if (req.method === "DELETE") {
      var delCode = String(req.query.code || "").trim().toUpperCase();
      if (!delCode) {
        var delBody = req.body || {};
        if (typeof delBody === "string") {
          try { delBody = JSON.parse(delBody); } catch (e) { delBody = {}; }
        }
        delCode = String(delBody.code || "").trim().toUpperCase();
      }
      if (!delCode) {
        return res.status(400).json({ success: false, error: "Code is required" });
      }
      var existing = await redis.get("auth:redeem:" + delCode);
      if (!existing) {
        return res.status(404).json({ success: false, error: "Redeem code not found" });
      }
      await redis.del("auth:redeem:" + delCode);
      try { await redis.srem("auth:redeem_codes", delCode); } catch (e) {}
      try { await redis.del("auth:counter:used_redeem_codes"); } catch (e) {}
      return res.json({ success: true, code: delCode, removed: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("Redeem codes error:", error && error.message ? error.message : error, error);
    var msg = "Internal server error";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Server database (Postgres) not configured, contact admin";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND/i.test(String(error.message || ""))) {
      msg = "Server database connection failed, try again later or contact admin";
    } else if (error && error.message) {
      msg = error.message;
    }
    return res.status(500).json({ success: false, error: msg });
  }
};