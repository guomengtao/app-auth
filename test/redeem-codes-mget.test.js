// test/redeem-codes-mget.test.js
//
// 回归目标：兑换码列表必须用「批量读」取记录，不能退回逐条串行。
//
// 背景（2026-11-05）：lib/redis.js 的 pipeline().exec() 在 Postgres 模拟模式下是
// `for (...) { await client[op](...) }` —— 串行逐条 SQL。api/admin/redeem-codes.js 的
// fetchRedeemRecords 曾按 100 条一批调 pipeline.get，导致 N 条兑换码产生 N 次串行往返。
// 实测：未登录 401 基线 0.70s，含查询的接口 1.38s，差额基本全是这段串行开销。
//
// 本测试用假 redis 注入，直接验证「批量次数」这一可观测事实：
// 1200 条码应只产生 3 次 mget（500 + 500 + 200），而不是 1200 次。

var path = require("path");
var fs = require("fs");

var pass = 0;
var fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name + (detail ? "  → " + detail : ""));
  }
}

var ROOT = path.join(__dirname, "..");

// ── 1. 源码契约（防回退）────────────────────────────────────────────
console.log("\n[1] 源码契约");
var src = fs.readFileSync(path.join(ROOT, "api/admin/redeem-codes.js"), "utf8");

check("不再用 pipeline.get 逐条取兑换码记录",
  !/pipeline\.get\s*\(\s*["']auth:redeem:/.test(src),
  "发现 pipeline.get('auth:redeem:' + code) 循环");

check("改用 redis.mget",
  /redis\.mget/.test(src), "未找到 redis.mget");

check("批量大小 >= 500",
  (function () {
    var m = src.match(/var\s+batchSize\s*=\s*(\d+)/);
    return !!m && parseInt(m[1], 10) >= 500;
  })(), "batchSize 小于 500");

var redisSrc = fs.readFileSync(path.join(ROOT, "lib/redis.js"), "utf8");
check("lib/redis.js 的 mget 是单条 SELECT 批量读",
  /SELECT key, value FROM kv_strings WHERE key IN \(/.test(redisSrc),
  "mget 未使用 IN (...) 批量查询");

check("lib/redis.js 的 mget 保持入参顺序",
  /return keys\.map\(function \(k\) \{ return \(k in map\) \? map\[k\] : null; \}\)/.test(redisSrc),
  "mget 未按入参顺序回填");

// ── 2. 行为测试：批量次数与顺序 ─────────────────────────────────────
console.log("\n[2] 行为：1200 条码的批量次数");

var TOTAL = 1200;
var codes = [];
for (var i = 1; i <= TOTAL; i++) {
  codes.push("CODE" + String(i).padStart(5, "0"));
}

var calls = { mget: [], sscan: 0 };
var missing = {};          // 阶段 2 才启用：指定这些 code 返回 null，模拟记录缺失
var productIdMap = {};     // 阶段 3 才启用：code -> product_id，缺省 "01"（模拟同一产品的多种写法）

var fakeRedis = {
  sscan: async function (key, cursor, options) {
    calls.sscan++;
    var count = (options && options.count) ? parseInt(options.count, 10) : 10;
    var start = parseInt(cursor, 10) || 0;
    var slice = codes.slice(start, start + count);
    var next = (start + slice.length >= codes.length) ? "0" : String(start + slice.length);
    return [next, slice];
  },
  mget: async function () {
    var keys = Array.prototype.slice.call(arguments);
    calls.mget.push(keys.slice());
    return keys.map(function (k) {
      var code = k.replace("auth:redeem:", "");
      if (missing[code]) return null;
      return JSON.stringify({
        code: code,
        product_id: productIdMap[code] || "01",
        used: false,
        duration_months: 12,
        created_at: 1700000000000 + parseInt(code.slice(4), 10),
      });
    });
  },
};

// 注入假依赖：必须在 require handler 之前写入 require.cache
var redisPath = require.resolve("../lib/redis.js");
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: fakeRedis, children: [], paths: [],
};

var authPath = require.resolve("../lib/auth.js");
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { requireAuth: function () { return { authorized: true, username: "test@local" }; } },
  children: [], paths: [],
};

var handler = require("../api/admin/redeem-codes.js");

function makeRes() {
  var r = { statusCode: 200, body: null };
  r.status = function (c) { r.statusCode = c; return r; };
  r.json = function (b) { r.body = b; return r; };
  return r;
}

(async function () {
  // ── 阶段 1：数据完整 ────────────────────────────────────────────
  var req1 = { method: "GET", query: { limit: "500" }, headers: {} };
  var res1 = makeRes();
  await handler(req1, res1);

  check("HTTP 200", res1.statusCode === 200, "status=" + res1.statusCode);
  check("total 为 1200", res1.body && res1.body.total === TOTAL,
    "total=" + (res1.body && res1.body.total));
  check("本页返回 500 条", res1.body && res1.body.codes && res1.body.codes.length === 500,
    "len=" + (res1.body && res1.body.codes && res1.body.codes.length));

  check("mget 调用 3 次（500+500+200），而非 1200 次",
    calls.mget.length === 3, "实际 " + calls.mget.length + " 次");

  var sizes = calls.mget.map(function (c) { return c.length; });
  check("批次切分为 [500,500,200]",
    sizes.join(",") === "500,500,200", "实际 [" + sizes.join(",") + "]");

  var allPrefixed = calls.mget.every(function (batch) {
    return batch.every(function (k) { return k.indexOf("auth:redeem:") === 0; });
  });
  check("批量 key 均带 auth:redeem: 前缀", allPrefixed);

  // 顺序：服务端按 created_at 倒序，第一页首条应是最大的 created_at
  var first = res1.body && res1.body.codes && res1.body.codes[0];
  check("本页按 created_at 倒序（首条 CODE01200）",
    !!first && first.code === "CODE01200",
    "首条=" + (first && first.code));

  check("每页 limit 生效（limit 字段=500）",
    res1.body && res1.body.limit === 500, "limit=" + (res1.body && res1.body.limit));

  check("未出现「每条一次读」的放大（mget 次数 << 总条数）",
    calls.mget.length * 100 < TOTAL, "mget=" + calls.mget.length);

  // ── 阶段 2：一条记录在存储中缺失 ────────────────────────────────
  missing["CODE00007"] = true;
  calls.mget = [];
  calls.sscan = 0;
  var res2 = makeRes();
  await handler({ method: "GET", query: { limit: "500" }, headers: {} }, res2);

  check("缺失记录被跳过（total 1199）", res2.body && res2.body.total === TOTAL - 1,
    "total=" + (res2.body && res2.body.total));
  check("缺失场景仍是 3 次批量读", calls.mget.length === 3,
    "实际 " + calls.mget.length + " 次");
  delete missing["CODE00007"];

  // ── 阶段 3：产品 ID 多种写法归一化 ────────────────────────────────
  // 真实数据里同一产品并存 "01"/"1"/"0001"（Ev课程表），严格相等会各筛出一半。
  // 这里让 1..10 号码用 "0001"、11..20 用 "1"、21..30 用 "02"，其余 "01"。
  productIdMap = {};
  for (var a = 1; a <= 10; a++) productIdMap["CODE" + String(a).padStart(5, "0")] = "0001";
  for (var b = 11; b <= 20; b++) productIdMap["CODE" + String(b).padStart(5, "0")] = "1";
  for (var c = 21; c <= 30; c++) productIdMap["CODE" + String(c).padStart(5, "0")] = "02";

  var res3 = makeRes();
  await handler({ method: "GET", query: { product_id: "01", limit: "500" }, headers: {} }, res3);
  check("筛选 01 覆盖 01/1/0001 三种写法（total 1190）",
    res3.body && res3.body.total === TOTAL - 10,
    "total=" + (res3.body && res3.body.total));

  var res4 = makeRes();
  await handler({ method: "GET", query: { product_id: "0001", limit: "500" }, headers: {} }, res4);
  check("筛选 0001 归一化到 01（total 同样 1190）",
    res4.body && res4.body.total === TOTAL - 10,
    "total=" + (res4.body && res4.body.total));

  var res5 = makeRes();
  await handler({ method: "GET", query: { product_id: "02", limit: "500" }, headers: {} }, res5);
  check("筛选 02 只出 10 条", res5.body && res5.body.total === 10,
    "total=" + (res5.body && res5.body.total));

  var res6 = makeRes();
  await handler({ method: "GET", query: { product_id: "prod-not-exist", limit: "500" }, headers: {} }, res6);
  check("筛选不存在的非数字产品 → 空", res6.body && res6.body.total === 0,
    "total=" + (res6.body && res6.body.total));

  console.log("\n共 " + (pass + fail) + " 项：" + pass + " PASS / " + fail + " FAIL");
  if (fail > 0) process.exit(1);
})().catch(function (e) {
  console.error("测试异常:", e && e.stack || e);
  process.exit(1);
});
