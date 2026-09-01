var redis = require("../../lib/redis");
var { requireAuth } = require("../../lib/auth");
var quota = require("../../lib/quota");

function parseJsonSafe(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function normalizeSscanResult(result) {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] == null ? "0" : result[0]),
      keys: Array.isArray(result[1]) ? result[1] : [],
    };
  }
  if (result && typeof result === "object") {
    return {
      cursor: String(result.cursor == null ? "0" : result.cursor),
      keys: Array.isArray(result.keys) ? result.keys : [],
    };
  }
  return { cursor: "0", keys: [] };
}

async function scanAllSetMembers(setKey) {
  var allKeys = [];
  var cursor = "0";
  var guard = 0;
  do {
    var raw = await redis.sscan(setKey, cursor, { count: 200 });
    var parsed = normalizeSscanResult(raw);
    cursor = parsed.cursor;
    if (parsed.keys.length) {
      allKeys = allKeys.concat(parsed.keys);
    }
    guard++;
    if (guard > 5000) break;
  } while (cursor !== "0");
  return allKeys;
}

async function snapshotAll() {
  try { await quota.bumpQuotaTick("/api/admin/diff"); } catch (_) {}

  var pAll = await redis.hgetall("auth:products");
  var productsArray = [];
  if (pAll && typeof pAll === "object") {
    Object.keys(pAll).sort().forEach(function (id) {
      var v = parseJsonSafe(pAll[id], null);
      if (v && typeof v === "object") {
        productsArray.push(Object.assign({ id: String(id).padStart(2, "0") }, v));
      }
    });
  }
  var productCounter = Number(await redis.get("auth:product_counter")) || 0;

  var codeKeys = await scanAllSetMembers("auth:redeem_codes");
  var redeemCodesArray = [];
  if (codeKeys.length) {
    var chunks = [];
    for (var i = 0; i < codeKeys.length; i += 200) chunks.push(codeKeys.slice(i, i + 200));
    for (var c = 0; c < chunks.length; c++) {
      var batch = chunks[c];
      var keys = batch.map(function (x) { return "auth:redeem:" + x; });
      var vals = await redis.mget(keys);
      for (var j = 0; j < batch.length; j++) {
        var code = batch[j];
        var raw = vals && vals[j];
        var obj = parseJsonSafe(raw, null);
        if (obj) {
          var o = Object.assign({}, obj, { code: String(code).toUpperCase() });
          if (o.product_id) o.product_id = String(o.product_id).padStart(2, "0");
          redeemCodesArray.push(o);
        }
      }
    }
  }

  var actKeys = await scanAllSetMembers("auth:activation_codes");
  var activationsArray = [];
  if (actKeys.length) {
    var chunksA = [];
    for (var i2 = 0; i2 < actKeys.length; i2 += 200) chunksA.push(actKeys.slice(i2, i2 + 200));
    for (var c2 = 0; c2 < chunksA.length; c2++) {
      var batchA = chunksA[c2];
      var keysA = batchA.map(function (x) { return "auth:activation:" + x; });
      var valsA = await redis.mget(keysA);
      for (var j2 = 0; j2 < batchA.length; j2++) {
        var acode = batchA[j2];
        var rawA = valsA && valsA[j2];
        var objA = parseJsonSafe(rawA, null);
        if (objA) {
          var oa = Object.assign({}, objA);
          if (!oa.activation_code) oa.activation_code = String(acode);
          activationsArray.push(oa);
        }
      }
    }
  }

  return {
    schema: 2,
    generatedAt: Date.now(),
    counters: {
      product_counter: productCounter,
    },
    products: productsArray,
    redeemCodes: redeemCodesArray,
    activationRecords: activationsArray,
    stats: {
      productCount: productsArray.length,
      redeemCodeCount: redeemCodesArray.length,
      activationCount: activationsArray.length,
    },
  };
}

function normalizeProductId(id) {
  return String(id || "").padStart(2, "0");
}

function productKey(p) {
  return normalizeProductId(p.id);
}

