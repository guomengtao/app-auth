process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var crypto = require("../../lib/crypto");
var quota = require("../../lib/quota");
var pgSync = null;
try { pgSync = require("pg"); } catch(e) { console.warn("pg module not available:", e.message); }
var dbSwitches = require("../../lib/db-switches");
var dbRegistry = require("../../lib/db-registry");
var verifySwitch = null;
try { verifySwitch = require("../../lib/verify-switch"); } catch(e) { console.warn("verify-switch module not available:", e.message); }

var CRON_STATS_KEY = "auth:cron:stats";
var CRON_LIST_KEY = "auth:cron:list";
var CRON_CONFIG_KEY = "auth:cron:config";
var DEFAULT_TASKS = [
  {
    id: "afdian-query-orders",
    name: "爱发电订单同步",
    description: "每天查询爱发电订单，同步激活数据到 Redis",
    schedule: "0 3 * * *",
    enabled: true,
    vercelPath: "/api/afdian/query-orders",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "health-backup",
    name: "数据库自动备份",
    description: "每天自动备份 Redis 数据（产品、兑换码、激活记录等）",
    schedule: "0 4 * * *",
    enabled: true,
    vercelPath: "/api/admin/health?section=backup&cron=1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "db-sync-backup",
    name: "数据库多路同步",
    description: "每天自动将主数据库数据批量同步到其他 PostgreSQL 备用数据库（不经过 Redis）",
    schedule: "0 5 * * *",
    enabled: true,
    vercelPath: "/api/admin/health?section=sync&cron=1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

async function getTaskConfigs() {
  var raw = await redis.get(CRON_CONFIG_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  return null;
}

async function saveTaskConfigs(configs) {
  await redis.set(CRON_CONFIG_KEY, JSON.stringify(configs));
}

async function ensureDefaults() {
  var configs = await getTaskConfigs();
  if (!configs || !configs.length) {
    configs = DEFAULT_TASKS.map(function(t) { return Object.assign({}, t, { createdAt: Date.now(), updatedAt: Date.now() }); });
    await saveTaskConfigs(configs);
    return configs;
  }
  var changed = false;
  DEFAULT_TASKS.forEach(function(dt) {
    var found = false;
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === dt.id) {
        found = true;
        break;
      }
    }
    if (!found) {
      configs.push(Object.assign({}, dt, { createdAt: Date.now(), updatedAt: Date.now() }));
      changed = true;
    }
  });
  if (changed) {
    await saveTaskConfigs(configs);
  }
  return configs;
}

async function mergeCronStats(configs) {
  var stats = {};
  try {
    var cronIds = await redis.smembers(CRON_LIST_KEY);
    if (cronIds && cronIds.length) {
      var keys = cronIds.map(function(id) { return CRON_STATS_KEY + ":" + id; });
      var vals = await redis.mget(keys);
      for (var i = 0; i < cronIds.length; i++) {
        var raw = vals[i];
        if (raw) {
          try { stats[cronIds[i]] = JSON.parse(raw); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return configs.map(function(c) {
    var s = stats[c.id] || null;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      schedule: c.schedule,
      enabled: c.enabled,
      vercelPath: c.vercelPath,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      stats: s ? {
        count: s.count || 0,
        lastRun: s.lastRun || null,
        lastDuration: s.lastDuration || 0,
        lastStatus: s.lastStatus || "",
        lastResult: s.lastResult || "",
        firstRun: s.firstRun || null,
      } : null,
    };
  });
}

async function recordCronRun(cronId, result) {
  var now = Date.now();
  var key = CRON_STATS_KEY + ":" + cronId;
  var existing = await redis.get(key);
  var stats = { name: cronId, count: 0, lastRun: null, lastDuration: 0, lastStatus: "", lastResult: "", firstRun: null };
  if (existing) {
    try { stats = JSON.parse(existing); } catch (_) {}
  }
  stats.count = (stats.count || 0) + 1;
  stats.lastRun = now;
  stats.lastDuration = result.duration || 0;
  stats.lastStatus = result.status || "unknown";
  stats.lastResult = result.summary || "";
  if (!stats.firstRun) stats.firstRun = now;
  await redis.set(key, JSON.stringify(stats));
  var pip = redis.pipeline();
  pip.sadd(CRON_LIST_KEY, cronId);
  pip.set(CRON_STATS_KEY + ":last_update", String(now));
  await pip.exec();
  return stats;
}

async function getCronStats() {
  var cronIds = await redis.smembers(CRON_LIST_KEY);
  var stats = [];
  if (cronIds && cronIds.length) {
    var keys = cronIds.map(function(id) { return CRON_STATS_KEY + ":" + id; });
    var vals = await redis.mget(keys);
    for (var i = 0; i < cronIds.length; i++) {
      var raw = vals[i];
      if (raw) {
        try {
          var s = JSON.parse(raw);
          s.id = cronIds[i];
          stats.push(s);
        } catch (_) {}
      }
    }
  }
  stats.sort(function(a, b) { return (b.lastRun || 0) - (a.lastRun || 0); });
  return stats;
}

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
    var cronStart = Date.now();
    try {
      try {
        var taskConfigRaw = await redis.get("auth:cron:config");
        if (taskConfigRaw) {
          var taskConfigs = JSON.parse(taskConfigRaw);
          var taskConfig = null;
          for (var ci = 0; ci < taskConfigs.length; ci++) {
            if (taskConfigs[ci].id === "health-backup") { taskConfig = taskConfigs[ci]; break; }
          }
          if (taskConfig && taskConfig.enabled === false) {
            console.log("health-backup cron: task disabled in config, skipping");
            return res.json({ success: true, message: "Task disabled", skipped: true });
          }
        }
      } catch (_) {}

      var configRaw = await redis.get(BACKUP_CONFIG_KEY);
      var config = configRaw ? JSON.parse(configRaw) : { enabled: false };
      if (!config.enabled) {
        await recordCronRun("health-backup", {
          duration: Date.now() - cronStart,
          status: "skipped",
          summary: "Auto backup disabled",
        });
        return res.json({ success: true, message: "Auto backup disabled", skipped: true });
      }

      var result = await doBackup(redis, true);

      await redis.set(BACKUP_CONFIG_KEY, JSON.stringify({
        enabled: config.enabled,
        lastBackupAt: new Date().toISOString(),
        lastBackupId: result.backupId,
      }));

      await recordCronRun("health-backup", {
        duration: Date.now() - cronStart,
        status: "success",
        summary: "Tables: " + (result.backupData.tables || 0) + ", Records: " + (result.backupData.totalCount || 0) + ", Size: " + (result.sizeBytes || 0) + "B",
      });

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
      await recordCronRun("health-backup", {
        duration: Date.now() - cronStart,
        status: "error",
        summary: (e && e.message) || String(e),
      });
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

      var syncLogs = [];
      try {
        var rawSyncLogs = await redis.lrange("db:sync_logs", 0, 19);
        for (var sl = 0; sl < rawSyncLogs.length; sl++) {
          try {
            var entry = JSON.parse(rawSyncLogs[sl]);
            syncLogs.push(entry);
          } catch (_) {}
        }
      } catch (e) {
        console.warn("health logs: syncLogs fetch failed:", e.message);
      }

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        activations: activations,
        redeemCodes: codes,
        messages: pgMessages,
        syncLogs: syncLogs,
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

  if (req.query && req.query.section === "activation-system") {
    try {
      if (req.method === "GET") {
        var rawEnabled = await redis.get("auth:activation_system_enabled");
        return res.json({
          success: true,
          enabled: rawEnabled !== "disabled",
        });
      }
      if (req.method === "POST") {
        var body = req.body || {};
        var enabled = body.enabled !== false;
        await redis.set("auth:activation_system_enabled", enabled ? "enabled" : "disabled");
        return res.json({ success: true, enabled: enabled });
      }
      return res.status(405).json({ success: false, error: "Method not allowed" });
    } catch (e) {
      console.error("activation-system error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "dbswitches") {
    try {
      var allDbIds2 = dbRegistry.getAllDatabases().map(function(db) { return db.id; });
      if (req.method === "GET") {
        var switchesResult = {};
        for (var sdi = 0; sdi < allDbIds2.length; sdi++) {
          var rawVal = await redis.get("db:switch:" + allDbIds2[sdi]);
          switchesResult[allDbIds2[sdi]] = (rawVal === "off") ? "off" : "on";
        }
        return res.json({ success: true, switches: switchesResult });
      }
      if (req.method === "POST") {
        var body = req.body || {};
        var db = body.db;
        var value = body.value;
        if (!db || !value || allDbIds2.indexOf(db) === -1 || ["on", "off"].indexOf(value) === -1) {
          return res.status(400).json({ success: false, error: "Invalid db or value. db: " + allDbIds2.join("/") + ", value: on/off" });
        }
        var currentPrimary = dbSwitches.getPrimary() || String(process.env.DB_PROVIDER || "auto").trim();
        if (value === "off" && db === currentPrimary) {
          return res.status(400).json({
            success: false,
            error: "Cannot disable the primary database. Switch to another primary first, then disable " + db + ".",
          });
        }
        await redis.set("db:switch:" + db, value);
        var allSwitches2 = {};
        for (var sdi2 = 0; sdi2 < allDbIds2.length; sdi2++) {
          var rawVal2 = await redis.get("db:switch:" + allDbIds2[sdi2]);
          allSwitches2[allDbIds2[sdi2]] = (rawVal2 === "off") ? "off" : "on";
        }
        allSwitches2[db] = value;
        dbSwitches.setSwitches(allSwitches2);
        var enabledCount2 = 0;
        for (var sdi3 = 0; sdi3 < allDbIds2.length; sdi3++) {
          if (allSwitches2[allDbIds2[sdi3]] === "on") enabledCount2++;
        }
        if (enabledCount2 === 0) {
          await redis.set("db:switch:" + db, "on");
          allSwitches2[db] = "on";
          return res.json({
            success: false,
            error: "Cannot disable all databases. At least one must remain enabled.",
            switches: allSwitches2,
          });
        }
        return res.json({ success: true, switches: allSwitches2 });
      }
      return res.status(405).json({ success: false, error: "Method not allowed" });
    } catch (e) {
      console.error("dbswitches error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "dbstatus") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var pg = require("../../lib/postgres");
      var primaryFromRedis = dbSwitches.getPrimary();
      var dbProvider = primaryFromRedis || String(process.env.DB_PROVIDER || "auto").trim();
      var providerDb = dbRegistry.getDatabase(dbProvider);

      var tablesResult = await pg.query(
        "SELECT schemaname, relname, n_live_tup AS est_rows, pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) AS bytes FROM pg_stat_user_tables ORDER BY bytes DESC"
      );
      var tables = (tablesResult && tablesResult.rows) ? tablesResult.rows : [];

      var dbSizeResult = await pg.query("SELECT pg_database_size(current_database()) AS bytes");
      var dbSizeBytes = (dbSizeResult && dbSizeResult.rows && dbSizeResult.rows[0]) ? Number(dbSizeResult.rows[0].bytes) || 0 : 0;

      var syncStatus = null;
      try {
        var raw = await redis.get("auth:db:sync_status");
        if (raw && typeof raw === "string") {
          syncStatus = JSON.parse(raw);
        }
      } catch (e) {
        syncStatus = null;
      }

      var syncLogsList = [];
      try {
        var rawSyncLogs = await redis.lrange("db:sync_logs", 0, 4);
        for (var sli = 0; sli < rawSyncLogs.length; sli++) {
          try { syncLogsList.push(JSON.parse(rawSyncLogs[sli])); } catch (_) {}
        }
      } catch (e) { console.warn("dbstatus: syncLogs fetch failed:", e.message); }

      var lastDbActivity = null;
      var daysSinceLastActivity = null;
      var pausedInDays = null;
      var activityWarning = null;
      try {
        var lastUpdateStr = await redis.get(CRON_STATS_KEY + ":last_update");
        if (lastUpdateStr) {
          var lastTs = parseInt(lastUpdateStr, 10);
          if (lastTs > 0) {
            lastDbActivity = lastTs;
            var now = Date.now();
            var diffMs = now - lastTs;
            daysSinceLastActivity = Math.round(diffMs / (1000 * 60 * 60 * 24) * 10) / 10;
            var supabasePauseDays = 7;
            if (daysSinceLastActivity >= supabasePauseDays) {
              pausedInDays = 0;
              activityWarning = "paused";
            } else {
              pausedInDays = Math.round((supabasePauseDays - daysSinceLastActivity) * 10) / 10;
              if (daysSinceLastActivity >= 5) {
                activityWarning = "critical";
              } else if (daysSinceLastActivity >= 3) {
                activityWarning = "warning";
              } else {
                activityWarning = "ok";
              }
            }
          }
        }
      } catch (_) {}

      var connStr = String(process.env.Ev_POSTGRES_URL || process.env.POSTGRES_URL || "");

      var KV_TABLES = ["kv_strings", "kv_hashes", "kv_sets", "kv_zsets"];

      function countRowsFromRows(rows) {
        var result = {};
        for (var i = 0; i < rows.length; i++) {
          result[rows[i].name] = Number(rows[i].row_count) || 0;
        }
        return result;
      }

      var primaryTables = [];
      var primaryTotalRows = 0;
      var primaryTableCount = 0;
      try {
        var primaryRows = await pg.query(
          "SELECT relname AS name, n_live_tup AS row_count FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY relname",
          [KV_TABLES]
        );
        if (primaryRows && primaryRows.rows) {
          var counts = countRowsFromRows(primaryRows.rows);
          for (var k = 0; k < KV_TABLES.length; k++) {
            var tname = KV_TABLES[k];
            var rc = counts[tname] || 0;
            primaryTables.push({ name: tname, rowCount: rc });
            primaryTotalRows += rc;
          }
          primaryTableCount = primaryRows.rows.length;
        }
      } catch (e) {
        console.warn("primary tables query error:", e.message);
      }

      var otherDbTables = null;
      var otherDbTotalRows = 0;
      var otherDbTableCount = 0;
      var otherDbUrl = "";
      var otherDbName = "";
      var otherDbError = "";
      var pgDbs = dbRegistry.getPostgresDatabases();
      var otherDbDef = null;
      for (var odi = 0; odi < pgDbs.length; odi++) {
        if (pgDbs[odi].id !== dbProvider) {
          otherDbDef = pgDbs[odi];
          break;
        }
      }
      if (otherDbDef) {
        otherDbName = otherDbDef.name;
        otherDbUrl = dbRegistry.getDatabaseUrl(otherDbDef.id) || "";
      }
      if (otherDbUrl) {
        if (!pgSync) {
          otherDbError = "pg module not available";
        } else {
          try {
            var otherPg = new pgSync.Pool({ connectionString: otherDbUrl, max: 1, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
            var otherRows = await otherPg.query(
              "SELECT relname AS name, n_live_tup AS row_count FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY relname",
              [KV_TABLES]
            );
            if (otherRows && otherRows.rows) {
              otherDbTables = [];
              var otherCounts = countRowsFromRows(otherRows.rows);
              for (var ok2 = 0; ok2 < KV_TABLES.length; ok2++) {
                var otname = KV_TABLES[ok2];
                var orc = otherCounts[otname] || 0;
                otherDbTables.push({ name: otname, rowCount: orc });
                otherDbTotalRows += orc;
              }
              otherDbTableCount = otherRows.rows.length;
            }
            await otherPg.end();
          } catch (e) {
            console.warn(otherDbName + " tables query error:", e.message);
            otherDbError = e.message || "connection failed";
          }
        }
      }

      var upstashKeyCount = null;
      var upstashKeys = [];
      var upstashError = "";
      try {
        var upstashDb3 = dbRegistry.getDatabase("upstash");
        var upstashUrl = upstashDb3 ? dbRegistry.getDatabaseUrl("upstash") || "" : "";
        var upstashToken = upstashDb3 && upstashDb3.tokenEnv ? (process.env[upstashDb3.tokenEnv] || "") : "";
        if (upstashUrl) {
          var dbsizeUrl = upstashUrl.replace(/\/$/, "") + "/dbsize";
          var dsOpts = { method: "GET" };
          if (upstashToken) { dsOpts.headers = { Authorization: "Bearer " + upstashToken }; }
          var dsResp = await fetch(dbsizeUrl, dsOpts);
          if (dsResp.ok) {
            var dsJson = await dsResp.json();
            upstashKeyCount = Number(dsJson.result) || 0;
          } else {
            upstashError = "DBSIZE failed: " + dsResp.status;
          }

          if (upstashKeyCount !== null && upstashKeyCount <= 500) {
            try {
              var prefixCounts = {};
              var keysUrl = upstashUrl.replace(/\/$/, "") + "/keys/*";
              var keysOpts = { method: "GET" };
              if (upstashToken) { keysOpts.headers = { Authorization: "Bearer " + upstashToken }; }
              var keysResp = await fetch(keysUrl, keysOpts);
              if (keysResp.ok) {
                var keysJson = await keysResp.json();
                var allKeys = (keysJson && keysJson.result) ? keysJson.result : [];
                for (var ki = 0; ki < allKeys.length; ki++) {
                  var fullKey = allKeys[ki];
                  var prefix = fullKey.split(":")[0] || "other";
                  prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
                }
                var prefixNames = Object.keys(prefixCounts);
                for (var pi = 0; pi < prefixNames.length; pi++) {
                  upstashKeys.push({ name: prefixNames[pi] + ":*", rowCount: prefixCounts[prefixNames[pi]] });
                }
              }
            } catch (e2) {
              console.warn("Upstash KEYS query error:", e2.message);
            }
          }
        }
      } catch (e) {
        console.warn("Upstash query error:", e.message);
        upstashError = e.message || "query failed";
      }

      var allSwitches = {};
      var allDbIds = dbRegistry.getAllDatabases().map(function(db) { return db.id; });
      for (var ai = 0; ai < allDbIds.length; ai++) {
        allSwitches[allDbIds[ai]] = "on";
      }
      try {
        for (var ai2 = 0; ai2 < allDbIds.length; ai2++) {
          var rawVal = await redis.get("db:switch:" + allDbIds[ai2]);
          if (rawVal === "off") allSwitches[allDbIds[ai2]] = "off";
        }
      } catch (_) {}

      var enabledPgCount = 0;
      var enabledTotal = 0;
      for (var ai3 = 0; ai3 < allDbIds.length; ai3++) {
        if (allSwitches[allDbIds[ai3]] === "on") {
          enabledTotal++;
          var dbInfo = dbRegistry.getDatabase(allDbIds[ai3]);
          if (dbInfo && dbInfo.type === "postgres") enabledPgCount++;
        }
      }

      var databases = [];
      var allDbs = dbRegistry.getAllDatabases();
      for (var di = 0; di < allDbs.length; di++) {
        var dbDef = allDbs[di];
        var isPrimary = dbProvider === dbDef.id;
        var dbRole = dbDef.role === "coordinator" ? "coordinator" : (isPrimary ? "primary" : "standby");
        var dbEntry = {
          id: dbDef.id,
          name: dbDef.name,
          role: dbRole,
          type: dbDef.type === "redis" ? "Redis" : "PostgreSQL",
          host: dbDef.host || "-",
          freeLimit: dbDef.freeLimit || "",
          configured: dbDef.type === "redis"
            ? Boolean(process.env[dbDef.urlEnv] && process.env[dbDef.tokenEnv])
            : Boolean(process.env[dbDef.urlEnv]),
          enabled: allSwitches[dbDef.id] || "on",
        };

        if (dbDef.type === "redis") {
          dbEntry.keyCount = upstashKeyCount;
          dbEntry.keys = upstashKeys;
          dbEntry.syncStats = (syncStatus && syncStatus.stats && syncStatus.stats[dbDef.name]) ? syncStatus.stats[dbDef.name] : null;
          dbEntry.error = upstashError;
        } else {
          dbEntry.tableCount = isPrimary ? primaryTableCount : (otherDbName === dbDef.name ? otherDbTableCount : 0);
          dbEntry.totalRows = isPrimary ? primaryTotalRows : (otherDbName === dbDef.name ? otherDbTotalRows : 0);
          dbEntry.tables = isPrimary ? primaryTables : (otherDbName === dbDef.name ? (otherDbTables || []) : []);
          dbEntry.error = isPrimary ? "" : (otherDbName === dbDef.name ? otherDbError : "");
        }
        databases.push(dbEntry);
      }

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        currentProvider: dbProvider || "auto",
        currentDatabase: providerDb ? providerDb.name : "Auto-detected",
        dbDiagnostics: {
          primaryUrl: (process.env.Ev_POSTGRES_URL || process.env.POSTGRES_URL || "").replace(/\/\/.*@/, "//***@"),
          primaryResolved: (typeof pg === "object" && pg.connectionString) ? pg.connectionString.replace(/\/\/.*@/, "//***@") : "unknown",
          otherDbUrl: otherDbUrl.replace(/\/\/.*@/, "//***@"),
          otherDbSkipped: (!otherDbUrl) ? "no other database configured" : null,
        },
        dbSizeBytes: dbSizeBytes,
        dbSizeMB: (dbSizeBytes / (1024 * 1024)).toFixed(2),
        lastDbActivity: lastDbActivity,
        daysSinceLastActivity: daysSinceLastActivity,
        pausedInDays: pausedInDays,
        activityWarning: activityWarning,
        tables: tables.map(function(t) {
          return {
            schema: t.schemaname,
            name: t.relname,
            estRows: Number(t.est_rows) || 0,
            sizeBytes: Number(t.bytes) || 0,
            sizeMB: (Number(t.bytes || 0) / (1024 * 1024)).toFixed(2),
          };
        }),
        syncStatus: syncStatus || {
          lastSyncDate: null,
          updateCount: 0,
          lastSyncType: null,
        },
        syncLogs: syncLogsList,
        databases: databases,
        dbSwitches: allSwitches,
        enabledPgCount: enabledPgCount,
        enabledTotal: enabledTotal,
      });
    } catch (e) {
      console.error("dbstatus error:", e);
      return res.status(500).json({
        success: false,
        error: (e && e.message) || String(e),
      });
    }
  }

  if (req.query && req.query.section === "switch-db") {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var body = req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ success: false, error: "Request body is required" });
      }
      var targetDb = (body.target || "").toLowerCase();
      var allDbIds = dbRegistry.getAllDatabases().map(function(db) { return db.id; });
      if (allDbIds.indexOf(targetDb) === -1) {
        return res.status(400).json({
          success: false,
          error: "Invalid target. Available databases: " + allDbIds.join(", "),
        });
      }
      var currentPrimary = dbSwitches.getPrimary() || String(process.env.DB_PROVIDER || "auto").trim();
        if (targetDb === currentPrimary) {
          return res.json({
            success: true,
            message: "Already the primary database",
            switched: false,
            from: currentPrimary,
            to: targetDb,
          });
        }
        if (!dbSwitches.isEnabled(targetDb)) {
          return res.status(400).json({
            success: false,
            error: "Cannot switch to a disabled database. Please enable " + targetDb + " first.",
          });
        }
      await dbSwitches.savePrimary(targetDb);
      return res.json({
        success: true,
        message: "Primary database switched from " + currentPrimary + " to " + targetDb,
        switched: true,
        from: currentPrimary,
        to: targetDb,
        note: "The switch takes effect on the next request. Existing connections may still use the old primary for a few seconds.",
      });
    } catch (e) {
      console.error("switch-db error:", e);
      return res.status(500).json({
        success: false,
        error: "Switch failed: " + (e.message || String(e)),
      });
    }
  }

  if (req.query && req.query.section === "sync") {
    var syncStart = Date.now();
    var isSyncCron = req.query.cron === "1";
    var syncTarget = (req.query.target || "").toLowerCase();

    try {
      if (!pgSync) {
        return res.status(500).json({ success: false, error: "pg module not available" });
      }

      if (isSyncCron) {
        try {
          var taskConfigRaw3 = await redis.get("auth:cron:config");
          if (taskConfigRaw3) {
            var taskConfigs3 = JSON.parse(taskConfigRaw3);
            var syncTaskConfig = null;
            for (var si = 0; si < taskConfigs3.length; si++) {
              if (taskConfigs3[si].id === "db-sync-backup") { syncTaskConfig = taskConfigs3[si]; break; }
            }
            if (syncTaskConfig && syncTaskConfig.enabled === false) {
              console.log("db-sync-backup cron: task disabled in config, skipping");
              return res.json({ success: true, message: "Task disabled", skipped: true });
            }
          }
        } catch (_) {}
      }

      var Pool = pgSync.Pool;

      var primaryFromRedis2 = dbSwitches.getPrimary();
      var dbProvider2 = primaryFromRedis2 || String(process.env.DB_PROVIDER || "auto").trim();

      var supabaseDb = dbRegistry.getDatabase("supabase");
      var neonDb = dbRegistry.getDatabase("neon");
      var supabaseUrl = supabaseDb ? dbRegistry.getDatabaseUrl("supabase") || "" : "";
      var neonUrl = neonDb ? dbRegistry.getDatabaseUrl("neon") || "" : "";

      if (supabaseUrl) {
        supabaseUrl = supabaseUrl.replace(/&supa=base-pooler\.x/, "").replace(/\?sslmode=require/, "?sslmode=verify-full");
      }

      var sourceUrl = "";
      var targetPgUrl = "";
      if (dbProvider2 === "supabase") {
        sourceUrl = supabaseUrl;
        targetPgUrl = neonUrl;
      } else {
        sourceUrl = neonUrl;
        targetPgUrl = supabaseUrl;
      }

      var sourcePg = null;
      var targetPg = null;
      var results = { targets: [], stats: {} };

      if (sourceUrl) {
        sourcePg = new Pool({ connectionString: sourceUrl, max: 3, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
      }

      var pgDbIds = dbRegistry.getPostgresDatabases().map(function(db) { return db.id; });
      var doPgSync = !syncTarget || syncTarget === "all" || pgDbIds.indexOf(syncTarget) !== -1;
      if (doPgSync && targetPgUrl && targetPgUrl !== sourceUrl) {
        targetPg = new Pool({ connectionString: targetPgUrl, max: 3, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });

        await targetPg.query(`
          CREATE TABLE IF NOT EXISTS kv_strings (
            key TEXT PRIMARY KEY, value TEXT, expires_at TIMESTAMPTZ
          );
          CREATE TABLE IF NOT EXISTS kv_hashes (
            key TEXT NOT NULL, field TEXT NOT NULL, value TEXT, PRIMARY KEY (key, field)
          );
          CREATE TABLE IF NOT EXISTS kv_sets (
            key TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (key, member)
          );
          CREATE TABLE IF NOT EXISTS kv_zsets (
            key TEXT NOT NULL, member TEXT NOT NULL, score DOUBLE PRECISION DEFAULT 0, PRIMARY KEY (key, member)
          );
        `);

        var syncStats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };

        var tables = [
          { name: "kv_strings", columns: "key, value, expires_at", conflict: "(key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at" },
          { name: "kv_hashes", columns: "key, field, value", conflict: "(key, field) DO UPDATE SET value = EXCLUDED.value" },
          { name: "kv_sets", columns: "key, member", conflict: "DO NOTHING" },
          { name: "kv_zsets", columns: "key, member, score", conflict: "(key, member) DO UPDATE SET score = EXCLUDED.score" },
        ];

        var BATCH_SIZE = 100;
        for (var ti = 0; ti < tables.length; ti++) {
          var t = tables[ti];
          try {
            var cols = t.columns.split(", ");
            var colCount = cols.length;
            var rows = await sourcePg.query("SELECT " + t.columns + " FROM " + t.name);
            var totalRows = rows.rows.length;

            for (var batchStart = 0; batchStart < totalRows; batchStart += BATCH_SIZE) {
              var batchEnd = Math.min(batchStart + BATCH_SIZE, totalRows);
              var batch = rows.rows.slice(batchStart, batchEnd);
              var batchSize = batch.length;

              var valuePlaceholders = [];
              var allValues = [];
              for (var bi = 0; bi < batchSize; bi++) {
                var row = batch[bi];
                var rowPlaceholders = [];
                for (var ci = 0; ci < colCount; ci++) {
                  var paramIndex = allValues.length + 1;
                  rowPlaceholders.push("$" + paramIndex);
                  allValues.push(row[cols[ci].trim()]);
                }
                valuePlaceholders.push("(" + rowPlaceholders.join(", ") + ")");
              }

              await targetPg.query(
                "INSERT INTO " + t.name + " (" + t.columns + ") VALUES " + valuePlaceholders.join(", ") + " ON CONFLICT " + t.conflict,
                allValues
              );
              syncStats[t.name.replace("kv_", "")] += batchSize;
            }
          } catch (e) {
            syncStats.errors++;
          }
        }

        var orphanCleanup = { kv_strings: 0, kv_sets: 0, kv_zsets: 0, kv_hashes: 0 };
        try {
          var srcStrKeys = await sourcePg.query("SELECT key FROM kv_strings");
          var tgtStrKeys = await targetPg.query("SELECT key FROM kv_strings");
          var srcStrSet = new Set();
          for (var sri = 0; sri < srcStrKeys.rows.length; sri++) srcStrSet.add(srcStrKeys.rows[sri].key);
          var orphanStrKeys = [];
          for (var tri = 0; tri < tgtStrKeys.rows.length; tri++) {
            if (!srcStrSet.has(tgtStrKeys.rows[tri].key)) {
              orphanStrKeys.push(tgtStrKeys.rows[tri].key);
            }
          }
          if (orphanStrKeys.length > 0) {
            await targetPg.query("DELETE FROM kv_strings WHERE key = ANY($1::text[])", [orphanStrKeys]);
            orphanCleanup.kv_strings = orphanStrKeys.length;
          }

          var orphanTables = [
            { name: "kv_sets", keyCol: "key", memberCol: "member" },
            { name: "kv_zsets", keyCol: "key", memberCol: "member" },
            { name: "kv_hashes", keyCol: "key", memberCol: "field" },
          ];
          for (var ot = 0; ot < orphanTables.length; ot++) {
            var otDef = orphanTables[ot];
            var srcRows = await sourcePg.query("SELECT " + otDef.keyCol + ", " + otDef.memberCol + " FROM " + otDef.name);
            var tgtRows = await targetPg.query("SELECT " + otDef.keyCol + ", " + otDef.memberCol + " FROM " + otDef.name);
            var srcSet = new Set();
            for (var sri = 0; sri < srcRows.rows.length; sri++) {
              srcSet.add(srcRows.rows[sri][otDef.keyCol] + "||" + srcRows.rows[sri][otDef.memberCol]);
            }
            var orphanPairs = [];
            for (var tri = 0; tri < tgtRows.rows.length; tri++) {
              var tgtRow = tgtRows.rows[tri];
              if (!srcSet.has(tgtRow[otDef.keyCol] + "||" + tgtRow[otDef.memberCol])) {
                orphanPairs.push([tgtRow[otDef.keyCol], tgtRow[otDef.memberCol]]);
              }
            }
            if (orphanPairs.length > 0) {
              var placeholders = [];
              var params = [];
              for (var opi = 0; opi < orphanPairs.length; opi++) {
                var p1 = params.length + 1;
                var p2 = params.length + 2;
                placeholders.push("($" + p1 + ", $" + p2 + ")");
                params.push(orphanPairs[opi][0], orphanPairs[opi][1]);
              }
              await targetPg.query("DELETE FROM " + otDef.name + " WHERE (" + otDef.keyCol + ", " + otDef.memberCol + ") IN (" + placeholders.join(", ") + ")", params);
              orphanCleanup[otDef.name] = orphanPairs.length;
            }
          }
        } catch (e) {
          console.warn("orphan cleanup error:", e.message);
        }

        var targetDbName = dbProvider2 === "supabase" ? (neonDb ? neonDb.name : "Neon") : (supabaseDb ? supabaseDb.name : "Supabase");
        results.targets.push(targetDbName);
        results.stats[targetDbName] = syncStats;
        if (orphanCleanup.kv_strings > 0 || orphanCleanup.kv_sets > 0 || orphanCleanup.kv_zsets > 0 || orphanCleanup.kv_hashes > 0) {
          results.orphanCleanup = orphanCleanup;
        }
        await targetPg.end();
      }

      var upstashDb = dbRegistry.getDatabase("upstash");
      var upstashUrl = upstashDb ? dbRegistry.getDatabaseUrl("upstash") || "" : "";
      var upstashToken = upstashDb && upstashDb.tokenEnv ? (process.env[upstashDb.tokenEnv] || "") : "";

      var doUpstashSync = syncTarget === "upstash";
      if (doUpstashSync && upstashUrl) {
        var upstashStats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };
        var baseUrl = upstashUrl.replace(/\/$/, "");
        var fetchOpts = { method: "GET" };
        if (upstashToken) { fetchOpts.headers = { Authorization: "Bearer " + upstashToken }; }

        try {
          var strRows = await sourcePg.query("SELECT key, value FROM kv_strings");
          for (var ui = 0; ui < strRows.rows.length; ui++) {
            var kr = strRows.rows[ui];
            try {
              var setUrl = baseUrl + "/set/" + encodeURIComponent(kr.key) + "/" + encodeURIComponent(kr.value || "");
              var setResp = await fetch(setUrl, fetchOpts);
              if (setResp.ok) { upstashStats.strings++; } else { upstashStats.errors++; }
            } catch (e) { upstashStats.errors++; }
          }
        } catch (e) { upstashStats.errors++; }

        try {
          var hashRows = await sourcePg.query("SELECT key, field, value FROM kv_hashes");
          var hashBatches = {};
          for (var hi = 0; hi < hashRows.rows.length; hi++) {
            var hr = hashRows.rows[hi];
            if (!hashBatches[hr.key]) hashBatches[hr.key] = [];
            hashBatches[hr.key].push(hr);
          }
          var hashKeys = Object.keys(hashBatches);
          for (var hk = 0; hk < hashKeys.length; hk++) {
            var hkey = hashKeys[hk];
            var fields = hashBatches[hkey];
            for (var hf = 0; hf < fields.length; hf++) {
              try {
                var hsetUrl = baseUrl + "/hset/" + encodeURIComponent(hkey) + "/" + encodeURIComponent(fields[hf].field) + "/" + encodeURIComponent(fields[hf].value || "");
                var hsetResp = await fetch(hsetUrl, fetchOpts);
                if (hsetResp.ok) { upstashStats.hashes++; } else { upstashStats.errors++; }
              } catch (e) { upstashStats.errors++; }
            }
          }
        } catch (e) { upstashStats.errors++; }

        try {
          var setRows = await sourcePg.query("SELECT key, member FROM kv_sets");
          for (var si2 = 0; si2 < setRows.rows.length; si2++) {
            var sr = setRows.rows[si2];
            try {
              var saddUrl = baseUrl + "/sadd/" + encodeURIComponent(sr.key) + "/" + encodeURIComponent(sr.member || "");
              var saddResp = await fetch(saddUrl, fetchOpts);
              if (saddResp.ok) { upstashStats.sets++; } else { upstashStats.errors++; }
            } catch (e) { upstashStats.errors++; }
          }
        } catch (e) { upstashStats.errors++; }

        try {
          var zsetRows = await sourcePg.query("SELECT key, member, score FROM kv_zsets");
          for (var zi = 0; zi < zsetRows.rows.length; zi++) {
            var zr = zsetRows.rows[zi];
            try {
              var zaddUrl = baseUrl + "/zadd/" + encodeURIComponent(zr.key) + "/" + encodeURIComponent(String(zr.score || 0)) + "/" + encodeURIComponent(zr.member || "");
              var zaddResp = await fetch(zaddUrl, fetchOpts);
              if (zaddResp.ok) { upstashStats.zsets++; } else { upstashStats.errors++; }
            } catch (e) { upstashStats.errors++; }
          }
        } catch (e) { upstashStats.errors++; }

        try {
          var keySet = {};
          var cursor = 0;
          var rounds = 0;
          do {
            var scanUrl = baseUrl + "/scan/" + cursor;
            var scanResp = await fetch(scanUrl, fetchOpts);
            var scanData = await scanResp.json();
            cursor = scanData.result[0];
            var batch = scanData.result[1] || [];
            for (var bi = 0; bi < batch.length; bi++) {
              keySet[batch[bi]] = true;
            }
            rounds++;
          } while (String(cursor) !== "0" && rounds < 100);
          var allUpstashKeys = Object.keys(keySet);

          var pgKeys = new Set();
          var allPgRows = await sourcePg.query("SELECT key FROM kv_strings UNION SELECT key FROM kv_hashes UNION SELECT key FROM kv_sets UNION SELECT key FROM kv_zsets");
          for (var pi = 0; pi < allPgRows.rows.length; pi++) {
            pgKeys.add(allPgRows.rows[pi].key);
          }

          var orphanCount = 0;
          for (var uki = 0; uki < allUpstashKeys.length; uki++) {
            var uk = allUpstashKeys[uki];
            if (uk.indexOf("auth:db:") === 0 || uk.indexOf("auth:cron:") === 0) continue;
            if (!pgKeys.has(uk)) {
              try {
                var delUrl = baseUrl + "/del/" + encodeURIComponent(uk);
                await fetch(delUrl, fetchOpts);
                orphanCount++;
              } catch (e) {}
            }
          }
          upstashStats.orphans_cleaned = orphanCount;
        } catch (e) {
          upstashStats.orphan_error = e.message;
        }

        results.targets.push(upstashDb ? upstashDb.name : "Upstash KV");
        results.stats[upstashDb ? upstashDb.name : "Upstash KV"] = upstashStats;
      }

      if (sourcePg) await sourcePg.end();

      var now = new Date().toISOString();
      var existingStatus = null;
      try {
        var raw = await redis.get("auth:db:sync_status");
        if (raw && typeof raw === "string") {
          existingStatus = JSON.parse(raw);
        }
      } catch (e) {
        console.error("sync: read existing status error:", e.message);
      }

      var updateCount = (existingStatus && existingStatus.updateCount ? existingStatus.updateCount : 0) + 1;
      var status = {
        lastSyncDate: now,
        updateCount: updateCount,
        lastSyncType: "multi-db-sync",
        message: "Synced to " + results.targets.join(", "),
        targets: results.targets,
        stats: results.stats,
      };

      try {
        await redis.set("auth:db:sync_status", JSON.stringify(status));
      } catch (e) {
        console.error("sync: write status error:", e.message);
      }

      try {
        var logEntry = {
          time: now,
          updateCount: updateCount,
          targets: results.targets,
          stats: results.stats,
          duration: Date.now() - syncStart,
          trigger: isSyncCron ? "cron" : "manual",
        };
        await redis.lpush("db:sync_logs", JSON.stringify(logEntry));
        await redis.ltrim("db:sync_logs", 0, 99);
      } catch (e) {
        console.error("sync: write log error:", e.message);
      }

      if (isSyncCron) {
        await recordCronRun("db-sync-backup", {
          duration: Date.now() - syncStart,
          status: "success",
          summary: "Targets: " + results.targets.join(", "),
        });
      }

      return res.json({
        success: true,
        message: "Sync completed",
        syncStatus: status,
        duration: Date.now() - syncStart,
      });
    } catch (e) {
      console.error("Sync error:", e);
      if (isSyncCron) {
        try {
          await recordCronRun("db-sync-backup", {
            duration: Date.now() - syncStart,
            status: "error",
            summary: (e && e.message) || String(e),
          });
        } catch (_) {}
      }
      return res.status(500).json({
        success: false,
        error: (e && e.message) || String(e),
      });
    }
  }

  if (req.query && req.query.section === "cron-tasks") {
    if (req.method === "GET") {
      try {
        var configs = await ensureDefaults();
        var tasks = await mergeCronStats(configs);
        return res.json({ success: true, tasks: tasks, total: tasks.length });
      } catch (e) {
        console.error("cron-tasks GET error:", e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    if (req.method === "PUT") {
      try {
        var body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch (_) {}
        }
        var taskId = (body && body.id) || (req.query && req.query.id);
        if (!taskId) {
          return res.status(400).json({ success: false, error: "Missing task id" });
        }
        var configs = await ensureDefaults();
        var found = false;
        for (var i = 0; i < configs.length; i++) {
          if (configs[i].id === taskId) {
            if (body.enabled !== undefined && body.enabled !== null) {
              configs[i].enabled = !!body.enabled;
            }
            if (body.name !== undefined) {
              configs[i].name = String(body.name);
            }
            if (body.description !== undefined) {
              configs[i].description = String(body.description);
            }
            if (body.schedule !== undefined) {
              configs[i].schedule = String(body.schedule);
            }
            if (body.vercelPath !== undefined) {
              configs[i].vercelPath = String(body.vercelPath);
            }
            configs[i].updatedAt = Date.now();
            found = true;
            break;
          }
        }
        if (!found) {
          return res.status(404).json({ success: false, error: "Task not found: " + taskId });
        }
        await saveTaskConfigs(configs);
        var tasks = await mergeCronStats(configs);
        return res.json({ success: true, tasks: tasks });
      } catch (e) {
        console.error("cron-tasks PUT error:", e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    if (req.method === "POST") {
      try {
        var body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch (_) {}
        }
        var taskId = (body && body.id) || "";
        if (!taskId) {
          return res.status(400).json({ success: false, error: "Missing task id" });
        }
        var configs = await ensureDefaults();
        for (var i = 0; i < configs.length; i++) {
          if (configs[i].id === taskId) {
            return res.status(409).json({ success: false, error: "Task already exists: " + taskId });
          }
        }
        var newTask = {
          id: taskId,
          name: (body && body.name) || taskId,
          description: (body && body.description) || "",
          schedule: (body && body.schedule) || "0 0 * * *",
          enabled: body && body.enabled !== undefined ? !!body.enabled : true,
          vercelPath: (body && body.vercelPath) || "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        configs.push(newTask);
        await saveTaskConfigs(configs);
        var tasks = await mergeCronStats(configs);
        return res.json({ success: true, task: newTask, tasks: tasks });
      } catch (e) {
        console.error("cron-tasks POST error:", e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    if (req.method === "DELETE") {
      try {
        var taskId = (req.query && req.query.id) || "";
        if (!taskId) {
          return res.status(400).json({ success: false, error: "Missing task id" });
        }
        var configs = await ensureDefaults();
        var found = false;
        var idx = -1;
        for (var i = 0; i < configs.length; i++) {
          if (configs[i].id === taskId) {
            found = true;
            idx = i;
            break;
          }
        }
        if (!found) {
          return res.status(404).json({ success: false, error: "Task not found: " + taskId });
        }
        configs.splice(idx, 1);
        await saveTaskConfigs(configs);
        var tasks = await mergeCronStats(configs);
        return res.json({ success: true, tasks: tasks });
      } catch (e) {
        console.error("cron-tasks DELETE error:", e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (req.query && req.query.section === "run-task") {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (_) {}
      }
      var runTaskId = (body && body.id) || (req.query && req.query.id);
      if (!runTaskId) {
        return res.status(400).json({ success: false, error: "Missing task id" });
      }
      var configs = await ensureDefaults();
      var taskConfig = null;
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === runTaskId) {
          taskConfig = configs[i];
          break;
        }
      }
      if (!taskConfig) {
        return res.status(404).json({ success: false, error: "Task not found: " + runTaskId });
      }
      if (!taskConfig.vercelPath) {
        return res.status(400).json({ success: false, error: "Task has no vercelPath configured" });
      }

      var runStart = Date.now();
      var baseUrl = "https://" + (req.headers.host || "app-auth.gudq.com");
      var targetUrl = baseUrl + taskConfig.vercelPath;
      console.log("run-task: executing " + runTaskId + " -> " + targetUrl);

      try {
        var fetchRes = await fetch(targetUrl, {
          signal: AbortSignal.timeout(120000),
        });
        var runDuration = Date.now() - runStart;
        var resultText = "";
        try {
          var resultJson = await fetchRes.json();
          resultText = JSON.stringify(resultJson).substring(0, 500);
        } catch (_) {
          resultText = "HTTP " + fetchRes.status;
        }

        await recordCronRun(runTaskId, {
          duration: runDuration,
          status: fetchRes.ok ? "success" : "error",
          summary: resultText,
        });

        return res.json({
          success: fetchRes.ok,
          taskId: runTaskId,
          duration: runDuration,
          status: fetchRes.ok ? "success" : "error",
          result: resultText,
        });
      } catch (e) {
        var runDuration = Date.now() - runStart;
        await recordCronRun(runTaskId, {
          duration: runDuration,
          status: "error",
          summary: (e && e.message) || String(e),
        });
        return res.status(500).json({
          success: false,
          taskId: runTaskId,
          duration: runDuration,
          error: (e && e.message) || String(e),
        });
      }
    } catch (e) {
      console.error("run-task error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "cron-stats") {
    if (req.method !== "GET") {
      return res.status(405).json({ success: false, error: "Method not allowed" });
    }
    try {
      var stats = await getCronStats();
      var lastUpdate = await redis.get(CRON_STATS_KEY + ":last_update");
      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        lastUpdate: lastUpdate ? Number(lastUpdate) : null,
        tasks: stats,
        total: stats.length,
      });
    } catch (e) {
      console.error("cron-stats error:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.query && req.query.section === "verify-switch") {
    if (!verifySwitch) {
      return res.status(500).json({ success: false, error: "verify-switch module not available" });
    }
    return verifySwitch(req, res);
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