// lib/afdian-dm.js — 爱发电买家私信：三条按序发送 / 待发队列 / 断点续发 / 退避重试
//
// 为什么要有这个模块（2026-10-27，evtask-D-evapp-auth-261027-336khr）：
//
// 旧实现对每笔订单在 webhook 里同步连发 3 条私信（① 激活链接 ② 收尾语 ③ 安装指导）。
// 两个硬伤都是实测出来的：
//   1) 单条 send-msg 实测 2.6~9.8s（补单时第 1 条直接 timeout after 9798ms），
//      三条串行最坏 24s+。而这段代码还排在订单落库（afdian:order:xxx / afdian:processed）
//      **之前** —— 函数一旦被平台掐断，买家钱付了、码生成了、记录没写，全链静默丢失。
//   2) 三条在 2 秒内连发时，爱发电可能只投递最后一条（10-26 买家只收到第 3 条安装指导页）。
//
// 现在保持「3 条」不变，改的是可靠性与顺序：
//   ① 发送前先入队 afdian:dm_pending（hash，field=out_trade_no）→ 崩溃也不丢
//   ② 订单记录 + processed 标记一律提到发送之前 → 私信失败绝不连累发码
//   ③ 三条按序发，**每条发成功就记一次进度**（afdian:dm_sent:<单号> 计数器，语义与旧版一致：
//      1/2/3 = 已发条数）。中途失败或时间预算用尽 → 留在队列，下次从断点续发，绝不重发已发的
//   ④ 重试入口：/api/afdian?kind=dm-retry（每小时 cron）、日同步 cron、后台手工触发；
//      带线性退避与次数上限，到顶推 dm_failed 告警（让人看得见，而不是等买家来问）
//   ⑤ 两条私信之间留 DM_GAP_MS 间隔，降低连发被爱发电归并/吞掉前几条的概率

var redis = require("./redis");
var afdianApi = require("./afdian-api");

var PENDING_KEY = "afdian:dm_pending";
var MAX_ATTEMPTS = 6;              // 6 次 × 线性退避，理论上覆盖 3 小时以上
var BACKOFF_BASE_MS = 5 * 60 * 1000;
var DM_GAP_MS = 1200;              // 相邻两条之间的间隔

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ── 文案模板（3 条，后台「爱发电订单 → 私信模板」可编辑）────────────────────
//
// 2026-11-05（evtask-D-evapp-auth-261105-ta38xn）：文案从硬编码改为「占位符模板」，
// 存 afdian:dm_templates（JSON），后台逐条编辑、服务端同一渲染函数预览、保存即对之后的新订单生效。
// 【默认值必须与旧硬编码文案逐字一致】—— 未保存过模板时，买家收到的内容一字不变。
// 条数固定 3：afdian:dm_sent:<单号> 按「已发条数」做断点续发，动条数会重发或漏发。
var TEMPLATES_KEY = "afdian:dm_templates";
var TEMPLATE_VERSION = 1;
var MAX_TEMPLATE_CHARS = 4000;

// 可用占位符（顺序即后台变量区展示顺序）
var TEMPLATE_VARS = ["product_name", "code", "activate_url", "guide_url", "user_name", "out_trade_no"];

// 缺值兜底：与旧拼接逻辑完全一致（code 缺失给人工兜底话术，链接缺失给空串）
var VAR_FALLBACK = {
  product_name: "Ev课程表",
  code: "（发货异常请回复本消息）",
  activate_url: "",
  guide_url: "",
  user_name: "",
  out_trade_no: "",
};

