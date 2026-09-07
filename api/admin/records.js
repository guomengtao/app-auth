const redis = require("../../lib/redis");
const { requireAuth } = require("../../lib/auth");

function parseRecord(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return raw;
}

async function fetchRecordsFromSet(setKey, keyPrefix, count) {
  try {
    const [nextCursor, keys] = await redis.sscan(setKey, 0, { count });
    if (keys.length === 0) return { nextCursor: 0, records: [] };
    const pipeline = redis.pipeline();
    keys.forEach((k) => pipeline.get(keyPrefix ? (keyPrefix + k) : k));
    const results = await pipeline.exec();
    const records = results
      .map(parseRecord)
      .filter(Boolean);
    return { nextCursor, records };
  } catch (e) {
    console.error("fetchRecordsFromSet error:", setKey, e.message);
    return { nextCursor: 0, records: [] };
  }
}

module.exports = async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.authorized) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { product_id, redeem_code, status, device_id, ip } = req.query;
    const count = Math.min(parseInt(req.query.count) || 500, 500);

    const statusFilter = status || "all";

    let allRecords = [];

    if (statusFilter === "all" || statusFilter === "success") {
      const { records } = await fetchRecordsFromSet("auth:activation_codes", "auth:activation:", count);
      allRecords = allRecords.concat(records);
    }

    if (statusFilter === "all" || statusFilter === "failure") {
      const { records } = await fetchRecordsFromSet("auth:activation_failures", "", count);
      allRecords = allRecords.concat(records);
    }

    if (product_id) {
      allRecords = allRecords.filter((r) => r.product_id === product_id);
    }

    if (redeem_code) {
      const rc = String(redeem_code).trim().toUpperCase();
      if (rc) {
        allRecords = allRecords.filter((r) => String(r.redeem_code || "").toUpperCase() === rc);
      }
    }

    if (device_id) {
      const did = String(device_id).trim().toLowerCase();
      if (did) {
        allRecords = allRecords.filter((r) => {
          var rd = String(r.device_id || r.device_id_full || "").toLowerCase();
          return rd.includes(did);
        });
      }
    }

    if (ip) {
      const ipStr = String(ip).trim();
      if (ipStr) {
        allRecords = allRecords.filter((r) => {
          var vi = r.visitor_info;
          if (!vi) return false;
          var recordIp = String(vi.ip || "").toLowerCase();
          return recordIp.includes(ipStr.toLowerCase());
        });
      }
    }

    allRecords.sort((a, b) => (Number(b.generated_at) || 0) - (Number(a.generated_at) || 0));

    return res.json({
      success: true,
      records: allRecords,
      cursor: 0,
      hasMore: false,
    });
  } catch (error) {
    console.error("Records error:", error);
    var msg = "Internal server error";
    if (error && error.code === "PG_ENV_MISSING") {
      msg = "Server database (Postgres) not configured, contact admin";
    } else if (error && /connection|ECONNREFUSED|ENOTFOUND/i.test(String(error.message || ""))) {
      msg = "Server database connection failed, try again later or contact admin";
    }
    return res.status(500).json({ success: false, error: msg });
  }
};