// api/visitor/ip.js — 前台「我的 IP 信息」页面后端
//
// GET /api/visitor/ip          → 查**调用者自己**的 IP 详情（缓存优先，命中不调腾讯）
// GET /api/visitor/ip?force=1  → 忽略缓存重查腾讯（限流 1 次/分钟/IP）
//
// 🔐 安全约束（重要）：**只查调用者自己的 IP**，刻意不接受 `?ip=` 参数。
//    否则本接口会沦为「免费 IP 查询代理」，一天就能把腾讯 6000 次/日的免费额度刷光。
//    要查任意 IP，请用管理员登录后的 /api/admin/health?section=ip-lookup-once。
//
// 额度保护：同一 IP 成功后落库 ip_lookups（30 天内不再调腾讯）；页面刷新走缓存 0 消耗。

var rateLimit = require("../../lib/rate-limit");
var notify = require("../../lib/notify");
var geoDistrict = require("../../lib/geo-district");
var geoZh = require("../../lib/geo-zh");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Use GET" });
  }

  try {
    var headers = req.headers || {};
    var ip = geoDistrict.normalizeIp(rateLimit.getClientIp(req));
    var force = Boolean(req.query && req.query.force === "1");

    if (force) {
      var limit = await rateLimit.checkMyIpForceLimit(req).catch(function () { return { blocked: false }; });
      if (limit.blocked) {
        return res.status(429).json({ success: false, error: limit.reason || "刷新过于频繁，请稍后再试" });
      }
    }

    var info = notify.collectRequestInfo(req);

    // 腾讯：本页允许同步等待（用户就在页面前等），成功后落库
    var tencent = await geoDistrict.resolveNow(ip, force).catch(function () { return null; });
    // 永久表里的中文省市 + 网络信息（1 次 SELECT）
    var stored = await geoDistrict.getStoredGeo(ip).catch(function () { return null; });

    var regionZh = (tencent && tencent.region) || (stored && stored.region) || "";
    var cityZh = (tencent && tencent.city) || (stored && stored.city) || "";
    var districtZh = (tencent && tencent.district) || (stored && stored.district) || "";
    var tencentFailed = Boolean(tencent && tencent.tencentFailed);

    // 兜底：Vercel 头部也能给省级（国内返回的是 SD/GD/BJ 这类省级代码）→ 至少把「省/直辖市」显示出来
    var vercelRegionZh = geoZh.regionZhOf(headers["x-vercel-ip-country-region"], headers["x-vercel-ip-country"]);
    var vercelCityZh = geoZh.cityZhOf(headers["x-vercel-ip-city"]);
    var regionFromVercel = false;
    if (!regionZh && vercelRegionZh) {
      regionZh = vercelRegionZh;
      regionFromVercel = true;
    }
    if (!cityZh && vercelCityZh) cityZh = vercelCityZh;

    var full = geoZh.resolveZhLocationFull({
      country: headers["x-vercel-ip-country"],
      region: headers["x-vercel-ip-country-region"],
      city: headers["x-vercel-ip-city"],
      zh_region: regionZh,
      zh_city: cityZh,
      district: districtZh,
    });

    var rawCountry = String(headers["x-vercel-ip-country"] || "").trim();
    var countryZh =
      (stored && stored.country) ||
      geoZh.resolveZhLocation({ country: rawCountry }) ||
      (/^CN$/i.test(rawCountry) ? "中国" : rawCountry); // 页面展示用，国内显示「中国」而不是「CN」

    // 来源标签：让页面能准确告诉用户「这个值是哪来的」
    var sourceLabel = "";
    if (tencentFailed) sourceLabel = "tencent_failed";
    else if (tencent && tencent.cached) sourceLabel = "cache";
    else if (tencent) sourceLabel = "tencent";
    else if (stored) sourceLabel = "stored";

    var notes = [];
    if (districtZh) {
      notes.push("区县来自腾讯位置服务，已按 IP 缓存 30 天（同一 IP 不会重复消耗额度）");
    } else if (tencentFailed) {
      notes.push(
        regionZh
          ? "腾讯位置服务暂时不可用（配额未分配 / 域名未授权 / 超时）；省/直辖市已用 Vercel 头部兜底，区县与城市暂缺"
          : "腾讯位置服务暂时不可用（配额未分配 / 域名未授权 / 超时），且 Vercel 头部也没给出省级信息"
      );
    } else {
      notes.push("腾讯位置服务未返回区县（该 IP 可能没有区县级数据）");
    }
    if (regionFromVercel) {
      notes.push("省/直辖市来自 Vercel 头部（原文：" + (headers["x-vercel-ip-country-region"] || "-") + " 省级代码）");
    }
    notes.push("IP 定位精度上限到区县，运营商出口 IP 可能覆盖多个区，仅供大致参考");
    if (!regionZh && !cityZh) {
      notes.push("Vercel 免费头部对国内 IP 常常只提供国家，省市可能出现空缺——这是数据源限制，不是页面故障");
    }

    return res.status(200).json({
      success: true,
      ip: ip,
      ipVersion: ip.indexOf(":") >= 0 ? 6 : 4,
      geo: {
        country: countryZh,
        region: regionZh,
        city: cityZh,
        district: districtZh,
        full: full.location_full_zh,
        source: sourceLabel,
        cached: sourceLabel === "cache",
        tencentFailed: tencentFailed,
        checkedAt: (tencent && tencent.checkedAt) || (stored && stored.checkedAt) || 0,
      },
      vercel: {
        country: headers["x-vercel-ip-country"] || "",
        region: headers["x-vercel-ip-country-region"] || "",
        city: headers["x-vercel-ip-city"] || "",
        timezone: headers["x-vercel-ip-timezone"] || "",
      },
      network: stored
        ? {
            isp: stored.isp || "",
            org: stored.org || "",
            asn: stored.asn || "",
            lat: stored.lat || 0,
            lon: stored.lon || 0,
            timezone: stored.timezone || "",
            source: "ip-api",
            updatedAt: stored.updatedAt || 0,
          }
        : null,
      device: { os: info.os, browser: info.browser, device: info.device },
      notes: notes,
    });
  } catch (e) {
    console.error("[visitor:ip] error:", e && e.message ? e.message : e);
    return res.status(500).json({ success: false, error: "查询失败，请稍后重试" });
  }
};