var DEFAULT_TEMPLATES = [
  {
    // #1 兑换码优先（2026-11-04 调整，evtask-D-evclass-sche-261104-735nm7）：
    // 4 位码直发到第一段，手工兑换码路径为主推（零蓝牙零 App 零会话，稳定）；
    // 同步器链接降为备选并如实标注「需安卓装同步器·常卡」+ 失败退路。
    // 注意不要写回旧文案「输入兑换码 → 一键激活」——快应用里要输的是 18 位激活码，与流程不符。
    i: 1,
    content: "🎉 感谢您赞助 {{product_name}} 永久高级版！\n\n您的兑换码：{{code}}\n\n激活方法（3 步，不用装任何东西）：\n1. 手环打开 Ev课程表 → 高级版 → 兑换码激活，记下屏幕上的 4 位设备ID\n2. 浏览器打开 https://app-auth.gudq.com/activate ，输入 4 位设备ID + 上面的兑换码\n3. 网页给出 18 位激活码，回手环输入即可激活\n\n也可以点这个链接自动激活（安卓专用，需装同步器，可能较慢）：\n{{activate_url}}\n\n若链接卡住，请用上面的手工方式，任一步有疑问直接回复本消息。",
  },
  { i: 2, content: "如有疑问欢迎回复~ 祝使用愉快！" },
  { i: 3, content: "安装步骤指导：{{guide_url}}" },
];

function cloneDefaultTemplates() {
  return DEFAULT_TEMPLATES.map(function (t) { return { i: t.i, content: t.content }; });
}

// 唯一渲染实现：后台预览与真实发送都走这里，杜绝前后端两套逻辑漂移。
// 已知变量缺值走 VAR_FALLBACK；未知变量原样保留（便于发现拼写错误）。
function renderTemplate(tpl, vars) {
  var v = {};
  Object.keys(VAR_FALLBACK).forEach(function (k) {
    v[k] = (vars && vars[k] != null && vars[k] !== "") ? String(vars[k]) : VAR_FALLBACK[k];
  });
  return String(tpl || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : m;
  });
}

function findUnknownVars(tpl) {
  var out = [];
  String(tpl || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) {
    if (TEMPLATE_VARS.indexOf(k) < 0 && out.indexOf(k) < 0) out.push(k);
    return m;
  });
  return out;
}

// 模板 → 3 条消息。templates 缺省/异常时回落内置默认（与旧文案逐字一致）。
function buildOrderMessages(o, templates) {
  o = o || {};
  var tpls = (Array.isArray(templates) && templates.length === 3) ? templates : DEFAULT_TEMPLATES;
  var vars = {
    product_name: o.product_name,
    code: o.code,
    activate_url: o.activate_url,
    guide_url: o.guide_url,
    user_name: o.user_name,
    out_trade_no: o.out_trade_no,
  };
  return tpls.map(function (t, idx) {
    return {
      i: parseInt(t && t.i, 10) || idx + 1,
      content: renderTemplate(t && t.content, vars),
    };
  });
}

// 严格校验（保存用）：正好 3 条、非空、不超长
function normalizeTemplates(list) {
  if (!Array.isArray(list) || list.length !== 3) return { ok: false, error: "必须正好 3 条模板" };
  var out = [];
  for (var i = 0; i < 3; i++) {
    var t = list[i] || {};
    var content = typeof t.content === "string" ? t.content : "";
    if (!content.trim()) return { ok: false, error: "第 " + (i + 1) + " 条不能为空" };
    if (content.length > MAX_TEMPLATE_CHARS) {
      return { ok: false, error: "第 " + (i + 1) + " 条超过 " + MAX_TEMPLATE_CHARS + " 字符" };
    }
    out.push({ i: i + 1, content: content });
  }
  return { ok: true, templates: out };
}

// 宽松归一（预览用）：编辑中途允许空/缺项，只为能实时看到渲染效果
function coerceTemplates(list) {
  var src = Array.isArray(list) ? list : [];
  return [0, 1, 2].map(function (i) {
    var t = src[i] || {};
    return { i: i + 1, content: typeof t.content === "string" ? t.content : "" };
  });
}

