// lib/user-score.js — 用户「数据完善度」评分 + 缺口聚合榜
//
// ⚠️ 这不是「用户价值分」，而是「这个用户的数据是否被完整、可信地记录下来」的体检分。
//    用途：① 采集健康度（缺口榜 → 开发优先级）② 标杆样本（TOP5）③ 排查入口（点进时间线看断点）
//
// 两个关键设计（详见 docs/用户数据完善度评分与TOP榜单-方案.md）：
//   1) 历史数据的缺口补不了（老记录里本来就没有 deviceId / 渠道参数），所以必须按**时间窗口**看，
//      并且区分两种口径：active（窗口内有事件的设备）/ new（窗口内才首次出现的设备，默认）。
//   2) 事件级检查项（如"访问事件带不带 deviceId"）无法按设备归属，单独放 coverage 里，不混进 gaps。

var pg = require("./postgres");
var geoZh = require("./geo-zh");

// 埋点补齐日：窗口起点早于此日时分数天然偏低，UI 需提示
var SCORE_EPOCH = "2026-09-24";

// 权重集中在此，便于按分布调参
var WEIGHTS = {
  identity: { device: 10, deviceFull: 6, ip: 5, single: 4 },              // 25
  journey: { step: 8, seqPenalty: 4, seqPenaltyMax: 8 },                  // 40
  attribute: { model: 6, rom: 4, channel: 5, order: 5 },                  // 20
  geo: { region: 5, city: 5, district: 5 },                               // 15
};

var MAX_SCORE = 100;

function clampDays(d) {
  var n = parseInt(d, 10) || 7;
  if (n < 1) n = 1;
  if (n > 180) n = 180;
  return n;
}

function gradeOf(score) {
  if (score >= 85) return "A";
  if (score >= 65) return "B";
  if (score >= 40) return "C";
  return "D";
}

var GRADE_LABEL = { A: "全链路可追溯", B: "基本完整", C: "部分可追溯", D: "数据稀疏" };

function maskDevice(s) {
  var v = String(s || "");
  if (v.length <= 8) return v;
  return v.slice(0, 4) + "…" + v.slice(-4);
}

