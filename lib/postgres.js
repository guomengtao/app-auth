var VercelPg;
try {
  VercelPg = require("@vercel/postgres");
} catch (e) {
  VercelPg = null;
}
var { Pool } = require("pg");
var dbSwitches = require("./db-switches");
var dbRegistry = require("./db-registry");

function resolveConnectionString() {
  var primaryFromRedis = dbSwitches.getPrimary();
  var effectiveProvider = primaryFromRedis || process.env.DB_PROVIDER;

  console.log("[postgres] resolveConnection: primaryFromRedis=", primaryFromRedis, "DB_PROVIDER=", process.env.DB_PROVIDER, "effective=", effectiveProvider);

  if (effectiveProvider) {
    var db = dbRegistry.getDatabase(effectiveProvider);
    console.log("[postgres] db lookup result:", db ? (db.id + " type=" + db.type + " urlEnv=" + db.urlEnv) : "null");
    if (db && db.type === "postgres" && dbSwitches.isEnabled(effectiveProvider)) {
      var url = process.env[db.urlEnv];
      console.log("[postgres] env var", db.urlEnv, "exists:", Boolean(url));
      if (url) {
        console.log("[postgres] RESOLVED to:", db.id, "connection string length:", url.length);
        return url;
      }
    }
  }

  var pgDbs = dbRegistry.getPostgresDatabases();
  for (var i = 0; i < pgDbs.length; i++) {
    if (dbSwitches.isEnabled(pgDbs[i].id)) {
      var altUrl = process.env[pgDbs[i].urlEnv];
      if (altUrl) {
        console.log("[postgres] FALLBACK to:", pgDbs[i].id);
        return altUrl;
      }
    }
  }

  console.log("[postgres] ALL DATABASES FAILED - no connection string found");
  throw new Error("All PostgreSQL databases are disabled or missing connection URLs. Enable at least one in the admin panel.");
}

function isConfigured() {
  return Boolean(resolveConnectionString());
}

function createMissingEnvClient(err) {
  return {
    __pgError: err,
    query: function () {
      return Promise.reject(err);
    },
    sql: function () {
      return Promise.reject(err);
    },
  };
}

var client;
var nativePool = null;

var nativePoolConnString = null;

function getNativePool() {
  var conn = resolveConnectionString();
  if (!conn) {
    throw new Error(
      "Postgres environment variable missing: POSTGRES_URL is required for Vercel Postgres"
    );
  }
  conn = conn.replace(/sslmode=require/g, 'sslmode=no-verify');

  if (nativePool && nativePoolConnString !== conn) {
    try { nativePool.end(); } catch (_) {}
    nativePool = null;
    nativePoolConnString = null;
  }

  if (nativePool) return nativePool;

  nativePool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  nativePool.on("error", function (err) {
    console.warn("Postgres native pool warning:", err.message || err);
  });
  nativePoolConnString = conn;
  return nativePool;
}