async function getTemplates() {
  try {
    var raw = await redis.get(TEMPLATES_KEY);
    if (raw) {
      var obj = JSON.parse(raw);
      var chk = normalizeTemplates((obj && obj.templates) || []);
      if (chk.ok) {
        return { templates: chk.templates, updated_at: (obj && obj.updated_at) || null, is_default: false };
      }
      console.warn("[afdian:dm] stored templates invalid, fallback to defaults");
    }
  } catch (e) {
    // 模板读不到绝不能阻断发码：回落默认文案（与改动前行为一致）
    console.warn("[afdian:dm] load templates failed, fallback to defaults:", e && e.message);
  }
  return { templates: cloneDefaultTemplates(), updated_at: null, is_default: true };
}

async function saveTemplates(list) {
  var chk = normalizeTemplates(list);
  if (!chk.ok) return chk;
  var payload = { v: TEMPLATE_VERSION, updated_at: Date.now(), templates: chk.templates };
  await redis.set(TEMPLATES_KEY, JSON.stringify(payload));
  return { ok: true, templates: chk.templates, updated_at: payload.updated_at };
}

// ⚠️ 2026-11-05 起为 async：入队前要读一次 afdian:dm_templates（后台可改）。
// 读到的模板会写进 job.messages 快照 —— 入队之后再改模板不影响在途任务。
async function buildOrderJob(o) {
  o = o || {};
  var job = {
    out_trade_no: o.out_trade_no || "",
    user_id: o.user_id || "",
    user_name: o.user_name || "",
    product_name: o.product_name || "",
    code: o.code || "",
    activate_url: o.activate_url || "",
    guide_url: o.guide_url || "",
    source: o.source || "afdian",
    sent_count: parseInt(o.sent_count, 10) || 0,  // 已成功发出的条数（断点续发起点）
    attempts: 0,
    created_at: Date.now(),
  };
  var loaded = await getTemplates();
  job.messages = buildOrderMessages(job, loaded.templates);
  job.template_is_default = loaded.is_default;
  job.template_updated_at = loaded.updated_at || null;
  return job;
}

// ── 私信日志（原在 afdian-processor.js，挪到这里避免循环 require）──────────
async function logDmSend(source, userId, userName, content, success, error, response) {
  try {
    var entry = {
      time: new Date().toISOString(),
      source: source,
      user_id: userId || "",
      user_name: userName || "",
      content: content || "",
      success: !!success,
      error: error || null,
      response: response || null,
    };
    await redis.lpush("afdian:dm_logs", JSON.stringify(entry));
    await redis.ltrim("afdian:dm_logs", 0, 199);
    console.log("[afdian:dm] log saved: source=" + source + " user=" + userId + " success=" + success);
  } catch (e) {
    console.error("[afdian:dm] log save failed:", e.message);
  }
}

// ── 队列 ────────────────────────────────────────────────────────────────
async function enqueue(job) {
  if (!job || !job.out_trade_no) return 0;
  var m = {};
  m[job.out_trade_no] = JSON.stringify(job);
  await redis.hset(PENDING_KEY, m);
  console.log("[afdian:dm] enqueued: " + job.out_trade_no + " sent_count=" + (job.sent_count || 0));
  return 1;
}

async function removeJob(outTradeNo) {
  if (!outTradeNo) return 0;
  try { return await redis.hdel(PENDING_KEY, outTradeNo); } catch (e) { return 0; }
}

async function pendingCount() {
  try { return await redis.hlen(PENDING_KEY); } catch (e) { return 0; }
}

async function listPending() {
  var raw = {};
  try { raw = (await redis.hgetall(PENDING_KEY)) || {}; } catch (e) { return []; }
  var jobs = [];
  Object.keys(raw).forEach(function (k) {
    try {
      var j = JSON.parse(raw[k]);
      if (j && j.out_trade_no) jobs.push(j);
    } catch (_) {}
  });
  jobs.sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); });
  return jobs;
}

