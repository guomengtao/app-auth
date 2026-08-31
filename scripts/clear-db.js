var redis = require("../lib/redis");

async function clearAll() {
  console.log("Clearing all auth:* keys from Redis...");

  var cursor = 0;
  var totalDeleted = 0;

  do {
    var result = await redis.scan(cursor, { match: "auth:*", count: 200 });
    cursor = result[0];
    var keys = result[1];

    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
      console.log("  Deleted " + keys.length + " keys (total: " + totalDeleted + ")");
    }
  } while (cursor !== 0);

  console.log("Done. Total keys deleted: " + totalDeleted);
  process.exit(0);
}

clearAll().catch(function (err) {
  console.error("Error:", err);
  process.exit(1);
});