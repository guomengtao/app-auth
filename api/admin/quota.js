var { requireAuth } = require("../../lib/auth");
var quota = require("../../lib/quota");

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    await quota.bumpQuotaTick(req.url || "/api/admin/quota");
    var summary = await quota.summarize();
    var tips = [
      {
        title: "核心：把每次冷启动后的连续访问打包到 5 分钟内完成",
        detail: "Neon 免费版默认 5 分钟无请求进入 Scale-to-Zero（休眠）。一旦休眠，下次请求需冷启动 (~350ms)。每次进入 Active 状态就开始计入 100 小时。所以：避免零散的 ping 把冷启动打碎成一个个短段；批量做操作；开发阶段集中调试而不是断断续续打开页。",
        tag: "最省",
      },
      {
        title: "把 Suspend Timeout 改成 0（永远不休眠=最花钱！）千万别做",
        detail: "免费版默认 5 分钟自动休眠正是免费的核心。任何把 compute 保持 Always-on 的设置会迅速吃掉 100h 甚至升级收费。保持默认 5m 或更短。",
        tag: "避坑",
      },
      {
        title: "后台管理页不要高频轮询",
        detail: "当前后台所有 Tab 都是点「刷新」才重新请求，没有自动轮询。如果你自己加了 setInterval 定期刷新 stats/records，把间隔调到 >5 分钟或干脆关掉；不然每 30s 打一次会让数据库永远不休眠，每月 100 小时 4 天就烧完。",
        tag: "后台",
      },
      {
        title: "尽量复用连接 / 一次请求内合并多次 Redis/Postgres 调用",
        detail: "activate.js 里目前 Promise.all 批量写入，这是正确的做法。不要把同一个功能拆成 3 次 HTTP 调用改成 1 次。减少 HTTP 次数 = 减少 DB 被唤醒的次数 = 省计算。",
        tag: "代码层",
      },
      {
        title: "Preview/Dev Branch 用完就删",
        detail: "每个 Neon Branch 有独立的 compute 和 storage，免费版总共允许 10 个分支。Vercel 每次 git push 生成的 preview URL 会创建对应 branch，历史分支如果没设 TTL 会一直占配额。可以在 neon.ts 里给 preview branch 设 TTL 7天自动清理，或 neon branch rm 手工删。",
        tag: "分支",
      },
      {
        title: "存储 512MB 限制：定期清理过期数据",
        detail: "旧版 kv_strings 里的临时 health probe（60s TTL）会自动过期。但 auth:activation:xxx 记录会永久保留。如果记录超 10 万条，可考虑每月归档或导出 JSON 后从 DB 清除。存储一旦超过 512MB 会拒绝写入导致所有激活失败。",
        tag: "存储",
      },
      {
        title: "跨区出流量 1GB：尽量让 Vercel Function 和 Neon 同区",
        detail: "Neon 项目默认选 us-east-2 (Ohio)；Vercel Serverless Function 默认最近区。把 Vercel 的 Function Region 也选 us-east-2 能大幅减少跨区 egress。跨区流量超过 1GB 会收费。",
        tag: "流量",
      },
      {
        title: "避免被爬虫刷激活接口",
        detail: "如果 /api/activate 被 bot 高频刷，每一次都会启动 compute。简单防护：前端/手环调用 activate 时加一个约定的 X-Token 头（不要和 JWT 一样），后端在 lib/auth.js 里对 activate 加简单阈值：同一 IP > 10次/min 就 429 拒绝。",
        tag: "防刷",
      },
    ];
    var howToCalculate = [
      {
        t: "100 小时是 Compute Active Hours（计算运行小时）",
        v: "不是整个月 720 小时挂在那儿。只要 Postgres Compute 在「Active 运行状态」，每过 1 秒就累加。Scale-to-Zero（休眠）后不计。",
      },
      {
        t: "判定规则：5 分钟无请求即休眠（默认 suspend_timeout=5m）",
        v: "例如：00:00:00 有一个请求 → Active 开始计费；00:03:00 又一个请求 → 保持 Active，这段累计 3 分钟；之后一直没请求 → 00:08:00（最后请求后 5 分钟）进入休眠 → 总共计 5 分钟。",
      },
      {
        t: "每月重置日：你 Neon 项目的 Billing 周期日，通常是注册日（本页估算默认自然月 1 号 UTC 重置）",
        v: "免费 100 小时是滚动账单月，不是 UTC 自然月，具体日期打开 console.neon.tech → Billing 查看。本页下方的「已用/剩余小时」是基于我们观察到的活跃段的估算值，精确值请以 Neon 控制台为准。",
      },
      {
        t: "100 小时到底能用多少？粗略换算",
        v: "如果每天均匀使用：100h ÷ 30 天 ≈ 3.3 小时/天。换算成「每次访问唤醒 + 5 分钟自动休眠」的段数：3.3h × 12段/h = 每天约 40 段。每天少于 40 次零散请求肯定够。如果把访问都集中成 2 段（比如早上 10 分钟、晚上 10 分钟），一天只用 20 分钟，100h 能用 300 天。",
      },
      {
        t: "何时会「打不开」？",
        v: "① 当月 Compute Hours 用满 100h → Neon 把 compute 挂起直到下月重置 → 所有 SQL 请求超时或失败 → 前端激活 500 / 后台 500；② 存储超过 512MB → 写失败；③ 跨区 egress 超过 1GB → 被限流/收费。",
      },
    ];
    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      summary: summary,
      howToCalculate: howToCalculate,
      tips: tips,
    });
  } catch (e) {
    console.error("quota summarize error:", e);
    return res.status(500).json({
      success: false,
      error: (e && e.message) || String(e),
    });
  }
};