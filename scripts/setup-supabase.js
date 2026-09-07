function getSupabasePg() {
  var url = process.env.Ev_POSTGRES_URL ||
    process.env.Ev_POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_POSTGRES_URL ||
    process.env.Ev_POSTGRES_PRISMA_URL;
  if (!url) {
    console.error("Missing Ev_POSTGRES_URL or Ev_POSTGRES_URL_NON_POOLING");
    process.exit(1);
  }
  url = url.replace(/&supa=base-pooler\.x/, "").replace(/\?sslmode=require/, "?sslmode=verify-full");
  console.log("Supabase URL: " + url.replace(/:[^:@]+@/, ":****@"));
  var Pool = require("pg").Pool;
  return new Pool({ connectionString: url, max: 5, ssl: { rejectUnauthorized: false } });
}

function getNeonPg() {
  var url = process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL;
  if (!url) {
    console.error("Missing POSTGRES_URL");
    process.exit(1);
  }
  var Pool = require("pg").Pool;
  return new Pool({ connectionString: url, max: 5 });
}

async function createTables(supabasePg) {
  console.log("Creating tables in Supabase...\n");

  var sql = `
    CREATE TABLE IF NOT EXISTS kv_strings (
      key TEXT PRIMARY KEY,
      value TEXT,
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS kv_hashes (
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (key, field)
    );

    CREATE TABLE IF NOT EXISTS kv_sets (
      key TEXT NOT NULL,
      member TEXT NOT NULL,
      PRIMARY KEY (key, member)
    );

    CREATE TABLE IF NOT EXISTS kv_zsets (
      key TEXT NOT NULL,
      member TEXT NOT NULL,
      score DOUBLE PRECISION DEFAULT 0,
      PRIMARY KEY (key, member)
    );
  `;

  await supabasePg.query(sql);
  console.log("Tables created successfully.\n");
}

async function syncData(neonPg, supabasePg) {
  console.log("=== Syncing Neon → Supabase ===\n");

  var stats = { strings: 0, hashes: 0, sets: 0, zsets: 0, errors: 0 };

  var stringsRes = await neonPg.query("SELECT key, value, expires_at FROM kv_strings");
  console.log("kv_strings: " + stringsRes.rows.length + " rows");
  for (var i = 0; i < stringsRes.rows.length; i++) {
    var r = stringsRes.rows[i];
    try {
      await supabasePg.query(
        "INSERT INTO kv_strings (key, value, expires_at) VALUES ($1, $2, $3) " +
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
        [r.key, r.value, r.expires_at]
      );
      stats.strings++;
    } catch (e) {
      stats.errors++;
      console.error("  string error: " + r.key + " -> " + e.message);
    }
  }
  console.log("  ✓ " + stats.strings + " written\n");

  var hashesRes = await neonPg.query("SELECT key, field, value FROM kv_hashes");
  console.log("kv_hashes: " + hashesRes.rows.length + " rows");
  for (var h = 0; h < hashesRes.rows.length; h++) {
    var hr = hashesRes.rows[h];
    try {
      await supabasePg.query(
        "INSERT INTO kv_hashes (key, field, value) VALUES ($1, $2, $3) " +
        "ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value",
        [hr.key, hr.field, hr.value]
      );
      stats.hashes++;
    } catch (e) {
      stats.errors++;
      console.error("  hash error: " + hr.key + ":" + hr.field + " -> " + e.message);
    }
  }
  console.log("  ✓ " + stats.hashes + " written\n");

  var setsRes = await neonPg.query("SELECT key, member FROM kv_sets");
  console.log("kv_sets: " + setsRes.rows.length + " rows");
  for (var s = 0; s < setsRes.rows.length; s++) {
    var sr = setsRes.rows[s];
    try {
      await supabasePg.query(
        "INSERT INTO kv_sets (key, member) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [sr.key, sr.member]
      );
      stats.sets++;
    } catch (e) {
      stats.errors++;
      console.error("  set error: " + sr.key + ":" + sr.member + " -> " + e.message);
    }
  }
  console.log("  ✓ " + stats.sets + " written\n");

  var zsetsRes = await neonPg.query("SELECT key, member, score FROM kv_zsets");
  console.log("kv_zsets: " + zsetsRes.rows.length + " rows");
  for (var z = 0; z < zsetsRes.rows.length; z++) {
    var zr = zsetsRes.rows[z];
    try {
      await supabasePg.query(
        "INSERT INTO kv_zsets (key, member, score) VALUES ($1, $2, $3) " +
        "ON CONFLICT (key, member) DO UPDATE SET score = EXCLUDED.score",
        [zr.key, zr.member, zr.score]
      );
      stats.zsets++;
    } catch (e) {
      stats.errors++;
      console.error("  zset error: " + zr.key + ":" + zr.member + " -> " + e.message);
    }
  }
  console.log("  ✓ " + stats.zsets + " written\n");

  console.log("=== Sync Complete ===");
  console.log("  strings: " + stats.strings);
  console.log("  hashes:  " + stats.hashes);
  console.log("  sets:    " + stats.sets);
  console.log("  zsets:   " + stats.zsets);
  console.log("  errors:  " + stats.errors);
}

async function recordSyncStatus(supabasePg) {
  try {
    var now = new Date().toISOString();
    var existing = null;
    try {
      var res = await supabasePg.query("SELECT value FROM kv_strings WHERE key = $1", ["auth:db:sync_status"]);
      if (res.rows && res.rows.length > 0) {
        existing = JSON.parse(res.rows[0].value);
      }
    } catch (e) {}
    var updateCount = (existing && existing.updateCount ? existing.updateCount : 0) + 1;
    var status = {
      lastSyncDate: now,
      updateCount: updateCount,
      lastSyncType: "neon-to-supabase",
      message: "Sync completed successfully",
    };
    await supabasePg.query(
      "INSERT INTO kv_strings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      ["auth:db:sync_status", JSON.stringify(status)]
    );
    console.log("Sync status recorded: " + JSON.stringify(status));
  } catch (e) {
    console.warn("Failed to record sync status:", e.message || e);
  }
}

async function main() {
  var supabasePg = getSupabasePg();
  var neonPg = getNeonPg();

  await createTables(supabasePg);
  await syncData(neonPg, supabasePg);
  await recordSyncStatus(supabasePg);

  await supabasePg.end();
  await neonPg.end();
}

main().catch(function(e) {
  console.error("Fatal:", e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});