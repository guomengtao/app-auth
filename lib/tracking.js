// lib/tracking.js — 统一事件流 tracking_events（全链路追踪 / 漏斗 / 画像汇总的地基）
//
// 为什么需要它：业务主数据分散在 Redis 单 key（afdian:order:* / auth:redeem:* / auth:activation:*）
// 和 Postgres（visitor_logs / message_delivery / ip_lookups）里，想算「漏斗」「画像分布」就必须全量扫 key，
// 冷启动下一次champs超过万条就不可用了。这里把关键节点**镜像**一份到一张窄表，按 device / ip / code 建索引。
//
// 设计约定：
//   1. 只做**追加写**（insert ... on conflict do nothing），不修改原有 Redis / visitor_logs 逻辑；
//   2. 调用方统一用 background.run(track.record(...))，失败只打日志，绝不影响主流程；
//   3. dedupe_key 保证回填幂等（历史数据可反复同步不会产生重复行）。

var pg = require("./postgres");
var validate = require("./validate");
var redis = require("./redis");

// 全扫 Redis 集合时的批量大小与上限（Redis 是 Postgres 代理，全扫很贵，必须限流）
var BATCH = 200;
var MAX_SCAN = 4000;

var ensurePromise = null;

var CREATE_SQL = [
  "create table if not exists tracking_events (",
  "  id bigserial primary key,",
  "  ts timestamptz not null,",
  "  kind varchar(32) not null,",
  "  canonical_id varchar(64) not null default '',",
  "  device_full varchar(128) not null default '',",
  "  device_norm varchar(4) not null default '',",
  "  visitor_hash varchar(32) not null default '',",
  "  ip varchar(45) not null default '',",
  "  redeem_code varchar(8) not null default '',",
  "  out_trade_no varchar(64) not null default '',",
  "  activation_code varchar(32) not null default '',",
  "  channel varchar(32) not null default '',",
  "  payload jsonb,",
  "  dedupe_key varchar(160),",
  "  created_at timestamptz not null default now()",
  ")",
].join(" ");

function ensureTable() {
  if (!ensurePromise) {
    ensurePromise = (async function () {
      await pg.query(CREATE_SQL);
      await pg.query("create index if not exists idx_te_ts on tracking_events(ts desc)");
      await pg.query("create index if not exists idx_te_kind_ts on tracking_events(kind, ts desc)");
      await pg.query("create index if not exists idx_te_device on tracking_events(device_full)");
      await pg.query("create index if not exists idx_te_ip on tracking_events(ip)");
      await pg.query("create index if not exists idx_te_redeem on tracking_events(redeem_code)");
      await pg.query("create index if not exists idx_te_order on tracking_events(out_trade_no)");
      // ⚠️ 必须是**普通**唯一索引，不能带 `where dedupe_key is not null`：
      //    ON CONFLICT (dedupe_key) 无法推断部分索引（会直接报
      //    "there is no unique or exclusion constraint matching the ON CONFLICT specification"）。
      //    PostgreSQL 的唯一索引把 NULL 视为互不相等，所以 dedupe_key 为空的实时事件依然可以随便插。
      await pg.query("drop index if exists idx_te_dedupe"); // 清掉早期建错的部分索引
      await pg.query("create unique index if not exists idx_te_dedupe_uq on tracking_events(dedupe_key)");
      console.log("[tracking] table ready");
    })().catch(function (e) {
      console.warn("[tracking] ensure table failed:", e && e.message);
      ensurePromise = null;
      throw e;
    });
  }
  return ensurePromise;
}

function alnum(s) { return String(s || "").replace(/[^0-9A-Za-z]/g, ""); }

// 机型取值：激活 URL 里 `m`（model）经常是 "ap" 这种垃圾值，真正的机型在 `p`（product，
// 如 "REDMI Watch 6"）。规则：长度 ≥ 3 才算有效，两者都有效时取更长的那个。
function pickModel(model, product) {
  var m = String(model || "").trim();
  var p = String(product || "").trim();
  var best = "";
  if (p.length >= 3) best = p;
  if (m.length >= 3 && (!best || m.length > p.length)) best = m;
  return best;
}

function isPrivateOrInvalid(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "unknown") return true;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) return true;
  return false;
}

