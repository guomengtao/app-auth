var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var crypto = require("../../lib/crypto");

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