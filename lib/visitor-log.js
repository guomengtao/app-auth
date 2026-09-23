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

// 归一化地名，让同一城市能合并统计：
//   「广州市」/「广东省」→「广州」/「广东」（ip-api 带「市」、腾讯不带）
//   「中国上海」→「上海」（ip-api 偶尔把国家名拼进 city）
function stripRegionSuffix(s) {
  var v = String(s || "").trim();
  var cleaned = v.replace(/^(?:中国|中華人民共和國|中华人民共和国)\s*/, "");
  if (cleaned) v = cleaned;
  return v.length >= 3 ? v.replace(/[市省]$/, "") : v;
}

// 唯一 IP 记录（面板「唯一 IP 记录」页）：
//   1) 一条 SQL 把最近 d 天按 IP 聚合（访问次数 / 独立访客 / 首末时间），并左连 ip_lookups 取原始 geo 列；
//   2) 中文化统一走 geoZh.pickCnPair()（腾讯整组优先，其次 ip-api 整组）——与「最近访客」完全同源，
//      避免出现「上海 · 杭州」这种跨源混搭；ip_lookups 没记录的 IP 用 visitor_logs 里的原始值兜底翻译；
//   3) 返回 { stats, cities, ips }：cities = 城市 → 唯一 IP 数（大的在前），可按某个城市筛 IP 列表。
// 注意：geo-zh 是纯本地映射表（无外呼），不违反本模块「写库不查外部接口」的约束。
async function uniqueIpStats(days, cityFilter) {
  var geoZh = require("./geo-zh");
  var d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  var out = { days: d, stats: { visits: 0, ips: 0, cities: 0, shown: 0 }, cities: [], ips: [] };
  try {
    await ensureTable();
    var ds = String(d);
    var rows = await pg.query(
      "select v.ip, v.visits, v.uv, v.first_ts, v.last_ts, " +
        "       v.country as v_country, v.region as v_region, v.city as v_city, " +
        "       l.country as l_country, l.region, l.region_zh, l.city, l.city_zh, l.district, l.isp, l.asn " +
        "from (" +
        "  select ip, count(*)::int as visits, count(distinct nullif(visitor_hash, ''))::int as uv, " +
        "         max(ts) as last_ts, min(ts) as first_ts, " +
        "         max(country) as country, max(region) as region, max(city) as city " +
        "  from visitor_logs " +
        "  where ts >= now() - (($1::int) || ' days')::interval and ip <> '' " +
        "  group by ip" +
        ") v left join ip_lookups l on l.ip = v.ip " +
        "order by v.visits desc, v.last_ts desc limit 20000",
      [ds]
    );

    // 每个 IP 的中文省 / 市（一处计算，后面分城市统计与明细共用）
    var all = [];
    (rows.rows || []).forEach(function (row) {
      var pair = geoZh.pickCnPair(row);
      var region = stripRegionSuffix(
        pair.region || geoZh.regionZhOf(row.v_region, row.v_country) || row.v_region || ""
      );
      var city = stripRegionSuffix(pair.city || geoZh.cityZhOf(row.v_city) || row.v_city || "");
      all.push({
        ip: row.ip,
        visits: row.visits || 0,
        uv: row.uv || 0,
        firstSeen: row.first_ts ? new Date(row.first_ts).getTime() : 0,
        lastSeen: row.last_ts ? new Date(row.last_ts).getTime() : 0,
        country: String(row.l_country || row.v_country || "").trim(),
        region: region,
        city: city,
        district: String(row.district || "").trim(),
        isp: String(row.isp || "").trim(),
        asn: String(row.asn || "").trim(),
        label: city || region || "(未知地区)",
        paths: [],
      });
    });

    // 2. 城市 → 唯一 IP 数 / 访问次数（数字大的在前）
    var byLabel = {};
    var totalVisits = 0;
    all.forEach(function (it) {
      totalVisits += it.visits;
      if (!byLabel[it.label]) byLabel[it.label] = { name: it.label, ips: 0, visits: 0 };
      byLabel[it.label].ips += 1;
      byLabel[it.label].visits += it.visits;
    });
    var cities = Object.keys(byLabel).map(function (k) { return byLabel[k]; });
    cities.sort(function (a, b) { return b.ips - a.ips || b.visits - a.visits; });

    // 3. 明细：可按城市筛，最多回 500 条（列表本身已按访问次数降序）
    var picked = cityFilter ? all.filter(function (it) { return it.label === cityFilter; }) : all;
    out.ips = picked.slice(0, 500);

    var byIp = {};
    out.ips.forEach(function (it) { byIp[it.ip] = it; });

    // 4. 每个 IP 最近 3 条访问路径
    if (out.ips.length > 0) {
      var pathRows = await pg.query(
        "select ip, path, ts from (" +
          "  select ip, path, ts, row_number() over (partition by ip order by ts desc) as rn" +
          "  from visitor_logs" +
          "  where ip = any($1) and ts >= now() - (($2::int) || ' days')::interval" +
          ") t where t.rn <= 3 order by t.ip, t.ts desc",
        [out.ips.map(function (it) { return it.ip; }), ds]
      );
      (pathRows.rows || []).forEach(function (row) {
        var it = byIp[row.ip];
        if (it && it.paths.length < 3) {
          it.paths.push({ path: row.path || "/", time: row.ts ? new Date(row.ts).getTime() : 0 });
        }
      });
    }

    out.stats = {
      visits: totalVisits,
      ips: all.length,
      cities: cities.length,
      shown: out.ips.length,
    };
    out.cities = cities.slice(0, 60);
    return out;
  } catch (e) {
    console.warn("[visitor-log] uniqueIpStats failed:", e && e.message);
    return out;
  }
}

module.exports = {
  ensureTable: ensureTable,
  logVisit: logVisit,
  listRecent: listRecent,
  count: count,
  dailyStats: dailyStats,
  dayOverview: dayOverview,
  uniqueIpStats: uniqueIpStats,
};