function parseDate(s) {
  if (!s) return 0;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDay(ts) {
  var d = new Date(ts + 8 * 3600 * 1000); // 北京时间展示
  return d.toISOString().slice(0, 10);
}

// --- 窗口解析 ------------------------------------------------------------

function resolveWindow(opts) {
  opts = opts || {};
  var fromTs = parseDate(opts.from);
  var toTs = parseDate(opts.to);
  if (fromTs && toTs) {
    return { fromTs: fromTs, toTs: toTs + 24 * 3600 * 1000 - 1, days: Math.max(1, Math.round((toTs - fromTs) / 86400000)) };
  }
  var days = clampDays(opts.days);
  var end = Date.now();
  return { fromTs: end - days * 86400000, toTs: end, days: days };
}

// --- 数据采集 ------------------------------------------------------------
//
// ⚠️ 性能约束：生产库单次查询 RTT ≈ 400ms（本地实测），Vercel 函数上限 10s。
//    所以**必须把查询压到最少**：把「当前窗口 + 上一等长窗口 + 覆盖率 + 顺序校验」全部
//    塞进**一条按 (窗口, 设备, 事件类型) 分组的 SQL**，返回后在内存里聚合。
//    （曾经拆成 10 条查询 → 实测 4~10 秒，有超时风险。）

var EVENTS_SQL = [
  "select",
  "  (ts >= to_timestamp($1 / 1000.0)) as is_cur,",
  "  device_full, kind,",
  "  min(ts) as first_ts, max(ts) as last_ts,",
  "  count(*)::int                                                  as n,",
  "  count(*) filter (where ip <> '')::int                          as with_ip,",
  "  count(*) filter (where channel <> '')::int                     as with_channel,",
  "  count(*) filter (where length(coalesce(payload->>'model','')) >= 3)::int as with_model,",
  "  max(nullif(ip, ''))                     as ip,",
  "  max(nullif(channel, ''))                as channel,",
  "  max(nullif(payload->>'model', ''))      as model,",
  "  max(nullif(payload->>'rom', ''))        as rom,",
  "  max(nullif(payload->>'user_name', ''))  as user_name,",
  "  max(nullif(payload->>'amount', ''))     as amount",
  "from tracking_events",
  "where ts >= to_timestamp($2 / 1000.0) and ts <= to_timestamp($3 / 1000.0)",
  "group by 1, 2, 3",
].join(" ");

function emptyDev(device) {
  return {
    device_full: device,
    has_visit: false, has_click: false, has_order: false,
    has_redeem: false, has_act: false, has_fail: false,
    ip: "", channel: "", model: "", rom: "", user_name: "", amount: "",
    devices: 1, events: 0, first_ts: 0, last_ts: 0, seq: {},
  };
}

function emptyCoverage() {
  return { total: 0, visit_total: 0, visit_device: 0, click_total: 0, click_device: 0, with_ip: 0, with_channel: 0, with_model: 0 };
}

// 把按 (窗口,设备,类型) 分组的结果在内存里聚合成「每个窗口的设备事实 + 覆盖率」
function fold(rows) {
  var out = {
    cur: { devs: {}, coverage: emptyCoverage() },
    prev: { devs: {}, coverage: emptyCoverage() },
  };
  rows.forEach(function (r) {
    var bucket = r.is_cur ? out.cur : out.prev;
    bucket.coverage.total += r.n;
    bucket.coverage.with_ip += r.with_ip;
    bucket.coverage.with_channel += r.with_channel;
    bucket.coverage.with_model += r.with_model;
    if (r.kind === "visit") {
      bucket.coverage.visit_total += r.n;
      if (r.device_full) bucket.coverage.visit_device += r.n;
    }
    if (r.kind === "go_click") {
      bucket.coverage.click_total += r.n;
      if (r.device_full) bucket.coverage.click_device += r.n;
    }
    if (!r.device_full) return;   // 无设备的记录只参与覆盖率统计，不进入设备行

    var d = bucket.devs[r.device_full];
    if (!d) { d = emptyDev(r.device_full); bucket.devs[r.device_full] = d; }
    d.events += r.n;
    var t0 = new Date(r.first_ts).getTime();
    var t1 = new Date(r.last_ts).getTime();
    if (!d.first_ts || t0 < d.first_ts) d.first_ts = t0;
    if (t1 > d.last_ts) d.last_ts = t1;

    if (r.kind === "visit" || r.kind === "go_click") d.has_visit = true;
    if (r.kind === "go_click" || r.kind === "purchase_click") d.has_click = true;
    if (r.kind === "order") d.has_order = true;
    if (r.kind === "redeem") d.has_redeem = true;
    if (r.kind === "activation") d.has_act = true;
    if (r.kind === "failure") d.has_fail = true;

    if (r.ip && !d.ip) d.ip = r.ip;
    if (r.channel && !d.channel) d.channel = r.channel;
    if (r.model && !d.model) d.model = r.model;
    if (r.rom && !d.rom) d.rom = r.rom;
    if (r.user_name && !d.user_name) d.user_name = r.user_name;
    if (r.amount && !d.amount) d.amount = r.amount;

    var k = (r.kind === "visit" || r.kind === "go_click" || r.kind === "purchase_click") ? "visitish" : r.kind;
    if (k !== "failure") {
      if (!d.seq[k] || t0 < d.seq[k]) d.seq[k] = t0;
    }
  });
  return out;
}

async function collect(win, prevWin) {
  var fromTs = prevWin ? prevWin.fromTs : win.fromTs;
  var rows = (await pg.query(EVENTS_SQL, [win.fromTs, fromTs, win.toTs]).catch(function (e) {
    console.warn("[user-score] events query failed:", e && e.message);
    return { rows: [] };
  })).rows || [];

  var folded = fold(rows);
  var curDevs = Object.keys(folded.cur.devs);
  var prevDevs = Object.keys(folded.prev.devs);
  var allDevs = Object.keys(folded.cur.devs).concat(Object.keys(folded.prev.devs));
  allDevs = allDevs.filter(function (v, i) { return allDevs.indexOf(v) === i; });

  // 首次出现时间（全表，不限窗口）→ 判定「新设备」；两个窗口共用一份
  var firstEver = {};
  if (allDevs.length) {
    var firstRows = (await pg.query(
      "select device_full, min(ts) as first_ever from tracking_events where device_full = any($1) group by device_full",
      [allDevs]
    ).catch(function () { return { rows: [] }; })).rows || [];
    firstRows.forEach(function (r) { firstEver[r.device_full] = new Date(r.first_ever).getTime(); });
  }

  // 归属地（两个窗口的 IP 一次查完）
  var geo = {};
  var ips = {};
  curDevs.concat(prevDevs).forEach(function (dev) {
    var d = folded.cur.devs[dev] || folded.prev.devs[dev];
    if (d && d.ip) ips[d.ip] = true;
  });
  var ipList = Object.keys(ips);
  if (ipList.length) {
    var gRows = (await pg.query(
      "select ip, country, region, region_zh, city, city_zh, district from ip_lookups where ip = any($1)",
      [ipList]
    ).catch(function () { return { rows: [] }; })).rows || [];
    gRows.forEach(function (g) { geo[g.ip] = g; });
  }

  return {
    cur: { rows: curDevs.map(function (d) { return folded.cur.devs[d]; }), coverage: folded.cur.coverage },
    prev: { rows: prevDevs.map(function (d) { return folded.prev.devs[d]; }), coverage: folded.prev.coverage },
    geo: geo, firstEver: firstEver,
  };
}

// --- 打分 ----------------------------------------------------------------

function scoreOne(row, ctx) {
  var miss = [];
  var id = 0;
  if (row.device_full) id += WEIGHTS.identity.device; else miss.push("device");
  if (String(row.device_full).length > 4) id += WEIGHTS.identity.deviceFull; else miss.push("deviceFull");
  if (row.ip) id += WEIGHTS.identity.ip; else miss.push("ip");
  if (Number(row.devices) <= 1) id += WEIGHTS.identity.single; else miss.push("multiDevice");

  var jr = 0;
  var steps = [];
  var stepDef = [
    ["has_visit", "访问"],
    ["has_click", "购买点击"],
    ["has_order", "支付订单"],
    ["has_redeem", "发放兑换码"],
    ["has_act", "激活成功"],
  ];
  stepDef.forEach(function (s) {
    var ok = Boolean(row[s[0]]);
    steps.push({ key: s[0], label: s[1], ok: ok });
    if (ok) jr += WEIGHTS.journey.step;
    else miss.push(s[0]);
  });

  // 顺序校验：visitish ≤ order ≤ redeem ≤ activation（seq 由 fold() 挂在设备行上）
  var seq = row.seq || {};
  var chain = [["visitish", "访问"], ["order", "支付"], ["redeem", "发码"], ["activation", "激活"]]
    .filter(function (c) { return seq[c[0]]; });
  var violations = 0;
  for (var i = 1; i < chain.length; i++) {
    if (seq[chain[i][0]] < seq[chain[i - 1][0]]) violations++;
  }
  var penalty = Math.min(violations * WEIGHTS.journey.seqPenalty, WEIGHTS.journey.seqPenaltyMax);
  jr -= penalty;
  if (violations) miss.push("seqOrder");

  var at = 0;
  var model = String(row.model || "");
  if (model.length >= 3) at += WEIGHTS.attribute.model; else miss.push("model");
  if (row.rom) at += WEIGHTS.attribute.rom; else miss.push("rom");
  if (row.channel) at += WEIGHTS.attribute.channel; else miss.push("channel");
  if (row.user_name || row.amount) at += WEIGHTS.attribute.order; else miss.push("orderInfo");

  var g = (ctx.geo && ctx.geo[row.ip]) || {};
  var pair = geoZh.resolveDisplayGeo({
    region_zh: g.region_zh, city_zh: g.city_zh,
    region: g.region, city: g.city,
    raw_region: "", raw_city: "", country: g.country,
  });
  var region = pair.region || "";
  var city = pair.city || "";
  var district = String(g.district || "").trim();
  var geoScore = 0;
  if (region) geoScore += WEIGHTS.geo.region; else miss.push("region");
  if (city) geoScore += WEIGHTS.geo.city; else miss.push("city");
  if (district) geoScore += WEIGHTS.geo.district; else miss.push("district");

  var score = Math.max(0, Math.min(MAX_SCORE, id + jr + at + geoScore));
  return {
    device_full: row.device_full,   // ⚠️ 必须带出来：leaderboard 靠它渲染掩码与「详情」跳转
    score: score,
    grade: gradeOf(score),
    dims: { identity: id, journey: jr, attribute: at, geo: geoScore },
    steps: steps,
    violations: violations,
    missing: miss,
    model: model,
    rom: String(row.rom || ""),
    channel: String(row.channel || ""),
    region: region,
    city: city,
    district: district,
    ip: row.ip || "",
    events: Number(row.events) || 0,
    firstTs: row.first_ts ? new Date(row.first_ts).getTime() : 0,
    lastTs: row.last_ts ? new Date(row.last_ts).getTime() : 0,
    isNew: ctx.firstEver[row.device_full] >= ctx.fromTs,
    emulator: /emulator/i.test(model),
  };
}

// --- 缺口聚合（设备口径）-------------------------------------------------

function buildGaps(items, total) {
  return Object.keys(items).map(function (k) {
    var it = items[k];
    var pct = total > 0 ? Number((it.miss / total).toFixed(4)) : null;
    return { key: k, label: it.label, miss: it.miss, total: total, pct: pct };
  }).sort(function (a, b) { return (b.pct || 0) - (a.pct || 0); });
}

// 注意：这里只放**设备口径**的缺口。像「访问事件带不带 deviceId」这种无法归属到设备的检查项，
// 放在 coverage（事件口径）里 —— 因为按 device_full 聚合时，没有 deviceId 的事件根本不会出现在这些行里。
//
// ⚠️ key 必须与 scoreOne() 往 missing 里推的值**逐字一致**（曾经写成 no_click 而打分推 has_click，
//    结果缺口榜全 0，属于静默失配，改这里务必同步检查 scoreOne）。
var GAP_DEFS = [
  ["has_visit", "缺访问记录（带 deviceId 的 visit / go_click）"],
  ["has_click", "缺购买点击记录"],
  ["has_order", "缺支付订单"],
  ["has_redeem", "缺兑换码记录"],
  ["has_act", "缺激活成功"],
  ["ip", "缺 IP"],
  ["channel", "缺渠道参数"],
  ["model", "缺机型"],
  ["rom", "缺 App / ROM 版本号"],
  ["region", "缺省份"],
  ["city", "缺城市"],
  ["district", "缺区县"],
  ["orderInfo", "缺订单侧信息（昵称 / 金额）"],
  ["seqOrder", "时间顺序异常"],
];

// 缺失项 key → 人话标签（前端「主要缺口」列用，避免出现 has_visit 这种内部 key）
// ⚠️ 必须在 GAP_DEFS 之后构建（var 会提升，放前面会拿到 undefined）
var MISSING_LABELS = {
  device: "无设备标识",
  deviceFull: "设备标识被截断为 4 位",
  multiDevice: "存在多个设备标识",
};
GAP_DEFS.forEach(function (d) { MISSING_LABELS[d[0]] = d[1]; });

function gapsOf(scored) {
  var items = {};
  GAP_DEFS.forEach(function (d) { items[d[0]] = { label: d[1], miss: 0 }; });
  scored.forEach(function (s) {
    s.missing.forEach(function (m) {
      if (items[m]) items[m].miss++;
    });
  });
  return buildGaps(items, scored.length);
}

function matchPct(list, key) {
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].pct;
  return null;
}

