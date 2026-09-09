const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");

const USED_COUNTER_KEY = "auth:counter:used_redeem_codes";

async function handleStats() {
  const [totalProducts, totalRedeemCodes, totalActivations, usedCountCached] = await Promise.all([
    redis.hlen("auth:products"),
    redis.scard("auth:redeem_codes"),
    redis.scard("auth:activation_codes"),
    redis.get(USED_COUNTER_KEY),
  ]);

  var usedCount = parseInt(usedCountCached, 10);
  if (!Number.isFinite(usedCount) || usedCount < 0) {
    usedCount = 0;
    var cursor = "0";
    var guard = 0;
    do {
      var codes = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
      var nextCursor = Array.isArray(codes) ? String(codes[0] ?? "0") : String(codes?.cursor ?? "0");
      var keys = Array.isArray(codes) ? (codes[1] || []) : (codes?.keys || []);
      cursor = nextCursor;
      if (keys.length > 0) {
        var pipeline = redis.pipeline();
        keys.forEach(function(code) { pipeline.get("auth:redeem:" + code); });
        var results = await pipeline.exec();
        usedCount += (results || []).filter(function(r) {
          var data = r;
          if (typeof data === "string") {
            try { data = JSON.parse(data); } catch (e) { return false; }
          }
          return data && data.used;
        }).length;
      }
      guard++;
    } while (cursor !== "0" && guard < 500);

    try {
      await redis.set(USED_COUNTER_KEY, String(usedCount), { ex: 300 });
    } catch (e) {
      console.error("Failed to cache used count:", e);
    }
  }

  return {
    success: true,
    stats: {
      totalProducts: totalProducts,
      totalRedeemCodes: totalRedeemCodes,
      usedRedeemCodes: usedCount,
      unusedRedeemCodes: Math.max(0, (totalRedeemCodes || 0) - usedCount),
      totalActivations: totalActivations,
    },
  };
}

async function handleTrends(days) {
  var now = Date.now();
  var dayMs = 24 * 60 * 60 * 1000;
  var startTs = now - days * dayMs;

  var dateSlots = [];
  for (var d = 0; d < days; d++) {
    var slotDate = new Date(now - (days - 1 - d) * dayMs);
    var dateKey = slotDate.toISOString().slice(0, 10);
    dateSlots.push({ date: dateKey, ts: slotDate.getTime() });
  }

  function getDateKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  var orderMap = {};
  var activationMap = {};
  dateSlots.forEach(function(s) {
    orderMap[s.date] = { count: 0, revenue: 0 };
    activationMap[s.date] = { count: 0 };
  });

  var orderKeys = [];
  try {
    var processedSet = await redis.smembers("afdian:processed");
    if (processedSet && processedSet.length) {
      orderKeys = processedSet;
    }
  } catch (e) {
    console.error("trends: failed to read afdian:processed set:", e.message);
  }

  var BATCH = 200;
  for (var i = 0; i < orderKeys.length; i += BATCH) {
    var batch = orderKeys.slice(i, i + BATCH);
    var pipeline = redis.pipeline();
    batch.forEach(function(key) {
      pipeline.get("afdian:order:" + key);
    });
    var results = await pipeline.exec();
    if (results && results.length) {
      for (var j = 0; j < results.length; j++) {
        var raw = results[j];
        if (!raw) continue;
        try {
          var order = typeof raw === "string" ? JSON.parse(raw) : raw;
          var orderTs = order.created_at;
          if (!orderTs) continue;
          if (orderTs < startTs) continue;
          var dk = getDateKey(orderTs);
          var slot = orderMap[dk];
          if (!slot) continue;
          slot.count++;
          var amt = parseFloat(order.total_amount) || 0;
          slot.revenue += amt;
        } catch (e) {}
      }
    }
  }

  var activationKeys = [];
  try {
    activationKeys = await redis.smembers("auth:activation_codes");
  } catch (e) {
    console.error("trends: failed to read auth:activation_codes:", e.message);
  }

  for (var k = 0; k < activationKeys.length; k += BATCH) {
    var abatch = activationKeys.slice(k, k + BATCH);
    var apipeline = redis.pipeline();
    abatch.forEach(function(code) {
      apipeline.get("auth:activation:" + code);
    });
    var aresults = await apipeline.exec();
    if (aresults && aresults.length) {
      for (var m = 0; m < aresults.length; m++) {
        var araw = aresults[m];
        if (!araw) continue;
        try {
          var act = typeof araw === "string" ? JSON.parse(araw) : araw;
          var actTs = act.generated_at;
          if (!actTs) continue;
          if (actTs < startTs) continue;
          var adk = getDateKey(actTs);
          var aslot = activationMap[adk];
          if (!aslot) continue;
          aslot.count++;
        } catch (e) {}
      }
    }
  }

  var totalKeys = 0;
  try {
    var counts = await Promise.all([
      redis.scard("auth:redeem_codes").catch(function() { return 0; }),
      redis.scard("auth:activation_codes").catch(function() { return 0; }),
      redis.scard("afdian:processed").catch(function() { return 0; }),
      redis.hlen("auth:products").catch(function() { return 0; }),
    ]);
    totalKeys = counts.reduce(function(a, b) { return a + b; }, 0);
  } catch (e) {
    totalKeys = 0;
  }

  var orders = dateSlots.map(function(s) { return orderMap[s.date]; });
  var activations = dateSlots.map(function(s) { return activationMap[s.date]; });

  return {
    success: true,
    days: days,
    labels: dateSlots.map(function(s) { return s.date.slice(5); }),
    orders: orders,
    activations: activations,
    summary: {
      totalOrders: orders.reduce(function(acc, o) { return acc + o.count; }, 0),
      totalRevenue: orders.reduce(function(acc, o) { return acc + o.revenue; }, 0),
      totalActivations: activations.reduce(function(acc, a) { return acc + a.count; }, 0),
      currentDbKeys: totalKeys,
    },
  };
}

