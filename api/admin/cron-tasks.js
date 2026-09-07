var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");

var CONFIG_KEY = "auth:cron:config";
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
];

async function getTaskConfigs() {
  var raw = await redis.get(CONFIG_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  return null;
}

async function saveTaskConfigs(configs) {
  await redis.set(CONFIG_KEY, JSON.stringify(configs));
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
    var cronIds = await redis.smembers("auth:cron:list");
    if (cronIds && cronIds.length) {
      var keys = cronIds.map(function(id) { return "auth:cron:stats:" + id; });
      var vals = await redis.mget(keys);
      for (var i = 0; i < cronIds.length; i++) {
        var raw = vals[i];
        if (raw) {
          try {
            stats[cronIds[i]] = JSON.parse(raw);
          } catch (_) {}
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

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

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
};