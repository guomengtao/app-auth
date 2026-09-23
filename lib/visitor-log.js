// lib/visitor-log.js — 访客访问的「永久」日志（业务表 visitor_logs）
//
// 背景：原先访客明细存在 KV 结构里（`kv_lists` 的 `stats:recent`）——只保留约 100 条，
//      而日报（`stats:pv/uv/pages`）7 天就过期。要长期保存 + 长期统计，必须落业务表。
//
// 设计要点：
//   1. 表 `visitor_logs(id, ts, ip, path, ua, ref, country, region, city, visitor_hash, source)`；
//   2. 写入放在**响应之后**（调用方用 `waitUntil`），绝不占用用户等待时间；
//   3. 写库不做任何外呼（不查腾讯、不查 ip-api）——中文地区在**读取时**用
//      `lib/geo-district.getStoredGeo()` 富化，保证写入快且稳定；
//   4. 建表自愈（`ensureTable()` 幂等 + 模块级记忆化），无需手工跑 SQL；
//   5. 任何失败都只打日志，**绝不影响主流程**。

var pg = require("./postgres");

var CST_OFFSET_MS = 8 * 60 * 60 * 1000; // 北京时间，与 lib/rate-limit.js beijingDateKey() 口径一致

var ensurePromise = null;

function ensureTable() {
  if (!ensurePromise) {
    ensurePromise = (async function () {
      await pg.query(
        "create table if not exists visitor_logs (" +
          "id bigserial primary key, " +
          "ts timestamptz not null default now(), " +
          "ip varchar(45) not null default '', " +
          "path text not null default '', " +
          "ua varchar(256) not null default '', " +
          "ref varchar(256) not null default '', " +
          "country varchar(32) not null default '', " +
          "region varchar(64) not null default '', " +
          "city varchar(64) not null default '', " +
          "visitor_hash varchar(32) not null default '', " +
          "source varchar(32) not null default 'visit')"
      );
      await pg.query("create index if not exists idx_visitor_logs_ts on visitor_logs(ts desc)");
      await pg.query("create index if not exists idx_visitor_logs_ip on visitor_logs(ip)");
      await pg.query("create index if not exists idx_visitor_logs_hash on visitor_logs(visitor_hash)");
      console.log("[visitor-log] table ready");
    })().catch(function (e) {
      console.warn("[visitor-log] ensure table failed:", e && e.message);
      ensurePromise = null;
      throw e;
    });
  }
  return ensurePromise;
}

// 写入一条访问日志（ts 用毫秒时间戳）
async function logVisit(entry) {
  entry = entry || {};
  try {
    await ensureTable();
    await pg.query(
      "insert into visitor_logs (ts, ip, path, ua, ref, country, region, city, visitor_hash, source) " +
        "values (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        Number(entry.ts) || Date.now(),
        String(entry.ip || "").slice(0, 45),
        String(entry.path || "/").slice(0, 500),
        String(entry.ua || "").slice(0, 256),
        String(entry.ref || "").slice(0, 256),
        String(entry.country || "").slice(0, 32),
        String(entry.region || "").slice(0, 64),
        String(entry.city || "").slice(0, 64),
        String(entry.hash || "").slice(0, 32),
        String(entry.source || "visit").slice(0, 32),
      ]
    );
    return true;
  } catch (e) {
    console.warn("[visitor-log] insert failed:", e && e.message);
    return false;
  }
}

// 读取最近 N 条（面板「访客记录」用）
async function listRecent(limit, offset) {
  var lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  var off = Math.max(parseInt(offset, 10) || 0, 0);
  await ensureTable();
  var r = await pg.query(
    "select id, ts, ip, path, ua, ref, country, region, city, visitor_hash " +
      "from visitor_logs order by ts desc, id desc limit $1 offset $2",
    [lim, off]
  );
  return (r.rows || []).map(function (row) {
    return {
      id: String(row.id),
      time: row.ts ? new Date(row.ts).getTime() : 0,
      ip: row.ip || "",
      path: row.path || "/",
      ua: row.ua || "",
      ref: row.ref || "",
      country: row.country || "",
      region: row.region || "",
      city: row.city || "",
      hash: row.visitor_hash || "",
    };
  });
}

async function count() {
  try {
    await ensureTable();
    var r = await pg.query("select count(*)::int as n from visitor_logs");
    return (r.rows && r.rows[0] && r.rows[0].n) || 0;
  } catch (e) {
    return 0;
  }
}

// 按北京时间（UTC+8）聚合最近 days 天的 PV / UV，供趋势图使用（永久数据的正确口径）
async function dailyStats(days) {
  var d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  try {
    await ensureTable();
    var r = await pg.query(
      "select to_char((ts + interval '8 hours')::date, 'YYYY-MM-DD') as day, " +
        "count(*)::int as pv, count(distinct visitor_hash)::int as uv " +
        "from visitor_logs " +
        "where ts >= now() - (($1::int + 1) || ' days')::interval " +
        "group by 1 order by 1",
      [String(d)]
    );
    return (r.rows || []).map(function (row) {
      return { date: row.day, pv: row.pv, uv: row.uv };
    });
  } catch (e) {
    console.warn("[visitor-log] dailyStats failed:", e && e.message);
    return [];
  }
}

// 某一天（北京时间 YYYY-MM-DD）的概览：PV / UV / Top 页面（走 ts 索引，避免逐行 to_char）
async function dayOverview(dateKey) {
  try {
    await ensureTable();
    var dk = String(dateKey || "").slice(0, 10);
    var startMs = Date.parse(dk + "T00:00:00Z");
    if (!Number.isFinite(startMs)) return null;
    var startUtc = new Date(startMs - CST_OFFSET_MS);
    var endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);

    var agg = await pg.query(
      "select count(*)::int as pv, count(distinct visitor_hash)::int as uv " +
        "from visitor_logs where ts >= $1 and ts < $2",
      [startUtc.toISOString(), endUtc.toISOString()]
    );
    var pages = await pg.query(
      "select path, count(*)::int as hits from visitor_logs where ts >= $1 and ts < $2 " +
        "group by 1 order by 2 desc limit 5",
      [startUtc.toISOString(), endUtc.toISOString()]
    );
    return {
      date: dk,
      pv: (agg.rows[0] && agg.rows[0].pv) || 0,
      uv: (agg.rows[0] && agg.rows[0].uv) || 0,
      topPages: (pages.rows || []).map(function (r) { return { path: r.path, hits: r.hits }; }),
    };
  } catch (e) {
    console.warn("[visitor-log] dayOverview failed:", e && e.message);
    return null;
  }
}

module.exports = {
  ensureTable: ensureTable,
  logVisit: logVisit,
  listRecent: listRecent,
  count: count,
  dailyStats: dailyStats,
  dayOverview: dayOverview,
};
