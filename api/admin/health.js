var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var crypto = require("../../lib/crypto");
var quota = require("../../lib/quota");

function nowMs() {
  return Date.now();
}

function getPgConfig() {
  return {
    url: String(process.env.POSTGRES_URL || process.env.DATABASE_URL || "").trim(),
    token: "",
  };
}

function maskUrl(url) {
  if (!url) return "";
  try {
    var u = new URL(url);
    return u.protocol + "//" + u.host + "/***";
  } catch (e) {
    return String(url).slice(0, 24) + "***";
  }
}

async function runCheck(id, name, fn) {
  var started = nowMs();
  try {
    var result = await fn();
    return {
      id: id,
      name: name,
      status: result.status || "pass",
      latencyMs: nowMs() - started,
      detail: result.detail || "",
      hint: result.hint || "",
      data: result.data || null,
    };
  } catch (e) {
    var detailMsg = (e && e.message) || String(e);
    var hintMsg = "Check Vercel function logs and Postgres connection config";
    if (e && e.code === "PG_ENV_MISSING") {
      detailMsg = "Postgres env missing: " + detailMsg;
      hintMsg = "Configure POSTGRES_URL in Vercel Project -> Settings -> Environment Variables, then redeploy";
    }
    return {
      id: id,
      name: name,
      status: "fail",
      latencyMs: nowMs() - started,
      detail: detailMsg,
      hint: hintMsg,
      data: null,
    };
  }
}

const BACKUP_CONFIG_KEY = "auth:backup:config";
const BACKUP_LIST_KEY = "auth:backup:list";
const BACKUP_PREFIX = "auth:backup:";

async function readSetMembers(redis, setKey, valueKeyPrefix) {
  var records = [];
  var cursor = 0;
  while (true) {
    var sscanResult = await redis.sscan(setKey, cursor, { count: 500 });
    var keys = sscanResult[1];
    cursor = parseInt(sscanResult[0], 10);
    if (!keys || keys.length === 0) break;
    var chunks = [];
    for (var i = 0; i < keys.length; i += 200) chunks.push(keys.slice(i, i + 200));
    for (var c = 0; c < chunks.length; c++) {
      var batch = chunks[c];
      var fullKeys = valueKeyPrefix ? batch.map(function(x) { return valueKeyPrefix + x; }) : batch;
      var vals = await redis.mget.apply(redis, fullKeys);
      for (var j = 0; j < batch.length; j++) {
        var raw = vals && vals[j];
        if (typeof raw === "string") {
          try { records.push(JSON.parse(raw)); } catch (_) {}
        }
      }
    }
    if (cursor === 0) break;
  }
  return records;
}

async function readSetMembersDirect(pg, setKey, valueKeyPrefix) {
  var records = [];
  var memberResult = await pg.query("SELECT member FROM kv_sets WHERE key = $1 ORDER BY member", [setKey]);
  var members = (memberResult.rows || []).map(function(r) { return r.member; });
  console.log("[backup] direct query " + setKey + ": " + members.length + " members");
  if (members.length === 0) return records;

  if (valueKeyPrefix === null || valueKeyPrefix === "") {
    for (var i = 0; i < members.length; i++) {
      records.push({ _backup_member: members[i], value: members[i] });
    }
    return records;
  }

  var chunks = [];
  for (var i = 0; i < members.length; i += 200) chunks.push(members.slice(i, i + 200));
  for (var c = 0; c < chunks.length; c++) {
    var batch = chunks[c];
    var lookupKeys = batch.map(function(x) { return valueKeyPrefix + x; });
    var placeholders = lookupKeys.map(function(_, idx) { return "$" + (idx + 1); }).join(",");
    var valResult = await pg.query(
      "SELECT key, value FROM kv_strings WHERE key IN (" + placeholders + ")",
      lookupKeys
    );
    var valMap = {};
    (valResult.rows || []).forEach(function(r) { valMap[r.key] = r.value; });
    for (var j = 0; j < batch.length; j++) {
      var raw = valMap[lookupKeys[j]];
      if (raw) {
        try {
          var rec = JSON.parse(raw);
          rec._backup_key = lookupKeys[j];
          rec._backup_member = batch[j];
          records.push(rec);
        } catch (_) {}
      }
    }
  }
  return records;
}

async function readHashAllDirect(pg, hashKey) {
  var records = [];
  var result = await pg.query("SELECT field, value FROM kv_hashes WHERE key = $1", [hashKey]);
  console.log("[backup] direct query " + hashKey + ": " + (result.rows ? result.rows.length : 0) + " fields");
  (result.rows || []).forEach(function(r) {
    try { records.push({ id: r.field, data: JSON.parse(r.value) }); } catch (_) {
      try { records.push({ id: r.field, value: r.value }); } catch (_) {}
    }
  });
  return records;
}

async function readStringDirect(pg, key) {
  var result = await pg.query("SELECT value FROM kv_strings WHERE key = $1", [key]);
  if (result.rows && result.rows.length > 0) {
    try { return JSON.parse(result.rows[0].value); } catch (_) {
      return result.rows[0].value;
    }
  }
  return null;
}

async function scanKeysDirect(pg, pattern) {
  var records = [];
  var sqlPattern = pattern.replace(/\*/g, "%").replace(/\?/g, "_");
  var result = await pg.query(
    "SELECT key, value FROM kv_strings WHERE key LIKE $1 ORDER BY key",
    [sqlPattern]
  );
  console.log("[backup] scan " + pattern + ": " + (result.rows ? result.rows.length : 0) + " keys");
  (result.rows || []).forEach(function(r) {
    try {
      var rec = JSON.parse(r.value);
      rec._backup_key = r.key;
      records.push(rec);
    } catch (_) {
      records.push({ _backup_key: r.key, value: r.value });
    }
  });
  return records;
}

