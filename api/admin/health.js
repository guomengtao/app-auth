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

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
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
      var vercelToken = process.env.VERCEL_TOKEN || "";
      var vercelProjectId = process.env.VERCEL_PROJECT_ID || "";
      var vercelTeamId = process.env.VERCEL_TEAM_ID || "";

      if (!vercelToken || !vercelProjectId) {
        return res.json({
          success: false,
          error: "Vercel API未配置。请在环境变量中设置 VERCEL_TOKEN 和 VERCEL_PROJECT_ID",
          configured: {
            hasToken: !!vercelToken,
            hasProjectId: !!vercelProjectId,
            hasTeamId: !!vercelTeamId,
          },
          hint: "VERCEL_TOKEN 在 Vercel Dashboard → Settings → Tokens 生成；VERCEL_PROJECT_ID 在项目 Settings → General 里找。Team 项目需要额外 VERCEL_TEAM_ID。",
        });
      }

      var fetchUrl = "https://api.vercel.com/v3/projects/" + encodeURIComponent(vercelProjectId) + "/events?limit=50";
      if (vercelTeamId) fetchUrl += "&teamId=" + encodeURIComponent(vercelTeamId);
      var fetchOpts = {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + vercelToken,
        },
      };

      var httpAdapter = null;
      try { httpAdapter = require("https"); } catch (_) {}
      try { httpAdapter = require("http"); } catch (_) {}

      if (!httpAdapter) {
        return res.json({ success: false, error: "Node.js http 模块不可用" });
      }

      var url = new URL(fetchUrl);
      var options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
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
        req2.setTimeout(8000, function() { req2.destroy(); reject(new Error("Request timeout")); });
        req2.end();
      });

      var logs = [];
      if (body && body.data && body.data.events && Array.isArray(body.data.events)) {
        body.data.events.forEach(function(ev) {
          var timeStr = "";
          if (ev.createdAt) {
            try { timeStr = new Date(ev.createdAt).toLocaleString("zh-CN"); } catch (_) { timeStr = String(ev.createdAt); }
          }
          logs.push({
            time: timeStr,
            type: ev.type || ev.name || "unknown",
            summary: ev.payload && ev.payload.message ? ev.payload.message : (ev.text || ev.name || JSON.stringify(ev).slice(0, 200)),
            buildId: ev.buildId || "",
            deploymentId: ev.deploymentId || "",
          });
        });
      }

      return res.json({
        success: true,
        fetchedAt: new Date().toISOString(),
        statusCode: body.status,
        logs: logs,
        rawSample: (body.data && typeof body.data === "object") ? JSON.stringify(body.data).slice(0, 500) : "",
      });
    } catch (e) {
      console.error("vercel-logs error:", e);
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