// 统一入口：把一个业务事件镜像进 tracking_events
// ev = { ts, kind, ip, visitorHash, deviceId(full), redeemCode, outTradeNo, activationCode, channel, payload, dedupeKey }
async function record(ev) {
  ev = ev || {};
  try {
    await ensureTable();
    var deviceFull = String(ev.deviceId || "").trim();
    var ts = Number(ev.ts) || Date.now();
    await pg.query(
      "insert into tracking_events " +
        "(ts, kind, device_full, device_norm, visitor_hash, ip, redeem_code, out_trade_no, activation_code, channel, payload, dedupe_key) " +
        "values (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) " +
        "on conflict (dedupe_key) do nothing",
      [
        ts,
        String(ev.kind || "unknown").slice(0, 32),
        deviceFull.slice(0, 128),
        validate.normalizeDeviceId(deviceFull),
        String(ev.visitorHash || "").slice(0, 32),
        String(ev.ip || "").slice(0, 45),
        String(ev.redeemCode || "").slice(0, 8),
        String(ev.outTradeNo || "").slice(0, 64),
        String(ev.activationCode || "").slice(0, 32),
        String(ev.channel || "").slice(0, 32),
        JSON.stringify(ev.payload || null),
        ev.dedupeKey ? String(ev.dedupeKey).slice(0, 160) : null,
      ]
    );
    return true;
  } catch (e) {
    console.warn("[tracking] record failed:", e && e.message);
    return false;
  }
}

// 批量写（回填用）：单条 INSERT 一条记录太慢（几千条要几分钟，会撞函数超时），
// 这里每 200 条拼成一条 multi-row insert。dedupe_key 冲突的行会被忽略。
async function recordMany(list) {
  if (!list || !list.length) return 0;
  await ensureTable();
  var CHUNK = 200;
  var COLS = "(ts, kind, device_full, device_norm, visitor_hash, ip, redeem_code, out_trade_no, activation_code, channel, payload, dedupe_key)";
  var written = 0;
  for (var s = 0; s < list.length; s += CHUNK) {
    var chunk = list.slice(s, s + CHUNK);
    var tuples = [];
    var params = [];
    chunk.forEach(function (ev) {
      var i = params.length;
      tuples.push(
        "(to_timestamp($" + (i + 1) + "/1000.0), $" + (i + 2) + ", $" + (i + 3) + ", $" + (i + 4) + ", $" +
        (i + 5) + ", $" + (i + 6) + ", $" + (i + 7) + ", $" + (i + 8) + ", $" + (i + 9) + ", $" +
        (i + 10) + ", $" + (i + 11) + "::jsonb, $" + (i + 12) + ")"
      );
      var deviceFull = String(ev.deviceId || "").trim();
      params.push(
        Number(ev.ts) || Date.now(),
        String(ev.kind || "unknown").slice(0, 32),
        deviceFull.slice(0, 128),
        validate.normalizeDeviceId(deviceFull),
        String(ev.visitorHash || "").slice(0, 32),
        String(ev.ip || "").slice(0, 45),
        String(ev.redeemCode || "").slice(0, 8),
        String(ev.outTradeNo || "").slice(0, 64),
        String(ev.activationCode || "").slice(0, 32),
        String(ev.channel || "").slice(0, 32),
        JSON.stringify(ev.payload || null),
        ev.dedupeKey ? String(ev.dedupeKey).slice(0, 160) : null
      );
    });
    try {
      var r = await pg.query(
        "insert into tracking_events " + COLS + " values " + tuples.join(",") +
          " on conflict (dedupe_key) do nothing returning id",
        params
      );
      written += (r.rows || []).length;
    } catch (e) {
      console.warn("[tracking] recordMany chunk failed:", e && e.message);
    }
  }
  return written;
}

