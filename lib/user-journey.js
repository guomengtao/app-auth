// lib/user-journey.js — 单个用户的「全链路追踪 / 画像」运行时解析（只读，不改写入侧）
//
// 目标：把 访问 → 购买点击 → 支付订单 → 发放兑换码 → 激活 → 后续使用 串成一条时间线。
//
// 可用外键（三跳齐全，不需要靠时间猜）：
//   afdian:order:<out_trade_no>.redeem_code  ↔  auth:redeem:<CODE4>.out_trade_no
//   auth:redeem:<CODE4>.generated_activation_code  ↔  auth:activation:<CODE18>
//   auth:activation:<CODE18>.device_id_full ↔ visitor_logs.params->>'deviceId'   ← 跨层唯一硬凭据
//
// ⚠️ 两个必须记住的坑：
//   1) deviceId 落库只保留最后 4 位（lib/validate.js normalizeDeviceId），5000 用户碰撞概率 ≈85%，
//      所以匹配一律以 device_id_full 为准，4 位只做候选筛选；
//   2) visitor_hash（32bit JS hash）与 device_id_hash（sha256）不可互转，不能互相 join。

var redis = require("./redis");
var pg = require("./postgres");
var validate = require("./validate");
var geoZh = require("./geo-zh");

var MAX_SCAN = 4000;      // 全扫 auth:activation_codes 的上限（Redis 是 Postgres 代理，全扫很贵）
var BATCH = 200;
var MAX_ROWS = 800;       // visitor_logs / message_delivery 单次上限

// --- 基础工具 ------------------------------------------------------------

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function alnum(s) { return String(s || "").replace(/[^0-9A-Za-z]/g, ""); }

function last4(raw) { return validate.normalizeDeviceId(raw); }

function clampDays(d) {
  var n = parseInt(d, 10) || 30;
  if (n < 1) n = 1;
  if (n > 90) n = 90;
  return n;
}

function maskDevice(s) {
  var v = String(s || "");
  if (v.length <= 8) return v;
  return v.slice(0, 4) + "…" + v.slice(-4);
}

// 锚点类型识别 + 探测（订单号与用户名靠探测区分）
async function detectAnchor(q) {
  var s = String(q || "").trim();
  if (!s) return { type: "none", value: "" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.indexOf(":") >= 0) return { type: "ip", value: s };
  if (/^[0-9]{18}$/.test(s)) return { type: "activation", value: s };
  if (/^[A-Z0-9]{4}$/i.test(s)) return { type: "redeem", value: s.toUpperCase() };
  if (/^[0-9a-fA-F]{16,64}$/.test(s)) return { type: "device", value: s.toLowerCase() };
  // 订单号 vs 用户名：直接探测 key
  var asOrder = await redis.get("afdian:order:" + s).catch(function () { return null; });
  if (asOrder) return { type: "order", value: s };
  return { type: "name", value: s };
}

// --- Redis 读取 ----------------------------------------------------------

async function getOrder(outTradeNo) {
  if (!outTradeNo) return null;
  var raw = await redis.get("afdian:order:" + outTradeNo).catch(function () { return null; });
  var o = parseJson(raw);
  if (!o) return null;
  o.out_trade_no = o.out_trade_no || outTradeNo;
  return o;
}

async function getRedeem(code) {
  if (!code) return null;
  var raw = await redis.get("auth:redeem:" + code).catch(function () { return null; });
  var r = parseJson(raw);
  if (!r) return null;
  r.code = r.code || code;
  return r;
}

async function getActivation(code) {
  if (!code) return null;
  var raw = await redis.get("auth:activation:" + code).catch(function () { return null; });
  var a = parseJson(raw);
  if (!a) return null;
  a.activation_code = a.activation_code || code;
  return a;
}

// 批量取（set of keys → 前缀 key 的 JSON）
async function batchGetByMembers(setKey, prefix, cap) {
  var members = await redis.smembers(setKey).catch(function () { return []; });
  if (!members || !members.length) return [];
  if (members.length > cap) members = members.slice(-cap); // 取最近的（set 无序，仅做上限保护）
  var out = [];
  for (var i = 0; i < members.length; i += BATCH) {
    var batch = members.slice(i, i + BATCH);
    var pip = redis.pipeline();
    batch.forEach(function (m) { pip.get(prefix ? prefix + m : m); });
    var res = await pip.exec().catch(function () { return []; });
    for (var j = 0; j < batch.length; j++) {
      var rec = parseJson(res && res[j]);
      if (rec) out.push(rec);
    }
  }
  return out;
}