function redeemCodeKey(c) {
  return String(c.code || "").toUpperCase().trim();
}

function activationKey(a) {
  return String(a.activation_code || "").trim();
}

function compareProducts(localArr, remoteArr) {
  var localMap = {};
  var remoteMap = {};
  var allKeys = {};
  localArr.forEach(function (p) {
    var k = productKey(p);
    localMap[k] = p;
    allKeys[k] = true;
  });
  remoteArr.forEach(function (p) {
    var k = productKey(p);
    remoteMap[k] = p;
    allKeys[k] = true;
  });

  var onlyLocal = [];
  var onlyRemote = [];
  var diff = [];
  var same = 0;

  Object.keys(allKeys).forEach(function (k) {
    var l = localMap[k];
    var r = remoteMap[k];
    if (l && !r) {
      onlyLocal.push({ id: k, local: l });
    } else if (!l && r) {
      onlyRemote.push({ id: k, remote: r });
    } else if (l && r) {
      var lStr = JSON.stringify(l);
      var rStr = JSON.stringify(r);
      if (lStr !== rStr) {
        diff.push({ id: k, local: l, remote: r });
      } else {
        same++;
      }
    }
  });

  return {
    localCount: localArr.length,
    remoteCount: remoteArr.length,
    same: same,
    onlyLocal: onlyLocal,
    onlyRemote: onlyRemote,
    diff: diff,
  };
}

function compareRedeemCodes(localArr, remoteArr) {
  var localMap = {};
  var remoteMap = {};
  var allKeys = {};
  localArr.forEach(function (c) {
    var k = redeemCodeKey(c);
    localMap[k] = c;
    allKeys[k] = true;
  });
  remoteArr.forEach(function (c) {
    var k = redeemCodeKey(c);
    remoteMap[k] = c;
    allKeys[k] = true;
  });

  var onlyLocal = [];
  var onlyRemote = [];
  var diff = [];
  var same = 0;

  Object.keys(allKeys).forEach(function (k) {
    var l = localMap[k];
    var r = remoteMap[k];
    if (l && !r) {
      onlyLocal.push({ code: k, local: l });
    } else if (!l && r) {
      onlyRemote.push({ code: k, remote: r });
    } else if (l && r) {
      var lStr = JSON.stringify(l);
      var rStr = JSON.stringify(r);
      if (lStr !== rStr) {
        diff.push({ code: k, local: l, remote: r });
      } else {
        same++;
      }
    }
  });

  return {
    localCount: localArr.length,
    remoteCount: remoteArr.length,
    same: same,
    onlyLocal: onlyLocal,
    onlyRemote: onlyRemote,
    diff: diff,
  };
}

function compareActivations(localArr, remoteArr) {
  var localMap = {};
  var remoteMap = {};
  var allKeys = {};
  localArr.forEach(function (a) {
    var k = activationKey(a);
    localMap[k] = a;
    allKeys[k] = true;
  });
  remoteArr.forEach(function (a) {
    var k = activationKey(a);
    remoteMap[k] = a;
    allKeys[k] = true;
  });

  var onlyLocal = [];
  var onlyRemote = [];
  var diff = [];
  var same = 0;

  Object.keys(allKeys).forEach(function (k) {
    var l = localMap[k];
    var r = remoteMap[k];
    if (l && !r) {
      onlyLocal.push({ activation_code: k, local: l });
    } else if (!l && r) {
      onlyRemote.push({ activation_code: k, remote: r });
    } else if (l && r) {
      var lStr = JSON.stringify(l);
      var rStr = JSON.stringify(r);
      if (lStr !== rStr) {
        diff.push({ activation_code: k, local: l, remote: r });
      } else {
        same++;
      }
    }
  });

  return {
    localCount: localArr.length,
    remoteCount: remoteArr.length,
    same: same,
    onlyLocal: onlyLocal,
    onlyRemote: onlyRemote,
    diff: diff,
  };
}

function compareCounters(local, remote) {
  return {
    local: local || {},
    remote: remote || {},
    diff: JSON.stringify(local) !== JSON.stringify(remote),
  };
}