// 身份富化：**订单 / 兑换码事件本身不带设备**（爱发电是服务端回调，没有买家 IP/deviceId），
// 但激活事件带 device_full —— 用 redeem_code 把设备反查回订单，漏斗的「访问→支付」才有样本。
// ⚠️ 只补 device，**不补 ip**：订单的 ip 一旦填成激活 IP，「购买 IP ≠ 激活 IP」这条冲突告警就永远触发不了。
async function enrichIdentityCore() {
  var r1 = await pg.query(
    "update tracking_events o set device_full = a.device_full, device_norm = a.device_norm " +
      "from (select redeem_code, max(device_full) as device_full, max(device_norm) as device_norm " +
      "      from tracking_events where kind = 'activation' and redeem_code <> '' and device_full <> '' " +
      "      group by redeem_code) a " +
      "where o.kind = 'order' and o.device_full = '' and o.redeem_code = a.redeem_code"
  );
  var r2 = await pg.query(
    "update tracking_events o set device_full = a.device_full, device_norm = a.device_norm " +
      "from (select redeem_code, max(device_full) as device_full, max(device_norm) as device_norm " +
      "      from tracking_events where kind = 'activation' and redeem_code <> '' and device_full <> '' " +
      "      group by redeem_code) a " +
      "where o.kind = 'redeem' and o.device_full = '' and o.redeem_code = a.redeem_code"
  );
  // 兑换码事件补订单号（历史数据里 auth:redeem:<code> 有些没记 out_trade_no）
  var r3 = await pg.query(
    "update tracking_events r set out_trade_no = o.out_trade_no " +
      "from tracking_events o " +
      "where r.kind = 'redeem' and r.out_trade_no = '' and o.kind = 'order' " +
      "  and o.out_trade_no <> '' and o.redeem_code = r.redeem_code"
  );
  return {
    ordersEnriched: (r1.rowCount || 0),
    redeemsEnriched: (r2.rowCount || 0),
    redeemOrdersLinked: (r3.rowCount || 0),
  };
}

// 机型回填：历史事件里 payload.model 存的是 `m=ap` 这种垃圾值，而真正的机型在激活记录的
// device_info.product（"REDMI Watch 6"）。这里从 auth:activation_codes 反查一遍并修正。
async function enrichModels() {
  var members = await redis.smembers("auth:activation_codes").catch(function () { return []; });
  if (!members || !members.length) return 0;
  if (members.length > 4000) members = members.slice(-4000);

  var map = {};   // device_full → { model, product }
  for (var i = 0; i < members.length; i += BATCH) {
    var batch = members.slice(i, i + BATCH);
    var vals = await redis.mget(batch.map(function (m) { return "auth:activation:" + m; })).catch(function () { return []; });
    for (var j = 0; j < batch.length; j++) {
      var rec = null;
      try { rec = typeof vals[j] === "string" ? JSON.parse(vals[j]) : vals[j]; } catch (e) {}
      if (!rec) continue;
      var dev = String(rec.device_id_full || rec.device_id || "").trim();
      if (!dev) continue;
      var di = rec.device_info || {};
      var best = pickModel(di.model, di.product);
      if (!best) continue;
      if (!map[dev] || best.length > String(map[dev].model || "").length) {
        map[dev] = { model: best, product: String(di.product || "").trim() };
      }
    }
  }

  var keys = Object.keys(map);
  if (!keys.length) return 0;
  var fixed = 0;
  for (var s = 0; s < keys.length; s += BATCH) {
    var chunk = keys.slice(s, s + BATCH);
    var tuples = [];
    var params = [];
    chunk.forEach(function (dev) {
      var n = params.length;
      tuples.push("($" + (n + 1) + "::text, $" + (n + 2) + "::text, $" + (n + 3) + "::text)");
      params.push(dev, map[dev].model, map[dev].product);
    });
    try {
      var r = await pg.query(
        "update tracking_events t " +
          "set payload = jsonb_set(jsonb_set(coalesce(t.payload, '{}'::jsonb), '{model}', to_jsonb(v.model)), '{product}', to_jsonb(v.product)) " +
          "from (values " + tuples.join(",") + ") as v(device_full, model, product) " +
          "where t.device_full = v.device_full " +
          "  and (coalesce(t.payload->>'model', '') = '' or length(coalesce(t.payload->>'model', '')) < 3)",
        params
      );
      fixed += (r.rowCount || 0);
    } catch (e) {
      console.warn("[tracking] enrichModels chunk failed:", e && e.message);
    }
  }
  return fixed;
}

// 机型回填要扫全部激活记录，比较贵（本地实测可达数十秒，生产同区通常几百毫秒）→
// 放后台执行（waitUntil），绝不阻塞读接口；独立 10 分钟节流，避免反复扫。
var lastModelEnrich = 0;
function enrichModelsInBackground(force) {
  if (!force && Date.now() - lastModelEnrich < 10 * 60 * 1000) return;
  lastModelEnrich = Date.now();
  try {
    require("./background").run(enrichModels(), "enrich-models");
  } catch (e) {
    enrichModels().catch(function () {});
  }
}