async function persistJob(job) {
  if (!job || !job.out_trade_no) return;
  var m = {};
  m[job.out_trade_no] = JSON.stringify(job);
  try { await redis.hset(PENDING_KEY, m); } catch (e) {
    console.error("[afdian:dm] persist job failed: " + job.out_trade_no + " " + (e && e.message));
  }
}

// ── 发送 ────────────────────────────────────────────────────────────────
// 从 job.sent_count 开始按序发送；每条成功即落进度，失败即停（保持顺序语义，
// 不允许 #1 还没送到就先送 #3）。返回结构永远不抛异常。
async function attemptNow(job, opts) {
  opts = opts || {};
  if (!job) return { ok: false, error: "no_job", sent_count: 0, sent_indexes: [] };

  var messages = (job.messages && job.messages.length) ? job.messages : buildOrderMessages(job);
  var budgetMs = opts.budgetMs || 30000;
  var startedAt = Date.now();
  var out = job.out_trade_no || "";
  var sendIndexes = [];   // 本次调用实际尝试的条号，便于日志与返回
  var lastError = null;
  var deferred = false;

  if (!job.user_id) {
    // 没有收件人：走正常失败分支（记 attempts + 退避），否则垃圾任务会被每轮 cron 反复重试
    lastError = "missing_user_id";
  } else for (var idx = job.sent_count || 0; idx < messages.length; idx++) {
    if (idx > (job.sent_count || 0)) {
      if (Date.now() - startedAt + DM_GAP_MS > budgetMs) { deferred = true; break; }
      await sleep(DM_GAP_MS);
    }
    if (Date.now() - startedAt > budgetMs) { deferred = true; break; }

    var msg = messages[idx];
    var content = msg.content || "";
    sendIndexes.push(msg.i);

    var r;
    try {
      var resp = await afdianApi.sendMessage(job.user_id, content);
      if (resp && resp.ec === 200) r = { ok: true, em: resp.em || "ok" };
      else r = { ok: false, error: "ec=" + (resp && resp.ec) + " em=" + (resp && resp.em) };
    } catch (e) {
      r = { ok: false, error: (e && e.message) || "unknown_error" };
    }

    if (r.ok) {
      job.sent_count = idx + 1;
      console.log("[afdian:dm] #" + msg.i + " sent OK (" + job.sent_count + "/" + messages.length + "): " + out);
      await logDmSend("system", job.user_id, job.user_name, content, true, null, r.em);
      // 进度先落计数器（与旧版 dm_sent 语义一致：1/2/3 = 已发条数）
      try { await redis.set("afdian:dm_sent:" + out, String(job.sent_count)); } catch (_) {}
    } else {
      lastError = r.error;
      console.log("[afdian:dm] #" + msg.i + " FAILED: " + out + " error=" + r.error);
      await logDmSend("system", job.user_id, job.user_name, content, false, r.error, null);
      break;
    }
  }

  var allSent = (job.sent_count || 0) >= messages.length;

  if (allSent) {
    console.log("[afdian:dm] all " + messages.length + " DMs done: " + out);
    try { await redis.hdel(PENDING_KEY, out); } catch (_) {}
    return { ok: true, sent_count: job.sent_count, total: messages.length, sent_indexes: sendIndexes };
  }

  if (lastError) {
    job.attempts = (parseInt(job.attempts, 10) || 0) + 1;
    job.last_error = lastError;
    job.last_try_at = Date.now();
    job.next_at = Date.now() + BACKOFF_BASE_MS * job.attempts;
    await persistJob(job);

    if (job.attempts >= MAX_ATTEMPTS) {
      // 到顶了：留队列备查，但推一条告警让人工介入（否则只能等买家来问）
      job.exhausted = true;
      await persistJob(job);
      try {
        var notify = require("./notify");
        await notify.pushNotification("dm_failed", {
          out_trade_no: out,
          user_id: job.user_id,
          user_name: job.user_name || "",
          sent_count: job.sent_count || 0,
          attempts: job.attempts,
          last_error: lastError,
        });
      } catch (ne) {
        console.error("[afdian:dm] dm_failed alert failed:", ne && ne.message);
      }
    }
    return { ok: false, error: lastError, sent_count: job.sent_count, total: messages.length, attempts: job.attempts, sent_indexes: sendIndexes };
  }

  // 预算用尽但没出错：进度已落库，等下轮从断点继续
  if (deferred) {
    await persistJob(job);
    console.log("[afdian:dm] budget exhausted, deferred with progress " + (job.sent_count || 0) + "/" + messages.length + ": " + out);
    return { ok: false, deferred: true, sent_count: job.sent_count, total: messages.length, sent_indexes: sendIndexes };
  }

  return { ok: false, error: "no_progress", sent_count: job.sent_count || 0, total: messages.length, sent_indexes: sendIndexes };
}