async function findActivationsByDevice(deviceFull, days) {
  var all = await batchGetByMembers("auth:activation_codes", "auth:activation:", MAX_SCAN);
  var tails = last4(deviceFull);
  var full = alnum(String(deviceFull || "").toLowerCase());
  var minTs = Date.now() - days * 24 * 60 * 60 * 1000;
  return all.filter(function (a) {
    if (a.generated_at && Number(a.generated_at) < minTs) return false;
    var df = alnum(String(a.device_id_full || "").toLowerCase());
    if (full.length > 4 && df && df === full) return true;      // 强匹配：完整 deviceId
    if (!full.length || full.length <= 4) {
      return String(a.device_id || "").toLowerCase() === tails.toLowerCase(); // 只有 4 位时退化
    }
    return df && df.slice(-4) === tails.toLowerCase() && String(a.device_id || "").toLowerCase() === tails.toLowerCase();
  });
}

async function findFailuresByDevice(deviceFull, days) {
  var all = await batchGetByMembers("auth:activation_failures", "", MAX_SCAN);
  var tails = last4(deviceFull);
  var full = alnum(String(deviceFull || "").toLowerCase());
  var minTs = Date.now() - days * 24 * 60 * 60 * 1000;
  return all.filter(function (f) {
    if (f.generated_at && Number(f.generated_at) < minTs) return false;
    var df = alnum(String(f.device_id_full || f.device_id || "").toLowerCase());
    if (full.length > 4) return df === full || (df && df.slice(-4) === tails.toLowerCase() && String(f.device_id || "").toLowerCase() === tails.toLowerCase());
    return String(f.device_id || "").toLowerCase() === tails.toLowerCase();
  });
}

async function findOrdersByName(name, days) {
  var members = await redis.smembers("afdian:processed").catch(function () { return []; });
  if (!members || !members.length) return [];
  if (members.length > 500) members = members.slice(-500);
  var out = [];
  for (var i = 0; i < members.length; i += BATCH) {
    var batch = members.slice(i, i + BATCH);
    var pip = redis.pipeline();
    batch.forEach(function (m) { pip.get("afdian:order:" + m); });
    var res = await pip.exec().catch(function () { return []; });
    for (var j = 0; j < batch.length; j++) {
      var o = parseJson(res && res[j]);
      if (o && String(o.user_name || "").indexOf(name) >= 0) out.push(o);
    }
  }
  return out;
}

// --- SQL 读取 ------------------------------------------------------------

async function visitorLogsByIp(ip, days) {
  var r = await pg.query(
    "select ts, ip, path, query, params, ua, ref, source, visitor_hash, country, region, city " +
      "from visitor_logs where ip = $1 and ts >= now() - (($2::int) || ' days')::interval " +
      "order by ts desc limit " + MAX_ROWS,
    [ip, String(days)]
  ).catch(function () { return { rows: [] }; });
  return r.rows || [];
}

async function visitorLogsByDevice(deviceFull, days) {
  var tail = last4(deviceFull).toLowerCase();
  var r = await pg.query(
    "select ts, ip, path, query, params, ua, ref, source, visitor_hash, country, region, city " +
      "from visitor_logs " +
      "where ts >= now() - (($1::int) || ' days')::interval " +
      "  and params is not null and params->>'deviceId' is not null " +
      "  and right(regexp_replace(params->>'deviceId', '[^0-9A-Za-z]', '', 'g'), 4) = $2 " +
      "order by ts desc limit " + MAX_ROWS,
    [String(days), tail]
  ).catch(function () { return { rows: [] }; });
  return r.rows || [];
}

// message_delivery 是唯一同时含 order/redeem/activation/ip/hash 的表 → 用它捞 purchase_click / page_visit / 通知
async function deliveryByText(pattern, days) {
  var r = await pg.query(
    "select id, message_type, payload, created_at, status " +
      "from message_delivery " +
      "where created_at >= now() - (($1::int) || ' days')::interval and payload::text like $2 " +
      "order by created_at asc limit " + MAX_ROWS,
    [String(days), "%" + pattern + "%"]
  ).catch(function () { return { rows: [] }; });
  return r.rows || [];
}