var lastEnrich = 0;
async function enrichIdentity(force) {
  if (!force && Date.now() - lastEnrich < 5 * 60 * 1000) return null;
  lastEnrich = Date.now();
  enrichModelsInBackground(force);
  try {
    return await enrichIdentityCore();
  } catch (e) {
    console.warn("[tracking] enrichIdentity failed:", e && e.message);
    return null;
  }
}

// --- 画像 / 漏斗查询 ------------------------------------------------------

function clampDays(d) {
  var n = parseInt(d, 10) || 30;
  if (n < 1) n = 1;
  if (n > 180) n = 180;
  return n;
}

function median(arr) {
  var a = (arr || []).filter(function (x) { return typeof x === "number" && isFinite(x) && x >= 0; }).sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  var mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

// 漏斗：一次性把窗口内的相关行拉到内存算（管理后台低频使用，量可控）
async function funnel(days) {
  days = clampDays(days);
  await ensureTable();
  await enrichIdentity(false);   // 补齐「订单 → 设备」（5 分钟节流），否则「访问→支付」永远没样本
  var r = await pg.query(
    "select kind, ts, device_full, visitor_hash, ip, redeem_code, out_trade_no, activation_code, channel " +
      "from tracking_events where ts >= now() - (($1::int) || ' days')::interval " +
      "order by ts asc limit 20000",
    [String(days)]
  );
  var rows = r.rows || [];
  var tsOf = function (v) { var d = new Date(v); return d.getTime(); };

  var step = {
    purchase_click: new Set(),
    order: new Set(),
    redeem: new Set(),
    activation: new Set(),
  };
  var visitSet = new Set();   // visit 与 go_click 用并集，避免同一访客被计两次
  var clickSet = new Set();   // go_click（短链落地）与 purchase_click（点击事件）是同一个动作的两条记录
  rows.forEach(function (row) {
    var key = String(row.visitor_hash || row.ip || "");
    if (row.kind === "order") step.order.add(row.out_trade_no);
    else if (row.kind === "redeem") step.redeem.add(row.redeem_code);
    else if (row.kind === "activation") step.activation.add(row.activation_code || row.device_full);
    else if (row.kind === "purchase_click" || row.kind === "go_click") clickSet.add(key);
    if (row.kind === "visit" || row.kind === "go_click") visitSet.add(key);
  });

  // 分阶段耗时：以「订单」为锚把前后事件串起来
  var orders = rows.filter(function (x) { return x.kind === "order"; });
  var visitsByIp = {};
  var visitsByDevice = {};
  rows.forEach(function (x) {
    if (x.kind !== "visit" && x.kind !== "go_click") return;
    var t = tsOf(x.ts);
    if (x.ip && (!visitsByIp[x.ip] || t > visitsByIp[x.ip])) visitsByIp[x.ip] = t;
    if (x.device_full && (!visitsByDevice[x.device_full] || t > visitsByDevice[x.device_full])) visitsByDevice[x.device_full] = t;
  });
  var redeemByCode = {};
  rows.forEach(function (x) { if (x.kind === "redeem" && x.redeem_code && !redeemByCode[x.redeem_code]) redeemByCode[x.redeem_code] = tsOf(x.ts); });
  var actByCode = {};
  rows.forEach(function (x) { if (x.kind === "activation" && x.redeem_code && !actByCode[x.redeem_code]) actByCode[x.redeem_code] = tsOf(x.ts); });

  var dVisitOrder = [];
  var dOrderRedeem = [];
  var dRedeemAct = [];
  orders.forEach(function (o) {
    var ot = tsOf(o.ts);
    var vt = visitsByDevice[o.device_full] || (o.ip ? visitsByIp[o.ip] : 0);
    if (vt && ot >= vt && ot - vt <= 24 * 3600 * 1000) dVisitOrder.push(ot - vt);
    var rt = redeemByCode[o.redeem_code];
    if (rt && rt >= ot) dOrderRedeem.push(rt - ot);
    var at = actByCode[o.redeem_code];
    if (at && rt && at >= rt) dRedeemAct.push(at - rt);
  });

  var stages = [
    { key: "visit", label: "访问（独立访客）", value: visitSet.size, rate: null },
    { key: "purchase_click", label: "购买点击（短链）", value: clickSet.size },
    { key: "order", label: "支付订单", value: step.order.size },
    { key: "redeem", label: "发放兑换码", value: step.redeem.size },
    { key: "activation", label: "激活成功", value: step.activation.size },
  ];
  for (var i = 1; i < stages.length; i++) {
    var prev = stages[i - 1].value;
    stages[i].rate = prev > 0 ? Number((stages[i].value / prev).toFixed(4)) : null;
    // 某一步比上一步还多，说明这一步还有「不经过上一步」的来源（不是数据错误）
    if (stages[i].rate !== null && stages[i].rate > 1) {
      if (stages[i].key === "redeem") {
        stages[i].rateNote = "兑换码数量多于订单：因为「后台直开的兑换码」不经过订单环节，属于正常现象";
      } else if (stages[i].key === "order") {
        stages[i].rateNote = "订单多于短链点击：用户可能直接到爱发电付款（没走 /go/ 短链），或短链点击记录缺失";
      } else {
        stages[i].rateNote = "该步数量大于上一步，说明该步还包含不经过上一步的来源";
      }
    }
  }

  var notes = [];
  if (dVisitOrder.length === 0) {
    notes.push("「访问 → 支付」暂无样本：订单事件必须有设备或 IP 才能和访问对上，而历史订单是服务端回调（没有买家 IP/deviceId）、历史访问也没记录 URL 参数（visitor_logs.params 是 2026-09-24 才加的）。新产生的数据会自动带上，无需干预。");
  }
  if (clickSet.size === 0 && step.order.size > 0) {
    notes.push("「购买点击」为 0：短链点击事件只从 2026-09-24 起开始记录（之前 /go/ 只写 visitor_logs，且没有 params）。");
  }

  return {
    success: true,
    days: days,
    stages: stages,
    notes: notes,
    durations: {
      visitToOrderMs: median(dVisitOrder),
      orderToRedeemMs: median(dOrderRedeem),
      redeemToActivationMs: median(dRedeemAct),
      samples: { visitToOrder: dVisitOrder.length, orderToRedeem: dOrderRedeem.length, redeemToActivation: dRedeemAct.length },
    },
  };
}

// 画像汇总：设备 / 地区 / 渠道 / 生命周期分布
async function portrait(days) {
  days = clampDays(days);
  await ensureTable();
  await enrichIdentity(false);
  var win = "now() - (($1::int) || ' days')::interval";

  // 设备：以 activation 事件的 payload->>'model' 为准
  // 机型：URL 参数里 m/p 经常缺失或被报成 "ap" 这类短串 → 长度 < 3 一律归为「未上报机型」，
  // 否则会出现「×46」这种没有名字的行
  var devRows = (await pg.query(
    "select case when length(coalesce(nullif(payload->>'model',''), '')) >= 3 then payload->>'model' " +
      "            else '(未上报机型)' end as model, " +
      "       count(distinct device_full)::int as devices " +
      "from tracking_events where kind = 'activation' and ts >= " + win + " and device_full <> '' " +
      "group by 1 order by 2 desc limit 20",
    [String(days)]
  ).catch(function () { return { rows: [] }; })).rows || [];

  var chRows = (await pg.query(
    "select coalesce(nullif(channel, ''), '(未知)') as channel, count(*)::int as n, " +
      "       count(distinct device_full)::int as devices " +
      "from tracking_events where ts >= " + win + " and channel <> '' " +
      "group by 1 order by 2 desc limit 20",
    [String(days)]
  ).catch(function () { return { rows: [] }; })).rows || [];

  var ipRows = (await pg.query(
    "select t.ip, count(*)::int as n from tracking_events t " +
      "where t.ts >= " + win + " and t.ip <> '' and t.ip not like '10.%' and t.ip not like '192.168.%' " +
      "group by t.ip order by 2 desc limit 50",
    [String(days)]
  ).catch(function () { return { rows: [] }; })).rows || [];

  var geoRows = [];
  if (ipRows.length) {
    geoRows = (await pg.query(
      "select ip, region_zh, city_zh, district, country, region, city from ip_lookups where ip = any($1)",
      [ipRows.map(function (r) { return r.ip; })]
    ).catch(function () { return { rows: [] }; })).rows || [];
  }
  var geoMap = {};
  geoRows.forEach(function (g) { geoMap[g.ip] = g; });

  var cities = {};
  ipRows.forEach(function (r) {
    var g = geoMap[r.ip] || {};
    var key = String(g.city_zh || g.city || g.region_zh || g.region || g.country || "未知").trim() || "未知";
    cities[key] = (cities[key] || 0) + r.n;
  });

  // 生命周期：按设备判定「仅浏览 / 已付费未激活 / 已激活」
  var lifeRows = (await pg.query(
    "select device_full, " +
      "  bool_or(kind in ('order')) as paid, " +
      "  bool_or(kind = 'activation') as activated, " +
      "  bool_or(kind in ('visit','go_click','purchase_click')) as visited, " +
      "  count(*) filter (where kind = 'failure') as failures " +
      "from tracking_events where ts >= " + win + " and device_full <> '' group by device_full",
    [String(days)]
  ).catch(function () { return { rows: [] }; })).rows || [];

  // ⚠️ 分桶必须互斥且**穷尽**，否则 total 与各桶之和对不上（历史 bug：只有失败记录的设备无处可去）
  var life = { total: 0, activated: 0, paidNotActivated: 0, onlyVisit: 0, onlyFailure: 0, hasFailure: 0 };
  lifeRows.forEach(function (r) {
    life.total++;
    if (r.activated) life.activated++;
    else if (r.paid) life.paidNotActivated++;
    else if (r.visited) life.onlyVisit++;
    else life.onlyFailure++;   // 只留下激活失败记录的设备：重点运营对象
    if (Number(r.failures) > 0) life.hasFailure++;
  });

  var totalEvs = (await pg.query(
    "select kind, count(*)::int as n from tracking_events where ts >= " + win + " group by kind",
    [String(days)]
  ).catch(function () { return { rows: [] }; })).rows || [];

  return {
    success: true,
    days: days,
    devices: devRows.map(function (r) { return { model: r.model, devices: r.devices }; }),
    channels: chRows.map(function (r) { return { channel: r.channel, events: r.n, devices: r.devices }; }),
    cities: Object.keys(cities).map(function (k) { return { city: k, events: cities[k] }; })
      .sort(function (a, b) { return b.events - a.events; }).slice(0, 20),
    lifecycle: life,
    events: totalEvs.map(function (r) { return { kind: r.kind, count: r.n }; })
      .sort(function (a, b) { return b.count - a.count; }),
  };
}

// --- 历史数据回填 ---------------------------------------------------------

// 幂等：所有行都带 dedupe_key，重复跑只会插不进去
async function backfill(days) {
  days = clampDays(days);
  await ensureTable();
  var win = String(days) + " days";
  var out = { visitorLogs: 0, orders: 0, redeems: 0, activations: 0, failures: 0 };

  // ① visitor_logs → visit / go_click
  var r1 = await pg.query(
    "insert into tracking_events (ts, kind, device_full, device_norm, visitor_hash, ip, channel, payload, dedupe_key) " +
      "select ts, case when source = 'go-link' then 'go_click' else 'visit' end, " +
      "  coalesce(params->>'deviceId',''), '', visitor_hash, ip, coalesce(params->>'c',''), " +
      "  jsonb_build_object('path', path, 'query', query, 'params', params, 'ua', ua), " +
      "  'vl:' || id::text " +
      "from visitor_logs where ts >= now() - ($1)::interval " +
      "on conflict (dedupe_key) do nothing returning id",
    [win]
  ).catch(function (e) { console.warn("[tracking] backfill visitor_logs failed:", e.message); return { rows: [] }; });
  out.visitorLogs = (r1.rows || []).length;

  // ② Redis 侧：订单 / 兑换码 / 激活 / 失败（全扫，带上限）
  var minTs = Date.now() - days * 24 * 60 * 60 * 1000;

  // ⚠️ 必须用 mget 而不是 pipeline：lib/redis.js 的 pipeline.exec() 是**逐条 await**，
  //    几千个 key 就是几千次串行查询（慢到超时）；mget 是一次 SELECT ... IN (...)。
  async function scanSet(setKey, prefix) {
    var members = await redis.smembers(setKey).catch(function () { return []; });
    if (!members || !members.length) return [];
    if (members.length > MAX_SCAN) members = members.slice(-MAX_SCAN);
    var out2 = [];
    for (var i = 0; i < members.length; i += BATCH) {
      var batch = members.slice(i, i + BATCH);
      var res = await redis.mget(batch.map(function (m) { return prefix + m; })).catch(function () { return []; });
      for (var j = 0; j < batch.length; j++) {
        var raw = res && res[j];
        var obj = null;
        if (raw) { try { obj = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) {} }
        if (obj) out2.push({ member: batch[j], obj: obj });
      }
    }
    return out2;
  }

  // 先收集成数组，最后批量写（逐条 INSERT 在几千条量级会撞函数超时）
  var batchOrders = [];
  var batchRedeems = [];
  var batchActs = [];
  var batchFails = [];

  var orderItems = await scanSet("afdian:processed", "afdian:order:");
  for (var oi = 0; oi < orderItems.length; oi++) {
    var o = orderItems[oi].obj;
    if (!o || o.processed === false) continue;
    var ots = Number(o.paid_at || o.created_at) || 0;
    if (!ots || ots < minTs) continue;
    batchOrders.push({
      ts: ots, kind: "order", ip: o.ip || "", deviceId: o.device_id || "",
      redeemCode: o.redeem_code || "", outTradeNo: o.out_trade_no || "", channel: "",
      payload: { user_name: o.user_name || "", amount: o.total_amount || "", plan_title: o.plan_title || "" },
      dedupeKey: "or:" + o.out_trade_no,
    });
  }

  var redeemItems = await scanSet("auth:redeem_codes", "auth:redeem:");
  var redeemOrderMap = {};
  for (var ri = 0; ri < redeemItems.length; ri++) {
    var rd = redeemItems[ri].obj;
    if (rd.out_trade_no) redeemOrderMap[rd.code] = rd.out_trade_no;
    var rts = Number(rd.paid_at || rd.created_at) || 0;
    if (!rts || rts < minTs) continue;
    batchRedeems.push({
      ts: rts, kind: "redeem", redeemCode: rd.code || "", outTradeNo: rd.out_trade_no || "",
      deviceId: rd.device_id || "", channel: "",
      payload: { source: rd.source || "", product_id: rd.product_id || "", used: Boolean(rd.used) },
      dedupeKey: "rd:" + rd.code,
    });
  }

  var actItems = await scanSet("auth:activation_codes", "auth:activation:");
  for (var ai = 0; ai < actItems.length; ai++) {
    var a = actItems[ai].obj;
    var ats = Number(a.generated_at) || 0;
    if (!ats || ats < minTs) continue;
    var di = a.device_info || {};
    var vi = a.visitor_info || {};
    batchActs.push({
      ts: ats, kind: "activation", deviceId: a.device_id_full || a.device_id || "",
      ip: vi.ip || "", redeemCode: a.redeem_code || "", outTradeNo: redeemOrderMap[a.redeem_code] || "",
      activationCode: a.activation_code || "", channel: di.source || "",
      payload: { model: pickModel(di.model, di.product), product: di.product || "", rom: di.romVersion || "", product_id: a.product_id || "", months: a.duration_months || 0, activation_seq: a.activation_seq || 1 },
      // 用集合成员（首次=<激活码>，复用追加=<激活码>:<第几次>）拼 dedupe，
      // 与实时写入 api/activate.js 保持同一套键：否则复用多次激活会被压成一条
      dedupeKey: "ac:" + (actItems[ai].member || a.activation_code),
    });
  }

  var failItems = await scanSet("auth:activation_failures", "");
  for (var fi = 0; fi < failItems.length; fi++) {
    var f = failItems[fi].obj;
    var fts = Number(f.generated_at) || 0;
    if (!fts || fts < minTs) continue;
    var fdi = f.device_info || {};
    var fvi = f.visitor_info || {};
    batchFails.push({
      ts: fts, kind: "failure", deviceId: f.device_id_full || f.device_id || "",
      ip: fvi.ip || "", redeemCode: f.redeem_code || "", activationCode: f.activation_code || "",
      channel: fdi.source || "", payload: { reason: f.reason || "", model: pickModel(fdi.model, fdi.product), product: fdi.product || "" },
      dedupeKey: "af:" + failItems[fi].member,
    });
  }

  out.orders = await recordMany(batchOrders);
  out.redeems = await recordMany(batchRedeems);
  out.activations = await recordMany(batchActs);
  out.failures = await recordMany(batchFails);

  // 回填完立刻做一次身份富化（订单/兑换码 → 设备），否则漏斗的「访问→支付」没有样本
  out.enriched = await enrichIdentity(true);

  return out;
}

module.exports = {
  ensureTable: ensureTable,
  record: record,
  recordMany: recordMany,
  funnel: funnel,
  portrait: portrait,
  backfill: backfill,
  enrichIdentity: enrichIdentity,
  enrichModels: enrichModels,
  pickModel: pickModel,
  isPrivateOrInvalid: isPrivateOrInvalid,
  alnum: alnum,
};
