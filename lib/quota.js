var postgres = require("./postgres");
var redis = require("./redis");

var FREE_TIER = {
  computeHoursMonth: 100,
  storageGiB: 0.5,
  egressGiBMonth: 1,
  maxBranches: 10,
  historyDays: 1,
};

function monthKey(d) {
  var now = d || new Date();
  return now.getUTCFullYear() + "-" + pad2(now.getUTCMonth() + 1);
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function monthResetUtcTs(d) {
  var now = d || new Date();
  var start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);
  var next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return { startMs: start, nextResetMs: next };
}

async function ensureTables() {
  try {
    await postgres.query(
      "CREATE TABLE IF NOT EXISTS quota_ticks (id BIGSERIAL PRIMARY KEY, tick_at BIGINT NOT NULL, path TEXT, gap_seconds INTEGER, added_active_seconds INTEGER, month_key TEXT NOT NULL)"
    );
    await postgres.query(
      "CREATE INDEX IF NOT EXISTS idx_quota_ticks_month ON quota_ticks(month_key)"
    );
  } catch (e) {
    console.warn("quota ensureTables skip:", e && e.message ? e.message : e);
  }
}

async function bumpQuotaTick(path) {
  try {
    ensureTables();
    var nowMs = Date.now();
    var mk = monthKey(new Date(nowMs));
    var stateKey = "quota:monthstate:" + mk;
    var raw;
    try { raw = await redis.get(stateKey); } catch (e) { raw = null; }
    var st = raw && typeof raw === "string" ? JSON.parse(raw) : null;
    if (!st || typeof st !== "object") {
      st = { lastActiveTs: 0, activeSecondsEst: 0, coldStarts: 0, pingCount: 0, firstTs: nowMs };
    }
    var gapSec = st.lastActiveTs ? Math.max(0, Math.floor((nowMs - Number(st.lastActiveTs)) / 1000)) : 0;
    var IDLE_S = 300;
    var added = 0;
    if (!st.lastActiveTs) {
      added = 0;
      st.coldStarts = Number(st.coldStarts || 0) + 1;
    } else if (gapSec > IDLE_S) {
      added = 0;
      st.coldStarts = Number(st.coldStarts || 0) + 1;
    } else {
      added = gapSec;
      st.activeSecondsEst = Number(st.activeSecondsEst || 0) + added;
    }
    st.lastActiveTs = nowMs;
    st.pingCount = Number(st.pingCount || 0) + 1;
    try {
      await redis.set(stateKey, JSON.stringify(st), { ex: 60 * 60 * 24 * 40 });
    } catch (e) {}
    try {
      if (added || st.pingCount === 1 || gapSec > IDLE_S) {
        await postgres.query(
          "INSERT INTO quota_ticks (tick_at, path, gap_seconds, added_active_seconds, month_key) VALUES ($1,$2,$3,$4,$5)",
          [nowMs, String(path || ""), gapSec, added, mk]
        );
      }
    } catch (e) {}
    return { gapSec: gapSec, addedSec: added, state: st };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

function round(n, d) {
  d = d || 2;
  var m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

async function queryStorageBytes() {
  var dbSizeBytes = 0;
  var tableCount = 0;
  var rowEstimates = {};
  var relationTotal = 0;
  try {
    var r = await postgres.query("SELECT pg_database_size(current_database()) AS bytes");
    if (r && r.rows && r.rows[0]) dbSizeBytes = Number(r.rows[0].bytes) || 0;
  } catch (e) {}
  try {
    var rr = await postgres.query(
      "SELECT relname, n_live_tup AS est_rows, pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) AS bytes FROM pg_stat_user_tables ORDER BY bytes DESC LIMIT 50"
    );
    if (rr && rr.rows) {
      rr.rows.forEach(function(row) {
        var rel = String(row.relname || "");
        var est = Number(row.est_rows) || 0;
        var b = Number(row.bytes) || 0;
        if (rel) {
          rowEstimates[rel] = { est_rows: est, bytes: b };
          relationTotal += b;
          tableCount++;
        }
      });
    }
  } catch (e) {}
  return { dbSizeBytes: dbSizeBytes, relationTotalBytes: relationTotal, tableCount: tableCount, byTable: rowEstimates };
}

async function countActivations() {
  try {
    var total = await redis.scard("auth:activation_codes");
    var codes = await redis.scard("auth:redeem_codes");
    return { totalActivations: Number(total) || 0, totalRedeemCodes: Number(codes) || 0 };
  } catch (e) {
    return { totalActivations: 0, totalRedeemCodes: 0, error: (e && e.message) || String(e) };
  }
}

async function getMonthlyState() {
  var mk = monthKey();
  try {
    var raw = await redis.get("quota:monthstate:" + mk);
    if (raw && typeof raw === "string") return JSON.parse(raw);
  } catch (e) {}
  return { lastActiveTs: 0, activeSecondsEst: 0, coldStarts: 0, pingCount: 0, firstTs: 0 };
}

async function summarize() {
  var storage = await queryStorageBytes();
  var counts = await countActivations();
  var state = await getMonthlyState();
  var resets = monthResetUtcTs();
  var nowMs = Date.now();
  var elapsedMs = Math.max(1, nowMs - resets.startMs);
  var elapsedDays = elapsedMs / 86400000;
  var totalMonthDays = (resets.nextResetMs - resets.startMs) / 86400000;
  var usedHoursEst = Number(state.activeSecondsEst || 0) / 3600;

  var projectedHoursByRate = usedHoursEst;
  if (elapsedDays > 0.25) {
    projectedHoursByRate = usedHoursEst * (totalMonthDays / elapsedDays);
  }

  var dbGiB = storage.dbSizeBytes / (1024 * 1024 * 1024);
  var relGiB = storage.relationTotalBytes / (1024 * 1024 * 1024);

  return {
    freeTier: FREE_TIER,
    month: {
      key: monthKey(),
      startUtcIso: new Date(resets.startMs).toISOString(),
      nextResetUtcIso: new Date(resets.nextResetMs).toISOString(),
      nowUtcIso: new Date(nowMs).toISOString(),
      elapsedDays: round(elapsedDays, 2),
      totalDaysInMonth: round(totalMonthDays, 1),
      percentMonthElapsed: round((elapsedDays / totalMonthDays) * 100, 1),
    },
    compute: {
      freeHours: FREE_TIER.computeHoursMonth,
      usedHoursEstimate: round(usedHoursEst, 3),
      remainingHoursEstimate: round(Math.max(0, FREE_TIER.computeHoursMonth - usedHoursEst), 3),
      percentUsed: round((usedHoursEst / FREE_TIER.computeHoursMonth) * 100, 2),
      coldStarts: Number(state.coldStarts || 0),
      totalPings: Number(state.pingCount || 0),
      lastActiveTs: Number(state.lastActiveTs || 0),
      projectedHoursAtCurrentRate: round(projectedHoursByRate, 2),
      dailyAverageHours: elapsedDays > 0 ? round(usedHoursEst / elapsedDays, 3) : 0,
      note: "Estimate based on observed DB-active spans (gap>300s = scale-to-zero). Neon official billing takes precedence; see console.neon.tech for exact numbers.",
    },
    storage: {
      freeGiB: FREE_TIER.storageGiB,
      dbSizeBytes: storage.dbSizeBytes,
      dbSizeGiB: round(dbGiB, 4),
      relationGiB: round(relGiB, 4),
      percentUsed: round((Math.max(dbGiB, relGiB) / FREE_TIER.storageGiB) * 100, 2),
      tableCount: storage.tableCount,
      byTable: storage.byTable,
    },
    egress: {
      freeGiB: FREE_TIER.egressGiBMonth,
      note: "Neon/Vercel does not expose precise egress via public SQL. Inspect console for exact egress. Below only shows a proxy indicator.",
      estimatedRowsTransferredProxied: counts.totalActivations * 2 + counts.totalRedeemCodes * 1,
    },
    counts: counts,
    limits: {
      maxBranches: FREE_TIER.maxBranches,
      historyDays: FREE_TIER.historyDays,
    },
    neon: {
      apiKeyConfigured: !!process.env.NEON_API_KEY,
      projectIdEnv: process.env.NEON_PROJECT_ID || "",
      branchIdEnv: process.env.NEON_BRANCH_ID || "",
    },
  };
}

module.exports = {
  FREE_TIER: FREE_TIER,
  bumpQuotaTick: bumpQuotaTick,
  summarize: summarize,
  monthKey: monthKey,
  monthResetUtcTs: monthResetUtcTs,
};