async function ipGeoMap(ips) {
  var map = {};
  var list = Object.keys(ips || {});
  if (!list.length) return map;
  try {
    var r = await pg.query(
      "select ip, country, region, region_zh, city, city_zh, district, isp, org from ip_lookups where ip = any($1)",
      [list]
    );
    (r.rows || []).forEach(function (row) { map[row.ip] = row; });
  } catch (e) {}
  return map;
}

// --- 事件构造 ------------------------------------------------------------

function tsOf(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  var n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n;
  var d = new Date(v);
  var t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

function pushEvent(out, ev) {
  if (!ev || !ev.ts) return;
  out.push(ev);
}

function visitorEvent(row) {
  var params = row.params && typeof row.params === "object" ? row.params : parseJson(row.params) || {};
  var isGo = row.source === "go-link";
  return {
    ts: tsOf(row.ts),
    kind: isGo ? "go_click" : "visit",
    title: isGo ? "扫码/点击购买短链" : "访问页面",
    ip: row.ip || "",
    deviceId: params.deviceId || "",
    channel: params.c || "",
    source: "visitor_logs",
    refId: String(row.path || ""),
    detail: { path: row.path || "/", query: row.query || "", params: params, ua: row.ua || "", ref: row.ref || "" },
  };
}

function activationEvent(a) {
  var di = a.device_info || {};
  var vi = a.visitor_info || {};
  return {
    ts: tsOf(a.generated_at),
    kind: "activation",
    title: "激活成功",
    ip: vi.ip || "",
    deviceId: a.device_id_full || a.device_id || "",
    channel: di.source || "",
    source: "auth:activation",
    refId: a.activation_code || "",
    detail: {
      activation_code: a.activation_code || "",
      redeem_code: a.redeem_code || "",
      product_id: a.product_id || "",
      months: a.duration_months || 0,
      expires_at: a.expires_at || null,
      device_info: di,
      ua: vi.userAgent || "",
    },
  };
}

function failureEvent(f) {
  var di = f.device_info || {};
  var vi = f.visitor_info || {};
  return {
    ts: tsOf(f.generated_at),
    kind: "failure",
    title: "激活失败：" + String(f.reason || "未知原因"),
    ip: vi.ip || "",
    deviceId: f.device_id_full || f.device_id || "",
    channel: di.source || "",
    source: "auth:activation_failure",
    refId: f.redeem_code || "",
    detail: { reason: f.reason || "", redeem_code: f.redeem_code || "", device_info: di },
  };
}

function orderEvent(o) {
  // 优先用爱发电真实支付时间（paid_at），没有才退回本系统处理时间（created_at）
  var paidTs = tsOf(o.paid_at);
  var procTs = tsOf(o.created_at);
  return {
    ts: paidTs || procTs,
    kind: "order",
    title: "支付成功 ¥" + String(o.total_amount || "0"),
    ip: o.ip || o.tracking_ip || "",
    deviceId: o.device_id || "",
    channel: "",
    source: "afdian:order",
    refId: o.out_trade_no || "",
    detail: {
      out_trade_no: o.out_trade_no || "",
      user_name: o.user_name || "",
      plan_title: o.plan_title || "",
      total_amount: o.total_amount || "",
      redeem_code: o.redeem_code || "",
      product_id: o.product_id || "",
      dm_sent: o.dm_sent || 0,
      paid_at: paidTs || null,
      processed_at: procTs || null,
      tsIsProcessedAt: !paidTs,
      remark: o.remark || "",
    },
  };
}

function redeemEvent(r) {
  return {
    ts: tsOf(r.created_at) || tsOf(r.used_at),
    kind: "redeem",
    title: "发放兑换码 " + String(r.code || ""),
    ip: "",
    deviceId: "",
    channel: "",
    source: "auth:redeem",
    refId: r.code || "",
    detail: {
      code: r.code || "",
      out_trade_no: r.out_trade_no || "",
      source: r.source || "",
      used: Boolean(r.used),
      used_at: tsOf(r.used_at) || null,
      product_id: r.product_id || "",
      user_name: r.user_name || "",
    },
  };
}

function deliveryEvent(row) {
  var p = row.payload && typeof row.payload === "object" ? row.payload : parseJson(row.payload) || {};
  if (row.message_type === "purchase_click") {
    return {
      ts: tsOf(row.created_at),
      kind: "purchase_click",
      title: "购买点击（" + String(p.slug || "") + "）",
      ip: p.ip || "",
      deviceId: "",
      channel: p.utm_source || "",
      source: "message_delivery",
      refId: String(p.slug || ""),
      detail: { slug: p.slug || "", target_url: p.target_url || "", referrer: p.referrer || "", ua: p.user_agent || "", visitor_hash: p.visitor_hash || "" },
    };
  }
  if (row.message_type === "page_visit") {
    return {
      ts: tsOf(row.created_at),
      kind: "page_visit",
      title: "浏览 " + String(p.page || ""),
      ip: p.ip || "",
      deviceId: "",
      channel: "",
      source: "message_delivery",
      refId: String(p.page || ""),
      detail: { page: p.page || "", referrer: p.referrer || "", title: p.title || "", location_zh: p.location_zh || "" },
    };
  }
  if (row.message_type === "new_order") {
    return {
      ts: tsOf(row.created_at),
      kind: "order_notify",
      title: "新订单通知（" + String(p.user_name || "") + "）",
      ip: p.ip || "",
      deviceId: "",
      channel: "",
      source: "message_delivery",
      refId: String(p.out_trade_no || ""),
      detail: { out_trade_no: p.out_trade_no || "", redeem_code: p.redeem_code || "", total_amount: p.total_amount || "" },
    };
  }
  return null;
}

// --- 主入口 --------------------------------------------------------------

async function resolve(q, opts) {
  opts = opts || {};
  var days = clampDays(opts.days);
  var anchor = await detectAnchor(q);

  var deviceFull = "";
  var redemCodes = {};
  var orderNos = {};
  var actCodes = {};
  var ips = {};

  if (anchor.type === "device") deviceFull = anchor.value;
  if (anchor.type === "ip") ips[anchor.value] = true;
  if (anchor.type === "redeem") redemCodes[anchor.value] = true;
  if (anchor.type === "activation") actCodes[anchor.value] = true;
  if (anchor.type === "order") orderNos[anchor.value] = true;

  // ① 激活码 → 兑换码 / 设备
  var actList = [];
  var failList = [];
  for (var ac in actCodes) {
    var a0 = await getActivation(ac);
    if (a0) actList.push(a0);
  }

  // ② 兑换码 → 订单 / 激活
  for (var rc in redemCodes) {
    var r0 = await getRedeem(rc);
    if (!r0) continue;
    if (r0.out_trade_no) orderNos[r0.out_trade_no] = true;
    if (r0.generated_activation_code && !actCodes[r0.generated_activation_code]) {
      var a1 = await getActivation(r0.generated_activation_code);
      if (a1) actList.push(a1);
    }
  }

  // ③ 设备 → 激活 / 失败（全扫，带上限）
  if (deviceFull) {
    var byDev = await findActivationsByDevice(deviceFull, days);
    byDev.forEach(function (a) {
      if (!actList.some(function (x) { return x.activation_code === a.activation_code; })) actList.push(a);
    });
    failList = await findFailuresByDevice(deviceFull, days);
  }

  // ④ 外键收敛扩展：激活 ⟷ 兑换码 ⟷ 订单 三跳互相拉（用占位 null 标记待取，循环到不再新增）
  var actMap = {};
  var redeemMap = {};
  var orderMap = {};
  actList.forEach(function (a) { actMap[a.activation_code] = a; });
  for (var rc1 in redemCodes) { redeemMap[rc1] = null; }
  for (var on1 in orderNos) { orderMap[on1] = null; }

  // 用户名检索：订单号未知，先按 user_name 全量扫订单，再交给收敛扩展
  if (anchor.type === "name") {
    var nameOrders = await findOrdersByName(anchor.value, days);
    nameOrders.forEach(function (o) {
      if (o.out_trade_no && !(o.out_trade_no in orderMap)) orderMap[o.out_trade_no] = null;
    });
  }

  for (var pass = 0; pass < 4; pass++) {
    var changed = false;

    Object.keys(actMap).forEach(function (k) {
      var a = actMap[k];
      if (a && a.redeem_code && !(a.redeem_code in redeemMap)) { redeemMap[a.redeem_code] = null; changed = true; }
    });
    Object.keys(orderMap).forEach(function (k) {
      var o = orderMap[k];
      if (o && o.redeem_code && !(o.redeem_code in redeemMap)) { redeemMap[o.redeem_code] = null; changed = true; }
    });

    var codeKeys = Object.keys(redeemMap);
    for (var ci = 0; ci < codeKeys.length; ci++) {
      if (redeemMap[codeKeys[ci]]) continue;
      var rr = await getRedeem(codeKeys[ci]);
      if (!rr) { delete redeemMap[codeKeys[ci]]; continue; }
      redeemMap[codeKeys[ci]] = rr;
      changed = true;
      if (rr.out_trade_no && !(rr.out_trade_no in orderMap)) { orderMap[rr.out_trade_no] = null; changed = true; }
      if (rr.generated_activation_code && !(rr.generated_activation_code in actMap)) { actMap[rr.generated_activation_code] = null; changed = true; }
    }

    var noKeys = Object.keys(orderMap);
    for (var ni = 0; ni < noKeys.length; ni++) {
      if (orderMap[noKeys[ni]]) continue;
      var oo = await getOrder(noKeys[ni]);
      if (!oo) { delete orderMap[noKeys[ni]]; continue; }
      orderMap[noKeys[ni]] = oo;
      changed = true;
      if (oo.redeem_code && !(oo.redeem_code in redeemMap)) { redeemMap[oo.redeem_code] = null; changed = true; }
    }

    var actKeys = Object.keys(actMap);
    for (var ai = 0; ai < actKeys.length; ai++) {
      if (actMap[actKeys[ai]]) continue;
      var aa = await getActivation(actKeys[ai]);
      if (!aa) { delete actMap[actKeys[ai]]; continue; }
      actMap[actKeys[ai]] = aa;
      changed = true;
    }

    if (!changed) break;
  }

  var orders = Object.keys(orderMap).map(function (k) { return orderMap[k]; }).filter(Boolean);
  var redeems = Object.keys(redeemMap).map(function (k) { return redeemMap[k]; }).filter(Boolean);
  actList = Object.keys(actMap).map(function (k) { return actMap[k]; }).filter(Boolean);

  redemCodes = {};
  orderNos = {};
  redeems.forEach(function (r) { redemCodes[r.code] = true; });
  orders.forEach(function (o) { orderNos[o.out_trade_no] = true; });

  // ⑤ 收集设备 / IP
  var devices = {};
  // 订单备注里带的 deviceId：订单 ↔ 访问侧的硬凭据（二期新增字段）
  orders.forEach(function (o) {
    if (o.device_id) devices[String(o.device_id)] = true;
  });
  actList.forEach(function (a) {
    var df = String(a.device_id_full || a.device_id || "");
    if (df) devices[df] = true;
    var vi = a.visitor_info || {};
    if (vi.ip) ips[vi.ip] = true;
    if (a.redeem_code) redemCodes[a.redeem_code] = true;
  });
  failList.forEach(function (f) {
    var df = String(f.device_id_full || f.device_id || "");
    if (df) devices[df] = true;
    var vi = f.visitor_info || {};
    if (vi.ip) ips[vi.ip] = true;
  });
  if (!deviceFull && Object.keys(devices).length) {
    // 取最长的一个作为主设备（短的是历史的 4 位老数据）
    deviceFull = Object.keys(devices).sort(function (a, b) { return b.length - a.length; })[0];
  }

  // ⑥ 访问侧：按 IP 与按 deviceId 两条路
  var visitRows = [];
  var ipList = Object.keys(ips);
  for (var i = 0; i < ipList.length; i++) {
    var rows = await visitorLogsByIp(ipList[i], days);
    rows.forEach(function (r) { visitRows.push(r); });
  }
  // 每个已知设备都查一遍访问（含订单备注里解析出来的 deviceId），上限 5 个避免放大查询
  var devKeys = Object.keys(devices).slice(0, 5);
  for (var di2 = 0; di2 < devKeys.length; di2++) {
    var rows2 = await visitorLogsByDevice(devKeys[di2], days);
    rows2.forEach(function (r) { visitRows.push(r); });
  }
  // 去重（同 id 可能两次命中）
  var seen = {};
  visitRows = visitRows.filter(function (r) {
    var k = String(r.ts) + "|" + String(r.ip) + "|" + String(r.path);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  // 访问行里带出来的 deviceId / 渠道
  visitRows.forEach(function (r) {
    var params = r.params && typeof r.params === "object" ? r.params : parseJson(r.params) || {};
    if (params.deviceId) devices[String(params.deviceId)] = true;
  });

  // ⑦ message_delivery：补 purchase_click / page_visit（有些页面不写 visitor_logs）
  var delivRows = [];
  var patterns = [];
  ipList.forEach(function (ip) { patterns.push('"ip":"' + ip + '"'); });
  if (deviceFull) patterns.push(String(deviceFull));
  Object.keys(redemCodes).forEach(function (c) { patterns.push('"redeem_code":"' + c + '"'); });
  Object.keys(orderNos).forEach(function (n) { patterns.push('"out_trade_no":"' + n + '"'); });
  for (var pi = 0; pi < patterns.length; pi++) {
    var dr = await deliveryByText(patterns[pi], days);
    dr.forEach(function (row) { delivRows.push(row); });
  }
  var seenD = {};
  delivRows = delivRows.filter(function (row) {
    if (seenD[row.id]) return false;
    seenD[row.id] = true;
    return true;
  });

  // ⑧ 组装事件
  var events = [];
  orders.forEach(function (o) { pushEvent(events, orderEvent(o)); });
  redeems.forEach(function (r) { pushEvent(events, redeemEvent(r)); });
  actList.forEach(function (a) { pushEvent(events, activationEvent(a)); });
  failList.forEach(function (f) { pushEvent(events, failureEvent(f)); });
  visitRows.forEach(function (r) { pushEvent(events, visitorEvent(r)); });
  delivRows.forEach(function (row) { pushEvent(events, deliveryEvent(row)); });

  // purchase_click 与 go_click 常常是同一次点击（/go/ 同时写两处）→ 去重
  var goKeys = {};
  events.forEach(function (e) { if (e.kind === "go_click") goKeys[Math.floor(e.ts / 10000) + "|" + e.ip] = true; });
  events = events.filter(function (e) {
    if (e.kind !== "purchase_click") return true;
    var k = Math.floor(e.ts / 10000) + "|" + e.ip;
    return !goKeys[k];
  });

  events.sort(function (a, b) { return a.ts - b.ts; });

  // 订单本身不带 IP（爱发电服务端回调没有买家 IP），这里用「同设备的临近访问」反推购买侧 IP，
  // 并打 ipInferred 标记，避免把推断值当成实测值。
  for (var oi = 0; oi < events.length; oi++) {
    var oe = events[oi];
    if ((oe.kind !== "order" && oe.kind !== "order_notify") || oe.ip) continue;
    var devId = String(oe.deviceId || "");
    var best = null;
    for (var pj = oi - 1; pj >= 0; pj--) {
      var pe = events[pj];
      if (!pe.ip) continue;
      if (oe.ts - pe.ts > 6 * 60 * 60 * 1000) break;
      if (!devId || !pe.deviceId || String(pe.deviceId) === devId) { best = pe; break; }
    }
    if (!best) {
      for (var qj = oi + 1; qj < events.length; qj++) {
        var qe = events[qj];
        if (!qe.ip) continue;
        if (qe.ts - oe.ts > 30 * 60 * 1000) break;
        if (!devId || !qe.deviceId || String(qe.deviceId) === devId) { best = qe; break; }
      }
    }
    if (best) { oe.ip = best.ip; oe.ipInferred = true; }
  }

  // ⑨ 画像卡
  var deviceList = Object.keys(devices).map(function (d) {
    return { full: d, masked: maskDevice(d), norm: last4(d), len: d.length };
  }).sort(function (a, b) { return b.len - a.len; });

  var fingerprints = {};
  var channels = {};
  actList.forEach(function (a) {
    var di = a.device_info || {};
    if (di.model || di.product) {
      var fp = [di.model, di.product, di.platformVersionCode, di.deviceType, di.screenWidth + "x" + di.screenHeight, di.romVersion, di.language].join("|");
      fingerprints[fp] = true;
    }
    if (di.source) channels[di.source] = (channels[di.source] || 0) + 1;
  });
  visitRows.forEach(function (r) {
    var params = r.params && typeof r.params === "object" ? r.params : parseJson(r.params) || {};
    if (params.m || params.p) {
      var fp2 = [params.m, params.p, params.v, params.t, params.w + "x" + params.h, params.r, params.l].join("|");
      fingerprints[fp2] = true;
    }
    if (params.c) channels[params.c] = (channels[params.c] || 0) + 1;
  });

  var geoMap = await ipGeoMap(ips);
  var ipListOut = Object.keys(ips).map(function (ip) {
    var g = geoMap[ip] || {};
    var pair = geoZh.resolveDisplayGeo({
      region_zh: g.region_zh, city_zh: g.city_zh,
      region: g.region, city: g.city,
      raw_region: "", raw_city: "", country: g.country,
    });
    return {
      ip: ip,
      region: pair.region || "",
      city: pair.city || "",
      district: g.district || "",
      isp: g.isp || g.org || "",
    };
  });

  // ⑩ 指标（转化耗时）
  var first = events.length ? events[0] : null;
  var firstVisit = events.filter(function (e) { return e.kind === "visit" || e.kind === "go_click" || e.kind === "purchase_click"; })[0] || null;
  var firstOrder = events.filter(function (e) { return e.kind === "order" || e.kind === "order_notify"; })[0] || null;
  var firstRedeem = events.filter(function (e) { return e.kind === "redeem"; })[0] || null;
  var firstActivation = events.filter(function (e) { return e.kind === "activation"; })[0] || null;
  function diff(a, b) { return a && b && a.ts && b.ts ? Math.max(0, b.ts - a.ts) : null; }
  var metrics = {
    visitToOrder: diff(firstVisit, firstOrder),
    orderToRedeem: diff(firstOrder, firstRedeem),
    redeemToActivation: diff(firstRedeem, firstActivation),
    total: first && firstActivation ? Math.max(0, firstActivation.ts - first.ts) : null,
  };

  // ⑪ 冲突 / 证据
  var warnings = [];
  var evidence = [];
  var orderIps = {};
  var orderIpInferred = false;
  events.forEach(function (e) {
    if ((e.kind === "order" || e.kind === "order_notify") && e.ip) {
      orderIps[e.ip] = true;
      if (e.ipInferred) orderIpInferred = true;
    }
  });
  if (orderIpInferred) {
    warnings.push({ level: "info", text: "订单本身不带买家 IP（爱发电是服务端回调），购买侧 IP 由同设备的临近访问反推得出，仅供参考" });
  }
  var actIps = {};
  actList.forEach(function (a) { if (a.visitor_info && a.visitor_info.ip) actIps[a.visitor_info.ip] = true; });

  if (devices[deviceFull] && deviceFull) {
    evidence.push("设备 " + maskDevice(deviceFull) + " 在 " + actList.length + " 条激活记录中出现（强证据，直接合并）");
  }
  Object.keys(redemCodes).forEach(function (c) {
    evidence.push("兑换码 " + c + " 通过 out_trade_no / generated_activation_code 外键串联订单与激活");
  });
  var oiList = Object.keys(orderIps);
  var aiList = Object.keys(actIps);
  if (oiList.length && aiList.length && oiList.indexOf(aiList[0]) < 0) {
    warnings.push({ level: "warn", text: "购买 IP（" + oiList.join(",") + "）与激活 IP（" + aiList.join(",") + "）不同 —— 按 deviceId 判定为同一人，已合并（常见于手机扫码、手表/另一网络激活）" });
  } else if (aiList.length && oiList.length) {
    evidence.push("购买与激活 IP 一致：" + aiList.join(","));
  }
  if (ipList.length) {
    var devCount = deviceList.length;
    if (devCount > 1) {
      warnings.push({ level: "info", text: "该用户使用了 " + devCount + " 个设备标识（可能是换设备 / 重装 / 4 位碰撞），请核对 deviceId 全文" });
    }
  }
  if (deviceFull && deviceFull.length <= 4) {
    warnings.push({ level: "warn", text: "只记录到 4 位短 deviceId（" + deviceFull + "），存在碰撞风险，判定降级为「疑似」" });
  }
  var isEmulator = Object.keys(fingerprints).some(function (f) { return /emulator/i.test(f); });
  if (isEmulator) {
    warnings.push({ level: "warn", text: "设备指纹含 Emulator（模拟器），同一环境可能被多人共用，设备维度不可信" });
  }
  var noOrderCodes = redeems.filter(function (r) { return !r.out_trade_no; }).map(function (r) { return r.code; });
  if (noOrderCodes.length) {
    warnings.push({ level: "info", text: "兑换码 " + noOrderCodes.join(",") + " 没有订单来源（后台直开 / 批量生成），链路在「支付」之前的节点缺失" });
  }
  if (!orders.length) {
    warnings.push({ level: "info", text: "未关联到爱发电订单（可能未同步、或该码为后台直开）" });
  }
  var remarkLinked = orders.filter(function (o) { return o.device_id; });
  if (remarkLinked.length) {
    evidence.push("订单备注里带出了 deviceId（" + remarkLinked.map(function (o) { return maskDevice(o.device_id); }).join("，") + "）——这是订单 ↔ 访问侧的硬凭据");
  }
  var noPaidAt = orders.filter(function (o) { return !tsOf(o.paid_at); });
  if (noPaidAt.length) {
    warnings.push({ level: "warn", text: "这 " + noPaidAt.length + " 条订单缺「真实支付时间」（老数据同步时没存），时间线里的支付节点用的是系统处理时间，浏览→支付耗时偏小" });
  }

  var lifecycle = firstActivation
    ? (actList.length > 1 ? "已激活 · 复购/重刷" : "已激活")
    : (orders.length ? "已付费 · 未激活" : (events.length ? "仅浏览 · 未付费" : "无数据"));

  var user = {
    anchor: anchor,
    devices: deviceList,
    primaryDevice: deviceFull ? { full: deviceFull, masked: maskDevice(deviceFull), norm: last4(deviceFull) } : null,
    fingerprints: Object.keys(fingerprints),
    channels: Object.keys(channels).map(function (c) { return { channel: c, count: channels[c] }; }),
    ips: ipListOut,
    orders: orders.map(function (o) {
      return { out_trade_no: o.out_trade_no, user_name: o.user_name || "", amount: o.total_amount || "", plan_title: o.plan_title || "", redeem_code: o.redeem_code || "", ts: tsOf(o.created_at) };
    }),
    redeems: redeems.map(function (r) {
      return { code: r.code, used: Boolean(r.used), source: r.source || "", out_trade_no: r.out_trade_no || "", ts: tsOf(r.created_at) };
    }),
    activations: actList.map(function (a) {
      var di = a.device_info || {};
      return {
        activation_code: a.activation_code, redeem_code: a.redeem_code || "",
        product_id: a.product_id || "", months: a.duration_months || 0,
        ts: tsOf(a.generated_at), expires_at: a.expires_at || null,
        device: di.model || di.product || "", rom: di.romVersion || "", ip: (a.visitor_info || {}).ip || "",
      };
    }),
    lifecycle: lifecycle,
  };

  // ⑫ 弱候选：同 IP 但无 deviceId 命中的访问（默认不合并）
  var candidates = [];
  var strongIps = {};
  events.forEach(function (e) { if (e.ip && (e.kind === "activation" || e.kind === "go_click")) strongIps[e.ip] = true; });
  visitRows.forEach(function (r) {
    var params = r.params && typeof r.params === "object" ? r.params : parseJson(r.params) || {};
    var hasDev = Boolean(params.deviceId);
    if (hasDev) return;
    if (!strongIps[r.ip]) return;
    candidates.push({
      ts: tsOf(r.ts), ip: r.ip, path: r.path || "/", ua: r.ua || "",
      score: 45, reason: "同 IP 但访问未携带 deviceId（可能是同一人的电脑浏览器，或 NAT 下的其他人）",
    });
  });
  candidates.sort(function (a, b) { return b.ts - a.ts; });
  candidates = candidates.slice(0, 20);

  return {
    success: true,
    query: String(q || ""),
    days: days,
    anchor: anchor,
    user: user,
    timeline: events,
    metrics: metrics,
    evidence: evidence,
    warnings: warnings,
    candidates: candidates,
    stats: { events: events.length, orders: orders.length, redeems: redeems.length, activations: actList.length, failures: failList.length, visits: visitRows.length },
  };
}

module.exports = { resolve: resolve, detectAnchor: detectAnchor };