async function readHashAll(redis, hashKey) {
  var raw = await redis.hgetall(hashKey);
  var records = [];
  if (raw) {
    Object.keys(raw).forEach(function(k) {
      try { records.push({ id: k, data: JSON.parse(raw[k]) }); } catch (_) {
        try { records.push({ id: k, value: raw[k] }); } catch (_) {}
      }
    });
  }
  return records;
}

async function doBackup(redis, isAuto) {
  var pg = require("../../lib/postgres");
  var timestamp = Date.now();
  var label = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  var backupId = isAuto ? ("auto-" + label) : ("manual-" + label);

  console.log("[backup] starting doBackup: " + backupId);

  var products = await readHashAllDirect(pg, "auth:products");
  var productIds = await readSetMembersDirect(pg, "auth:product_ids", null);
  var redeemCodes = await readSetMembersDirect(pg, "auth:redeem_codes", "auth:redeem:");
  var activations = await readSetMembersDirect(pg, "auth:activation_codes", "auth:activation:");
  var failures = await readSetMembersDirect(pg, "auth:activation_failures", "");
  var devices = await scanKeysDirect(pg, "auth:device:%");
  var adminAccount = await readHashAllDirect(pg, "auth:admin");
  var productCounter = await readStringDirect(pg, "auth:product_counter");
  var usedCounter = await readStringDirect(pg, "auth:counter:used_redeem_codes");
  var afdianOrders = await scanKeysDirect(pg, "afdian:order:%");
  var afdianProcessed = await readSetMembersDirect(pg, "afdian:processed", null);
  var afdianLastSync = await readStringDirect(pg, "afdian:last_sync");
  var afdianPlanMap = await readHashAllDirect(pg, "afdian:plan_map");
  var quotaStates = await scanKeysDirect(pg, "quota:monthstate:%");

  console.log("[backup] results: products=" + products.length +
    " productIds=" + productIds.length +
    " redeem=" + redeemCodes.length +
    " activations=" + activations.length +
    " failures=" + failures.length +
    " devices=" + devices.length +
    " admin=" + (adminAccount ? adminAccount.length : 0) +
    " afdianOrders=" + afdianOrders.length +
    " afdianProcessed=" + afdianProcessed.length +
    " quotaStates=" + quotaStates.length);

  var backupData = {
    id: backupId,
    type: isAuto ? "auto" : "manual",
    created_at: new Date().toISOString(),
    timestamp: timestamp,
    tables: {
      products:         { count: products.length,       key: "auth:products",            type: "hash" },
      product_ids:      { count: productIds.length,     key: "auth:product_ids",         type: "set" },
      redeem_codes:     { count: redeemCodes.length,    key: "auth:redeem_codes",        type: "set" },
      activations:      { count: activations.length,    key: "auth:activation_codes",    type: "set" },
      failures:         { count: failures.length,       key: "auth:activation_failures", type: "set" },
      devices:          { count: devices.length,        key: "auth:device:*",            type: "scan" },
      admin_account:    { count: adminAccount ? adminAccount.length : 0, key: "auth:admin", type: "hash" },
      product_counter:  { count: productCounter ? 1 : 0, key: "auth:product_counter",   type: "string" },
      used_counter:     { count: usedCounter ? 1 : 0,   key: "auth:counter:used_redeem_codes", type: "string" },
      afdian_orders:    { count: afdianOrders.length,   key: "afdian:order:*",           type: "scan" },
      afdian_processed: { count: afdianProcessed.length,key: "afdian:processed",         type: "set" },
      afdian_last_sync: { count: afdianLastSync ? 1 : 0,key: "afdian:last_sync",         type: "string" },
      afdian_plan_map:  { count: afdianPlanMap ? afdianPlanMap.length : 0, key: "afdian:plan_map", type: "hash" },
      quota_states:     { count: quotaStates.length,    key: "quota:monthstate:*",       type: "scan" },
    },
    activationCount: activations.length,
    failureCount: failures.length,
    totalCount: activations.length + failures.length,
    products: products,
    product_ids: productIds,
    redeem_codes: redeemCodes,
    activations: activations,
    failures: failures,
    devices: devices,
    admin_account: adminAccount,
    product_counter: productCounter,
    used_counter: usedCounter,
    afdian_orders: afdianOrders,
    afdian_processed: afdianProcessed,
    afdian_last_sync: afdianLastSync,
    afdian_plan_map: afdianPlanMap,
    quota_states: quotaStates,
  };

  var jsonData = JSON.stringify(backupData);
  var sizeBytes = Buffer.byteLength(jsonData, "utf8");

  var pip = redis.pipeline();
  pip.set(BACKUP_PREFIX + "meta:" + backupId, JSON.stringify({
    id: backupId,
    type: backupData.type,
    created_at: backupData.created_at,
    timestamp: timestamp,
    tables: backupData.tables,
    activationCount: backupData.activationCount,
    failureCount: backupData.failureCount,
    totalCount: backupData.totalCount,
    size: sizeBytes,
  }));
  pip.set(BACKUP_PREFIX + "data:" + backupId, jsonData);
  pip.zadd(BACKUP_LIST_KEY, timestamp, backupId);
  await pip.exec();

  return { backupId: backupId, backupData: backupData, sizeBytes: sizeBytes };
}

