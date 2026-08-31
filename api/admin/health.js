var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var crypto = require("../../lib/crypto");

function nowMs() {
  return Date.now();
}

function getRedisConfig() {
  return redis.getRedisConfig ? redis.getRedisConfig() : { url: "", token: "" };
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
    return {
      id: id,
      name: name,
      status: "fail",
      latencyMs: nowMs() - started,
      detail: (e && e.message) || String(e),
      hint: "查看 Vercel 函数日志与 Upstash/KV 连接配置",
      data: null,
    };
  }
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  var checks = [];
  var cfg = getRedisConfig();

  checks.push(
    await runCheck("env", "环境变量", async function () {
      var missing = [];
      if (!cfg.url) missing.push("KV_REST_API_URL / UPSTASH_REDIS_REST_URL");
      if (!cfg.token) missing.push("KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN");
      var jwtSet = !!(process.env.JWT_SECRET && process.env.JWT_SECRET !== "jwt-secret-change-me");
      if (missing.length) {
        return {
          status: "fail",
          detail: "缺失: " + missing.join(", "),
          hint: "在 Vercel Project → Settings → Environment Variables 中配置 Upstash/KV 变量并重新部署",
          data: { jwtConfigured: jwtSet, redisUrl: maskUrl(cfg.url) },
        };
      }
      return {
        status: jwtSet ? "pass" : "warn",
        detail: jwtSet
          ? "Redis 与 JWT 环境变量已配置"
          : "Redis 已配置，但 JWT_SECRET 使用默认值（不安全）",
        hint: jwtSet ? "" : "建议设置强随机 JWT_SECRET",
        data: { jwtConfigured: jwtSet, redisUrl: maskUrl(cfg.url) },
      };
    })
  );

  checks.push(
    await runCheck("redis_ping", "Redis 连通性", async function () {
      var pong = await redis.ping();
      return {
        status: pong === "PONG" || pong === "pong" || pong ? "pass" : "warn",
        detail: "ping => " + String(pong),
        data: { pong: pong },
      };
    })
  );

  checks.push(
    await runCheck("redis_rw", "Redis 读写", async function () {
      var key = "auth:health:probe";
      var payload = { t: Date.now(), by: auth.username || "admin" };
      await redis.set(key, JSON.stringify(payload), { ex: 60 });
      var got = await redis.get(key);
      var parsed = typeof got === "string" ? JSON.parse(got) : got;
      var ok = parsed && Number(parsed.t) === payload.t;
      if (!ok) {
        return {
          status: "fail",
          detail: "写入后读回不一致",
          hint: "检查 KV 是否只读、或是否连到了错误的 Redis 实例",
          data: { wrote: payload, read: parsed },
        };
      }
      return {
        status: "pass",
        detail: "set/get 正常（临时键 60s 过期）",
        data: { key: key },
      };
    })
  );

  checks.push(
    await runCheck("products", "产品数据", async function () {
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
          "产品数 " +
          count +
          "，计数器 " +
          String(counter == null ? "-" : counter) +
          (parseErrors ? "，解析异常 " + parseErrors : ""),
        hint: count === 0 ? "当前无产品，添加产品失败通常是 Redis 写入或鉴权问题" : "",
        data: { count: count, counter: counter, sampleIds: sampleIds, parseErrors: parseErrors },
      };
    })
  );

  checks.push(
    await runCheck("redeem_codes", "兑换码数据", async function () {
      var total = await redis.scard("auth:redeem_codes");
      return {
        status: "pass",
        detail: "兑换码集合大小 " + total,
        data: { total: total },
      };
    })
  );

  checks.push(
    await runCheck("activations", "激活记录", async function () {
      var total = await redis.scard("auth:activation_codes");
      return {
        status: "pass",
        detail: "激活码集合大小 " + total,
        data: { total: total },
      };
    })
  );

  checks.push(
    await runCheck("crypto", "激活码编解码", async function () {
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
          detail: "编解码校验失败",
          data: { code: code, dec: dec },
        };
      }
      return {
        status: "pass",
        detail: "18位激活码编解码正常: " + crypto.fmtCode18(code),
        data: { sample: code },
      };
    })
  );

  checks.push(
    await runCheck("activate_path", "激活链路抽检", async function () {
      // Non-destructive: ensure redis read path used by activate works.
      var probeCode = "____";
      var missing = await redis.get("auth:redeem:" + probeCode);
      if (missing != null) {
        return {
          status: "warn",
          detail: "探测键意外存在，跳过",
        };
      }
      // Try listing one real redeem if any
      var scan = await redis.sscan("auth:redeem_codes", "0", { count: 5 });
      var keys = Array.isArray(scan) ? scan[1] || [] : scan && scan.keys ? scan.keys : [];
      if (!keys.length) {
        return {
          status: "warn",
          detail: "暂无兑换码，无法做真实兑换码读取抽检（编解码已通过）",
          hint: "先在后台生成兑换码后再测激活；若激活仍 500，优先看 Redis 连通性检查",
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
            detail: "兑换码 " + sampleKey + " JSON 解析失败",
            hint: "兑换码 payload 损坏会导致激活 500",
          };
        }
      }
      if (!info || typeof info !== "object") {
        return {
          status: "fail",
          detail: "兑换码 " + sampleKey + " 数据无法解析",
          hint: "兑换码 payload 损坏会导致激活 500",
        };
      }
      var pid = crypto.pad2(info.product_id);
      var months = parseInt(info.duration_months, 10);
      if (!Number.isFinite(months) || months < 1) {
        return {
          status: "fail",
          detail: "兑换码 " + sampleKey + " 的 duration_months 无效: " + String(info.duration_months),
          hint: "修复该兑换码数据或重新生成",
          data: { code: sampleKey, product_id: info.product_id, duration_months: info.duration_months },
        };
      }
      var act = crypto.generateActivationCode(pid, "Zz99", months, String(sampleKey).toUpperCase());
      return {
        status: "pass",
        detail: "样例兑换码 " + sampleKey + " 可读，模拟激活码生成成功",
        data: { sampleCode: sampleKey, product_id: pid, duration_months: months, sampleActivation: act },
      };
    })
  );

  checks.push(
    await runCheck("auth", "后台鉴权", async function () {
      return {
        status: "pass",
        detail: "当前请求已通过鉴权: " + (auth.username || "unknown"),
        data: { username: auth.username || "" },
      };
    })
  );

  var fail = checks.filter(function (c) { return c.status === "fail"; }).length;
  var warn = checks.filter(function (c) { return c.status === "warn"; }).length;
  var overall = fail ? "down" : warn ? "degraded" : "ok";

  var summary = "";
  if (overall === "ok") {
    summary = "服务器核心依赖正常。若前台仍提示激活失败，请核对兑换码是否存在于 Redis，以及设备ID是否正确。";
  } else if (overall === "degraded") {
    summary = "存在告警项，服务可能部分可用。请优先处理警告项后再重试添加产品/激活。";
  } else {
    summary =
      "检测到故障。添加产品失败与激活 500 最常见原因是 Redis/KV 未配置或连不通。请先修复失败的检查项。";
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
