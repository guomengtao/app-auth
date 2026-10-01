var redis = require("../lib/redis");
var crypto = require("../lib/crypto");
var { validateRedeemCode, validateDeviceId, isNaDeviceId, normalizeDeviceId } = require("../lib/validate");
var NA_USAGE_LIMIT_DEFAULT = 5;
var quota = require("../lib/quota");
var rateLimit = require("../lib/rate-limit");
var notify = require("../lib/notify");
var geoZh = require("../lib/geo-zh");
var geoDistrict = require("../lib/geo-district");
var visitorLog = require("../lib/visitor-log");
var background = require("../lib/background");
var ipWarmup = require("../lib/ip-warmup");
var tracking = require("../lib/tracking");

// Vercel 免费头部 + 腾讯位置服务区县 → geo 字段（中文由 lib/geo-zh.js 统一产出）
async function getGeoFields(req) {
  var country = String(req.headers["x-vercel-ip-country"] || "").slice(0, 8);
  var region = String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16);
  // Vercel 的 city 头对非 ASCII 是 percent-encoded，必须解码后再用
  var city = geoZh.decodeGeoValue(String(req.headers["x-vercel-ip-city"] || "")).slice(0, 40);
  var ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "").split(",")[0].trim();
  // 中文省市优先取 ip_lookups（ip-api lang=zh-CN，国内 IP 往往只有这里有值），Vercel 头部仅兜底
  var storedGeo = await geoDistrict.getStoredGeo(ip);
  var district = (await geoDistrict.getDistrict(ip)) || (storedGeo && storedGeo.district) || "";
  var full = geoZh.resolveZhLocationFull({
    country: country,
    region: region,
    city: city,
    zh_region: storedGeo && storedGeo.region,
    zh_city: storedGeo && storedGeo.city,
    district: district,
  });
  return {
    country: country,
    region: region,
    city: city,
    location_zh: full.location_zh,
    district_zh: full.district_zh,
    location_full_zh: full.location_full_zh,
    city_zh: full.location_zh,
  };
}

var VISITOR_TTL = 7 * 24 * 60 * 60;

// 访问通知的全局速率上限：每 1 分钟最多推 VISIT_PUSH_MAX 条「页面访问」通知，
// 超出的只落 visitor_logs / stats:recent（访客记录照常保留），不推给 Mac。
// 为什么不用旧的「同一访客 5 分钟一条」：那个策略换个人就又能推，人多时照样连着响；
// 这里限制的是**单位时间总量**（防通知爆炸）。15 条/分钟 ≈ 每 4 秒一条，
// 日常访问量根本碰不到，只有异常刷量才会被截断。要调松/调紧只改这个常量。
var VISIT_PUSH_MAX = 15;
var VISIT_PUSH_WINDOW_MS = 60 * 1000;

// ============ P3：App 客户端事件（section=client-event，§4.4 / F1-F3）============
// kind 白名单与推送分级（§8#4 拍板：成功实时有节流，失败整点合并）：
//   realtime = 立即推 Mac/EvOps（每 kind 每分钟全局 ≤ APP_EVENT_PUSH_MAX 条，超限只落库）
//   digest   = 只累计进「失败合并桶」，由 maybeFlushAppFailDigest() 每至多 1 小时合并推一条
//   none     = 只落 tracking_events 不推（app_open/connect_ok 与 page_visit 高度重复，推了纯噪音）
var APP_EVENT_KINDS = {
  "app_open":             { push: "none",     cn: "打开应用" },
  "app_connect_ok":       { push: "none",     cn: "连接手环成功" },
  "app_connect_fail":     { push: "digest",   cn: "连接手环失败" },
  "app_import_ok":        { push: "realtime", cn: "导入课表成功" },
  "app_import_fail":      { push: "digest",   cn: "导入课表失败" },
  "app_export_ok":        { push: "realtime", cn: "导出课表成功" },
  "app_export_fail":      { push: "digest",   cn: "导出课表失败" },
  "app_activate_ok":      { push: "realtime", cn: "App 激活成功" },
  "app_update_found":     { push: "realtime", cn: "发现新版本" },
  "app_update_installed": { push: "realtime", cn: "升级完成" },
};
var APP_EVENT_PUSH_MAX = 5;            // 每 kind 每分钟实时推送上限
var APP_EVENT_PUSH_WINDOW_MS = 60 * 1000;
var APP_EVENT_IP_MAX = 60;             // 每 IP 每分钟事件上报上限（防刷库）
// 失败合并桶：List 存最近 50 条失败明细，每至多 1 小时 flush 成一条汇总通知
var APP_FAIL_PENDING_KEY = "auth:appfail:pending";
var APP_FAIL_FLUSH_KEY = "auth:appfail:lastflush";
var APP_FAIL_FLUSH_INTERVAL_MS = 60 * 60 * 1000;
var APP_FAIL_LIST_CAP = 50;
// payload 白名单：客户端可控 JSON，只收这些键（逐个限长），防塞任意字段/超长串
var APP_EVENT_PAYLOAD_KEYS = [
  "course_count", "format", "source", "target", "stage", "reason",
  "from_code", "to_code", "activation_code", "uid", "channel", "order_no",
  "open_count", "upgrade_count", "schedule_index",
];

function sanitizeEventPayload(raw) {
  var out = {};
  if (!raw || typeof raw !== "object") return out;
  for (var i = 0; i < APP_EVENT_PAYLOAD_KEYS.length; i++) {
    var k = APP_EVENT_PAYLOAD_KEYS[i];
    var v = raw[k];
    if (v == null || v === "") continue;
    if (typeof v === "number" && isFinite(v)) { out[k] = Math.round(v); }
    else { out[k] = clipStr(v, 200); }
  }
  return out;
}

// 失败事件进合并桶（lpush+ltrim 限容量；lrange+del 取走即清，del 返回 0 说明被别的请求抢先取走）
function accumulateAppFail(kind, payload, dev) {
  return (async function () {
    try {
      var item = JSON.stringify({
        kind: kind,
        at: Date.now(),
        model: dev.model,
        app_version: dev.app_version,
        stage: payload.stage || "",
        reason: String(payload.reason || "").slice(0, 80),
        course_count: payload.course_count || 0,
        target: payload.target || "",
      });
      await redis.lpush(APP_FAIL_PENDING_KEY, item);
      await redis.ltrim(APP_FAIL_PENDING_KEY, 0, APP_FAIL_LIST_CAP - 1);
      await redis.pexpire(APP_FAIL_PENDING_KEY, 26 * 3600 * 1000).catch(function () {});
    } catch (e) {
      console.error("[client-event] fail accumulate failed (non-blocking):", e.message);
    }
  })();
}

// 惰性整点合并：任何 client-event 请求都会顺手检查一次；距上次 flush ≥1h 且桶里有货，
// 就把整桶取走（lrange→del，del≥1 才推，天然防并发双推）合并成一条 app_event 汇总。
// 注：Vercel Hobby 的 cron 最小粒度是每天，做不到真正的「整点触发」，这里用
// 「事件驱动的 1 小时节流」近似 —— 没流量的时段汇总顺延到下一个请求到达时补发。
function maybeFlushAppFailDigest() {
  return (async function () {
    try {
      var now = Date.now();
      var last = parseInt(String(await redis.get(APP_FAIL_FLUSH_KEY) || "0"), 10) || 0;
      if (now - last < APP_FAIL_FLUSH_INTERVAL_MS) return;
      var items = await redis.lrange(APP_FAIL_PENDING_KEY, 0, -1);
      if (items && items.length) {
        var deleted = await redis.del(APP_FAIL_PENDING_KEY);
        if (deleted) {
          var byKind = {};
          var order = [];
          for (var i = 0; i < items.length; i++) {
            var it = null;
            try { it = JSON.parse(items[i]); } catch (e) { continue; }
            if (!it || !it.kind) continue;
            if (!byKind[it.kind]) { byKind[it.kind] = { kind: it.kind, kind_cn: (APP_EVENT_KINDS[it.kind] || {}).cn || it.kind, count: 0, sample: "" }; order.push(it.kind); }
            byKind[it.kind].count += 1;
            if (!byKind[it.kind].sample) {
              var bits = [];
              if (it.model) bits.push(it.model);
              if (it.stage) bits.push("stage " + it.stage);
              if (it.reason) bits.push(it.reason);
              byKind[it.kind].sample = bits.join(" · ").slice(0, 80);
            }
          }
          var fails = order.map(function (k) { return byKind[k]; });
          var total = fails.reduce(function (s, f) { return s + f.count; }, 0);
          var bj = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 13).replace("T", " ");
          await notify.pushNotification("app_event", {
            kind: "hourly_fail_digest", kind_cn: "失败汇总",
            hour: bj, total: total, fails: fails,
          });
        }
      }
      await redis.set(APP_FAIL_FLUSH_KEY, String(now));
      await redis.pexpire(APP_FAIL_FLUSH_KEY, 7 * 24 * 3600 * 1000).catch(function () {});
    } catch (e) {
      console.error("[client-event] digest flush failed (non-blocking):", e.message);
    }
  })();
}

