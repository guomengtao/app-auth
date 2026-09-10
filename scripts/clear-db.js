var redis = require("../lib/redis");

function hasFlag(flag) {
  return process.argv.indexOf(flag) !== -1;
}

if (process.env.NODE_ENV === "production") {
  console.error("❌ REFUSING to run in production. Set NODE_ENV=development or unset it.");
  process.exit(1);
}

if (!hasFlag("--confirm")) {
  console.error("❌ REFUSING to run without explicit confirmation.");
  console.error("   This script will DELETE ALL 'auth:*' keys from Redis.");
  console.error("   Usage: node scripts/clear-db.js --confirm");
  console.error("   Add --dry-run first to preview what would be deleted.");
  process.exit(1);
}

var dryRun = hasFlag("--dry-run");

async function clearAll() {
  var envLabel = (process.env.NODE_ENV || "development") + " - " + (redis._config && redis._config.url ? redis._config.url.replace(/^redis:\/\/[^@]+@/, "redis://***@") : "default");
  console.log("=== clear-db.js (RED GUARDRAILS ACTIVE) ===");
  console.log("Environment: " + envLabel);
  console.log("Dry-run: " + (dryRun ? "YES (no actual deletion)" : "NO (REAL DELETION)"));
  if (dryRun) {
    console.log();
  } else {
    var readline = require("readline");
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(function(resolve) {
      rl.question("Type 'YES_DELETE_ALL' to confirm you understand this is irreversible: ", function(ans) {
        rl.close();
        resolve(ans);
      });
    }).then(function(ans) {
      if (ans !== "YES_DELETE_ALL") {
        console.error("❌ Confirmation text mismatch. Aborting.");
        process.exit(1);
      }
    });
  }

  console.log("Scanning auth:* keys...");
  var cursor = 0;
  var totalKeys = 0;
  var totalDeleted = 0;
  do {
    var result = await redis.scan(cursor, { match: "auth:*", count: 200 });
    cursor = result[0];
    var keys = result[1];
    if (keys.length > 0) {
      totalKeys += keys.length;
      if (dryRun) {
        console.log("  [DRY-RUN] Would delete " + keys.length + " keys");
      } else {
        await redis.del.apply(redis, keys);
        totalDeleted += keys.length;
        console.log("  Deleted " + keys.length + " keys (total: " + totalDeleted + ")");
      }
    }
  } while (String(cursor) !== "0");

  console.log("\nDone. Scanned: " + totalKeys + (dryRun ? " (dry-run, none deleted)" : ", deleted: " + totalDeleted));
  process.exit(0);
}
clearAll().catch(function(err) {
  console.error("Error:", err);
  process.exit(1);
});