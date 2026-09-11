/**
 * Stream Smoke Test - Verify xadd + pushNotification work end-to-end
 *
 * Usage: node test/test-stream.js
 */
var path = require("path");

var envLocal = path.join(__dirname, "..", ".env.local");
var rootEnv = path.join(__dirname, "..", ".env");

try {
  require("fs").readFileSync(rootEnv, "utf8")
    .split("\n")
    .forEach(function (line) {
      var idx = line.indexOf("=");
      if (idx > 0 && !line.startsWith("#")) {
        var k = line.substring(0, idx).trim();
        var v = line.substring(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    });
} catch (e) {}

try {
  require("fs").readFileSync(envLocal, "utf8")
    .split("\n")
    .forEach(function (line) {
      var idx = line.indexOf("=");
      if (idx > 0 && !line.startsWith("#")) {
        var k = line.substring(0, idx).trim();
        var v = line.substring(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    });
} catch (e) {}

var passed = 0;
var failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log("  PASS: " + name);
    passed++;
  } catch (e) {
    console.log("  FAIL: " + name + " - " + e.message);
    failed++;
  }
}

async function run() {
  console.log("=".repeat(60));
  console.log("Stream Architecture Smoke Tests");
  console.log("=".repeat(60));

  var notify, redis;

  try {
    redis = require("../lib/redis");
    notify = require("../lib/notify");
  } catch (e) {
    console.log("  SKIP: Module load failed: " + e.message);
    console.log("  (may need UPSTASH_REDIS_REST_URL/TOKEN or POSTGRES_URL)");
    console.log("=".repeat(60));
    return;
  }

  check("redis module loaded", function () {
    if (!redis) throw new Error("redis is null");
    if (typeof redis.xadd !== "function") throw new Error("xadd not exported");
  });

  check("notify module loaded", function () {
    if (!notify) throw new Error("notify is null");
    if (typeof notify.pushNotification !== "function") throw new Error("pushNotification not exported");
  });

  check("redis.ping returns PONG", async function () {
    var res = await redis.ping();
    if (res !== "PONG") throw new Error("Expected PONG, got " + JSON.stringify(res));
  });

  var testMsgId;
  check("redis.xadd writes to stream", async function () {
    testMsgId = await redis.xadd("auth:notifications:stream", "*", {
      data: JSON.stringify({
        ts: Math.floor(Date.now() / 1000),
        type: "test_smoke",
        payload: { test: true, time: new Date().toISOString() },
      }),
    });
    if (!testMsgId || typeof testMsgId !== "string") {
      throw new Error("xadd returned invalid message ID: " + JSON.stringify(testMsgId));
    }
    console.log("    Message ID: " + testMsgId);
  });

  check("pushNotification new_activation", async function () {
    var ok = await notify.pushNotification("new_activation", {
      redeem_code: "TEST-SMOKE-CODE",
      activation_code: "ACT-TEST-123",
      product_id: "prod-smoke-test",
      device_id: "device-test-mac",
      months: 1,
      source: "smoke-test",
      ip: "127.0.0.1",
      user_agent: "SmokeTest/1.0",
    });
    if (!ok) throw new Error("pushNotification returned false");
  });

  check("pushNotification page_visit", async function () {
    var ok = await notify.pushNotification("page_visit", {
      page: "/test-smoke-page",
      referrer: "https://test.example.com",
      title: "Smoke Test Visit",
      user_agent: "SmokeTest/1.0",
      ip: "127.0.0.1",
    });
    if (!ok) throw new Error("pushNotification returned false");
  });

  check("pushNotification activation_failure", async function () {
    var ok = await notify.pushNotification("activation_failure", {
      reason: "Smoke test - simulated failure",
      redeem_code: "BAD-SMOKE-CODE",
      device_id: "device-test-bad",
      source: "smoke-test",
      ip: "127.0.0.1",
      user_agent: "SmokeTest/1.0",
    });
    if (!ok) throw new Error("pushNotification returned false");
  });

  console.log("\n" + "=".repeat(60));
  console.log("Results: " + passed + " passed, " + failed + " failed, " + (passed + failed) + " total");
  if (failed) {
    console.log("SOME TESTS FAILED!");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED!");
  }
}

run().catch(function (e) {
  console.log("  FAIL: Unhandled error: " + e.message);
  console.error(e);
  process.exit(1);
});