var IP_CACHE_PREFIX = "ip:detail:";
var IP_CACHE_TTL = 24 * 60 * 60;
var API_TIMEOUT = 4000;

var IP_APIS = [
  {
    name: "ip-api",
    fetch: function(ip) {
      return fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query", {
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

async function queryAllApis(ip) {
  if (isPrivateOrInvalid(ip)) return null;

  var rawResults = [];
  for (var i = 0; i < IP_APIS.length; i++) {
    var api = IP_APIS[i];
    try {
      var r = await api.fetch(ip);
      if (r) {
        var nr = normalizeResult(r);
        rawResults.push(nr);
      }
    } catch (e) {}
  }

  if (rawResults.length === 0) return null;

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

  return { merged: merged, individual: rawResults };
}

async function getIpDetail(redisClient, ip) {
  if (isPrivateOrInvalid(ip)) return null;

  var safeKey = ip.replace(/[^a-fA-F0-9:.]/g, "_");
  var cacheKey = IP_CACHE_PREFIX + safeKey;

  var cached = await redisClient.get(cacheKey).catch(function () { return null; });
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var result = await queryAllApis(ip);
  if (result) {
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
  var rawKey = IP_CACHE_PREFIX + safeKey + ":raw";

  var cached = await redisClient.get(rawKey).catch(function () { return null; });
  if (cached) {
    try {
      var arr = JSON.parse(cached);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }

  var result = await queryAllApis(ip);
  if (result && result.individual) {
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
  getIpDetail: getIpDetail,
  getIpIndividualResults: getIpIndividualResults,
  isPrivateOrInvalid: isPrivateOrInvalid
};