try {
  if (!isConfigured()) {
    var envErr = new Error(
      "Postgres environment variable missing: POSTGRES_URL is required for Vercel Postgres"
    );
    envErr.code = "PG_ENV_MISSING";
    client = createMissingEnvClient(envErr);
  } else {
    var vercelDb = VercelPg && VercelPg.db;
    var vercelSql = VercelPg && VercelPg.sql;
    var isSqlAvailable = typeof vercelSql === "function";

    client = {
      query: async function (text, params) {
        await dbSwitches.loadSwitches();
        // Primary DB resolution at query time (runtime hot-switch capable).
        // This allows primary changes to take effect without restart, unlike redis.js which resolves at load time.
        var primaryFromRedis2 = dbSwitches.getPrimary();
        var effectiveProvider2 = primaryFromRedis2 || process.env.DB_PROVIDER;
        var db2 = dbRegistry.getDatabase(effectiveProvider2);
        var isSupabase = db2 && db2.id === "supabase" && dbSwitches.isEnabled("supabase");
        var primaryEnabled = db2 && dbSwitches.isEnabled(db2.id);
        if (!isSupabase && primaryEnabled) {
          try {
            if (vercelDb) {
              try {
                var pool = await vercelDb.connect();
                try {
                  return await pool.query(text, params || []);
                } finally {
                  if (pool && typeof pool.release === "function") pool.release();
                }
              } catch (vercelErr) {
                if (
                  !/Invalid URL|parse|connection|ECONNREFUSED|ENOTFOUND/i.test(
                    String(vercelErr.message || vercelErr)
                  )
                ) {
                  throw vercelErr;
                }
              }
            }
          } catch (e) {
            if (!/Invalid URL|parse|connection/i.test(String(e.message || e))) {
              throw e;
            }
          }
        }
        var np = getNativePool();
        return np.query(text, params || []);
      },
      sql: function () {
        var args = Array.prototype.slice.call(arguments);
        var primaryFromRedis3 = dbSwitches.getPrimary();
        var effectiveProvider3 = primaryFromRedis3 || process.env.DB_PROVIDER;
        var db3 = dbRegistry.getDatabase(effectiveProvider3);
        var isSupabase2 = db3 && db3.id === "supabase";
        if (isSupabase2) {
          return Promise.reject(new Error("Tagged sql not available in Supabase mode"));
        }
        if (isSqlAvailable && vercelSql) {
          try {
            return vercelSql.apply(null, args);
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return Promise.reject(new Error("Tagged sql not available in fallback mode"));
      },
    };
  }
} catch (e) {
  client = createMissingEnvClient(e);
}

client.isConfigured = isConfigured;
client.getNativePool = getNativePool;
client.dbSwitches = dbSwitches;

async function ensureTables() {
  if (!isConfigured()) {
    return;
  }
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_strings (" +
        "key VARCHAR(512) PRIMARY KEY, " +
        "value TEXT, " +
        "expires_at TIMESTAMP WITH TIME ZONE)"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_strings_expires ON kv_strings(expires_at) WHERE expires_at IS NOT NULL"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_hashes (" +
        "key VARCHAR(512) NOT NULL, " +
        "field VARCHAR(256) NOT NULL, " +
        "value TEXT, " +
        "PRIMARY KEY (key, field))"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_hashes_key ON kv_hashes(key)"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_sets (" +
        "key VARCHAR(512) NOT NULL, " +
        "member VARCHAR(512) NOT NULL, " +
        "PRIMARY KEY (key, member))"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_sets_key ON kv_sets(key)"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_lists (" +
        "key VARCHAR(512) NOT NULL, " +
        "idx BIGSERIAL NOT NULL, " +
        "value TEXT, " +
        "PRIMARY KEY (key, idx))"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_lists_key ON kv_lists(key)"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_zsets (" +
        "key VARCHAR(512) NOT NULL, " +
        "member VARCHAR(512) NOT NULL, " +
        "score DOUBLE PRECISION NOT NULL DEFAULT 0, " +
        "PRIMARY KEY (key, member))"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_zsets_key_score ON kv_zsets(key, score)"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS admin_messages (" +
        "id SERIAL PRIMARY KEY, " +
        "uuid VARCHAR(64) UNIQUE NOT NULL, " +
        "title VARCHAR(255), " +
        "content TEXT NOT NULL, " +
        "message_type VARCHAR(32) DEFAULT 'info', " +
        "priority INTEGER DEFAULT 0, " +
        "is_active BOOLEAN DEFAULT TRUE, " +
        "created_by VARCHAR(128), " +
        "created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, " +
        "updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)"
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv_streams (" +
        "stream_key VARCHAR(512) NOT NULL, " +
        "message_id VARCHAR(128) NOT NULL, " +
        "fields JSONB NOT NULL, " +
        "created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, " +
        "PRIMARY KEY (stream_key, message_id))"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_kv_streams_key_created ON kv_streams(stream_key, created_at DESC)"
    );
    // 消息投递追踪表。以前只有 scripts/setup-message-delivery.js 会建它，ensureTables 不建，
    // 于是「表不存在」时后台投递面板恒为空、EvNotifier 的离线补拉（section=delivery-sync）
    // 静默返回 0 条。这里补上（DDL 与 scripts/setup-message-delivery.sql 保持一致）。
    await client.query(
      "CREATE TABLE IF NOT EXISTS message_delivery (" +
        "id BIGSERIAL PRIMARY KEY, " +
        "message_id VARCHAR(64) NOT NULL, " +
        "message_type VARCHAR(32) NOT NULL, " +
        "payload JSONB NOT NULL DEFAULT '{}', " +
        "source VARCHAR(64) NOT NULL, " +
        "channel VARCHAR(64) NOT NULL DEFAULT 'auth:push_channel', " +
        "target_client VARCHAR(128), " +
        "created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), " +
        "published_at TIMESTAMP WITH TIME ZONE, " +
        "delivered_at TIMESTAMP WITH TIME ZONE, " +
        "confirmed_at TIMESTAMP WITH TIME ZONE, " +
        "status VARCHAR(16) NOT NULL DEFAULT 'pending', " +
        "error_message TEXT, " +
        "retry_count INT NOT NULL DEFAULT 0, " +
        "related_code VARCHAR(32), " +
        "related_device VARCHAR(128))"
    );
    // 设备授权令牌（EvNotifier 等桌面客户端用「登录一次、长期记住」替代手工共享密钥）
    // 只存 sha256 哈希，明文只在校验成功的那一次返回给客户端；见 tools/ev-notifier/后台登录鉴权改造方案.md
    await client.query(
      "CREATE TABLE IF NOT EXISTS device_tokens (" +
        "id BIGSERIAL PRIMARY KEY, " +
        "token_hash VARCHAR(64) NOT NULL UNIQUE, " +
        "label VARCHAR(128) NOT NULL, " +
        "email VARCHAR(128) NOT NULL, " +
        "app_version VARCHAR(32), " +
        "created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), " +
        "last_seen_at TIMESTAMP WITH TIME ZONE, " +
        "last_seen_ip VARCHAR(64), " +
        "revoked_at TIMESTAMP WITH TIME ZONE)"
    );
    await client.query("CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_device_tokens_revoked ON device_tokens(revoked_at)");

    await client.query("CREATE INDEX IF NOT EXISTS idx_md_status ON message_delivery(status)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_md_created ON message_delivery(created_at DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_md_message_id ON message_delivery(message_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_md_related_code ON message_delivery(related_code)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_md_status_created ON message_delivery(status, created_at DESC)");
  } catch (e) {
    if (!/relation.*already exists|already exists/i.test(String(e.message || e))) {
      console.warn("Postgres table init warning:", e.message || e);
    }
  }
}

async function ensureMessagesTable() {
  await ensureTables();
}

client.ensureTables = ensureTables;
client.ensureMessagesTable = ensureMessagesTable;

async function withTransaction(fn) {
  if (!isConfigured()) {
    throw new Error("Postgres not configured");
  }
  var pool = getNativePool();
  var conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    var result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (e) {
    try { await conn.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    try { conn.release(); } catch (_) {}
  }
}
client.withTransaction = withTransaction;

module.exports = client;