var visitorTTL = 7 * 24 * 60 * 60;

function todayKey(ts) {
  var d = new Date(ts || Date.now());
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, "0");
  var day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

async function handleVisitorOverview() {
  var today = todayKey();
  var yesterday = todayKey(Date.now() - 24 * 60 * 60 * 1000);

  var result = await Promise.all([
    redis.scard("stats:uv:" + today).catch(function () { return 0; }),
    redis.get("stats:pv:" + today).catch(function () { return null; }),
    redis.scard("stats:uv:" + yesterday).catch(function () { return 0; }),
    redis.get("stats:pv:" + yesterday).catch(function () { return null; }),
    redis.zrange("stats:pages:" + today, 0, -1, { withScores: true }).catch(function () { return []; }),
  ]);

  var todayUv = result[0] || 0;
  var todayPv = parseInt(result[1], 10) || 0;
  var ydUv = result[2] || 0;
  var ydPv = parseInt(result[3], 10) || 0;
  var pagesRaw = result[4] || [];

  var topPages = [];
  for (var i = 0; i < pagesRaw.length; i += 2) {
    topPages.push({ path: pagesRaw[i], hits: parseInt(pagesRaw[i + 1], 10) || 0 });
  }
  topPages.sort(function (a, b) { return b.hits - a.hits; });
  topPages = topPages.slice(0, 5);

  return {
    success: true,
    today: { uv: todayUv, pv: todayPv },
    yesterday: { uv: ydUv, pv: ydPv },
    topPages: topPages,
  };
}

async function handleVisitorTrend(days) {
  days = Math.max(1, Math.min(days, 30));
  var labels = [];
  var uvData = [];
  var pvData = [];

  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    var dk = todayKey(d.getTime());
    labels.push(dk.slice(5));
    var uv = await redis.scard("stats:uv:" + dk).catch(function () { return 0; });
    var pvRaw = await redis.get("stats:pv:" + dk).catch(function () { return null; });
    uvData.push(uv || 0);
    pvData.push(parseInt(pvRaw, 10) || 0);
  }

  return {
    success: true,
    days: days,
    labels: labels,
    uv: uvData,
    pv: pvData,
  };
}

async function handleVisitorRecent() {
  var records = await redis.lrange("stats:recent", 0, 49).catch(function () { return []; });
  var list = [];
  for (var i = 0; i < records.length; i++) {
    try {
      var obj = typeof records[i] === "string" ? JSON.parse(records[i]) : records[i];
      list.push({
        hash: obj.h || "",
        path: obj.p || "/",
        ua: obj.u || "",
        ref: obj.r || "",
        time: obj.t || 0,
        country: obj.c || "",
        region: obj.rg || "",
        city: obj.ci || "",
        timezone: obj.tz || "",
      });
    } catch (e) {}
  }
  return { success: true, visitors: list };
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var section = req.query && req.query.section;

    if (section === "visitor-overview") {
      return res.json(await handleVisitorOverview());
    }
    if (section === "visitor-trend") {
      var vdays = parseInt(req.query && req.query.days, 10) || 7;
      if (vdays < 1) vdays = 1;
      if (vdays > 30) vdays = 30;
      return res.json(await handleVisitorTrend(vdays));
    }
    if (section === "visitor-recent") {
      return res.json(await handleVisitorRecent());
    }

    if (section === "trends") {
      var days = parseInt(req.query && req.query.days, 10) || 7;
      if (days < 1) days = 1;
      if (days > 90) days = 90;
      return res.json(await handleTrends(days));
    }

    return res.json(await handleStats());
  } catch (error) {
    console.error("Stats error:", error);
    var msg = "Internal server error";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Server database (Postgres) not configured, contact admin";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND/i.test(String(error.message || ""))) {
      msg = "Server database connection failed, try again later or contact admin";
    }
    return res.status(500).json({ success: false, error: msg });
  }
};