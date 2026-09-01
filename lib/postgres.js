var VercelPg;
try {
  VercelPg = require("@vercel/postgres");
} catch (e) {
  VercelPg = null;
}
var { Pool } = require("pg");

function resolveConnectionString() {
  return (
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ""
  );
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

function getNativePool() {
  if (nativePool) return nativePool;
  var conn = resolveConnectionString();
  if (!conn) {
    throw new Error(
      "Postgres environment variable missing: POSTGRES_URL is required for Vercel Postgres"
    );
  }
  nativePool = new Pool({
    connectionString: conn,
    ssl:
      /sslmode=require|ssl=true/i.test(conn) ||
      /neon|vercel|postgres\.vercel-storage|aws\.amazonaws\.com/i.test(conn)
        ? { rejectUnauthorized: false }
        : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  nativePool.on("error", function (err) {
    console.warn("Postgres native pool warning:", err.message || err);
  });
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
        try {
          // ⚠️ 统一使用 vercelDb.connect() 路径
          // 之前混用 vercelSql.query（无params）和 vercelDb.connect（有params）
          // Vercel Postgres 可能对两者做读写分离，导致 applyPatch 写入主库后
          // snapshotAll 通过只读副本读，立刻读到空数据！
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
        var np = getNativePool();
        return np.query(text, params || []);
      },
      sql: function () {
        var args = Array.prototype.slice.call(arguments);
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