function withTrend(cur, prev) {
  return cur.map(function (g) {
    var p = matchPct(prev, g.key);
    g.prevPct = p;
    g.delta = (p === null || g.pct === null) ? null : Number((g.pct - p).toFixed(4));
    g.trend = g.delta === null ? "na" : (g.delta < -0.005 ? "down" : (g.delta > 0.005 ? "up" : "flat"));
    return g;
  });
}

// --- 事件口径覆盖率 ------------------------------------------------------

function coverageOf(c, p) {
  function rate(a, b) { return b > 0 ? Number((a / b).toFixed(4)) : null; }
  function one(label, cur, prev) {
    var r = { label: label, miss: cur[0], total: cur[1], pct: rate(cur[0], cur[1]) };
    var pp = prev ? rate(prev[0], prev[1]) : null;
    r.prevPct = pp;
    r.delta = (pp === null || r.pct === null) ? null : Number((r.pct - pp).toFixed(4));
    r.trend = r.delta === null ? "na" : (r.delta < -0.005 ? "down" : (r.delta > 0.005 ? "up" : "flat"));
    return r;
  }
  function missOf(total, ok) { return Math.max(0, (total || 0) - (ok || 0)); }
  var cur = [
    one("访问事件缺 deviceId（事件口径）", [missOf(c.visit_total, c.visit_device), c.visit_total],
      p ? [missOf(p.visit_total, p.visit_device), p.visit_total] : null),
    one("短链点击缺 deviceId（事件口径）", [missOf(c.click_total, c.click_device), c.click_total],
      p ? [missOf(p.click_total, p.click_device), p.click_total] : null),
    one("事件缺 IP", [missOf(c.total, c.with_ip), c.total], p ? [missOf(p.total, p.with_ip), p.total] : null),
    one("事件缺渠道参数", [missOf(c.total, c.with_channel), c.total], p ? [missOf(p.total, p.with_channel), p.total] : null),
    one("事件缺机型", [missOf(c.total, c.with_model), c.total], p ? [missOf(p.total, p.with_model), p.total] : null),
  ];
  return cur;
}

