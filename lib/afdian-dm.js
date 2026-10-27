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

// ── 文案（三条，内容与原版逐字保持一致，只补了一条手动填码的兜底）──────────
function buildOrderMessages(o) {
  o = o || {};
  var productName = o.product_name || "Ev课程表";
  var msgs = [];

  // #1 激活链接（信息量最大的一条，永远先发）
  var msg1 = "🎉 感谢您赞助 " + productName + " 永久高级版！\n\n您的激活链接（点开自动激活）：" + (o.activate_url || "");
  if (o.code) {
    msg1 += "\n\n若链接点不开：打开 App → 高级版 → 输入兑换码 " + o.code + " → 一键激活";
  }
  msgs.push({ i: 1, content: msg1 });

  // #2 收尾语
  msgs.push({ i: 2, content: "如有疑问欢迎回复~ 祝使用愉快！" });

  // #3 安装指导
  msgs.push({ i: 3, content: "安装步骤指导：" + (o.guide_url || "") });

  return msgs;
}

function buildOrderJob(o) {
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
  job.messages = buildOrderMessages(job);
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

module.exports = {
  PENDING_KEY: PENDING_KEY,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
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
};