// P3/F1：App 客户端事件入口。老 APK 永远不会调这个 section —— 所以这里没有兼容包袱，
//   但新 APK 的报文仍按「可缺省」处理（payload/dedupeKey/install_id 都可空）。
async function handleClientEvent(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Request method not supported" });
    }
    var body = parseBody(req);
    var kind = clipStr(body.kind, 40);
    var meta = APP_EVENT_KINDS[kind];
    if (!meta) {
      return res.status(400).json({ success: false, error: "unknown kind: " + kind });
    }
    var ip = rateLimit.getClientIp(req);
    var ua = String((req.headers && req.headers["user-agent"]) || "unknown");
    var ts = Date.now();
    // 每 IP 每分钟上限（防刷 tracking_events；正常用户一分钟到不了 60 个事件）
    var rlKey = "auth:appev_rl:" + visitorHashKey(ip) + ":" + Math.floor(ts / 60000);
    var rn = await redis.incr(rlKey);
    if (rn === 1) { await redis.pexpire(rlKey, 120000).catch(function () {}); }
    if (rn > APP_EVENT_IP_MAX) {
      return res.status(429).json({ success: false, error: "rate limited" });
    }
    var dev = sanitizeDevice(body);
    var payload = sanitizeEventPayload(body.payload);
    var dedupeKey = clipStr(body.dedupeKey, 160).replace(/\s+/g, "_") || null;
    var vHash = visitorHashKey(ip + "|" + ua.slice(0, 120));

    // 统一事件流（tracking_events）：dedupe_key 唯一 → 客户端带 key 的重报天然幂等
    background.run(tracking.record({
      ts: ts,
      kind: kind,
      ip: ip,
      visitorHash: vHash,
      deviceId: clipStr(body.deviceId, 128),
      installId: dev.install_id,
      watchId: dev.watch_device_id,
      client: "apk",
      channel: "apk",
      payload: Object.assign({}, payload, {
        app_version: dev.app_version, app_variant: dev.app_variant,
        app_open_count: dev.app_open_count, app_upgrade_count: dev.app_upgrade_count,
        watch_node_id: dev.watch_node_id, watch_device_id: dev.watch_device_id,
        watch_connected: dev.watch_connected,
      }),
      dedupeKey: dedupeKey,
    }), "tracking");

    // 推送分级（见 APP_EVENT_KINDS 注释）
    if (meta.push === "realtime") {
      background.run((async function () {
        try {
          var rateKey = "auth:appev_push:" + kind + ":" + Math.floor(Date.now() / APP_EVENT_PUSH_WINDOW_MS);
          var n = await redis.incr(rateKey);
          if (n === 1) { await redis.pexpire(rateKey, APP_EVENT_PUSH_WINDOW_MS).catch(function () {}); }
          if (n > APP_EVENT_PUSH_MAX) {
            console.warn("[client-event] push rate-limited: " + kind + " " + n + " > " + APP_EVENT_PUSH_MAX + "/min");
            return;
          }
          var pushGeo = await getGeoFields(req);
          await notify.pushNotification("app_event", {
            kind: kind, kind_cn: meta.cn,
            install_id: dev.install_id, device_id: dev.watch_device_id,
            device_model: dev.model, device_brand: dev.brand,
            os_version: dev.os, os_brand: dev.os_brand,
            app_version: dev.app_version, app_variant: dev.app_variant,
            watch_connected: dev.watch_connected, watch_model: dev.watch_model,
            watch_ev_version: dev.watch_ev_version,
            ip: ip,
            country: pushGeo.country, region: pushGeo.region, city: pushGeo.city,
            location_zh: pushGeo.location_zh, district_zh: pushGeo.district_zh,
            location_full_zh: pushGeo.location_full_zh,
            payload: payload,
          });
        } catch (e) {
          console.error("[client-event] push failed (non-blocking):", e.message);
        }
      })(), "app-event-push");
    } else if (meta.push === "digest") {
      background.run(accumulateAppFail(kind, payload, dev), "appfail-acc");
    }
    // 惰性 flush 检查（app_open 每次启动都会发事件 → 这里是可靠的触发点）
    background.run(maybeFlushAppFailDigest(), "appfail-flush");

    return res.json({ success: true });
  } catch (e) {
    console.error("[client-event]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}

function visitorHashKey(str) {
  if (!str) return "unknown";
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// 日期分桶统一用北京时间（UTC+8），复用 lib/rate-limit.js 的唯一实现。
// ⚠️ 历史 bug：这里原本用 UTC（且 getTimezoneOffset 公式只在 UTC 运行时成立），
//    导致北京时间 00:00–08:00 的访问被统计到「前一天」的键，后台看「今日访客 / 今日 PV」像没写入。
//    详见 docs/访客记录写入问题分析与核验.md
function visitorTodayKey(ts) {
  return rateLimit.beijingDateKey(ts);
}


// Page path -> Chinese title for visitor notifications
// ⚠️ 只影响「通知/后台里显示什么」，不参与任何判断分支 —— 缺名字的页面退回原 path，不影响埋点。
//    P2/D4：补齐这次新纳入埋点的页面（原来是裸路径，Mac 通知里看着像乱码）。
function pageTitleForPath(p) {
  var map = {
    '/apk/home': '首页（周视图）',
    '/apk/settings': '设置页',
    '/apk/schedules': '课程表管理',
    '/apk/message': '留言页',
    '/apk/transfer': '导入导出',
    '/apk/debug': '调试页',
    '/apk/activate': 'App内激活页',
    '/user-guide.html': '用户指南',
    '/course-guide.html': '使用教程',
    '/activation-guide.html': '激活流程教学动画',
    '/ev-schedule.html': 'EV课程表主页',
    '/ev-timetable.html': 'EV课程表介绍',
    '/apk-download.html': '安卓版下载',
    '/android-apk.html': '安卓APK页面档案',
    '/deep-link-test.html': '激活页（私信深链）',
    '/ui-gallery-9.html': 'UI 截图档案（手环 9）',
    '/feedback.html': '帮助与反馈',
    '/my-ip.html': 'IP查询',
    '/redeem-counts.html': '兑换码数量',
    '/index.html': '首页',
    '/activate.html': '激活页',
    '/activate': '激活页',
    '/ev-login.html': '登录页',
    '/login_aXs12.html': '登录页'
  };
  if (map[p]) return map[p];
  if (p.startsWith('/apk/')) return p.replace('/apk/', '');
  return p;
}

// 页面分组（P2/D5）：画像汇总按「指南 / 激活 / 下载 / 站内 / 工具」出报表。
// 客户端来自 track.js 的 data-group，或 URL 上的 g=<分组>（P1 起的深链就带 g=activate）。
// 白名单限定，避免脏值进库；超出的一律记空。
var ALLOWED_GROUPS = { guide: 1, activate: 1, download: 1, home: 1, tool: 1 };
function normalizeGroup(v) {
  var g = clipStr(v, 24).toLowerCase().replace(/[^a-z_-]/g, "");
  return ALLOWED_GROUPS[g] ? g : "";
}

function clipStr(v, n) {
  return String(v == null ? "" : v).slice(0, n);
}

function clipInt(v) {
  var n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// 毫秒级累计值可能是 64 位（如前台时长），不能用 parseInt
function clipNum(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 激活事件的客户端类型（tracking_events.client）。
 * APK 代激活会在 deviceInfo.source 里写 "apk"（FastActivateActivity.deviceInfo()）；
 * 其余（手环端自发 / 网页激活页）记 evapp。
 * ⚠️ 只是**标注**，不参与任何校验分支 —— 老客户端不带 source 时按 evapp 落，不影响激活成败。
 */
function activationClient(deviceInfo) {
  var s = String((deviceInfo && deviceInfo.source) || "").toLowerCase();
  return s.indexOf("apk") >= 0 ? "apk" : "evapp";
}

/**
 * 激活来源细分（写入记录顶层 act_source，后台「来源」列用）。
 *   apk-deeplink  同步器深链拉起自动填码（trace 参数 uid/channel/orderNo 任一有值）
 *   apk-manual    同步器里手工输入 4 位兑换码
 *   evapp         手环端自发 / 网页激活页（暂无更细分）
 * ⚠️ 只加不改（§6.1）：老记录无此字段，后台按 device_info.source + channel/uid/order_no 兜底推导；
 *    任何读法都必须容忍 act_source 缺失，不许报错。
 */
function activationSource(deviceInfo, channel, uid, orderNo) {
  if (activationClient(deviceInfo) === "apk") {
    return (channel || uid || orderNo) ? "apk-deeplink" : "apk-manual";
  }
  return "evapp";
}

/**
 * 手环历史清单（多手环场景）：SyncEngine 以前只存单个 nodeId，后连接的手环会覆盖前一只。
 * 这里把「当前 + 历史」列表单独收下来（最多 MAX_WATCH_HISTORY 只，逐项限长）。
 * ⚠️ 客户端可控，必须逐项裁剪：条数上限 + 每字段限长 + 只保留白名单键。
 */
var MAX_WATCH_HISTORY = 10;
function sanitizeWatchHistory(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < MAX_WATCH_HISTORY; i++) {
    var it = list[i];
    if (!it || typeof it !== "object") continue;
    var nodeId = clipStr(it.node_id, 64);
    var deviceId = clipStr(it.device_id, 128);
    if (!nodeId && !deviceId) continue;   // 两项全空的历史项没有意义，丢掉
    out.push({
      node_id: nodeId,
      device_id: deviceId,
      device_id4: deviceId ? normalizeDeviceId(deviceId) : "",
      model: clipStr(it.model, 64),
      ev_version: clipStr(it.ev_version, 24),
      first_seen: clipInt(it.first_seen),
      last_seen: clipInt(it.last_seen),
      ok: clipInt(it.ok),
      fail: clipInt(it.fail),
    });
  }
  return out;
}

/**
 * APK 埋点带的设备上下文：白名单字段 + 逐个限长。
 * 埋点体是客户端可控的 JSON，不能原样落库（防超长/防塞任意字段）。
 * 字段口径见仓库文档 apk-tracking-telemetry-spec.md。
 *
 * ⚠️ 向下兼容铁律（分析方案 §6.1）：**只加字段，不改/不删任何已有字段名与层级**。
 *    老版 APK 无法强制升级，会长期以旧格式上报；任何"收不到新字段就报错"的写法都不许出现。
 */
function sanitizeDevice(body) {
  var d = (body && typeof body.device === "object" && body.device) || {};
  var a = (body && typeof body.app === "object" && body.app) || {};
  var w = (body && typeof body.watch === "object" && body.watch) || {};
  // 手环真实 deviceId：新 APK 走 watch.device_id；老 APK 只会在顶层 deviceId 里塞 nodeId
  var watchDeviceId = clipStr(w.device_id != null ? w.device_id : w.deviceId, 128);
  return {
    model: clipStr(d.model, 64),
    brand: clipStr(d.brand, 32),
    manufacturer: clipStr(d.manufacturer, 32),
    os: clipStr(d.os, 32),
    sdk: clipInt(d.sdk),
    os_brand: clipStr(d.os_brand, 16),
    app_version: clipStr(a.version, 24),
    app_code: clipInt(a.code),
    app_variant: clipStr(a.variant, 16),
    first_install: clipInt(a.first_install),
    last_update: clipInt(a.last_update),
    // 本机累计统计（APK-Stats 提供）
    app_upgrade_count: clipInt(a.upgrade_count),
    app_open_count: clipInt(a.open_count),
    app_foreground_ms: clipNum(a.foreground_ms),
    app_last_open: clipInt(a.last_open_ms),
    // 📱 App 同步器维度（新增，见分析方案 §3.3-A1/A3）
    //    install_id = 手机安装实例 ID（新 APK 一定有；老 APK 永远为空）
    install_id: clipStr(body && body.install_id != null ? body.install_id : a.install_id, 64),
    watch_model: clipStr(w.model, 64),
    watch_ev_version: clipStr(w.ev_version, 24),
    watch_ev_code: clipInt(w.ev_code),
    watch_connected: w.connected === true || w.connected === 1,
    watch_node_id: clipStr(w.node_id, 64),
    // 手环真实 deviceId（与激活记录同一把钥匙 → 手机↔手环可合并）
    watch_device_id: watchDeviceId,
    watch_device_id4: watchDeviceId ? normalizeDeviceId(watchDeviceId) : "",
    // 手环连接统计（APK-Stats 提供）：次数 / 成功 / 失败 / 失败步与原因
    watch_connect_total: clipInt(w.connect_total),
    watch_connect_ok: clipInt(w.connect_ok),
    watch_connect_fail: clipInt(w.connect_fail),
    watch_connect_last_ms: clipNum(w.connect_last_ms),
    watch_last_fail_step: clipInt(w.connect_last_fail_step),
    watch_last_fail_reason: clipStr(w.connect_last_fail_reason, 120),
    // 多手环：历史清单（最多 10 只）
    watch_history: sanitizeWatchHistory(w.history),
    nickname: clipStr(body && body.nickname, 64),
  };
}

async function handleVisitorTrack(req, res) {
  try {
    var ipCheck = await rateLimit.checkVisitorIpRateLimit(req);
    if (ipCheck.blocked) {
      return res.status(429).json({ success: false, error: ipCheck.reason });
    }
    var body = parseBody(req);
    // APK 埋点可以直接带 deviceId（优先于 query 里的 ?deviceId=），供 tracking_events 归因
    var bodyDeviceId = String(body.deviceId || "");
    var dev = sanitizeDevice(body);
    // P2/D5：页面分组。优先 body.group（来自 js/track.js 的 data-group），
    //   退回 URL 上的 g=（P1 起的私信深链带 g=activate）；都不合法则记空串（不进报表）。
    var bodyGroup = normalizeGroup(body.group);
    // 前端发的是 pathname + search；这里拆成两列：
    //   path  → 只留 pathname（否则「热门页面」会被 ?deviceId=1 / ?deviceId=2 分裂成无数条）
    //   query → 完整参数串，长期留存在 visitor_logs.query / params，供渠道归因
    var rawPath = String(body.path || body.href || (req.query && req.query.path) || "/");
    var splitAt = rawPath.indexOf("?");
    var path = splitAt >= 0 ? rawPath.slice(0, splitAt) : rawPath;
    var fullQuery = splitAt >= 0
      ? rawPath.slice(splitAt + 1)
      : String(body.query || (req.query && req.query.query) || "");
    if (!path) path = "/";
    var queryParams = null;
    if (fullQuery) {
      queryParams = {};
      fullQuery.split("&").forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf("=");
        try {
          queryParams[decodeURIComponent(i >= 0 ? pair.slice(0, i) : pair)] =
            decodeURIComponent((i >= 0 ? pair.slice(i + 1) : "").replace(/\+/g, " "));
        } catch (e) {}
      });
      if (Object.keys(queryParams).length === 0) queryParams = null;
    }
    var ua = String((req.headers && req.headers["user-agent"]) || "unknown");
    var ref = String(body.ref || (req.query && req.query.ref) || "");
    var ts = Date.now();
    var dateKey = visitorTodayKey(ts);
    var ip = rateLimit.getClientIp(req);
    var vHash = visitorHashKey(ip + "|" + ua.slice(0, 120));
    var uvKey = "stats:uv:" + dateKey;
    var pvKey = "stats:pv:" + dateKey;
    var pagesKey = "stats:pages:" + dateKey;
    var recentKey = "stats:recent";
    var trimmedPath = path.length > 120 ? path.slice(0, 120) : path;
    var isNew = await redis.sadd(uvKey, vHash);
    if (isNew === 1) { await redis.pexpire(uvKey, VISITOR_TTL * 1000).catch(function () {}); }
    await redis.incr(pvKey);
    await redis.pexpire(pvKey, VISITOR_TTL * 1000).catch(function () {});
    var curScore = 0;
    try {
      var zr = await redis.zrange(pagesKey, 0, -1, { withScores: true });
      for (var zi = 0; zi < zr.length; zi += 2) {
        if (zr[zi] === trimmedPath) { curScore = parseFloat(zr[zi + 1]) || 0; break; }
      }
    } catch (e) {}
    await redis.zadd(pagesKey, curScore + 1, trimmedPath);
    await redis.pexpire(pagesKey, VISITOR_TTL * 1000).catch(function () {});
    // 注：stats:recent 是 LIST（kv_lists 表没有 expires_at 列），pexpire 对它无效，
    // 这里靠下面的 ltrim 控制容量（保留最近 ~100 条），不要再写无意义的 pexpire。
    await redis.lpush(recentKey, JSON.stringify({
      h: vHash.slice(0, 8),
      p: trimmedPath,
      u: ua.slice(0, 80),
      r: ref.slice(0, 80),
      t: ts,
      ip: ip.slice(0, 45),
      c: String(req.headers["x-vercel-ip-country"] || "").slice(0, 8),
      rg: String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16),
      ci: geoZh.decodeGeoValue(String(req.headers["x-vercel-ip-city"] || "")).slice(0, 40),
      tz: String(req.headers["x-vercel-ip-timezone"] || "").slice(0, 40),
      q: fullQuery.slice(0, 500),
    }));
    await redis.ltrim(recentKey, 0, 99);

    // ⭐ 永久日志（业务表 visitor_logs）：放在响应之后执行，不占用用户等待时间。
    //    KV 的 stats:recent 只留 ~100 条、日报 7 天过期，长期存档靠这张表。
    // App 同步器维度（§3.3-B2）：手环**真实** deviceId 只从这两处取 ——
    //   ① 新 APK 上报的 watch.device_id；② 网页 query 里的 ?deviceId=（激活页/QR 过来的真实设备号）。
    // ⚠️ 老 APK 把 XMS 数字 nodeId 塞在顶层 deviceId / watch.node_id 里，是**另一套编号**，
    //    这里刻意不混入，避免两套编号在同一列互相污染（§6.1-K1）。
    var watchDeviceId = dev.watch_device_id || (queryParams && queryParams.deviceId ? String(queryParams.deviceId) : "");
    background.run(
      visitorLog.logVisit({
        device: dev,
        ts: ts,
        ip: ip,
        path: trimmedPath,
        ua: ua,
        ref: ref,
        country: req.headers["x-vercel-ip-country"] || "",
        region: req.headers["x-vercel-ip-country-region"] || "",
        city: geoZh.decodeGeoValue(req.headers["x-vercel-ip-city"] || ""),
        hash: vHash,
        source: "visit",
        query: fullQuery,
        params: queryParams,
        installId: dev.install_id,
        watchDeviceId: watchDeviceId,
      }),
      "visitor-log"
    );

    // 中文归属地自动补齐（境外 IP 靠腾讯永远写不进 ip_lookups，必须补一次境外源）
    background.run(ipWarmup.warmup(ip), "ip-warmup");

    // 统一事件流（tracking_events）：供漏斗 / 画像汇总使用，失败不影响埋点响应
    // client 判定：带 app 上下文的必是 APK；老 APK 会在 tracking 的 resolveIdentity 里
    //   被进一步识别为 legacy-apk（它没有 install_id，deviceId 是数字 nodeId）。
    background.run(tracking.record({
      ts: ts,
      kind: "visit",
      ip: ip,
      visitorHash: vHash,
      deviceId: bodyDeviceId || (queryParams ? queryParams.deviceId || "" : ""),
      installId: dev.install_id,
      watchId: watchDeviceId,
      client: (dev.app_version || dev.app_variant || dev.watch_node_id) ? "apk" : "web",
      channel: queryParams ? queryParams.c || "" : "",
      payload: {
        path: path, query: fullQuery, params: queryParams || {}, ua: ua.slice(0, 200), ref: ref.slice(0, 200),
        // 页面分组（P2/D5）：画像汇总按它分「指南 / 激活 / 下载 / 站内 / 工具」出报表
        group: bodyGroup || normalizeGroup(queryParams && queryParams.g) || "",
        // App 同步器维度明细（老客户端不带，读取侧需容忍缺省）
        app_version: dev.app_version, app_variant: dev.app_variant,
        watch_node_id: dev.watch_node_id, watch_device_id: dev.watch_device_id,
      },
      dedupeKey: null,
    }), "tracking");

    // ⭐ 让「APK / 网页访问」也出现在后台「消息投递」追踪（排查丢通知用），并推给 Mac。
    //    统一用标准 `page_visit` 类型：与 api/admin/health.js 的网页埋点同一套模板，
    //    客户端已有中文弹窗 + 中文语音，后台也能按「访问」筛选（旧类型 `visit` 客户端无模板）。
    //    节流：见 VISIT_PUSH_MAX（全局每分钟上限），超出的只落库、不推通知。
    background.run((async function () {
      try {
        var rateKey = "auth:visit_push_rate:" + Math.floor(Date.now() / VISIT_PUSH_WINDOW_MS);
        var n = await redis.incr(rateKey);
        if (n === 1) {
          await redis.pexpire(rateKey, VISIT_PUSH_WINDOW_MS).catch(function () {});
        }
        if (n > VISIT_PUSH_MAX) {
          console.warn("[visitor/track] visit push rate-limited: " + n + " > " + VISIT_PUSH_MAX + "/min");
          return;
        }
        var pushGeo = await getGeoFields(req);
        await notify.pushNotification("page_visit", {
          page: path,
          referrer: ref,
          title: pageTitleForPath(path),
          user_agent: ua.slice(0, 200),
          ip: ip,
          country: pushGeo.country,
          region: pushGeo.region,
          city: pushGeo.city,
          location_zh: pushGeo.location_zh,
          district_zh: pushGeo.district_zh,
          location_full_zh: pushGeo.location_full_zh,
          // 手机 / APK / 手环上下文：Mac 端据此播报「安卓<型号>用户访问…」并展示连接状态
          device_model: dev.model,
          device_brand: dev.brand,
          os_version: dev.os,
          os_brand: dev.os_brand,
          app_version: dev.app_version,
          app_variant: dev.app_variant,
          watch_connected: dev.watch_connected,
          watch_model: dev.watch_model,
          watch_ev_version: dev.watch_ev_version,
        });
      } catch (e) {
        console.error("[visitor/track] visit push failed (non-blocking):", e.message);
      }
    })(), "visit-push");

    return res.json({ success: true, isNewVisitor: isNew === 1 });
  } catch (e) {
    console.error("[visitor/track]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}

function parseBody(req) {
  var body = req.body;
  if (body == null || body === "") return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return body;
}

function parseRedisJson(value) {
  var cur = value;
  var guard = 0;
  while (typeof cur === "string" && guard < 3) {
    try {
      cur = JSON.parse(cur);
    } catch (e) {
      break;
    }
    guard++;
  }
  return cur && typeof cur === "object" ? cur : null;
}

function normalizeProductId(productId) {
  var n = parseInt(productId, 10);
  if (!Number.isFinite(n) || n < 0 || n > 99) return null;
  return crypto.pad2(n);
}

function normalizeMonths(months) {
  var n = parseInt(months, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return n;
}

function saveFailureRecord(reason, deviceId, redeemCode, productId, months, visitorInfo, deviceInfo) {
  var now = Date.now();
  var rnd = Math.random().toString(36).slice(2, 6);
  var key = "auth:activation_failure:" + now + ":" + rnd;
  // 统一事件流：所有激活失败（含限流 / 校验失败 / 码不存在）都记一条，漏斗里能看到卡在哪一步
  background.run(tracking.record({
    ts: now,
    kind: "failure",
    deviceId: deviceId || "",
    ip: (visitorInfo && visitorInfo.ip) || "",
    redeemCode: redeemCode || "",
    channel: (deviceInfo && deviceInfo.source) || "",
    payload: { reason: reason, product_id: productId || "", months: months || "", model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "" },
    dedupeKey: null,
  }), "tracking");
  var record = {
    status: "failure",
    reason: reason,
    device_id: deviceId || "",
    device_id_full: deviceId || "",
    redeem_code: redeemCode || "",
    product_id: productId || "",
    duration_months: months || "",
    generated_at: now,
    device_info: deviceInfo || null,
    visitor_info: visitorInfo || null,
  };
  return Promise.all([
    redis.set(key, JSON.stringify(record)),
    redis.sadd("auth:activation_failures", key),
  ]).catch(function (e) {
    console.error("[activate] Failed to save failure record:", e.message);
  });
}

function buildNotificationStatus(result) {
  if (result && result.sent) return "sent";
  if (result && result.error) return "email_failed";
  return "skipped";
}

// ⚠️ redis.pipeline().exec() 在 lib/redis.js 里会把**每条命令的异常吞成 null**（只 push(null)，不抛错）。
//    因此 `set("auth:activation:<码>")` 失败而 `sadd("auth:activation_codes", <码>)` 成功时，
//    集合里就有 member、kv_strings 里却没有 value → 记录在后台凭空消失，且因为没有异常而无人知晓。
//    这里把 null 结果定位到具体命令并**主动推送告警**，保证这类数据缺失不再静默。
//    详见 docs/激活记录丢失问题分析与修复方案.md 根因 4。
async function reportPipelineFailures(results, ops, ctx) {
  if (!results || !results.length) return 0;
  var failed = [];
  for (var i = 0; i < results.length; i++) {
    if (results[i] === null) failed.push(ops[i] || ("op#" + i));
  }
  if (!failed.length) return 0;
  ctx = ctx || {};
  console.error("[activate] pipeline failed ops:", failed, results);
  await notify.pushNotification("activation_failure", {
    reason: (ctx.reasonPrefix || "写库部分失败") + "：" + failed.join(" / "),
    redeem_code: ctx.redeemCode || "",
    activation_code: ctx.activationCode || "",
    device_id: ctx.device || "",
    source: ctx.source || "user",
    ip: (ctx.visitorInfo && ctx.visitorInfo.ip) || "",
    user_agent: (ctx.visitorInfo && ctx.visitorInfo.userAgent) || "",
    visitor_info: ctx.visitorInfo || {},
    device_info: ctx.deviceInfo || {},
    country: (ctx.geo && ctx.geo.country) || "",
    region: (ctx.geo && ctx.geo.region) || "",
    city: (ctx.geo && ctx.geo.city) || "",
    location_zh: (ctx.geo && ctx.geo.location_zh) || "",
    district_zh: (ctx.geo && ctx.geo.district_zh) || "",
    location_full_zh: (ctx.geo && ctx.geo.location_full_zh) || "",
  }).catch(function (e) {
    console.error("[activate] pipeline-failure notify failed:", e.message);
  });
  return failed.length;
}

module.exports = async (req, res) => {
  if (req.query && req.query.section === "visitor-track") {
    return handleVisitorTrack(req, res);
  }
  // P3/F1：App 客户端事件（连接/导入导出/激活/升级）。不新建文件（Vercel 10 函数上限已超）。
  if (req.query && req.query.section === "client-event") {
    return handleClientEvent(req, res);
  }

  try { quota.bumpQuotaTick("/api/activate"); } catch (_) {}
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Request method not supported" });
  }

  var body = parseBody(req);
  var rawDeviceId = body.deviceId;
  var rawRedeemCode = body.redeemCode;
  var deviceInfo = body.deviceInfo || null;
  // P1（§4.1）：深链带来的溯源参数。老 APK 不会发这三个字段 → 一律按缺省处理，不报错。
  //   uid     = 用户独立识别码（od-xxxxxxxx / da-<批次>）
  //   orderNo = 订单号原文（比 uid 更权威，能直接和爱发电订单对上）
  //   channel = 渠道（c=，如 t-9p-d / afdian-dm / admin-direct / apk-fast）
  var bodyUid = clipStr(body.uid, 32).replace(/[^0-9A-Za-z_-]/g, "");
  var bodyOrderNo = clipStr(body.orderNo, 64).replace(/[^0-9A-Za-z_-]/g, "");
  var bodyChannel = clipStr(body.channel, 32).replace(/[^0-9A-Za-z_-]/g, "");
  var visitorInfo = notify.collectRequestInfo(req);
  // 与限流检查并行：getGeoFields 只查一次区县缓存（不联网），不额外占用用户等待时间
  var geoPromise = getGeoFields(req);

  var ipCheck = await rateLimit.checkIpRateLimit(req);
  var geo = await geoPromise;
  if (ipCheck.blocked) {
    saveFailureRecord(ipCheck.reason, rawDeviceId, rawRedeemCode, "", "", visitorInfo, deviceInfo);
    var ipNotifyResult = await notify.sendActivationFailure(req, {
      reason: ipCheck.reason,
      redeemCode: rawRedeemCode || "",
      deviceId: rawDeviceId || "",
      productId: "",
      months: "",
      source: "user",
    }).catch(function () {});
    await notify.pushNotification("activation_failure", {
      reason: ipCheck.reason,
      redeem_code: rawRedeemCode || "",
      device_id: rawDeviceId || "",
      source: "user",
      ip: visitorInfo ? visitorInfo.ip : "",
      user_agent: visitorInfo ? visitorInfo.userAgent : "",
      visitor_info: visitorInfo || {},
      device_info: deviceInfo || {},
      country: geo.country,
      region: geo.region,
      city: geo.city,
      location_zh: geo.location_zh,
      district_zh: geo.district_zh,
      location_full_zh: geo.location_full_zh,
    }).catch(function () {});
    res.setHeader("Retry-After", Math.ceil(ipCheck.retryAfterMs / 1000));
    return res.status(429).json({ success: false, error: ipCheck.reason, debug: { visitor: visitorInfo, notification: buildNotificationStatus(ipNotifyResult), reason: ipCheck.reason } });
  }

  try {
    var deviceId = rawDeviceId;
    var redeemCode = rawRedeemCode;

    var deviceCheck = validateDeviceId(deviceId);
    var device = deviceCheck.value;
    if (!deviceCheck.valid) {
      // 无效设备ID（如手环取不到 ID 回落的 "NA"）单独成一档，后台漏斗可见、可告警
      // 详见 docs/设备ID为NA无效值拦截与反馈引导方案.md
      var deviceFailReason = deviceCheck.code === "DEVICE_ID_INVALID"
        ? "设备ID无效(" + (deviceCheck.raw || "") + ")"
        : deviceCheck.error;
      saveFailureRecord(deviceFailReason, deviceId, redeemCode, "", "", visitorInfo, deviceInfo);
      var deviceNotifyResult = await notify.sendActivationFailure(req, {
        reason: deviceFailReason,
        redeemCode: redeemCode || "",
        deviceId: deviceId || "",
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: deviceFailReason,
        redeem_code: redeemCode || "",
        device_id: deviceId || "",
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      // code 供前端分支（DEVICE_ID_INVALID / DEVICE_ID_EMPTY）；群号不写在这里，前端去页面底部取
      return res.status(400).json({ success: false, code: deviceCheck.code, error: deviceCheck.error, debug: { visitor: visitorInfo, notification: buildNotificationStatus(deviceNotifyResult), reason: deviceFailReason } });
    }

    var codeCheck = validateRedeemCode(redeemCode);
    if (!codeCheck.valid) {
      saveFailureRecord(codeCheck.error, device, redeemCode, "", "", visitorInfo, deviceInfo);
      var codeNotifyResult = await notify.sendActivationFailure(req, {
        reason: codeCheck.error,
        redeemCode: redeemCode || "",
        deviceId: deviceCheck.value || "",
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: codeCheck.error,
        redeem_code: redeemCode || "",
        device_id: deviceCheck.value || "",
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      return res.status(400).json({ success: false, error: codeCheck.error, debug: { visitor: visitorInfo, notification: buildNotificationStatus(codeNotifyResult), reason: codeCheck.error } });
    }

    var code = codeCheck.value;

    var deviceCheck2 = await rateLimit.checkDeviceRateLimit(device, code);
    if (deviceCheck2.blocked) {
      saveFailureRecord(deviceCheck2.reason, device, code, "", "", visitorInfo, deviceInfo);
      var device2NotifyResult = await notify.sendActivationFailure(req, {
        reason: deviceCheck2.reason,
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: deviceCheck2.reason,
        redeem_code: code,
        device_id: device,
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      res.setHeader("Retry-After", Math.ceil(deviceCheck2.retryAfterMs / 1000));
      return res.status(429).json({ success: false, error: deviceCheck2.reason, debug: { visitor: visitorInfo, notification: buildNotificationStatus(device2NotifyResult), reason: deviceCheck2.reason } });
    }

    var deviceHash = crypto.sha256(device);

    var codeData = await redis.get("auth:redeem:" + code);
    if (!codeData) {
      saveFailureRecord("兑换码不存在", device, code, "", "", visitorInfo, deviceInfo);
      var codeNotFoundResult = await notify.sendActivationFailure(req, {
        reason: "兑换码不存在或尚未同步到服务器",
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: "兑换码不存在或尚未同步到服务器",
        redeem_code: code,
        device_id: device,
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      return res.status(400).json({ success: false, error: "兑换码不存在或尚未同步到服务器，请在管理后台同步后重试", debug: { visitor: visitorInfo, notification: buildNotificationStatus(codeNotFoundResult), reason: "兑换码不存在" } });
    }

    var info = parseRedisJson(codeData);
    var infoOutTradeNo = (info && info.out_trade_no) || "";   // 爱发电渠道的码才有，用于事件流关联订单
    // P1（§4.1）：激活侧溯源三件套。优先级：
    //   请求带来的（深链最权威）> 兑换码记录里存的（发码时写入）> 空（渠道再退回 deviceInfo.source）
    // ⚠️ 老码没有 uid/channel 字段，老 APK 也不发这三个参数 → 全部走缺省，行为与改造前一致。
    var actOrderNo = bodyOrderNo || infoOutTradeNo || "";
    var actUid = bodyUid || (info && info.uid) || "";
    var actChannel = bodyChannel || (info && info.channel) || "";
    if (!info) {
      saveFailureRecord("兑换码数据已损坏", device, code, "", "", visitorInfo, deviceInfo);
      var corruptNotifyResult = await notify.sendActivationFailure(req, {
        reason: "兑换码数据已损坏",
        redeemCode: code,
        deviceId: device,
        productId: "",
        months: "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: "兑换码数据已损坏",
        redeem_code: code,
        device_id: device,
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      console.error("Activate: invalid redeem payload", typeof codeData, codeData);
      return res.status(500).json({ success: false, error: "兑换码数据已损坏，请联系管理员", debug: { visitor: visitorInfo, notification: buildNotificationStatus(corruptNotifyResult), reason: "兑换码数据已损坏" } });
    }

    var productId = normalizeProductId(info.product_id);
    var months = normalizeMonths(info.duration_months);
    if (!productId || !months) {
      saveFailureRecord("兑换码配置异常（商品或时长无效）", device, code, info.product_id || "", info.duration_months || "", visitorInfo, deviceInfo);
      var configNotifyResult = await notify.sendActivationFailure(req, {
        reason: "兑换码配置异常（商品或时长无效）",
        redeemCode: code,
        deviceId: device,
        productId: info.product_id || "",
        months: info.duration_months || "",
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: "兑换码配置异常（商品或时长无效）",
        redeem_code: code,
        device_id: device,
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      console.error("Activate: bad product/duration", info.product_id, info.duration_months);
      return res.status(500).json({
        success: false,
        error: "兑换码配置异常（商品或时长无效），请联系管理员",
        debug: { visitor: visitorInfo, notification: buildNotificationStatus(configNotifyResult), reason: "兑换码配置异常" },
      });
    }

    if (info.used) {
      if (info.used_device_id === deviceHash) {
        var activationCodeReuse = crypto.generateActivationCode(
          productId,
          device,
          months,
          code
        );
        var reuseNow = Date.now();
        // ⚠️ 复用（同一兑换码 + 同一设备二次激活）**不再覆盖首次那条记录**：
        //    首次记录 auth:activation:<激活码> 原样保留（历史不许丢），
        //    本次追加 auth:activation:<激活码>:<第几次>（带 activation_seq，后台标「第 N 次激活」）。
        //    详见 docs/激活记录丢失问题分析与修复方案.md
        var firstRecordRaw = await redis.get("auth:activation:" + activationCodeReuse);
        var firstRecord = parseRedisJson(firstRecordRaw) || {};
        var reuseExpires = null;
        if (months !== 99) {
          var baseTs = reuseNow;
          if (firstRecord.expires_at && Number(firstRecord.expires_at) > baseTs) {
            baseTs = Number(firstRecord.expires_at);
          }
          var rd = new Date(baseTs);
          rd.setUTCMonth(rd.getUTCMonth() + months);
          reuseExpires = rd.getTime();
        }
        // 序号：优先用兑换码记录上累计的（不依赖首次记录），退回首次记录上的，最后兜底 1
        var prevSeq = Number(info.activation_seq) || Number(firstRecord.activation_seq) || 1;
        var reuseSeq = prevSeq + 1;
        var reuseMember = activationCodeReuse + ":" + reuseSeq;
        var repeatRecord = null;
        if (activationCodeReuse) {
          repeatRecord = {
            activation_code: activationCodeReuse,
            activation_member: reuseMember,
            activation_seq: reuseSeq,
            is_repeat: true,
            first_activated_at: firstRecord.first_activated_at || firstRecord.generated_at || reuseNow,
            device_id_hash: deviceHash,
            device_id: device,
            device_id_full: rawDeviceId,
            product_id: productId,
            duration_months: months,
            redeem_code: code,
            generated_at: reuseNow,
            expires_at: reuseExpires,
            device_info: deviceInfo || firstRecord.device_info || null,
            visitor_info: visitorInfo,
            // P1（§4.1）：激活记录直接带「订单 ↔ 用户 ↔ 渠道」，后台不必再反查
            order_no: actOrderNo,
            order_uid: actUid,
            channel: actChannel,
            act_source: activationSource(deviceInfo, actChannel, actUid, actOrderNo),
          };
        }
        info.generated_activation_code = activationCodeReuse;
        info.product_id = productId;
        info.duration_months = months;
        info.used_at = reuseNow;
        info.activation_seq = reuseSeq;
        var reusePipeline = redis.pipeline();
        var reuseOps = [];
        reusePipeline.set("auth:redeem:" + code, JSON.stringify(info));
        reuseOps.push("set auth:redeem:" + code);
        reusePipeline.set("auth:device:" + deviceHash, activationCodeReuse);
        reuseOps.push("set auth:device:" + deviceHash.slice(0, 8) + "...");
        if (repeatRecord) {
          reusePipeline.set("auth:activation:" + reuseMember, JSON.stringify(repeatRecord));
          reuseOps.push("set auth:activation:" + reuseMember);
          reusePipeline.sadd("auth:activation_codes", reuseMember);
          reuseOps.push("sadd auth:activation_codes " + reuseMember);
        }
        var reuseResults = await reusePipeline.exec();
        await reportPipelineFailures(reuseResults, reuseOps, {
          reasonPrefix: "复用激活写库部分失败",
          redeemCode: code,
          device: device,
          activationCode: reuseMember,
          source: "user-reuse",
          visitorInfo: visitorInfo,
          deviceInfo: deviceInfo,
          geo: geo,
        });

        background.run(tracking.record({
          ts: reuseNow,
          kind: "activation",
          deviceId: rawDeviceId || device,
          ip: (visitorInfo && visitorInfo.ip) || "",
          redeemCode: code,
          outTradeNo: actOrderNo,
          activationCode: activationCodeReuse,
          channel: actChannel || (deviceInfo && deviceInfo.source) || "",
          client: activationClient(deviceInfo),
          payload: {
            product_id: productId, months: months, reuse: true, activation_seq: reuseSeq,
            uid: actUid,
            model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "",
            product: (deviceInfo && deviceInfo.product) || "",
          },
          dedupeKey: "ac:" + reuseMember,
        }), "tracking");

        notify.sendActivationNotification(req, {
          redeemCode: code,
          activationCode: activationCodeReuse,
          productId: productId,
          deviceId: device,
          months: months,
          deviceInfo: deviceInfo,
          source: "user-reuse",
        }).catch(function (e) {
          console.error("[activate] Notification failed:", e.message);
        });

        await notify.pushNotification("new_activation", {
          redeem_code: code,
          activation_code: activationCodeReuse,
          product_id: productId,
          device_id: device,
          months: months,
          activation_seq: reuseSeq,
          source: "user-reuse",
          ip: visitorInfo ? visitorInfo.ip : "",
          user_agent: visitorInfo ? visitorInfo.userAgent : "",
          country: geo.country,
          region: geo.region,
          city: geo.city,
          location_zh: geo.location_zh,
          district_zh: geo.district_zh,
          location_full_zh: geo.location_full_zh,
        }).catch(function () {});

        rateLimit.clearDeviceRateLimit(device).catch(function () {});

        return res.json({ success: true, activationCode: activationCodeReuse, debug: { visitor: visitorInfo, notification: "success", productId: productId, months: months } });
      }

      // 不同设备使用同一兑换码 → 先判断是否 NA 设备且在次数上限内
      var deviceIsNa = isNaDeviceId(rawDeviceId);
      var naLimit = Number(info.na_usage_limit) || NA_USAGE_LIMIT_DEFAULT;
      var naCount = Number(info.na_usage_count) || 0;

      if (deviceIsNa && naCount < naLimit) {
        var activationCodeNa = crypto.generateActivationCode(productId, device, months, code);
        var naNow = Date.now();
        var naPrevSeq = Number(info.activation_seq) || 0;
        var naPrevRecord = parseRedisJson(await redis.get("auth:activation:" + activationCodeNa));
        var naFirstActivatedAt = naNow;
        if (naPrevRecord) {
          naFirstActivatedAt = naPrevRecord.first_activated_at || naPrevRecord.generated_at || naNow;
          if ((Number(naPrevRecord.activation_seq) || 0) > naPrevSeq) naPrevSeq = Number(naPrevRecord.activation_seq);
        }
        var naFinalSeq = naPrevSeq + 1;
        var naMember = activationCodeNa + ":" + naFinalSeq;

        var naExpiresAt = null;
        if (months !== 99) {
          var naBaseTs = naNow;
          if (naPrevRecord && naPrevRecord.expires_at && Number(naPrevRecord.expires_at) > naBaseTs) {
            naBaseTs = Number(naPrevRecord.expires_at);
          }
          var naExpiryDate = new Date(naBaseTs);
          naExpiryDate.setUTCMonth(naExpiryDate.getUTCMonth() + months);
          naExpiresAt = naExpiryDate.getTime();
        }

        var naUpdated = JSON.parse(JSON.stringify(info));
        naUpdated.na_usage_count = naCount + 1;
        naUpdated.used_device_id = deviceHash;
        naUpdated.used_at = naNow;
        naUpdated.activation_seq = naFinalSeq;
        naUpdated.generated_activation_code = activationCodeNa;

        var naRecord = {
          activation_code: activationCodeNa,
          activation_member: naMember,
          activation_seq: naFinalSeq,
          is_repeat: true,
          is_na: true,
          na_device_index: naCount + 1,
          first_activated_at: naFirstActivatedAt,
          device_id_hash: deviceHash,
          device_id: device,
          device_id_full: rawDeviceId,
          product_id: productId,
          duration_months: months,
          redeem_code: code,
          generated_at: naNow,
          expires_at: naExpiresAt,
          device_info: deviceInfo || null,
          visitor_info: visitorInfo,
          // P1（§4.1）：NA（多设备）分支同样带上溯源字段
          order_no: actOrderNo,
          order_uid: actUid,
          channel: actChannel,
          act_source: activationSource(deviceInfo, actChannel, actUid, actOrderNo),
        };

        var naPipeline = redis.pipeline();
        naPipeline.set("auth:redeem:" + code, JSON.stringify(naUpdated));
        naPipeline.set("auth:activation:" + naMember, JSON.stringify(naRecord));
        naPipeline.sadd("auth:activation_codes", naMember);
        naPipeline.set("auth:device:" + deviceHash, activationCodeNa);
        var naResults = await naPipeline.exec();
        await reportPipelineFailures(naResults, ["set auth:redeem:" + code, "set auth:activation:" + naMember], {
          reasonPrefix: "NA设备激活写库部分失败",
          redeemCode: code,
          device: device,
          activationCode: naMember,
          source: "user-na",
          visitorInfo: visitorInfo,
          deviceInfo: deviceInfo,
          geo: geo,
        });

        background.run(tracking.record({
          ts: naNow,
          kind: "activation",
          deviceId: rawDeviceId || device,
          ip: (visitorInfo && visitorInfo.ip) || "",
          redeemCode: code,
          outTradeNo: actOrderNo,
          activationCode: activationCodeNa,
          channel: actChannel || (deviceInfo && deviceInfo.source) || "",
          client: activationClient(deviceInfo),
          payload: {
            product_id: productId, months: months,
            is_na: true, na_device_index: naCount + 1, activation_seq: naFinalSeq,
            uid: actUid,
            model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "",
            product: (deviceInfo && deviceInfo.product) || "",
          },
          dedupeKey: "ac:" + naMember,
        }), "tracking");

        await notify.pushNotification("new_activation", {
          redeem_code: code,
          activation_code: activationCodeNa,
          product_id: productId,
          device_id: device,
          months: months,
          is_na: true,
          na_usage: (naCount + 1) + "/" + naLimit,
          source: "user-na",
          ip: visitorInfo ? visitorInfo.ip : "",
          user_agent: visitorInfo ? visitorInfo.userAgent : "",
          country: geo.country,
          region: geo.region,
          city: geo.city,
          location_zh: geo.location_zh,
          district_zh: geo.district_zh,
          location_full_zh: geo.location_full_zh,
        }).catch(function () {});

        rateLimit.clearDeviceRateLimit(device).catch(function () {});

        return res.json({
          success: true,
          activationCode: activationCodeNa,
          naDevice: true,
          naUsage: (naCount + 1) + "/" + naLimit,
          debug: { visitor: visitorInfo, notification: "success", productId: productId, months: months },
        });
      }

      saveFailureRecord("该兑换码已被其他设备使用过", device, code, productId, months, visitorInfo, deviceInfo);
      var alreadyUsedNotifyResult = await notify.sendActivationFailure(req, {
        reason: "该兑换码已被其他设备使用过，无法重复激活。如需解绑请联系作者（QQ群/微信）" + (deviceIsNa ? "（NA设备使用次数已达上限 " + naCount + "/" + naLimit + "）" : ""),
        redeemCode: code,
        deviceId: device,
        productId: productId,
        months: months,
        source: "user",
      }).catch(function () {});
      await notify.pushNotification("activation_failure", {
        reason: "该兑换码已被其他设备使用过",
        redeem_code: code,
        device_id: device,
        source: "user",
        ip: visitorInfo ? visitorInfo.ip : "",
        user_agent: visitorInfo ? visitorInfo.userAgent : "",
        visitor_info: visitorInfo || {},
        device_info: deviceInfo || {},
        country: geo.country,
        region: geo.region,
        city: geo.city,
        location_zh: geo.location_zh,
        district_zh: geo.district_zh,
        location_full_zh: geo.location_full_zh,
      }).catch(function () {});
      return res.status(400).json({
        success: false,
        error: "该兑换码已被其他设备使用过，无法重复激活。如需解绑请联系作者（QQ群/微信）" + (deviceIsNa ? "（NA设备使用次数已达上限 " + naCount + "/" + naLimit + "）" : ""),
        debug: { visitor: visitorInfo, notification: buildNotificationStatus(alreadyUsedNotifyResult), reason: "该兑换码已被其他设备使用过" },
      });
    }

    var activationCode = crypto.generateActivationCode(
      productId,
      device,
      months,
      code
    );

    var now = Date.now();
    var expiresAt = null;
    if (months !== 99) {
      var d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + months);
      expiresAt = d.getTime();
    }

    // 同一激活码之前已有记录（典型：解绑后在同一设备重新激活）→ 同样**追加** <激活码>:<第几次>，
    // 不覆盖首次那条（历史不许丢）。激活码是确定性函数，解绑再激活算出的还是同一个码。
    // 注意：解绑后也可能换了设备 → 激活码不同、老记录不存在 → 这种情况仍算该码的第 1 次。
    var prevSeq = Number(info.activation_seq) || 0;
    var firstActivatedAt = now;
    if (prevSeq >= 1) {
      var prevRecord = parseRedisJson(await redis.get("auth:activation:" + activationCode));
      if (prevRecord) {
        firstActivatedAt = prevRecord.first_activated_at || prevRecord.generated_at || now;
        if ((Number(prevRecord.activation_seq) || 0) > prevSeq) prevSeq = Number(prevRecord.activation_seq);
      } else {
        prevSeq = 0;
      }
    }
    var activationSeq = prevSeq + 1;
    var activationMember = activationSeq > 1 ? (activationCode + ":" + activationSeq) : activationCode;

    var updated = {
      code: info.code || code,
      product_id: productId,
      duration_months: months,
      used: true,
      used_device_id: deviceHash,
      generated_activation_code: activationCode,
      created_at: info.created_at || now,
      used_at: now,
      activation_seq: activationSeq,
    };

    // 统一事件流：激活成功节点（dedupe 用集合成员，保证多次激活各自成条）
    background.run(tracking.record({
      ts: now,
      kind: "activation",
      deviceId: rawDeviceId || device,
      ip: (visitorInfo && visitorInfo.ip) || "",
      redeemCode: code,
      outTradeNo: actOrderNo,
      activationCode: activationCode,
      channel: actChannel || (deviceInfo && deviceInfo.source) || "",
      client: activationClient(deviceInfo),
      payload: {
        product_id: productId, months: months, activation_seq: activationSeq,
        uid: actUid,
        model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "",
        product: (deviceInfo && deviceInfo.product) || "",
        rom: (deviceInfo && deviceInfo.romVersion) || "",
      },
      dedupeKey: "ac:" + activationMember,
    }), "tracking");

    var record = {
      activation_code: activationCode,
      activation_member: activationMember,
      activation_seq: activationSeq,
      is_repeat: activationSeq > 1,
      first_activated_at: firstActivatedAt,
      device_id_hash: deviceHash,
      device_id: device,
      device_id_full: rawDeviceId,
      product_id: productId,
      duration_months: months,
      redeem_code: code,
      generated_at: now,
      expires_at: expiresAt,
      device_info: deviceInfo || null,
      visitor_info: visitorInfo,
      // P1（§4.1）：激活记录直接带「订单 ↔ 用户 ↔ 渠道」，后台不必再反查
      order_no: actOrderNo,
      order_uid: actUid,
      channel: actChannel,
      act_source: activationSource(deviceInfo, actChannel, actUid, actOrderNo),
    };

    var USED_COUNTER_KEY = "auth:counter:used_redeem_codes";
    var writePipeline = redis.pipeline();
    writePipeline.set("auth:redeem:" + code, JSON.stringify(updated));
    writePipeline.set("auth:activation:" + activationMember, JSON.stringify(record));
    writePipeline.sadd("auth:activation_codes", activationMember);
    writePipeline.set("auth:device:" + deviceHash, activationCode);
    writePipeline.incr(USED_COUNTER_KEY);
    var writeOps = [
      "set auth:redeem:" + code,
      "set auth:activation:" + activationMember,
      "sadd auth:activation_codes " + activationMember,
      "set auth:device:" + deviceHash.slice(0, 8) + "...",
      "incr " + USED_COUNTER_KEY,
    ];
    var writeResults = await writePipeline.exec();
    await reportPipelineFailures(writeResults, writeOps, {
      reasonPrefix: "激活写库部分失败",
      redeemCode: code,
      device: device,
      activationCode: activationMember,
      source: "user",
      visitorInfo: visitorInfo,
      deviceInfo: deviceInfo,
      geo: geo,
    });
    console.log("✅ Activate success:", {
      redeemCode: code,
      activationCode: activationCode,
      activationMember: activationMember,
      activationSeq: activationSeq,
      productId: productId,
      deviceHash: deviceHash.slice(0, 8) + "...",
      months: months,
    });

    // Push notification must complete BEFORE response to avoid Vercel freezing
    await notify.pushNotification("new_activation", {
      redeem_code: code,
      activation_code: activationCode,
      product_id: productId,
      device_id: device,
      months: months,
      activation_seq: activationSeq,
      source: "user",
      user_name: (info && info.user_name) || "",
      ip: visitorInfo ? visitorInfo.ip : "",
      user_agent: visitorInfo ? visitorInfo.userAgent : "",
      visitor_info: visitorInfo || {},
      device_info: deviceInfo || {},
      device_model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "",
      country: geo.country,
      region: geo.region,
      city: geo.city,
      location_zh: geo.location_zh,
      district_zh: geo.district_zh,
      location_full_zh: geo.location_full_zh,
      city_zh: geo.city_zh,
    }).catch(function (e) {
      console.error("[activate] Push notification failed:", e.message);
    });

    // Send response after push completes
    res.json({ success: true, activationCode: activationCode, debug: { visitor: visitorInfo, notification: "success", productId: productId, months: months } });

    // Background: email notification (fire-and-forget, non-blocking after response)
    notify.sendActivationNotification(req, {
      redeemCode: code,
      activationCode: activationCode,
      productId: productId,
      deviceId: device,
      months: months,
      deviceInfo: deviceInfo,
      source: "user",
    }).catch(function (e) {
      console.error("[activate] Email failed:", e.message);
    });

    rateLimit.clearDeviceRateLimit(device).catch(function () {});
  } catch (error) {
    console.error("Activate error:", error && error.message ? error.message : error, error);
    var msg = "服务器内部错误，请稍后重试";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "服务器数据库未配置，请联系管理员（缺少 POSTGRES_URL 环境变量）";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND|Unauthorized|401|403/i.test(String(error.message || ""))) {
      msg = "服务器数据库连接失败，请稍后重试或联系管理员";
    }
    saveFailureRecord(msg, rawDeviceId, rawRedeemCode, "", "", visitorInfo, deviceInfo);

    // Push notification must complete BEFORE response to avoid Vercel freezing
    await notify.pushNotification("activation_failure", {
      reason: msg,
      redeem_code: rawRedeemCode || "",
      device_id: rawDeviceId || "",
      source: "user",
      ip: visitorInfo ? visitorInfo.ip : "",
      user_agent: visitorInfo ? visitorInfo.userAgent : "",
      visitor_info: visitorInfo || {},
      device_info: deviceInfo || {},
      country: geo.country,
      region: geo.region,
      city: geo.city,
      location_zh: geo.location_zh,
      district_zh: geo.district_zh,
      location_full_zh: geo.location_full_zh,
    }).catch(function () {});

    // Send response after push completes
    res.status(500).json({ success: false, error: msg, debug: { visitor: visitorInfo, notification: "background", reason: msg } });

    // Background: email notification (fire-and-forget, non-blocking after response)
    notify.sendActivationFailure(req, {
      reason: msg,
      redeemCode: rawRedeemCode || "",
      deviceId: rawDeviceId || "",
      productId: "",
      months: "",
      source: "user",
    }).catch(function () {});
  }
};