module.exports = async (req, res) => {
  var isCron = req.query.cron === "1";
  var isBackup = req.query.section === "backup";

  if (isCron && isBackup) {
    try {
      var configRaw = await redis.get(BACKUP_CONFIG_KEY);
      var config = configRaw ? JSON.parse(configRaw) : { enabled: false };
      if (!config.enabled) {
        return res.json({ success: true, message: "Auto backup disabled", skipped: true });
      }

      var result = await doBackup(redis, true);

      await redis.set(BACKUP_CONFIG_KEY, JSON.stringify({
        enabled: config.enabled,
        lastBackupAt: new Date().toISOString(),
        lastBackupId: result.backupId,
      }));

      return res.json({
        success: true,
        message: "Auto backup completed",
        backup: {
          id: result.backupId,
          tables: result.backupData.tables,
          totalCount: result.backupData.totalCount,
          size: result.sizeBytes,
        },
      });
    } catch (e) {
      console.error("Auto backup error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.query && req.query.section === "backup") {
    if (req.method === "GET") {
      try {
        var backupIds = await redis.zrange(BACKUP_LIST_KEY, 0, -1, { withScores: true });
        var backups = [];
        if (backupIds && backupIds.length) {
          for (var bi = 0; bi < backupIds.length; bi += 2) {
            var bId = backupIds[bi];
            var bScore = backupIds[bi + 1];
            var metaRaw = await redis.get(BACKUP_PREFIX + "meta:" + bId);
            if (metaRaw) {
              try {
                var meta = JSON.parse(metaRaw);
                backups.push(meta);
              } catch (_) {}
            } else {
              backups.push({ id: bId, timestamp: Number(bScore) || 0, type: bId.indexOf("auto-") === 0 ? "auto" : "manual" });
            }
          }
        }
        backups.sort(function(a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); });

        var configRaw = await redis.get(BACKUP_CONFIG_KEY);
        var config = configRaw ? JSON.parse(configRaw) : { enabled: false };

        return res.json({
          success: true,
          backups: backups,
          config: config,
        });
      } catch (e) {
        console.error("backup list error:", e);
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    if (req.method === "POST") {
      try {
        var body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch (_) {}
        }

        var isAuto = body && body.auto === true;
        var result = await doBackup(redis, isAuto);

        await redis.set(BACKUP_CONFIG_KEY, JSON.stringify({
          enabled: true,
          lastBackupAt: new Date().toISOString(),
          lastBackupId: result.backupId,
        }));

        return res.json({
          success: true,
          backup: {
            id: result.backupId,
            type: isAuto ? "auto" : "manual",
            tables: result.backupData.tables,
            activationCount: result.backupData.activationCount,
            failureCount: result.backupData.failureCount,
            totalCount: result.backupData.totalCount,
            size: result.sizeBytes,
            created_at: result.backupData.created_at,
          },
        });
      } catch (e) {
        console.error("backup create error:", e);
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    if (req.method === "PUT") {
      try {
        var body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch (_) {}
        }

        if (body && body.enabled !== undefined) {
          var configRaw = await redis.get(BACKUP_CONFIG_KEY);
          var config = configRaw ? JSON.parse(configRaw) : {};
          config.enabled = !!body.enabled;
          await redis.set(BACKUP_CONFIG_KEY, JSON.stringify(config));
          return res.json({ success: true, config: config });
        }

        if (body && body.restoreId) {
          var restoreId = body.restoreId;
          var backupRaw = await redis.get(BACKUP_PREFIX + "data:" + restoreId);
          if (!backupRaw) {
            return res.status(404).json({ success: false, error: "Backup not found: " + restoreId });
          }

          var backup;
          try { backup = JSON.parse(backupRaw); } catch (e) {
            return res.status(500).json({ success: false, error: "Backup data corrupted" });
          }

          var restored = {
            products: 0, product_ids: 0, redeem_codes: 0, activations: 0, failures: 0,
            devices: 0, admin_account: 0, product_counter: 0, used_counter: 0,
            afdian_orders: 0, afdian_processed: 0, afdian_last_sync: 0, afdian_plan_map: 0,
            quota_states: 0,
          };

          if (backup.products && backup.products.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.products.length; i++) {
              var p = backup.products[i];
              if (p.id && p.data) pip.hset("auth:products", p.id, JSON.stringify(p.data));
            }
            await pip.exec();
            restored.products = backup.products.length;
          }

          if (backup.product_ids && backup.product_ids.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.product_ids.length; i++) {
              var pid = backup.product_ids[i];
              var m = pid._backup_member || pid.id || pid;
              if (m) pip.sadd("auth:product_ids", m);
            }
            await pip.exec();
            restored.product_ids = backup.product_ids.length;
          }

          if (backup.redeem_codes && backup.redeem_codes.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.redeem_codes.length; i++) {
              var rc = backup.redeem_codes[i];
              var rcode = rc.code || rc._backup_member;
              if (rcode) {
                pip.set("auth:redeem:" + rcode, JSON.stringify(rc));
                pip.sadd("auth:redeem_codes", rcode);
              }
            }
            await pip.exec();
            restored.redeem_codes = backup.redeem_codes.length;
          }

          if (backup.activations && backup.activations.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.activations.length; i++) {
              var act = backup.activations[i];
              var acode = act.activation_code || act._backup_member;
              if (acode) {
                pip.set("auth:activation:" + acode, JSON.stringify(act));
                pip.sadd("auth:activation_codes", acode);
              }
            }
            await pip.exec();
            restored.activations = backup.activations.length;
          }

          if (backup.failures && backup.failures.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.failures.length; i++) {
              var fail = backup.failures[i];
              var failKey = fail._backup_member || fail._backup_key || "";
              if (failKey) {
                pip.set(failKey, JSON.stringify(fail));
                pip.sadd("auth:activation_failures", failKey);
              }
            }
            await pip.exec();
            restored.failures = backup.failures.length;
          }

          if (backup.devices && backup.devices.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.devices.length; i++) {
              var dev = backup.devices[i];
              var dk = dev._backup_key;
              if (dk) pip.set(dk, JSON.stringify(dev));
            }
            await pip.exec();
            restored.devices = backup.devices.length;
          }

          if (backup.admin_account && backup.admin_account.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.admin_account.length; i++) {
              var adm = backup.admin_account[i];
              if (adm.id) pip.hset("auth:admin", adm.id, JSON.stringify(adm.data || adm));
            }
            await pip.exec();
            restored.admin_account = backup.admin_account.length;
          }

          if (backup.product_counter != null) {
            await redis.set("auth:product_counter", String(backup.product_counter));
            restored.product_counter = 1;
          }

          if (backup.used_counter != null) {
            await redis.set("auth:counter:used_redeem_codes", String(backup.used_counter));
            restored.used_counter = 1;
          }

          if (backup.afdian_orders && backup.afdian_orders.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.afdian_orders.length; i++) {
              var ao = backup.afdian_orders[i];
              var aok = ao._backup_key;
              if (aok) pip.set(aok, JSON.stringify(ao));
            }
            await pip.exec();
            restored.afdian_orders = backup.afdian_orders.length;
          }

          if (backup.afdian_processed && backup.afdian_processed.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.afdian_processed.length; i++) {
              var ap = backup.afdian_processed[i];
              var apm = ap._backup_member || ap._backup_key || "";
              if (apm) pip.sadd("afdian:processed", apm);
            }
            await pip.exec();
            restored.afdian_processed = backup.afdian_processed.length;
          }

          if (backup.afdian_last_sync != null) {
            await redis.set("afdian:last_sync", String(backup.afdian_last_sync));
            restored.afdian_last_sync = 1;
          }

          if (backup.afdian_plan_map && backup.afdian_plan_map.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.afdian_plan_map.length; i++) {
              var pm = backup.afdian_plan_map[i];
              if (pm.id) pip.hset("afdian:plan_map", pm.id, JSON.stringify(pm.data || pm));
            }
            await pip.exec();
            restored.afdian_plan_map = backup.afdian_plan_map.length;
          }

          if (backup.quota_states && backup.quota_states.length) {
            var pip = redis.pipeline();
            for (var i = 0; i < backup.quota_states.length; i++) {
              var qs = backup.quota_states[i];
              var qk = qs._backup_key;
              if (qk) pip.set(qk, JSON.stringify(qs));
            }
            await pip.exec();
            restored.quota_states = backup.quota_states.length;
          }

          return res.json({
            success: true,
            message: "Restored from backup: " + restoreId,
            restored: restored,
          });
        }

        return res.status(400).json({ success: false, error: "Invalid request" });
      } catch (e) {
        console.error("backup restore error:", e);
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    if (req.method === "DELETE") {
      try {
        var body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch (_) {}
        }

        var deleteId = body && body.id;
        if (!deleteId) {
          return res.status(400).json({ success: false, error: "Missing backup id" });
        }

        var pip = redis.pipeline();
        pip.del(BACKUP_PREFIX + "meta:" + deleteId);
        pip.del(BACKUP_PREFIX + "data:" + deleteId);
        pip.zrem(BACKUP_LIST_KEY, deleteId);
        await pip.exec();

        return res.json({ success: true, message: "Backup deleted: " + deleteId });
      } catch (e) {
        console.error("backup delete error:", e);
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (req.query && req.query.section === "logs") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var limit = 50;
      if (req.query.limit) {
        var li = parseInt(req.query.limit, 10);
        if (Number.isFinite(li) && li > 0 && li <= 200) limit = li;
      }

      var actSet = await redis.smembers("auth:activation_codes");
      var actKeys = Array.isArray(actSet) ? actSet : [];
      var activations = [];
      if (actKeys.length) {
        var chunksA = [];
        for (var i2 = 0; i2 < actKeys.length; i2 += 200) chunksA.push(actKeys.slice(i2, i2 + 200));
        for (var c2 = 0; c2 < chunksA.length; c2++) {
          var batchA = chunksA[c2];
          var keysA = batchA.map(function(x) { return "auth:activation:" + x; });
          var valsA = await redis.mget(keysA);
          for (var j2 = 0; j2 < batchA.length; j2++) {
            var rawA = valsA && valsA[j2];
            var objA = null;
            if (typeof rawA === "string") { try { objA = JSON.parse(rawA); } catch (_) {} }
            if (objA && typeof objA === "object") {
              activations.push(objA);
            }
          }
        }
      }
      activations.sort(function(a, b) { return (Number(b.generated_at) || 0) - (Number(a.generated_at) || 0); });
      activations = activations.slice(0, limit);

      var codeSet = await redis.smembers("auth:redeem_codes");
      var codeKeys = Array.isArray(codeSet) ? codeSet : [];
      var codes = [];
      if (codeKeys.length) {
        var chunksC = [];
        for (var i3 = 0; i3 < codeKeys.length; i3 += 200) chunksC.push(codeKeys.slice(i3, i3 + 200));
        for (var c3 = 0; c3 < chunksC.length; c3++) {
          var batchC = chunksC[c3];
          var keysC = batchC.map(function(x) { return "auth:redeem:" + x; });
          var valsC = await redis.mget(keysC);
          for (var j3 = 0; j3 < batchC.length; j3++) {
            var rawC = valsC && valsC[j3];
            var objC = null;
            if (typeof rawC === "string") { try { objC = JSON.parse(rawC); } catch (_) {} }
            if (objC && typeof objC === "object") {
              var usedFlag = !!objC.used;
              var usedAt = Number(objC.used_at) || 0;
              var sortTs = usedAt || Number(objC.created_at) || 0;
              codes.push(Object.assign({}, objC, { __sort: sortTs, __used: usedFlag }));
            }
          }
        }
      }
      codes.sort(function(a, b) { return Number(b.__sort || 0) - Number(a.__sort || 0); });
      codes = codes.slice(0, limit).map(function(c) {
        var o = Object.assign({}, c);
        delete o.__sort; delete o.__used;
        return o;
      });

      var pgMessages = [];
      try {
        var postgres = require("../../lib/postgres");
        if (postgres.isConfigured()) {
          await postgres.ensureTables();
          var msgResult = await postgres.query(
            "SELECT id, uuid, title, content, message_type, priority, is_active, created_by, created_at FROM admin_messages ORDER BY priority DESC, created_at DESC LIMIT $1",
            [limit]
          );
          pgMessages = (msgResult && msgResult.rows) || [];
        }
      } catch (msgErr) {
        console.warn("health logs: messages fetch failed:", msgErr.message || msgErr);
      }

      var counters = {
        product_counter: Number(await redis.get("auth:product_counter")) || 0,
        used_redeem_codes: Number(await redis.get("auth:counter:used_redeem_codes")) || 0,
        products_total: await redis.hlen("auth:products"),
        redeem_codes_total: await redis.scard("auth:redeem_codes"),
        activations_total: await redis.scard("auth:activation_codes"),
      };

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        activations: activations,
        redeemCodes: codes,
        messages: pgMessages,
        counters: counters,
        env: {
          node: process.version,
          region: process.env.VERCEL_REGION || process.env.AWS_REGION || "unknown",
          env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
          project: process.env.VERCEL_PROJECT_NAME || "",
        },
      });
    } catch (e) {
      console.error("health logs error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "vercel-logs") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var vercelToken = process.env.VERCEL_TOKEN_ALT || process.env.VERCEL_TOKEN || "";
      var vercelProjectId = process.env.VERCEL_PROJECT_ID || "";
      var vercelTeamId = process.env.VERCEL_TEAM_ID || "";

      if (!vercelToken || !vercelProjectId) {
        return res.json({
          success: false,
          error: "Vercel API未配置。请在环境变量中设置 VERCEL_TOKEN 和 VERCEL_PROJECT_ID",
          configured: {
            hasToken: !!vercelToken,
            hasAltToken: !!(process.env.VERCEL_TOKEN_ALT || ""),
            hasProjectId: !!vercelProjectId,
            hasTeamId: !!vercelTeamId,
          },
          hint: "VERCEL_TOKEN 在 Vercel Dashboard → Settings → Tokens 生成；VERCEL_PROJECT_ID 在项目 Settings → General 里找。Team 项目需要额外 VERCEL_TEAM_ID。",
        });
      }

      var fetchUrl = "https://api.vercel.com/v6/deployments?projectId=" + encodeURIComponent(vercelProjectId) + "&limit=50";
      if (vercelTeamId) fetchUrl += "&teamId=" + encodeURIComponent(vercelTeamId);
      var fetchOpts = {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + vercelToken,
        },
      };

      var httpAdapter = null;
      try { httpAdapter = require("https"); } catch (_) {}

      if (!httpAdapter) {
        return res.json({ success: false, error: "Node.js https 模块不可用" });
      }

      var url = new URL(fetchUrl);
      var options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: fetchOpts.headers,
      };

      var body = await new Promise(function(resolve, reject) {
        var req2 = httpAdapter.request(options, function(res2) {
          var chunks = [];
          res2.on("data", function(c) { chunks.push(c); });
          res2.on("end", function() {
            var raw = Buffer.concat(chunks).toString("utf8");
            try { resolve({ status: res2.statusCode, data: JSON.parse(raw) }); }
            catch (_) { resolve({ status: res2.statusCode, data: raw }); }
          });
        });
        req2.on("error", reject);
        req2.setTimeout(10000, function() { req2.destroy(); reject(new Error("Request timeout")); });
        req2.end();
      });

      var logs = [];
      var deployments = (body.data && body.data.deployments && Array.isArray(body.data.deployments)) ? body.data.deployments : [];
      deployments.forEach(function(dep) {
        var timeStr = "";
        if (dep.created) {
          try { timeStr = new Date(dep.created).toLocaleString("zh-CN"); } catch (_) { timeStr = String(dep.created); }
        }
        var creator = dep.creator ? (dep.creator.username || dep.creator.email || "") : "";
        var sourceMap = { "cli": "Vercel CLI", "git": "Git Push", "api": "Vercel API", "marketplace": "Marketplace" };
        var sourceLabel = sourceMap[dep.source] || dep.source || "";
        var stateMap = {
          "READY": "✅ 部署成功",
          "BUILDING": "🔨 构建中",
          "INITIALIZING": "⏳ 初始化",
          "CANCELLED": "❌ 已取消",
          "ERROR": "❌ 错误",
          "QUEUED": "⏸️ 排队中",
          "DELETED": "🗑️ 已删除",
        };
        var stateLabel = stateMap[dep.state] || dep.state || "";
        logs.push({
          time: timeStr,
          type: dep.target === "production" ? "🚀 生产部署" : "🧪 预览部署",
          summary: dep.name + " · " + stateLabel + (sourceLabel ? " · " + sourceLabel : "") + (creator ? " · " + creator : ""),
          deploymentId: dep.uid || "",
          url: dep.url ? ("https://" + dep.url) : "",
          state: dep.state || "",
          target: dep.target || "",
          source: dep.source || "",
        });
      });

      return res.json({
        success: true,
        fetchedAt: new Date().toISOString(),
        statusCode: body.status,
        totalDeployments: deployments.length,
        logs: logs,
      });
    } catch (e) {
      console.error("vercel-logs error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "email-logs") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var notify = require("../../lib/notify");
      var limit = 50;
      if (req.query.limit) {
        var li = parseInt(req.query.limit, 10);
        if (Number.isFinite(li) && li > 0 && li <= 200) limit = li;
      }
      var emailLogs = await notify.getEmailLogs(limit);
      return res.json({
        success: true,
        fetchedAt: new Date().toISOString(),
        total: emailLogs.length,
        logs: emailLogs,
      });
    } catch (e) {
      console.error("email-logs error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "resend-logs") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var resendKey = process.env.RESEND_API_KEY || "";
      if (!resendKey) {
        return res.status(400).json({ success: false, error: "RESEND_API_KEY not configured" });
      }

      var limit = 50;
      if (req.query.limit) {
        var li = parseInt(req.query.limit, 10);
        if (Number.isFinite(li) && li > 0 && li <= 200) limit = li;
      }

      var resendResult = await new Promise(function (resolve, reject) {
        var https = require("https");
        var req2 = https.get({
          hostname: "api.resend.com",
          path: "/emails?limit=" + limit,
          headers: {
            "Authorization": "Bearer " + resendKey,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }, function (resp) {
          var body = "";
          resp.on("data", function (chunk) { body += chunk; });
          resp.on("end", function () {
            try {
              var json = JSON.parse(body);
              resolve({ statusCode: resp.statusCode, data: json });
            } catch (e) {
              reject(new Error("Resend API parse error: " + body.substring(0, 200)));
            }
          });
        });
        req2.on("error", function (e) { reject(e); });
        req2.on("timeout", function () { req2.destroy(); reject(new Error("Resend API timeout")); });
      });

      if (resendResult.statusCode !== 200) {
        return res.status(502).json({
          success: false,
          error: "Resend API returned HTTP " + resendResult.statusCode,
          detail: resendResult.data,
        });
      }

      var emails = (resendResult.data && resendResult.data.data) || [];
      var logs = emails.map(function (email) {
        return {
          id: email.id || "",
          from: email.from || "",
          to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
          subject: email.subject || "",
          status: email.last_event || "unknown",
          created_at: email.created_at || "",
        };
      });

      return res.json({
        success: true,
        fetchedAt: new Date().toISOString(),
        total: logs.length,
        logs: logs,
      });
    } catch (e) {
      console.error("resend-logs error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "afdian-dm-logs") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var limit = 50;
      if (req.query.limit) {
        var li = parseInt(req.query.limit, 10);
        if (Number.isFinite(li) && li > 0 && li <= 200) limit = li;
      }
      var rawLogs = await redis.lrange("afdian:dm_logs", 0, limit - 1);
      var dmLogs = [];
      for (var i = 0; i < rawLogs.length; i++) {
        try {
          var entry = JSON.parse(rawLogs[i]);
          dmLogs.push(entry);
        } catch (_) {}
      }
      return res.json({
        success: true,
        fetchedAt: new Date().toISOString(),
        total: dmLogs.length,
        logs: dmLogs,
      });
    } catch (e) {
      console.error("afdian-dm-logs error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "quota") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      await quota.bumpQuotaTick(req.url || "/api/admin/health");
      var summary = await quota.summarize();
      var dailyConsumption = await quota.getDailyConsumption();
      var tips = [
        { title: "核心：把每次冷启动后的连续访问打包到 5 分钟内完成", detail: "Neon 免费版默认 5 分钟无请求进入 Scale-to-Zero（休眠）。一旦休眠，下次请求需冷启动 (~350ms)。每次进入 Active 状态就开始计入 100 小时。所以：避免零散的 ping 把冷启动打碎成一个个短段；批量做操作；开发阶段集中调试而不是断断续续打开页。", tag: "最省" },
        { title: "把 Suspend Timeout 改成 0（永远不休眠=最花钱！）千万别做", detail: "免费版默认 5 分钟自动休眠正是免费的核心。任何把 compute 保持 Always-on 的设置会迅速吃掉 100h 甚至升级收费。保持默认 5m 或更短。", tag: "避坑" },
        { title: "后台管理页不要高频轮询", detail: "当前后台所有 Tab 都是点「刷新」才重新请求，没有自动轮询。如果你自己加了 setInterval 定期刷新 stats/records，把间隔调到 >5 分钟或干脆关掉；不然每 30s 打一次会让数据库永远不休眠，每月 100 小时 4 天就烧完。", tag: "后台" },
        { title: "尽量复用连接 / 一次请求内合并多次 Redis/Postgres 调用", detail: "activate.js 里目前 Promise.all 批量写入，这是正确的做法。不要把同一个功能拆成 3 次 HTTP 调用改成 1 次。减少 HTTP 次数 = 减少 DB 被唤醒的次数 = 省计算。", tag: "代码层" },
        { title: "Preview/Dev Branch 用完就删", detail: "每个 Neon Branch 有独立的 compute 和 storage，免费版总共允许 10 个分支。Vercel 每次 git push 生成的 preview URL 会创建对应 branch，历史分支如果没设 TTL 会一直占配额。可以在 neon.ts 里给 preview branch 设 TTL 7天自动清理，或 neon branch rm 手工删。", tag: "分支" },
        { title: "存储 512MB 限制：定期清理过期数据", detail: "旧版 kv_strings 里的临时 health probe（60s TTL）会自动过期。但 auth:activation:xxx 记录会永久保留。如果记录超 10 万条，可考虑每月归档或导出 JSON 后从 DB 清除。存储一旦超过 512MB 会拒绝写入导致所有激活失败。", tag: "存储" },
        { title: "跨区出流量 1GB：尽量让 Vercel Function 和 Neon 同区", detail: "Neon 项目默认选 us-east-2 (Ohio)；Vercel Serverless Function 默认最近区。把 Vercel 的 Function Region 也选 us-east-2 能大幅减少跨区 egress。跨区流量超过 1GB 会收费。", tag: "流量" },
        { title: "避免被爬虫刷激活接口", detail: "如果 /api/activate 被 bot 高频刷，每一次都会启动 compute。简单防护：前端/手环调用 activate 时加一个约定的 X-Token 头（不要和 JWT 一样），后端在 lib/auth.js 里对 activate 加简单阈值：同一 IP > 10次/min 就 429 拒绝。", tag: "防刷" },
      ];
      var howToCalculate = [
        { t: "100 小时是 Compute Active Hours（计算运行小时）", v: "不是整个月 720 小时挂在那儿。只要 Postgres Compute 在「Active 运行状态」，每过 1 秒就累加。Scale-to-Zero（休眠）后不计。" },
        { t: "判定规则：5 分钟无请求即休眠（默认 suspend_timeout=5m）", v: "例如：00:00:00 有一个请求 → Active 开始计费；00:03:00 又一个请求 → 保持 Active，这段累计 3 分钟；之后一直没请求 → 00:08:00（最后请求后 5 分钟）进入休眠 → 总共计 5 分钟。" },
        { t: "每月重置日：你 Neon 项目的 Billing 周期日，通常是注册日（本页估算默认自然月 1 号 UTC 重置）", v: "免费 100 小时是滚动账单月，不是 UTC 自然月，具体日期打开 console.neon.tech → Billing 查看。本页下方的「已用/剩余小时」是基于我们观察到的活跃段的估算值，精确值请以 Neon 控制台为准。" },
        { t: "100 小时到底能用多少？粗略换算", v: "如果每天均匀使用：100h ÷ 30 天 ≈ 3.3 小时/天。换算成「每次访问唤醒 + 5 分钟自动休眠」的段数：3.3h × 12段/h = 每天约 40 段。每天少于 40 次零散请求肯定够。如果把访问都集中成 2 段（比如早上 10 分钟、晚上 10 分钟），一天只用 20 分钟，100h 能用 300 天。" },
        { t: "何时会「打不开」？", v: "① 当月 Compute Hours 用满 100h → Neon 把 compute 挂起直到下月重置 → 所有 SQL 请求超时或失败 → 前端激活 500 / 后台 500；② 存储超过 512MB → 写失败；③ 跨区 egress 超过 1GB → 被限流/收费。" },
      ];
      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        summary: summary,
        dailyConsumption: dailyConsumption,
        howToCalculate: howToCalculate,
        tips: tips,
      });
    } catch (e) {
      console.error("quota summarize error:", e);
      return res.status(500).json({
        success: false,
        error: (e && e.message) || String(e),
      });
    }
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  var checks = [];
  var cfg = getPgConfig();

  checks.push(
    await runCheck("env", "Environment Variables", async function () {
      var missing = [];
      if (!cfg.url) missing.push("POSTGRES_URL / DATABASE_URL");
      var jwtSet = !!(process.env.JWT_SECRET && process.env.JWT_SECRET !== "jwt-secret-change-me");
      if (missing.length) {
        return {
          status: "fail",
          detail: "Missing: " + missing.join(", "),
          hint: "Configure Postgres variables in Vercel Project -> Settings -> Environment Variables, then redeploy",
          data: { jwtConfigured: jwtSet, pgUrl: maskUrl(cfg.url) },
        };
      }
      return {
        status: jwtSet ? "pass" : "warn",
        detail: jwtSet
          ? "Postgres and JWT environment variables configured"
          : "Postgres configured, but JWT_SECRET uses default value (insecure)",
        hint: jwtSet ? "" : "Set a strong random JWT_SECRET",
        data: { jwtConfigured: jwtSet, pgUrl: maskUrl(cfg.url) },
      };
    })
  );

  checks.push(
    await runCheck("pg_ping", "Postgres Connectivity", async function () {
      var pong = await redis.ping();
      return {
        status: pong === "PONG" || pong === "pong" || pong ? "pass" : "warn",
        detail: "ping => " + String(pong),
        data: { pong: pong },
      };
    })
  );

  checks.push(
    await runCheck("pg_rw", "Postgres Read/Write", async function () {
      var key = "auth:health:probe";
      var payload = { t: Date.now(), by: auth.username || "admin" };
      await redis.set(key, JSON.stringify(payload), { ex: 60 });
      var got = await redis.get(key);
      var parsed = typeof got === "string" ? JSON.parse(got) : got;
      var ok = parsed && Number(parsed.t) === payload.t;
      if (!ok) {
        return {
          status: "fail",
          detail: "Write then read mismatch",
          hint: "Check if Postgres is read-only or connected to wrong database instance",
          data: { wrote: payload, read: parsed },
        };
      }
      return {
        status: "pass",
        detail: "set/get OK (temp key expires in 60s)",
        data: { key: key },
      };
    })
  );

  checks.push(
    await runCheck("products", "Products Data", async function () {
      var raw = await redis.hgetall("auth:products");
      var counter = await redis.get("auth:product_counter");
      var count = raw ? Object.keys(raw).length : 0;
      var sampleIds = raw ? Object.keys(raw).slice(0, 5) : [];
      var parseErrors = 0;
      if (raw) {
        Object.keys(raw).forEach(function (id) {
          var val = raw[id];
          if (typeof val === "string") {
            try {
              JSON.parse(val);
            } catch (e) {
              parseErrors++;
            }
          }
        });
      }
      return {
        status: parseErrors ? "warn" : "pass",
        detail:
          "Product count " +
          count +
          ", counter " +
          String(counter == null ? "-" : counter) +
          (parseErrors ? ", parse errors " + parseErrors : ""),
        hint: count === 0 ? "No products yet. Add product failures are usually Postgres write or auth issues." : "",
        data: { count: count, counter: counter, sampleIds: sampleIds, parseErrors: parseErrors },
      };
    })
  );

  checks.push(
    await runCheck("redeem_codes", "Redeem Codes Data", async function () {
      var total = await redis.scard("auth:redeem_codes");
      return {
        status: "pass",
        detail: "Redeem code set size: " + total,
        data: { total: total },
      };
    })
  );

  checks.push(
    await runCheck("activations", "Activation Records", async function () {
      var total = await redis.scard("auth:activation_codes");
      return {
        status: "pass",
        detail: "Activation code set size: " + total,
        data: { total: total },
      };
    })
  );

  checks.push(
    await runCheck("crypto", "Activation Code Encode/Decode", async function () {
      var code = crypto.generateActivationCode("01", "Ab12", 12, "TEST");
      var dec = crypto.decryptActivationCode(code);
      var ok =
        dec &&
        dec.valid &&
        dec.productId === "01" &&
        dec.checkCode === "TEST" &&
        dec.months === 12 &&
        dec.deviceId === "Ab12";
      if (!ok) {
        return {
          status: "fail",
          detail: "Encode/decode verification failed",
          data: { code: code, dec: dec },
        };
      }
      return {
        status: "pass",
        detail: "18-digit activation code encode/decode OK: " + crypto.fmtCode18(code),
        data: { sample: code },
      };
    })
  );

  checks.push(
    await runCheck("activate_path", "Activation Path Spot Check", async function () {
      var probeCode = "____";
      var missing = await redis.get("auth:redeem:" + probeCode);
      if (missing != null) {
        return {
          status: "warn",
          detail: "Probe key unexpectedly exists, skipping",
        };
      }
      var scan = await redis.sscan("auth:redeem_codes", "0", { count: 5 });
      var keys = Array.isArray(scan) ? scan[1] || [] : scan && scan.keys ? scan.keys : [];
      if (!keys.length) {
        return {
          status: "warn",
          detail: "No redeem codes yet, cannot do real redeem code read spot-check (encode/decode passed)",
          hint: "Generate redeem codes in admin panel first, then test activation. If activation still returns 500, prioritize Postgres connectivity checks.",
        };
      }
      var sampleKey = keys[0];
      var raw = await redis.get("auth:redeem:" + sampleKey);
      var info = raw;
      if (typeof raw === "string") {
        try {
          info = JSON.parse(raw);
        } catch (e) {
          return {
            status: "fail",
            detail: "Redeem code " + sampleKey + " JSON parse failed",
            hint: "Corrupted redeem code payload causes activation 500",
          };
        }
      }
      if (!info || typeof info !== "object") {
        return {
          status: "fail",
          detail: "Redeem code " + sampleKey + " data unparseable",
          hint: "Corrupted redeem code payload causes activation 500",
        };
      }
      var pid = crypto.pad2(info.product_id);
      var months = parseInt(info.duration_months, 10);
      if (!Number.isFinite(months) || months < 1) {
        return {
          status: "fail",
          detail: "Redeem code " + sampleKey + " has invalid duration_months: " + String(info.duration_months),
          hint: "Fix the redeem code data or regenerate it",
          data: { code: sampleKey, product_id: info.product_id, duration_months: info.duration_months },
        };
      }
      var act = crypto.generateActivationCode(pid, "Zz99", months, String(sampleKey).toUpperCase());
      return {
        status: "pass",
        detail: "Sample redeem code " + sampleKey + " readable, simulated activation generated",
        data: { sampleCode: sampleKey, product_id: pid, duration_months: months, sampleActivation: act },
      };
    })
  );

  checks.push(
    await runCheck("auth", "Admin Authentication", async function () {
      return {
        status: "pass",
        detail: "Current request authenticated: " + (auth.username || "unknown"),
        data: { username: auth.username || "" },
      };
    })
  );

  var fail = checks.filter(function (c) { return c.status === "fail"; }).length;
  var warn = checks.filter(function (c) { return c.status === "warn"; }).length;
  var overall = fail ? "down" : warn ? "degraded" : "ok";

  var summary = "";
  if (overall === "ok") {
    summary = "Core server dependencies healthy. If frontend still reports activation failure, verify redeem code exists in Postgres and device ID is correct.";
  } else if (overall === "degraded") {
    summary = "Warnings present, service may be partially available. Resolve warning items before retrying product add / activation.";
  } else {
    summary =
      "Faults detected. Most common causes for add-product failure and activation 500 are unconfigured or unreachable Postgres. Fix failed check items first.";
  }

  return res.json({
    success: true,
    overall: overall,
    summary: summary,
    checkedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      region: process.env.VERCEL_REGION || process.env.AWS_REGION || "unknown",
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    },
    checks: checks,
    failCount: fail,
    warnCount: warn,
  });
};