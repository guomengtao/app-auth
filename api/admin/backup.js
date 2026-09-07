const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");

const BACKUP_LIST_KEY = "auth:backup:list";
const BACKUP_PREFIX = "auth:backup:";
const BACKUP_CONFIG_KEY = "auth:backup:config";

const SETS_TO_BACKUP = [
  "auth:activation_codes",
  "auth:activation_failures",
];

async function dumpAllKeys(setName) {
  const keys = [];
  let cursor = 0;
  do {
    const [next, batch] = await redis.sscan(setName, cursor, { count: 200 });
    cursor = next;
    for (const k of batch) keys.push(k);
  } while (cursor !== 0);
  return keys;
}

async function fetchAllRecords(members, keyPrefix) {
  if (members.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const m of members) {
    pipeline.get(keyPrefix + m);
  }
  const results = await pipeline.exec();
  return results.filter(Boolean);
}

module.exports = async function handler(req, res) {
  const isCron = req.query.cron === "1";

  if (isCron) {
    try {
      const configRaw = await redis.get(BACKUP_CONFIG_KEY);
      const config = configRaw ? JSON.parse(configRaw) : { enabled: false };
      if (!config.enabled) {
        return res.json({ success: true, message: "Auto backup disabled", skipped: true });
      }

      const timestamp = Date.now();
      const label = "backup-" + timestamp;
      const data = { sets: {}, records: {}, timestamp, auto: true };

      for (const setKey of SETS_TO_BACKUP) {
        data.sets[setKey] = await dumpAllKeys(setKey);
      }

      const prefixMap = {
        "auth:activation_codes": "auth:activation:",
        "auth:activation_failures": "",
      };

      let totalRecords = 0;
      let totalFailures = 0;

      for (const setKey of SETS_TO_BACKUP) {
        const members = data.sets[setKey] || [];
        const keyPrefix = prefixMap[setKey] || "";
        const recordValues = await fetchAllRecords(members, keyPrefix);
        for (let i = 0; i < members.length; i++) {
          const fullKey = keyPrefix + members[i];
          data.records[fullKey] = recordValues[i] || null;
        }
        if (setKey === "auth:activation_codes") totalRecords = members.length;
        if (setKey === "auth:activation_failures") totalFailures = members.length;
      }

      const json = JSON.stringify(data);
      const size = Buffer.byteLength(json, "utf8");

      const pipeline = redis.pipeline();
      pipeline.set(BACKUP_PREFIX + label, json);
      pipeline.zadd(BACKUP_LIST_KEY, timestamp, label);
      const meta = { size, recordCount: totalRecords, failureCount: totalFailures, auto: true, timestamp };
      pipeline.set(BACKUP_PREFIX + "meta:" + label, JSON.stringify(meta));
      await pipeline.exec();

      config.lastBackup = timestamp;
      await redis.set(BACKUP_CONFIG_KEY, JSON.stringify(config));

      return res.json({ success: true, message: "Auto backup completed", backup: { id: label, timestamp, size, recordCount: totalRecords, failureCount: totalFailures } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status || 401).json({ error: auth.error || "Unauthorized" });
  }

  const method = req.method || "GET";
  const action = req.query.action || "";

  if (method === "GET") {
    if (action === "config") {
      try {
        const raw = await redis.get(BACKUP_CONFIG_KEY);
        const config = raw ? JSON.parse(raw) : { enabled: false, lastBackup: null, intervalHours: 24 };
        return res.json({ success: true, config });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    try {
      const backups = [];
      const members = await redis.zrange(BACKUP_LIST_KEY, 0, -1, { withScores: true });
      for (let i = 0; i < members.length; i += 2) {
        const ts = parseInt(members[i + 1]);
        const label = members[i];
        const metaRaw = await redis.get(BACKUP_PREFIX + "meta:" + label);
        const meta = metaRaw ? JSON.parse(metaRaw) : null;
        backups.push({
          id: label,
          timestamp: ts,
          date: new Date(ts).toISOString(),
          size: meta ? meta.size : 0,
          recordCount: meta ? meta.recordCount : 0,
          failureCount: meta ? meta.failureCount : 0,
          auto: meta ? !!meta.auto : false,
        });
      }
      backups.sort((a, b) => b.timestamp - a.timestamp);
      return res.json({ success: true, backups });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (method === "POST") {
    if (action === "restore") {
      const backupId = req.body && req.body.backupId;
      if (!backupId) return res.status(400).json({ error: "Missing backupId" });

      try {
        const raw = await redis.get(BACKUP_PREFIX + backupId);
        if (!raw) return res.status(404).json({ error: "Backup not found" });

        const data = JSON.parse(raw);
        const pipeline = redis.pipeline();

        for (const setKey of SETS_TO_BACKUP) {
          const members = data.sets[setKey] || [];
          pipeline.del(setKey);
          for (const m of members) {
            pipeline.sadd(setKey, m);
          }
        }

        for (const [key, value] of Object.entries(data.records || {})) {
          pipeline.set(key, value);
        }

        await pipeline.exec();
        return res.json({ success: true, message: "Restored from backup: " + backupId, restoredKeys: Object.keys(data.records || {}).length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === "config") {
      try {
        const config = {
          enabled: !!req.body.enabled,
          lastBackup: req.body.lastBackup || null,
          intervalHours: parseInt(req.body.intervalHours) || 24,
          updatedAt: Date.now(),
        };
        await redis.set(BACKUP_CONFIG_KEY, JSON.stringify(config));
        return res.json({ success: true, config });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    try {
      const isAuto = req.body && req.body.auto;
      const timestamp = Date.now();
      const label = "backup-" + timestamp;
      const data = { sets: {}, records: {}, timestamp, auto: !!isAuto };

      for (const setKey of SETS_TO_BACKUP) {
        data.sets[setKey] = await dumpAllKeys(setKey);
      }

      const prefixMap = {
        "auth:activation_codes": "auth:activation:",
        "auth:activation_failures": "",
      };

      let totalRecords = 0;
      let totalFailures = 0;

      for (const setKey of SETS_TO_BACKUP) {
        const members = data.sets[setKey] || [];
        const keyPrefix = prefixMap[setKey] || "";
        const recordValues = await fetchAllRecords(members, keyPrefix);
        for (let i = 0; i < members.length; i++) {
          const fullKey = keyPrefix + members[i];
          data.records[fullKey] = recordValues[i] || null;
        }
        if (setKey === "auth:activation_codes") totalRecords = members.length;
        if (setKey === "auth:activation_failures") totalFailures = members.length;
      }

      const json = JSON.stringify(data);
      const size = Buffer.byteLength(json, "utf8");

      const pipeline = redis.pipeline();
      pipeline.set(BACKUP_PREFIX + label, json);
      pipeline.zadd(BACKUP_LIST_KEY, timestamp, label);

      const meta = {
        size,
        recordCount: totalRecords,
        failureCount: totalFailures,
        auto: !!isAuto,
        timestamp,
      };
      pipeline.set(BACKUP_PREFIX + "meta:" + label, JSON.stringify(meta));

      await pipeline.exec();

      const configRaw = await redis.get(BACKUP_CONFIG_KEY);
      if (configRaw) {
        const config = JSON.parse(configRaw);
        config.lastBackup = timestamp;
        await redis.set(BACKUP_CONFIG_KEY, JSON.stringify(config));
      }

      return res.json({
        success: true,
        backup: { id: label, timestamp, date: new Date(timestamp).toISOString(), size, recordCount: totalRecords, failureCount: totalFailures, auto: !!isAuto },
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (method === "DELETE") {
    const backupId = req.query.id;
    if (!backupId) return res.status(400).json({ error: "Missing id" });

    try {
      const pipeline = redis.pipeline();
      pipeline.del(BACKUP_PREFIX + backupId);
      pipeline.del(BACKUP_PREFIX + "meta:" + backupId);
      pipeline.zrem(BACKUP_LIST_KEY, backupId);
      await pipeline.exec();
      return res.json({ success: true, message: "Deleted: " + backupId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};