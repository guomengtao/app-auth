// 撞库（激活码枚举）防护 —— 2026-10-06 数据分析后新增
// 背景：auth:activation_failures 累计 285 条 > auth:activation_codes 发放 195 条，
//   其中 45% 集中在两天（09-28 72 次 / 09-29 56 次），失败码为 4 位小写字母且 285 条全部唯一
//   → 符合「同一来源慢速枚举」特征（26^4 ≈ 45.7 万搜索空间偏小）。
// 已有 lib/rate-limit.js 只限制「每分钟请求数」，挡得住洪泛、挡不住慢速枚举：
//   攻击者控制在阈值以下，一天照样能试出成百上千个码。
// 本模块补的是**第二层：同一 IP 当日失败累计达到阈值即封禁**，与分钟级限流互补。
// 依赖的 redis 命令只用 get / set / incr / pexpire —— 均已在 lib/rate-limit.js 与 api/activate.js 中验证可用。

var redis = require("./redis");

// 失败计数窗口：滚动 24 小时（键带当日后缀，跨天自然重置）
var FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
// 单个 IP 在窗口内允许的失败次数，超过即封禁
var FAIL_THRESHOLD = 20;
// 封禁时长
var BLOCK_MS = 6 * 60 * 60 * 1000;
var CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingDayKey() {
  var d = new Date(Date.now() + CST_OFFSET_MS);
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}

function safeIp(ip) {
  var s = String(ip || "").trim();
  if (!s) return "unknown";
  return s.replace(/[^0-9A-Za-z.:_-]/g, "").slice(0, 64) || "unknown";
}

// 记录一次激活失败；达到阈值时落下封禁键。返回值仅供日志/调试，调用方可不 await。
async function noteFailure(ip) {
  var ip2 = safeIp(ip);
  var countKey = "auth:guard:fail:" + beijingDayKey() + ":" + ip2;
  var n = await redis.incr(countKey).catch(function (e) {
    console.error("[brute-guard] incr failed:", e && e.message);
    return null;
  });
  if (n === null) return { blocked: false, failures: 0 };
  if (n === 1) {
    await redis.pexpire(countKey, FAIL_WINDOW_MS).catch(function () {});
  }
  if (n >= FAIL_THRESHOLD) {
    await redis
      .set("auth:guard:block:" + ip2, String(Date.now() + BLOCK_MS))
      .catch(function (e) {
        console.error("[brute-guard] block write failed:", e && e.message);
      });
    return { blocked: true, failures: n };
  }
  return { blocked: false, failures: n };
}

// 查询某 IP 是否处于封禁中。值里存的是到期时间戳，过期即视为解封（不依赖额外的过期命令）。
async function isBlocked(ip) {
  var ip2 = safeIp(ip);
  var until = await redis.get("auth:guard:block:" + ip2).catch(function (e) {
    console.error("[brute-guard] block read failed:", e && e.message);
    return null;
  });
  if (!until) return { blocked: false };
  var t = parseInt(until, 10);
  if (!isFinite(t) || Date.now() > t) return { blocked: false };
  return { blocked: true, retryAfterMs: t - Date.now() };
}

module.exports = {
  noteFailure: noteFailure,
  isBlocked: isBlocked,
  safeIp: safeIp,
  beijingDayKey: beijingDayKey,
  FAIL_THRESHOLD: FAIL_THRESHOLD,
  BLOCK_MS: BLOCK_MS,
  FAIL_WINDOW_MS: FAIL_WINDOW_MS,
};