async function fixProducts(data) {
  var products = Array.isArray(data) ? data : [];
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    var id = normalizeProductId(p.id);
    await redis.hset("auth:products", id, JSON.stringify(p));
  }
  return { fixed: products.length };
}

async function fixRedeemCodes(data) {
  var codes = Array.isArray(data) ? data : [];
  var fixed = 0;
  for (var i = 0; i < codes.length; i++) {
    var c = codes[i];
    var code = redeemCodeKey(c);
    try {
      await redis.setWithSadd("auth:redeem:" + code, JSON.stringify(c), "auth:redeem_codes", code);
      fixed++;
    } catch (se) {
      console.error("fixRedeemCodes setWithSadd failed:", code, se.message);
      await redis.set("auth:redeem:" + code, JSON.stringify(c));
      try { await redis.sadd("auth:redeem_codes", code); } catch (_) {}
      fixed++;
    }
  }
  return { fixed: fixed };
}

async function fixActivationRecords(data) {
  var records = Array.isArray(data) ? data : [];
  var fixed = 0;
  for (var i = 0; i < records.length; i++) {
    var a = records[i];
    var code = activationKey(a);
    try {
      await redis.setWithSadd("auth:activation:" + code, JSON.stringify(a), "auth:activation_codes", code);
      fixed++;
    } catch (se) {
      console.error("fixActivationRecords setWithSadd failed:", code, se.message);
      await redis.set("auth:activation:" + code, JSON.stringify(a));
      try { await redis.sadd("auth:activation_codes", code); } catch (_) {}
      fixed++;
    }
  }
  return { fixed: fixed };
}

async function fixCounters(data) {
  if (data && typeof data.product_counter !== "undefined") {
    await redis.set("auth:product_counter", String(data.product_counter));
  }
  return { fixed: true };
}

module.exports = async (req, res) => {
  var auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method === "GET") {
    try {
      var snap = await snapshotAll();
      return res.json({ success: true, snapshot: snap });
    } catch (e) {
      console.error("diff GET snapshot failed:", e);
      return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
    }
  }

  if (req.method === "POST") {
    var body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    if (!body || typeof body !== "object") {
      return res.status(400).json({ success: false, error: "Invalid request body" });
    }

    var action = String(body.action || "compare");
    var table = String(body.table || "");

    if (action === "compare") {
      try {
        var snap = await snapshotAll();
        var local = body.local || {};

        var result = {
          success: true,
          action: "compare",
          remoteGeneratedAt: snap.generatedAt,
          products: compareProducts(
            Array.isArray(local.products) ? local.products : [],
            snap.products || []
          ),
          redeemCodes: compareRedeemCodes(
            Array.isArray(local.redeemCodes) ? local.redeemCodes : [],
            snap.redeemCodes || []
          ),
          activationRecords: compareActivations(
            Array.isArray(local.activationRecords) ? local.activationRecords : [],
            snap.activationRecords || []
          ),
          counters: compareCounters(
            local.counters || {},
            snap.counters || {}
          ),
        };
        return res.json(result);
      } catch (e) {
        console.error("diff compare failed:", e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    if (action === "fix") {
      if (!table) {
        return res.status(400).json({ success: false, error: "Missing table parameter" });
      }
      try {
        var fixResult = null;
        switch (table) {
          case "products":
            fixResult = await fixProducts(body.data || []);
            break;
          case "redeemCodes":
            fixResult = await fixRedeemCodes(body.data || []);
            break;
          case "activationRecords":
            fixResult = await fixActivationRecords(body.data || []);
            break;
          case "counters":
            fixResult = await fixCounters(body.data || {});
            break;
          default:
            return res.status(400).json({ success: false, error: "Unknown table: " + table });
        }
        return res.json({ success: true, action: "fix", table: table, result: fixResult });
      } catch (e) {
        console.error("diff fix failed:", table, e);
        return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
      }
    }

    return res.status(400).json({ success: false, error: "Unknown action: " + action });
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};