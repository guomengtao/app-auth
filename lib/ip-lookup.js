var IP_CACHE_PREFIX = "ip:detail:";
var IP_CACHE_TTL = 24 * 60 * 60;
var API_TIMEOUT = 4000;
// ⚠️ 5 个源串行跑最坏 5×4000ms = 20s，冷启动下极易撞 Vercel maxDuration。
//    改成并行 + 总闸：单源仍 4s，但整体最多等 6s，超时就用已返回的部分结果。
var TOTAL_TIMEOUT = 6000;

var IP_APIS = [
  {
    name: "ip-api",
    fetch: function(ip) {
      return fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query&lang=zh-CN", {
        signal: AbortSignal.timeout(API_TIMEOUT)
      }).then(function(r) { return r.json(); }).then(function(o) {
        if (o && o.status === "success") {
          return { country: o.country || "", region: o.regionName || "", city: o.city || "",
            isp: o.isp || "", org: o.org || "", asn: (o.as || "").replace(/^AS/, ""),
            lat: o.lat || 0, lon: o.lon || 0, timezone: o.timezone || "", source: "ip-api" };
        }
        return null;
      }).catch(function() { return null; });
    }
  },
  {
    name: "ip-sb",
    fetch: function(ip) {
      return fetch("https://api.ip.sb/geoip/" + encodeURIComponent(ip), {
        signal: AbortSignal.timeout(API_TIMEOUT)
      }).then(function(r) { return r.json(); }).then(function(o) {
        if (o && o.ip) {
          return { country: o.country || "", region: o.region || "", city: o.city || "",
            isp: o.isp || o.organization || "", org: o.organization || "", asn: String(o.asn || ""),
            lat: o.latitude || 0, lon: o.longitude || 0, timezone: o.timezone || "", source: "ip-sb" };
        }
        return null;
      }).catch(function() { return null; });
    }
  },
  {
    name: "ipinfo",
    fetch: function(ip) {
      return fetch("https://ipinfo.io/" + encodeURIComponent(ip) + "/json", {
        signal: AbortSignal.timeout(API_TIMEOUT)
      }).then(function(r) { return r.json(); }).then(function(o) {
        if (o && o.ip) {
          var asnMatch = (o.org || "").match(/AS(\d+)/);
          return { country: o.country || "", region: o.region || "", city: o.city || "",
            isp: "", org: o.org || "", asn: asnMatch ? asnMatch[1] : "",
            lat: o.loc ? parseFloat(o.loc.split(",")[0]) : 0,
            lon: o.loc ? parseFloat(o.loc.split(",")[1]) : 0,
            timezone: o.timezone || "", source: "ipinfo" };
        }
        return null;
      }).catch(function() { return null; });
    }
  },
  {
    name: "ipwhois",
    fetch: function(ip) {
      return fetch("https://ipwhois.app/json/" + encodeURIComponent(ip), {
        signal: AbortSignal.timeout(API_TIMEOUT)
      }).then(function(r) { return r.json(); }).then(function(o) {
        if (o && o.success !== false && o.ip) {
          return { country: o.country || "", region: o.region || "", city: o.city || "",
            isp: o.isp || "", org: o.org || "",
            asn: String(o.asn || "").replace(/^AS/, ""),
            lat: o.latitude || 0, lon: o.longitude || 0,
            timezone: o.timezone || "", source: "ipwhois" };
        }
        return null;
      }).catch(function() { return null; });
    }
  },
  {
    name: "ipapi-is",
    fetch: function(ip) {
      return fetch("https://ipapi.is/json/" + encodeURIComponent(ip), {
        signal: AbortSignal.timeout(API_TIMEOUT)
      }).then(function(r) { return r.json(); }).then(function(o) {
        if (o && o.ip) {
          return { country: o.location ? o.location.country || "" : "",
            region: (o.location && o.location.state) || "",
            city: (o.location && o.location.city) || "",
            isp: o.company ? o.company.name || "" : "",
            org: o.company ? (o.company.name || "") : "",
            asn: (o.asn && o.asn.asn) ? String(o.asn.asn).replace(/^AS/, "") : "",
            lat: (o.location && o.location.latitude) || 0,
            lon: (o.location && o.location.longitude) || 0,
            timezone: (o.location && o.location.timezone) || "",
            source: "ipapi-is" };
        }
        return null;
      }).catch(function() { return null; });
    }
  }
];

function isPrivateOrInvalid(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "unknown") return true;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) return true;
  return false;
}

function normalizeResult(result) {
  if (!result) return null;
  return {
    country: String(result.country || "").slice(0, 40),
    region: String(result.region || "").slice(0, 40),
    city: String(result.city || "").slice(0, 40),
    isp: String(result.isp || "").slice(0, 60),
    org: String(result.org || "").slice(0, 80),
    asn: String(result.asn || "").slice(0, 20),
    lat: Number(result.lat) || 0,
    lon: Number(result.lon) || 0,
    timezone: String(result.timezone || "").slice(0, 40),
    source: result.source || "unknown",
    updated: Date.now()
  };
}

