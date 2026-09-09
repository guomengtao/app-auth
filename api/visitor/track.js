var redis = require("../../lib/redis");
var rateLimit = require("../../lib/rate-limit");

var TTL_SECONDS = 7 * 24 * 60 * 60;

function hashKey(str) {
  if (!str) return "unknown";
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function todayKey(ts) {
  var d = new Date(ts || Date.now());
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, "0");
  var day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

async function track(req, res) {
  try {
    var ipCheck = await rateLimit.checkIpRateLimit(req);
    if (ipCheck.blocked) {
      return res.status(429).json({ success: false, error: ipCheck.reason });
    }

    var body = req.body || {};
    var path = String(body.path || (req.query && req.query.path) || "/");
    var ua = String((req.headers && req.headers["user-agent"]) || "unknown");
    var ref = String(body.ref || (req.query && req.query.ref) || "");
    var ts = Date.now();
    var dateKey = todayKey(ts);

    var ip = rateLimit.getClientIp(req);
    var visitorHash = hashKey(ip + "|" + ua.slice(0, 120));

    var uvKey = "stats:uv:" + dateKey;
    var pvKey = "stats:pv:" + dateKey;
    var pagesKey = "stats:pages:" + dateKey;
    var recentKey = "stats:recent";

    var trimmedPath = path.length > 120 ? path.slice(0, 120) : path;

    var isNew = await redis.sadd(uvKey, visitorHash);
    if (isNew === 1) {
      await redis.expire(uvKey, TTL_SECONDS).catch(function () {});
    }

    await redis.incr(pvKey);
    await redis.expire(pvKey, TTL_SECONDS).catch(function () {});

    await redis.zincrby(pagesKey, 1, trimmedPath);
    await redis.expire(pagesKey, TTL_SECONDS).catch(function () {});

    var record = JSON.stringify({
      h: visitorHash.slice(0, 8),
      p: trimmedPath,
      u: ua.slice(0, 80),
      r: ref.slice(0, 80),
      t: ts,
    });
    await redis.lpush(recentKey, record);
    await redis.ltrim(recentKey, 0, 99);
    await redis.expire(recentKey, TTL_SECONDS).catch(function () {});

    return res.json({
      success: true,
      isNewVisitor: isNew === 1,
    });
  } catch (e) {
    console.error("[visitor/track]", e);
    return res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = track;