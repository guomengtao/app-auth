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
          if (vercelDb && isSqlAvailable && !params) {
            try {
              return await vercelSql.query(text);
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
          if (vercelDb) {
            try {
              var pool = await vercelDb.connect();
              try {
                return await pool.query(text, params || []);
              } finally {
                if (pool && typeof pool.release === "function") pool.release();
              }
            } catch (vercelErr2) {
              if (
                !/Invalid URL|parse|connection|ECONNREFUSED|ENOTFOUND/i.test(
                  String(vercelErr2.message || vercelErr2)
                )
              ) {
                throw vercelErr2;
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

async function ensureMessagesTable() {
  if (!isConfigured()) {
    return;
  }
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS admin_messages (' +
        'id SERIAL PRIMARY KEY, ' +
        'uuid VARCHAR(64) UNIQUE NOT NULL, ' +
        'title VARCHAR(255), ' +
        'content TEXT NOT NULL, ' +
        "message_type VARCHAR(32) DEFAULT 'info', " +
        'priority INTEGER DEFAULT 0, ' +
        'is_active BOOLEAN DEFAULT TRUE, ' +
        'created_by VARCHAR(128), ' +
        'created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, ' +
        'updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)'
    );
  } catch (e) {
    if (!/relation.*already exists/i.test(String(e.message || e))) {
      console.warn("Postgres table init warning:", e.message || e);
    }
  }
}

client.ensureMessagesTable = ensureMessagesTable;

module.exports = client;