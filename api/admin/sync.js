var redis = require("../../lib/redis");
var crypto = require("../../lib/crypto");
var { requireAuth } = require("../../lib/auth");
var quota = require("../../lib/quota");
var postgres = require("../../lib/postgres");

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return body || {};
}

function parseJsonSafe(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch (e) { return fallback; }
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

async function scanAllSetMembers(setKey) {
  var allKeys = [];
  var cursor = "0";
  var guard = 0;
  do {
    var raw = await redis.sscan(setKey, cursor, { count: 200 });
    var parsed = normalizeSscanResult(raw);
    cursor = parsed.cursor;
    if (parsed.keys.length) {
      allKeys = allKeys.concat(parsed.keys);
    }
    guard++;
    if (guard > 5000) break;
  } while (cursor !== "0");
  return allKeys;
}

async function snapshotAll() {
  try { await quota.bumpQuotaTick("/api/admin/sync"); } catch (_) {}
  var pAll = await redis.hgetall("auth:products");
  var productsArray = [];
  if (pAll && typeof pAll === "object") {
    Object.keys(pAll).sort().forEach(function(id) {
      var v = parseJsonSafe(pAll[id], null);
      if (v && typeof v === "object") {
        productsArray.push(Object.assign({ id: String(id).padStart(2, '0') }, v));
      }
    });
  }
  var productCounter = Number(await redis.get("auth:product_counter")) || 0;

  var codeKeys = await scanAllSetMembers("auth:redeem_codes");
  console.log('📊 snapshotAll redeem sscan returned:', codeKeys.length, codeKeys.slice(0, 10));
  var redeemCodesArray = [];
  if (codeKeys.length) {
    var chunks = [];
    for (var i = 0; i < codeKeys.length; i += 200) chunks.push(codeKeys.slice(i, i + 200));
    for (var c = 0; c < chunks.length; c++) {
      var batch = chunks[c];
      var keys = batch.map(function(x) { return "auth:redeem:" + x; });
      var vals = await redis.mget(keys);
      console.log('📊 snapshotAll redeem mget:', keys.length, 'keys, vals length:', vals ? vals.length : 'NULL', 'first val:', vals && vals[0] ? String(vals[0]).slice(0, 60) : 'EMPTY');
      for (var j = 0; j < batch.length; j++) {
        var code = batch[j];
        var raw = vals && vals[j];
        var obj = parseJsonSafe(raw, null);
        if (obj) {
          var o = Object.assign({}, obj, { code: String(code).toUpperCase() });
          if (o.product_id) o.product_id = String(o.product_id).padStart(2, '0');
          redeemCodesArray.push(o);
        } else {
          console.warn("snapshotAll: redeem set member has no kv_string data, key=", code, "raw=", raw);
        }
      }
    }
  }

  var actKeys = await scanAllSetMembers("auth:activation_codes");
  var activationsArray = [];
  if (actKeys.length) {
    var chunksA = [];
    for (var i2 = 0; i2 < actKeys.length; i2 += 200) chunksA.push(actKeys.slice(i2, i2 + 200));
    for (var c2 = 0; c2 < chunksA.length; c2++) {
      var batchA = chunksA[c2];
      var keysA = batchA.map(function(x) { return "auth:activation:" + x; });
      var valsA = await redis.mget(keysA);
      for (var j2 = 0; j2 < batchA.length; j2++) {
        var acode = batchA[j2];
        var rawA = valsA && valsA[j2];
        var objA = parseJsonSafe(rawA, null);
        if (objA) {
          var oa = Object.assign({}, objA);
          if (!oa.activation_code) oa.activation_code = String(acode);
          activationsArray.push(oa);
        } else {
          console.warn("snapshotAll: activation set member has no kv_string data, key=", acode, "raw=", rawA);
        }
      }
    }
  }

  // 📊 调试日志：输出每个数据集合的数量，方便排查
  console.log("📊 snapshotAll stats:", {
    products: productsArray.length,
    redeemCodes: redeemCodesArray.length,
    activationRecords: activationsArray.length,
    codeSetSize: codeKeys.length,
    activationSetSize: actKeys.length,
    productCounter: productCounter,
  });

  return {
    schema: 2,
    generatedAt: Date.now(),
    counters: {
      product_counter: productCounter,
    },
    products: productsArray,
    redeemCodes: redeemCodesArray,
    activationRecords: activationsArray,
    stats: {
      productCount: productsArray.length,
      redeemCodeCount: redeemCodesArray.length,
      activationCount: activationsArray.length,
    },
  };
}

function validateLocalProduct(id, p) {
  if (p && typeof p === "object" && !id) id = p.id;
  id = String(id || "").trim();
  if (!/^\d{1,2}$/.test(id)) return null;
  if (!p || typeof p !== "object") return null;
  var name = String(p.name || "").trim();
  if (name.length < 1 || name.length > 60) return null;
  return {
    id: id.padStart(2, "0"),
    name: name,
    description: String(p.description || "").trim().slice(0, 200),
    created_at: Number(p.created_at) || Date.now(),
    updated_at: Number(p.updated_at) || Date.now(),
  };
}

function validateLocalCode(obj, idx) {
  if (!obj || typeof obj !== "object") {
    console.warn("validateLocalCode: skip, not an object", { idx: idx, type: typeof obj });
    return null;
  }
  var c = String(obj.code || (typeof idx === "string" ? idx : "")).toUpperCase().trim();
  if (!/^[A-Z0-9]{3,16}$/.test(c)) {
    console.warn("validateLocalCode: skip, invalid code format", { code: c, idx: idx });
    return null;
  }
  var pid = String(obj.product_id || "01").padStart(2, "0");
  var dm = Number(obj.duration_months);
  if (!/^\d{2}$/.test(pid)) {
    console.warn("validateLocalCode: skip, invalid product_id", { code: c, product_id: obj.product_id });
    return null;
  }
  if (!Number.isFinite(dm) || dm < 1 || dm > 99) {
    console.warn("validateLocalCode: skip, invalid duration_months", { code: c, duration_months: obj.duration_months });
    return null;
  }
  var used = !!obj.used;
  return {
    code: c,
    product_id: pid,
    duration_months: dm,
    created_at: Number(obj.created_at) || Date.now(),
    used: used,
    used_device_id: used ? String(obj.used_device_id || "").trim() : "",
    used_at: used ? (Number(obj.used_at) || Date.now()) : 0,
    generated_activation_code: String(obj.generated_activation_code || "").trim(),
  };
}

function validateLocalActivation(obj, idx) {
  if (!obj || typeof obj !== "object") return null;
  var c = String(obj.activation_code || (typeof idx === "string" ? idx : "")).replace(/\D/g, "");
  if (c.length < 8 || c.length > 32) return null;
  var pid = String(obj.product_id || "01").padStart(2, "0");
  if (!/^\d{2}$/.test(pid)) return null;
  return {
    activation_code: c,
    device_id_hash: String(obj.device_id_hash || obj.used_device_id || "").trim(),
    device_id: String(obj.device_id || "").trim(),
    product_id: pid,
    duration_months: Number(obj.duration_months) || 1,
    redeem_code: String(obj.redeem_code || "").trim().toUpperCase(),
    generated_at: Number(obj.generated_at) || Date.now(),
    expires_at: (obj.expires_at != null) ? Number(obj.expires_at) : null,
  };
}

async function applyPatch(patch) {
  var report = {
    products: { added: 0, updated: 0, skipped: 0, deleted: 0 },
    redeemCodes: { added: 0, updated: 0, skipped: 0, deleted: 0 },
    activationRecords: { added: 0, updated: 0, skipped: 0 },
    counters: {}
  };
  if (!patch || typeof patch !== "object") return report;

  console.log('📦 applyPatch incoming', {
    productCount: patch.products ? Object.keys(patch.products).length : 0,
    codeArrayLen: patch.redeemCodes ? patch.redeemCodes.length : 0,
    recordArrayLen: patch.activationRecords ? patch.activationRecords.length : 0,
    deletes: patch.deletes,
    codeSample: Array.isArray(patch.redeemCodes) && patch.redeemCodes.length ? patch.redeemCodes.slice(0, 2).map(function(c){ return c && c.code; }) : [],
  });

  // 1) counters
  if (patch.counters && typeof patch.counters === "object") {
    if (Number.isFinite(Number(patch.counters.product_counter))) {
      var local = Number(patch.counters.product_counter);
      var cur = Number(await redis.get("auth:product_counter")) || 0;
      if (local > cur) {
        await redis.set("auth:product_counter", String(local));
        report.counters.product_counter_updated_from_to = [cur, local];
      } else {
        report.counters.product_counter_kept = cur;
      }
    }
  }

  // 2) products: 支持数组或对象两种来源（前端传对象、数组都兼容）
  var productsInput = [];
  if (Array.isArray(patch.products)) {
    productsInput = patch.products.slice();
  } else if (patch.products && typeof patch.products === "object") {
    Object.keys(patch.products).forEach(function(k) {
      productsInput.push(Object.assign({ id: k }, patch.products[k] || {}));
    });
  }
  for (var i = 0; i < productsInput.length; i++) {
    var rawP = productsInput[i];
    var v = validateLocalProduct(rawP && rawP.id, rawP);
    if (!v) { report.products.skipped++; continue; }
    var existedRaw = await redis.hget("auth:products", v.id);
    var existed = parseJsonSafe(existedRaw, null);
    var existedTs = existed && Number(existed.updated_at) ? Number(existed.updated_at) : 0;
    if (!existed || existedTs < Number(v.updated_at || 0)) {
      if (!existed) report.products.added++; else report.products.updated++;
      await redis.hset("auth:products", { [v.id]: JSON.stringify(v) });
      try { await redis.sadd("auth:product_ids", v.id); } catch (_) {}
    } else {
      report.products.skipped++;
    }
  }

  var deletes = (patch.deletes && typeof patch.deletes === "object") ? patch.deletes : {};
  var delPids = [];
  if (Array.isArray(patch.deletedProductIds)) delPids = delPids.concat(patch.deletedProductIds);
  if (Array.isArray(deletes.productIds)) delPids = delPids.concat(deletes.productIds);
  var seenPid = {};
  for (var di = 0; di < delPids.length; di++) {
    var did = String(delPids[di]).padStart(2, "0");
    if (seenPid[did]) continue;
    seenPid[did] = true;
    if (/^\d{2}$/.test(did)) {
      await redis.hdel("auth:products", did);
      try { await redis.srem("auth:product_ids", did); } catch (_) {}
      report.products.deleted++;
    }
  }

  // 3) redeem codes: 支持数组（前端）或对象两种输入
  var codesInput = [];
  if (Array.isArray(patch.redeemCodes)) {
    codesInput = patch.redeemCodes.slice();
  } else if (patch.redeemCodes && typeof patch.redeemCodes === "object") {
    Object.keys(patch.redeemCodes).forEach(function(k) {
      codesInput.push(Object.assign({ code: k }, patch.redeemCodes[k] || {}));
    });
  }
  for (var k = 0; k < codesInput.length; k++) {
    var cv = validateLocalCode(codesInput[k]);
    if (!cv) { report.redeemCodes.skipped++; continue; }
    var key = "auth:redeem:" + cv.code;
    var existed2Raw = await redis.get(key);
    var existed2 = parseJsonSafe(existed2Raw, null);
    var e2Ts = existed2 && (Number(existed2.used_at) || Number(existed2.created_at) || 0);
    var nTs = Number(cv.used_at) || Number(cv.created_at) || 0;
    var serverWins = existed2 && existed2.used && !cv.used; // server 已使用本地没使用，保持服务器
    if (serverWins) { report.redeemCodes.skipped++; continue; }
    if (!existed2 || e2Ts <= nTs || (cv.used && !existed2.used)) {
      if (!existed2) report.redeemCodes.added++; else report.redeemCodes.updated++;
      try {
        await redis.setWithSadd(key, JSON.stringify(cv), "auth:redeem_codes", cv.code);
        console.log('📦 applyPatch write redeem:', cv.code, 'txn=OK');
      } catch (se) {
        console.error('📦 applyPatch redeem setWithSadd failed:', cv.code, se.message);
        await redis.set(key, JSON.stringify(cv));
        try { await redis.sadd("auth:redeem_codes", cv.code); } catch (_) {}
      }
    } else {
      report.redeemCodes.skipped++;
    }
  }
  console.log('📦 applyPatch redeemCodes result:', report.redeemCodes);

  var delCodes = [];
  if (Array.isArray(patch.deletedRedeemCodes)) delCodes = delCodes.concat(patch.deletedRedeemCodes);
  if (Array.isArray(deletes.redeemCodes)) delCodes = delCodes.concat(deletes.redeemCodes);
  var seenCode = {};
  for (var dk = 0; dk < delCodes.length; dk++) {
    var dcode = String(delCodes[dk]).toUpperCase();
    if (seenCode[dcode]) continue;
    seenCode[dcode] = true;
    if (/^[A-Z0-9]{3,16}$/.test(dcode)) {
      await redis.del("auth:redeem:" + dcode);
      try { await redis.srem("auth:redeem_codes", dcode); } catch (_) {}
      report.redeemCodes.deleted++;
    }
  }

  // 4) activation records: 支持数组（前端）或对象两种；激活记录以服务器为权威（客户端不允许覆盖服务器记录），只有服务器不存在的新激活才插入
  var actInput = [];
  if (Array.isArray(patch.activationRecords)) {
    actInput = patch.activationRecords.slice();
  } else if (patch.activations && typeof patch.activations === "object") {
    Object.keys(patch.activations).forEach(function(k) {
      actInput.push(Object.assign({ activation_code: k }, patch.activations[k] || {}));
    });
  }
  for (var m = 0; m < actInput.length; m++) {
    var av = validateLocalActivation(actInput[m]);
    if (!av) { report.activationRecords.skipped++; continue; }
    var aKey = "auth:activation:" + av.activation_code;
    var existedARaw = await redis.get(aKey);
    var existedA = parseJsonSafe(existedARaw, null);
    // 服务器为权威：已存在记录一律不覆盖（除非服务器缺字段本地补上）
    if (!existedA) {
      report.activationRecords.added++;
      try {
        await redis.setWithSadd(aKey, JSON.stringify(av), "auth:activation_codes", av.activation_code);
      } catch (se) {
        console.error('📦 applyPatch activation setWithSadd failed:', av.activation_code, se.message);
        await redis.set(aKey, JSON.stringify(av));
        try { await redis.sadd("auth:activation_codes", av.activation_code); } catch (_) {}
      }
      if (av.device_id_hash) {
        try { await redis.set("auth:device:" + av.device_id_hash, av.activation_code); } catch (_) {}
      }
    } else {
      var needPatch = false;
      var merged = Object.assign({}, existedA);
      if (!merged.device_id && av.device_id) { merged.device_id = av.device_id; needPatch = true; }
      if (!merged.expires_at && av.expires_at) { merged.expires_at = av.expires_at; needPatch = true; }
      if (needPatch) {
        report.activationRecords.updated++;
        await redis.set(aKey, JSON.stringify(merged));
      } else {
        report.activationRecords.skipped++;
      }
    }
  }
  return report;
}

function summarizeReport(r) {
  var parts = [];
  if (r.products) {
    parts.push(
      "产品: " + r.products.added + "新增/" + r.products.updated + "更新/" + r.products.deleted + "删除/" + r.products.skipped + "跳过"
    );
  }
  if (r.redeemCodes) {
    parts.push(
      "兑换码: " + r.redeemCodes.added + "新增/" + r.redeemCodes.updated + "更新/" + r.redeemCodes.deleted + "删除/" + r.redeemCodes.skipped + "跳过"
    );
  }
  if (r.activationRecords) {
    parts.push(
      "激活记录: " + r.activationRecords.added + "新增/" + r.activationRecords.updated + "补齐字段/" + r.activationRecords.skipped + "跳过(服务器权威)"
    );
  }
  return parts.join("；");
}

function generateMessageUuid() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

function validateMessageInput(body) {
  var errors = [];
  var result = { title: "", content: "", message_type: "info", priority: 0, is_active: true };
  if (!body) { errors.push("Request body is required"); return { valid: false, errors, data: result }; }
  if (body.title !== undefined && body.title !== null) {
    result.title = String(body.title).trim();
    if (result.title.length > 255) errors.push("Title must be 255 characters or less");
  }
  var content = body.content !== undefined ? String(body.content) : "";
  result.content = content.trim();
  if (!result.content) errors.push("Content is required");
  if (result.content.length > 10000) errors.push("Content must be 10000 characters or less");
  var allowedTypes = ["info", "warning", "success", "error", "announcement"];
  if (body.message_type) {
    var t = String(body.message_type).toLowerCase();
    if (allowedTypes.indexOf(t) !== -1) result.message_type = t;
    else errors.push("Invalid message type. Allowed: " + allowedTypes.join(", "));
  }
  if (body.priority !== undefined && body.priority !== null && body.priority !== "") {
    var p = parseInt(body.priority, 10);
    if (Number.isFinite(p)) result.priority = Math.max(0, Math.min(10, p));
  }
  if (body.is_active !== undefined) result.is_active = body.is_active === true || body.is_active === "true" || body.is_active === 1;
  return { valid: errors.length === 0, errors, data: result };
}

async function handlePostgresMessages(req, res, auth) {
  if (!postgres.isConfigured()) {
    return res.status(500).json({ success: false, error: "Postgres is not configured. Set POSTGRES_URL environment variable." });
  }
  try { await postgres.ensureMessagesTable(); } catch (initErr) {
    console.error("Postgres init error:", initErr);
    return res.status(500).json({ success: false, error: "Failed to initialize database: " + (initErr.message || initErr) });
  }

  if (req.method === "GET") {
    try {
      var limit = 50;
      var offset = 0;
      if (req.query && req.query.limit) { var l = parseInt(req.query.limit, 10); if (Number.isFinite(l) && l > 0) limit = Math.min(200, l); }
      if (req.query && req.query.offset) { var o = parseInt(req.query.offset, 10); if (Number.isFinite(o) && o > 0) offset = o; }
      var result = await postgres.query(
        "SELECT id, uuid, title, content, message_type, priority, is_active, created_by, created_at, updated_at FROM admin_messages ORDER BY priority DESC, created_at DESC LIMIT $1 OFFSET $2",
        [limit, offset]
      );
      var countResult = await postgres.query("SELECT COUNT(*)::int AS total FROM admin_messages");
      var total = countResult && countResult.rows && countResult.rows[0] ? countResult.rows[0].total : 0;
      return res.status(200).json({ success: true, messages: result.rows || [], total: total, limit: limit, offset: offset });
    } catch (error) {
      console.error("Postgres messages fetch error:", error);
      return res.status(500).json({ success: false, error: "Failed to fetch messages: " + (error.message || error) });
    }
  }

  if (req.method === "POST") {
    try {
      var validation = validateMessageInput(req.body);
      if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.join("; ") });
      var data = validation.data;
      var uuid = generateMessageUuid();
      var result2 = await postgres.query(
        "INSERT INTO admin_messages (uuid, title, content, message_type, priority, is_active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, uuid, title, content, message_type, priority, is_active, created_by, created_at, updated_at",
        [uuid, data.title || null, data.content, data.message_type, data.priority, data.is_active, auth.username || "system"]
      );
      var created = result2.rows && result2.rows[0] ? result2.rows[0] : null;
      if (!created) return res.status(500).json({ success: false, error: "Failed to create message record" });
      return res.status(200).json({ success: true, message: created });
    } catch (error) {
      console.error("Postgres create message error:", error);
      return res.status(500).json({ success: false, error: "Failed to create message: " + (error.message || error) });
    }
  }

  if (req.method === "DELETE") {
    try {
      var id = null;
      var uuidDel = null;
      if (req.query) { if (req.query.id !== undefined) id = parseInt(req.query.id, 10); if (req.query.uuid !== undefined) uuidDel = String(req.query.uuid).trim(); }
      if (req.body) { if (id === null && req.body.id !== undefined) id = parseInt(req.body.id, 10); if (!uuidDel && req.body.uuid !== undefined) uuidDel = String(req.body.uuid).trim(); }
      if (!Number.isFinite(id) && !uuidDel) return res.status(400).json({ success: false, error: "Message id or uuid is required for deletion" });
      var delResult = Number.isFinite(id)
        ? await postgres.query("DELETE FROM admin_messages WHERE id = $1 RETURNING id", [id])
        : await postgres.query("DELETE FROM admin_messages WHERE uuid = $1 RETURNING id", [uuidDel]);
      var deleted = delResult.rows && delResult.rows.length > 0;
      if (!deleted) return res.status(404).json({ success: false, error: "Message not found" });
      return res.status(200).json({ success: true, deleted: true });
    } catch (error) {
      console.error("Postgres delete message error:", error);
      return res.status(500).json({ success: false, error: "Failed to delete message: " + (error.message || error) });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}

function normalizeProductId(id) { return String(id || "").padStart(2, "0"); }
function redeemCodeKey(c) { return String(c.code || "").toUpperCase().trim(); }
function activationKey(a) { return String(a.activation_code || "").trim(); }

function compareProducts(localArr, remoteArr) {
  var localMap = {}, remoteMap = {}, allKeys = {};
  localArr.forEach(function(p) { var k = normalizeProductId(p.id); localMap[k] = p; allKeys[k] = true; });
  remoteArr.forEach(function(p) { var k = normalizeProductId(p.id); remoteMap[k] = p; allKeys[k] = true; });
  var onlyLocal = [], onlyRemote = [], diff = [], same = 0;
  Object.keys(allKeys).forEach(function(k) {
    var l = localMap[k], r = remoteMap[k];
    if (l && !r) { onlyLocal.push({ id: k, local: l }); }
    else if (!l && r) { onlyRemote.push({ id: k, remote: r }); }
    else if (l && r) { JSON.stringify(l) !== JSON.stringify(r) ? diff.push({ id: k, local: l, remote: r }) : same++; }
  });
  return { localCount: localArr.length, remoteCount: remoteArr.length, same: same, onlyLocal: onlyLocal, onlyRemote: onlyRemote, diff: diff };
}

function compareRedeemCodes(localArr, remoteArr) {
  var localMap = {}, remoteMap = {}, allKeys = {};
  localArr.forEach(function(c) { var k = redeemCodeKey(c); localMap[k] = c; allKeys[k] = true; });
  remoteArr.forEach(function(c) { var k = redeemCodeKey(c); remoteMap[k] = c; allKeys[k] = true; });
  var onlyLocal = [], onlyRemote = [], diff = [], same = 0;
  Object.keys(allKeys).forEach(function(k) {
    var l = localMap[k], r = remoteMap[k];
    if (l && !r) { onlyLocal.push({ code: k, local: l }); }
    else if (!l && r) { onlyRemote.push({ code: k, remote: r }); }
    else if (l && r) { JSON.stringify(l) !== JSON.stringify(r) ? diff.push({ code: k, local: l, remote: r }) : same++; }
  });
  return { localCount: localArr.length, remoteCount: remoteArr.length, same: same, onlyLocal: onlyLocal, onlyRemote: onlyRemote, diff: diff };
}

function compareActivations(localArr, remoteArr) {
  var localMap = {}, remoteMap = {}, allKeys = {};
  localArr.forEach(function(a) { var k = activationKey(a); localMap[k] = a; allKeys[k] = true; });
  remoteArr.forEach(function(a) { var k = activationKey(a); remoteMap[k] = a; allKeys[k] = true; });
  var onlyLocal = [], onlyRemote = [], diff = [], same = 0;
  Object.keys(allKeys).forEach(function(k) {
    var l = localMap[k], r = remoteMap[k];
    if (l && !r) { onlyLocal.push({ activation_code: k, local: l }); }
    else if (!l && r) { onlyRemote.push({ activation_code: k, remote: r }); }
    else if (l && r) { JSON.stringify(l) !== JSON.stringify(r) ? diff.push({ activation_code: k, local: l, remote: r }) : same++; }
  });
  return { localCount: localArr.length, remoteCount: remoteArr.length, same: same, onlyLocal: onlyLocal, onlyRemote: onlyRemote, diff: diff };
}

function compareCounters(local, remote) {
  return { local: local || {}, remote: remote || {}, diff: JSON.stringify(local) !== JSON.stringify(remote) };
}

async function diffFixProducts(data) {
  var products = Array.isArray(data) ? data : [];
  for (var fi = 0; fi < products.length; fi++) {
    var p = products[fi];
    await redis.hset("auth:products", normalizeProductId(p.id), JSON.stringify(p));
  }
  return { fixed: products.length };
}

async function diffFixRedeemCodes(data) {
  var codes = Array.isArray(data) ? data : [];
  var fixed = 0;
  for (var fj = 0; fj < codes.length; fj++) {
    var c = codes[fj];
    var code = redeemCodeKey(c);
    try {
      await redis.setWithSadd("auth:redeem:" + code, JSON.stringify(c), "auth:redeem_codes", code);
      fixed++;
    } catch (se) {
      await redis.set("auth:redeem:" + code, JSON.stringify(c));
      try { await redis.sadd("auth:redeem_codes", code); } catch (_) {}
      fixed++;
    }
  }
  return { fixed: fixed };
}

async function diffFixActivationRecords(data) {
  var records = Array.isArray(data) ? data : [];
  var fixed = 0;
  for (var fk = 0; fk < records.length; fk++) {
    var a = records[fk];
    var code = activationKey(a);
    try {
      await redis.setWithSadd("auth:activation:" + code, JSON.stringify(a), "auth:activation_codes", code);
      fixed++;
    } catch (se) {
      await redis.set("auth:activation:" + code, JSON.stringify(a));
      try { await redis.sadd("auth:activation_codes", code); } catch (_) {}
      fixed++;
    }
  }
  return { fixed: fixed };
}

async function diffFixCounters(data) {
  if (data && typeof data.product_counter !== "undefined") {
    await redis.set("auth:product_counter", String(data.product_counter));
  }
  return { fixed: true };
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.query && req.query.resource === "postgres-messages") {
    return handlePostgresMessages(req, res, auth);
  }

  if (req.method === "GET") {
    try {
      var snap = await snapshotAll();
      return res.json({ success: true, mode: "full-snapshot", snapshot: snap, data: snap });
    } catch (e) {
      console.error("sync GET snapshot failed:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.method === "POST") {
    var body = parseBody(req);
    // 兼容两种前端：body.mode(新) / body.action(旧)
    var mode = String(body.mode || body.action || "merge");
    if (!["push", "pull", "merge", "diff-compare", "diff-fix"].includes(mode)) mode = "merge";
    try {
      if (mode === "pull") {
        var s = await snapshotAll();
        return res.json({ success: true, mode: "pull", snapshot: s, data: s });
      }
      if (mode === "push" || mode === "merge") {
        if (!body.patch && !body.data) {
          return res.status(400).json({ success: false, error: "Missing patch payload" });
        }
        var patch = body.patch || body.data || {};
        var r = await applyPatch(patch);
        var summary = summarizeReport(r);
        // Wait 800ms for Neon read-replica to catch up after writes
        await new Promise(function(resolve) { setTimeout(resolve, 800); });
        var after = (mode === "merge" || mode === "push") ? await snapshotAll() : null;
        if (mode === "merge") {
          return res.json({
            success: true,
            mode: "merge",
            applied: r,
            summary: summary,
            snapshot: after,
          });
        }
        return res.json({
          success: true,
          mode: "push",
          applied: r,
          summary: summary,
          snapshot: after,
        });
      }
      if (mode === "diff-compare") {
        var local = body.local || {};
        var snap = await snapshotAll();
        var redeemCodesResult = compareRedeemCodes(Array.isArray(local.redeemCodes) ? local.redeemCodes : [], snap.redeemCodes || []);
        return res.json({
          success: true,
          mode: "diff-compare",
          action: "compare",
          remoteGeneratedAt: snap.generatedAt,
          _debugStats: snap.stats || null,
          products: compareProducts(Array.isArray(local.products) ? local.products : [], snap.products || []),
          redeemCodes: redeemCodesResult,
          activationRecords: compareActivations(Array.isArray(local.activationRecords) ? local.activationRecords : [], snap.activationRecords || []),
          counters: compareCounters(local.counters || {}, snap.counters || {}),
        });
      }
      if (mode === "diff-fix") {
        var table = String(body.table || "");
        if (!table) return res.status(400).json({ success: false, error: "Missing table parameter" });
        var fixResult = null;
        switch (table) {
          case "products": fixResult = await diffFixProducts(body.data || []); break;
          case "redeemCodes": fixResult = await diffFixRedeemCodes(body.data || []); break;
          case "activationRecords": fixResult = await diffFixActivationRecords(body.data || []); break;
          case "counters": fixResult = await diffFixCounters(body.data || {}); break;
          default: return res.status(400).json({ success: false, error: "Unknown table: " + table });
        }
        return res.json({ success: true, mode: "diff-fix", action: "fix", table: table, result: fixResult });
      }
      return res.status(400).json({ success: false, error: "Unknown mode: " + mode });
    } catch (e) {
      console.error("sync POST failed:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};