// 把多个源的明细合并成一条「最优」记录：第一个源（ip-api，lang=zh-CN 中文质量最好）打底，
// 其余源只补空缺字段。与 api/admin/health.js 的历史逻辑保持一致，抽出来供各处复用。
function mergeResults(rawResults) {
  if (!rawResults || rawResults.length === 0) return null;
  var merged = Object.assign({}, rawResults[0]);
  for (var j = 1; j < rawResults.length; j++) {
    var r2 = rawResults[j];
    if (!merged.isp && r2.isp) merged.isp = r2.isp;
    if (!merged.org && r2.org) merged.org = r2.org;
    if (!merged.asn && r2.asn) merged.asn = r2.asn;
    if (!merged.lat && r2.lat) { merged.lat = r2.lat; merged.lon = r2.lon; }
    if (!merged.timezone && r2.timezone) merged.timezone = r2.timezone;
    merged.source = merged.source + "+" + r2.source;
  }
  return merged;
}

// opts: { sources: ["ip-api"], totalTimeoutMs: 6000 }
async function queryAllApis(ip, opts) {
  if (isPrivateOrInvalid(ip)) return null;
  opts = opts || {};

  var list = IP_APIS;
  if (opts.sources && opts.sources.length) {
    list = IP_APIS.filter(function (a) { return opts.sources.indexOf(a.name) >= 0; });
    if (list.length === 0) list = IP_APIS;
  }

  // 结果按「完成顺序」入 collected；总闸到点时就用已收集到的部分结果（不再空手而归）
  var collected = [];
  var tasks = list.map(function (api) {
    return Promise.resolve(api.fetch(ip))
      .then(function (r) {
        var nr = normalizeResult(r);
        if (nr) collected.push(nr);
        return nr;
      })
      .catch(function () { return null; });
  });

  var totalMs = Number(opts.totalTimeoutMs) || TOTAL_TIMEOUT;
  if (totalMs < 500) totalMs = 500;
  await Promise.race([
    Promise.all(tasks).catch(function () { return null; }),
    new Promise(function (resolve) { setTimeout(resolve, totalMs); }),
  ]).catch(function () {});

  if (collected.length === 0) return null;

  // 输出顺序固定为源声明顺序，保证 merged 永远以 ip-api 打底
  var ordered = [];
  for (var i = 0; i < list.length; i++) {
    for (var k = 0; k < collected.length; k++) {
      if (collected[k].source === list[i].name) { ordered.push(collected[k]); break; }
    }
  }

  return { merged: mergeResults(ordered), individual: ordered };
}

async function getIpDetail(redisClient, ip) {
  if (isPrivateOrInvalid(ip)) return null;

  var result = null;

  // Try Redis cache if client is available
  if (redisClient) {
    var safeKey = ip.replace(/[^a-fA-F0-9:.]/g, "_");
    var cacheKey = IP_CACHE_PREFIX + safeKey;

    var cached = await redisClient.get(cacheKey).catch(function () { return null; });
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  result = await queryAllApis(ip);
  if (result && redisClient) {
    var safeKey = ip.replace(/[^a-fA-F0-9:.]/g, "_");
    var cacheKey = IP_CACHE_PREFIX + safeKey;
    await redisClient.set(cacheKey, JSON.stringify(result.merged)).catch(function () {});
    await redisClient.expire(cacheKey, IP_CACHE_TTL).catch(function () {});

    var rawKey = cacheKey + ":raw";
    await redisClient.set(rawKey, JSON.stringify(result.individual)).catch(function () {});
    await redisClient.expire(rawKey, IP_CACHE_TTL).catch(function () {});
  }

  return result ? result.merged : null;
}

async function getIpIndividualResults(redisClient, ip) {
  if (isPrivateOrInvalid(ip)) return [];

  var safeKey = ip.replace(/[^a-fA-F0-9:.]/g, "_");

  // Try Redis cache if client is available
  if (redisClient) {
    var rawKey = IP_CACHE_PREFIX + safeKey + ":raw";
    var cached = await redisClient.get(rawKey).catch(function () { return null; });
    if (cached) {
      try {
        var arr = JSON.parse(cached);
        if (Array.isArray(arr)) return arr;
      } catch (e) {}
    }
  }

  var result = await queryAllApis(ip);
  if (result && result.individual && redisClient) {
    var rawKey = IP_CACHE_PREFIX + safeKey + ":raw";
    await redisClient.set(rawKey, JSON.stringify(result.individual)).catch(function () {});
    await redisClient.expire(rawKey, IP_CACHE_TTL).catch(function () {});

    var cacheKey = IP_CACHE_PREFIX + safeKey;
    await redisClient.set(cacheKey, JSON.stringify(result.merged)).catch(function () {});
    await redisClient.expire(cacheKey, IP_CACHE_TTL).catch(function () {});
  }

  return result ? result.individual : [];
}

module.exports = {
  IP_APIS: IP_APIS,
  IP_CACHE_PREFIX: IP_CACHE_PREFIX,
  IP_CACHE_TTL: IP_CACHE_TTL,
  queryAllApis: queryAllApis,
  mergeResults: mergeResults,
  getIpDetail: getIpDetail,
  getIpIndividualResults: getIpIndividualResults,
  isPrivateOrInvalid: isPrivateOrInvalid
};