// --- 主入口 --------------------------------------------------------------

// 进程内缓存：同一个窗口 + 口径的重复请求（面板反复刷新、漏斗/画像/评分同时拉）直接复用，
// 避免每次都付 3 次数据库往返。TTL 60s，数据新鲜度足够。
var CACHE_TTL_MS = 60 * 1000;
var cacheMap = {};

async function analyze(opts) {
  opts = opts || {};
  var cacheKey = [opts.days, opts.from || "", opts.to || "", opts.scope || "", opts.limit || 5, opts.compare !== false].join("|");
  var hit = cacheMap[cacheKey];
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

  var win = resolveWindow(opts);
  var limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 20);
  var scope = opts.scope === "active" ? "active" : "new";
  var doCompare = opts.compare !== false;

  var spanMs = win.toTs - win.fromTs;
  var prevWin = { fromTs: win.fromTs - spanMs - 1, toTs: win.fromTs - 1, days: win.days };

  // 3 条查询搞定：事件分组（含两个窗口 + 覆盖率）、首次出现时间、归属地
  var data = await collect(win, doCompare ? prevWin : null);

  var scored = data.cur.rows.map(function (r) {
    return scoreOne(r, { geo: data.geo, firstEver: data.firstEver, fromTs: win.fromTs });
  });

  var prevScored = doCompare ? data.prev.rows.map(function (r) {
    return scoreOne(r, { geo: data.geo, firstEver: data.firstEver, fromTs: prevWin.fromTs });
  }) : [];

  var curCoverage = data.cur.coverage;
  var prevCoverage = doCompare ? data.prev.coverage : null;
  var prevGapsNew = doCompare ? gapsOf(prevScored.filter(function (s) { return s.isNew; })) : [];
  var prevGapsAll = doCompare ? gapsOf(prevScored) : [];

  var byScope = {
    active: scored,
    new: scored.filter(function (s) { return s.isNew; }),
  };

  // TOP 榜（默认看 active：榜单要展示标杆）
  var lbScope = opts.scope === "new" ? "new" : "active";
  var pool = byScope[lbScope].filter(function (s) { return s.steps.some(function (x) { return x.key === "has_order" || x.key === "has_act"; }); });
  pool.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.dims.journey !== a.dims.journey) return b.dims.journey - a.dims.journey;
    if (b.dims.identity !== a.dims.identity) return b.dims.identity - a.dims.identity;
    if (b.events !== a.events) return b.events - a.events;
    return b.lastTs - a.lastTs;
  });
  var leaderboard = pool.slice(0, limit).map(function (s, i) {
    return {
      rank: i + 1, device: s.device_full, deviceMasked: maskDevice(s.device_full),
      score: s.score, grade: s.grade, gradeLabel: GRADE_LABEL[s.grade],
      dims: s.dims, steps: s.steps, missing: s.missing,
      missingLabels: s.missing.map(function (k) { return MISSING_LABELS[k] || k; }),
      // 长度 < 3 的机型（如 "ap"）是垃圾值，统一按「未上报」处理（与 portrait 口径一致）
      model: s.model.length >= 3 ? s.model : "",
      rom: s.rom, channel: s.channel,
      region: s.region, city: s.city, district: s.district,
      events: s.events, lastTs: s.lastTs, emulator: s.emulator,
    };
  });

  var gapsNew = gapsOf(byScope.new);
  var gapsAll = gapsOf(byScope.active);

  var scores = byScope.active.map(function (s) { return s.score; });
  var avg = scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : 0;
  var byGrade = { A: 0, B: 0, C: 0, D: 0 };
  byScope.active.forEach(function (s) { byGrade[s.grade]++; });

  var epochWarning = win.fromTs < parseDate(SCORE_EPOCH);

  var report = {
    success: true,
    window: {
      from: fmtDay(win.fromTs), to: fmtDay(win.toTs), days: win.days,
      epoch: SCORE_EPOCH, epochWarning: epochWarning,
    },
    scope: lbScope,
    weights: WEIGHTS,
    leaderboard: leaderboard,
    summary: {
      devices: byScope.active.length,
      newDevices: byScope.new.length,
      avgScore: avg,
      byGrade: byGrade,
    },
    gaps: {
      scope: scope,
      sample: byScope[scope].length,
      lowSample: byScope[scope].length > 0 && byScope[scope].length < 10,
      items: scope === "new"
        ? withTrend(gapsNew, prevGapsNew || [])
        : withTrend(gapsAll, prevGapsAll || []),
    },
    gapsAllScope: { sample: byScope.active.length, items: withTrend(gapsAll, prevGapsAll || []) },
    coverage: coverageOf(curCoverage, prevCoverage),
  };

  // 缓存条数上限保护（避免不同参数组合无限增长）
  var keys = Object.keys(cacheMap);
  if (keys.length > 40) cacheMap = {};
  cacheMap[cacheKey] = { t: Date.now(), v: report };
  return report;
}

