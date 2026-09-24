// lib/ip-warmup.js — 访客链路自动补齐 ip_lookups（中文归属地）
//
// 背景（根因）：ip_lookups 原先只有两个写入源
//   1) 腾讯位置服务（lib/geo-district.js）—— 对境外 IP 直接返回 status != 0，不写库；
//   2) 后台手工点「重新查询」（api/admin/health.js section=ip-lookup-once）。
// 结果是：境外 IP 永远停留在「未落入 ip_lookups」，后台只能回落到 Vercel 请求头，
// 显示成 `IL · 芝加哥` / `Z · Magh%C4%81r` 这种混搭，必须人工点一次才正常。
//
// 方案：访问发生后用 background.run(warmup(ip)) 在响应之后补一次查询（不占用用户等待时间）。
//   · 已有记录 → 直接返回，零外呼；
//   · 先只打 ip-api（lang=zh-CN，中文质量最好、最便宜），失败再退化为全源。

var ipLookup = require("./ip-lookup");
var ipStore = require("./ip-lookup-store");

var inflight = {};

async function warmup(ip, opts) {
  opts = opts || {};
  if (!ip || ipLookup.isPrivateOrInvalid(ip)) return false;
  if (inflight[ip]) return false; // 同进程内去重
  inflight[ip] = true;
  try {
    var stored = await ipStore.getFromStore(ip);
    if (stored) return false;

    var res = await ipLookup.queryAllApis(ip, { sources: ["ip-api"], totalTimeoutMs: 4000 });
    if (!res || !res.individual || res.individual.length === 0) {
      res = await ipLookup.queryAllApis(ip, { totalTimeoutMs: 6000 });
    }
    if (!res || !res.individual || res.individual.length === 0) return false;

    await ipStore.saveToStore(ip, res.merged, res.individual);
    return true;
  } catch (e) {
    console.warn("[ip-warmup] failed:", e && e.message);
    return false;
  } finally {
    delete inflight[ip];
  }
}

module.exports = { warmup: warmup };
