const { db, sql } = require("@vercel/postgres");

function isConfigured() {
  return Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
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
var isSqlAvailable = typeof sql === "function";

try {
  if (!isConfigured()) {
    var envErr = new Error(
      "Postgres environment variable missing: POSTGRES_URL is required for Vercel Postgres"
    );
    envErr.code = "PG_ENV_MISSING";
    client = createMissingEnvClient(envErr);
  } else {
    client = {
      query: async function (text, params) {
        if (isSqlAvailable && !params) {
          return sql.query(text);
        }
        var pool = await db.connect();
        try {
          return await pool.query(text, params || []);
        } finally {
          pool.release();
        }
      },
      sql: sql,
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_messages (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(64) UNIQUE NOT NULL,
        title VARCHAR(255),
        content TEXT NOT NULL,
        message_type VARCHAR(32) DEFAULT 'info',
        priority INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by VARCHAR(128),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    if (!/relation.*already exists/i.test(String(e.message || e))) {
      console.warn("Postgres table init warning:", e.message || e);
    }
  }
}

client.ensureMessagesTable = ensureMessagesTable;

module.exports = client;