// ── 重试 ────────────────────────────────────────────────────────────────
// 有时间预算：宁可少发几条留给下次，也不让调用方（webhook / cron）超时。
async function flush(opts) {
  opts = opts || {};
  var limit = opts.limit || 5;
  var budgetMs = opts.budgetMs || 15000;
  var startedAt = Date.now();
  var deadline = startedAt + budgetMs;
  var stat = { total: 0, tried: 0, sent: 0, failed: 0, deferred: 0, skipped: 0, remaining: 0 };

  var jobs = await listPending();
  stat.total = jobs.length;
  if (!jobs.length) return stat;

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (job.exhausted) { stat.skipped++; continue; }
    if (stat.tried >= limit) { stat.deferred++; continue; }
    if (job.next_at && job.next_at > Date.now()) { stat.deferred++; continue; }
    if (Date.now() >= deadline) { stat.deferred++; continue; }

    stat.tried++;
    var remainingBudget = Math.max(5000, deadline - Date.now());
    var r = await attemptNow(job, { budgetMs: remainingBudget });
    if (r.ok) stat.sent++;
    else if (r.deferred) stat.deferred++;
    else stat.failed++;
  }

  try { stat.remaining = await pendingCount(); } catch (_) {}
  console.log("[afdian:dm] flush done: " + JSON.stringify(stat) + " elapsed=" + (Date.now() - startedAt) + "ms");
  return stat;
}

// ── HTTP 入口：GET /api/afdian?kind=dm-retry ─────────────────────────────
// cron 调用（带 CRON_SECRET）与登录后台都可以打；队列为空时零开销直接返回。
async function handleRetry(req, res) {
  var query = (req && req.query) || {};
  var isCronCall = (query.cron === "1" || query.cron === "true");
  var cronSecret = process.env.CRON_SECRET || "";
  var authorized = false;

  if (isCronCall) {
    var authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    authorized = !!cronSecret && (authHeader === "Bearer " + cronSecret);
    if (!authorized) return res.status(401).json({ success: false, error: "unauthorized cron" });
  } else {
    try {
      var auth = require("./auth");
      var a = auth.requireAuth(req);
      authorized = !!(a && a.authorized);
    } catch (e) {}
    if (!authorized) return res.status(401).json({ success: false, error: "unauthorized" });
  }

  // mode=show 只看队列不发送（排查用）
  if (query.mode === "show") {
    var jobs = await listPending();
    return res.status(200).json({
      success: true,
      pending: jobs.length,
      jobs: jobs.map(function (j) {
        return {
          out_trade_no: j.out_trade_no,
          user_id: j.user_id,
          user_name: j.user_name,
          sent_count: j.sent_count || 0,
          total: (j.messages || []).length || 3,
          attempts: j.attempts || 0,
          last_error: j.last_error || null,
          next_at: j.next_at || null,
          exhausted: !!j.exhausted,
          created_at: j.created_at || null,
        };
      }),
    });
  }

  var limit = parseInt(query.limit, 10) || (isCronCall ? 10 : 3);
  var stat = await flush({ limit: limit, budgetMs: 20000 });
  return res.status(200).json({ success: true, flushed: stat });
}