// 单设备评分（「用户画像」页看这个人自己的得分）。
// 一台设备的事件通常只有几十条 → 一次查询把该设备全部事件拉回来，在内存里切窗口 + 算 firstEver，
// 再配一次 ip_lookups（共 2 次查询）。不走 analyze()，避免为一个人拉全库。
async function scoreDevice(deviceFull, days) {
  var dev = String(deviceFull || "").trim();
  if (!dev) return { success: false, error: "缺少 deviceId" };
  days = clampDays(days || 30);
  var toTs = Date.now();
  var fromTs = toTs - days * 86400000;

  var rows = (await pg.query(
    "select ts, kind, ip, channel, payload, device_full from tracking_events where device_full = $1 order by ts asc",
    [dev]
  ).catch(function (e) {
    console.warn("[user-score] scoreDevice query failed:", e && e.message);
    return { rows: [] };
  })).rows || [];

  // 全部事件（不限窗口）→ 计算窗口内事实 + firstEver（isNew 判定）
  var facts = emptyDev(dev);
  var cover = emptyCoverage();
  var firstEverTs = 0;
  rows.forEach(function (r) {
    var t = new Date(r.ts).getTime();
    if (!firstEverTs || t < firstEverTs) firstEverTs = t;
    if (t < fromTs || t > toTs) return;
    var one = fold([{
      is_cur: true, device_full: r.device_full, kind: r.kind,
      first_ts: r.ts, last_ts: r.ts, n: 1,
      with_ip: r.ip ? 1 : 0, with_channel: r.channel ? 1 : 0,
      with_model: (String((r.payload || {}).model || "").length >= 3) ? 1 : 0,
      ip: r.ip, channel: r.channel,
      model: (r.payload || {}).model, rom: (r.payload || {}).rom,
      user_name: (r.payload || {}).user_name, amount: (r.payload || {}).amount,
    }]);
    var d = one.cur.devs[dev];
    if (d) {
      var target = facts;
      target.events += 1;
      if (!target.first_ts || t < target.first_ts) target.first_ts = t;
      if (t > target.last_ts) target.last_ts = t;
      ["has_visit", "has_click", "has_order", "has_redeem", "has_act", "has_fail"].forEach(function (k) { if (d[k]) target[k] = true; });
      if (d.ip && !target.ip) target.ip = d.ip;
      if (d.channel && !target.channel) target.channel = d.channel;
      if (d.model && !target.model) target.model = d.model;
      if (d.rom && !target.rom) target.rom = d.rom;
      if (d.user_name && !target.user_name) target.user_name = d.user_name;
      if (d.amount && !target.amount) target.amount = d.amount;
      Object.keys(d.seq || {}).forEach(function (k) {
        if (!target.seq[k] || d.seq[k] < target.seq[k]) target.seq[k] = d.seq[k];
      });
    }
    cover.total += 1;
    if (r.ip) cover.with_ip += 1;
    if (r.channel) cover.with_channel += 1;
  });

  var geo = {};
  if (facts.ip) {
    var gRows = (await pg.query(
      "select ip, country, region, region_zh, city, city_zh, district from ip_lookups where ip = $1",
      [facts.ip]
    ).catch(function () { return { rows: [] }; })).rows || [];
    if (gRows[0]) geo[facts.ip] = gRows[0];
  }

  var s = scoreOne(facts, { geo: geo, firstEver: {}, fromTs: fromTs });
  return {
    success: true,
    device: dev,
    window: { from: fmtDay(fromTs), to: fmtDay(toTs), days: days, epoch: SCORE_EPOCH, epochWarning: fromTs < parseDate(SCORE_EPOCH) },
    events: facts.events,
    score: s.score,
    grade: s.grade,
    gradeLabel: GRADE_LABEL[s.grade],
    dims: s.dims,
    steps: s.steps,
    violations: s.violations,
    missing: s.missing,
    missingLabels: s.missing.map(function (k) { return MISSING_LABELS[k] || k; }),
    model: s.model.length >= 3 ? s.model : "",
    rom: s.rom,
    channel: s.channel,
    region: s.region,
    city: s.city,
    district: s.district,
    weights: WEIGHTS,
    maxScore: MAX_SCORE,
  };
}

module.exports = {
  analyze: analyze,
  scoreDevice: scoreDevice,
  SCORE_EPOCH: SCORE_EPOCH,
  WEIGHTS: WEIGHTS,
  GRADE_LABEL: GRADE_LABEL,
};