// ── HTTP 入口：GET/POST /api/afdian?kind=dm-templates ────────────────────
// 后台「爱发电订单 → 私信模板」用。四种操作（读 / 预览 / 保存 / 恢复默认）
// **全部**要求后台登录，含 GET —— 模板虽不是密钥，但没必要对匿名开放写入口。
async function handleTemplates(req, res) {
  try {
    var auth = require("./auth");
    var a = auth.requireAuth(req);
    if (!a || !a.authorized) return res.status(401).json({ success: false, error: "unauthorized" });
  } catch (e) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }

  var q = (req && req.query) || {};
  var op = String(q.op || "");
  var body = (req && req.body) || {};

  // 预览用的示例订单：渲染口径与真实发送完全一致，只是数据是假的
  var sample = {
    product_name: "Ev课程表",
    code: "A7K2-9QXM-3T8P",
    user_name: "示例用户",
    out_trade_no: "AF202611050001",
    activate_url: "https://app-auth.gudq.com/deep-link-test.html?code=A7K2-9QXM-3T8P&u=8F3C&o=AF202611050001&c=afdian&g=activate",
    guide_url: "https://app-auth.gudq.com/user-guide.html?ev&u=8F3C&c=afdian&g=guide",
  };

  function pack(templates, extra) {
    var rendered = buildOrderMessages(sample, templates).map(function (m) { return m.content; });
    var unknown = templates.map(function (t) { return findUnknownVars(t.content); });
    var out = {
      success: true,
      templates: templates,
      rendered: rendered,
      unknown: unknown,
      vars: TEMPLATE_VARS,
      sample: sample,
      max_chars: MAX_TEMPLATE_CHARS,
    };
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  try {
    if (op === "preview") {
      return res.status(200).json(pack(coerceTemplates(body.templates), {}));
    }
    if (op === "save") {
      var saved = await saveTemplates(body.templates);
      if (!saved.ok) return res.status(400).json({ success: false, error: saved.error });
      return res.status(200).json(pack(saved.templates, { updated_at: saved.updated_at, is_default: false }));
    }
    if (op === "reset") {
      try {
        await redis.del(TEMPLATES_KEY);
      } catch (de) {
        console.warn("[afdian:dm] reset templates failed:", de && de.message);
      }
      return res.status(200).json(pack(cloneDefaultTemplates(), { updated_at: null, is_default: true }));
    }
    var loaded = await getTemplates();
    return res.status(200).json(pack(loaded.templates, { updated_at: loaded.updated_at, is_default: loaded.is_default }));
  } catch (e) {
    console.error("[afdian:dm] handleTemplates error:", e && e.message);
    return res.status(500).json({ success: false, error: (e && e.message) || "internal_error" });
  }
}

module.exports = {
  PENDING_KEY: PENDING_KEY,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  TEMPLATES_KEY: TEMPLATES_KEY,
  TEMPLATE_VARS: TEMPLATE_VARS,
  DEFAULT_TEMPLATES: DEFAULT_TEMPLATES,
  MAX_TEMPLATE_CHARS: MAX_TEMPLATE_CHARS,
  renderTemplate: renderTemplate,
  findUnknownVars: findUnknownVars,
  normalizeTemplates: normalizeTemplates,
  getTemplates: getTemplates,
  saveTemplates: saveTemplates,
  buildOrderMessages: buildOrderMessages,
  buildOrderJob: buildOrderJob,
  logDmSend: logDmSend,
  enqueue: enqueue,
  removeJob: removeJob,
  pendingCount: pendingCount,
  listPending: listPending,
  attemptNow: attemptNow,
  flush: flush,
  handleRetry: handleRetry,
  handleTemplates: handleTemplates,
};
