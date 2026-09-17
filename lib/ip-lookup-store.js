var pg = require("./postgres");

var UPSERT_SQL = [
  "insert into ip_lookups (ip, country, region, city, isp, org, asn, lat, lon, timezone, sources, raw_data, updated_at)",
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())",
  "on conflict (ip) do update set",
  "  country = excluded.country,",
  "  region = excluded.region,",
  "  city = excluded.city,",
  "  isp = excluded.isp,",
  "  org = excluded.org,",
  "  asn = excluded.asn,",
  "  lat = excluded.lat,",
  "  lon = excluded.lon,",
  "  timezone = excluded.timezone,",
  "  sources = excluded.sources,",
  "  raw_data = excluded.raw_data,",
  "  updated_at = now()",
].join(" ");

var SELECT_SQL = "select * from ip_lookups where ip = $1";

async function getFromStore(ip) {
  try {
    var result = await pg.query(SELECT_SQL, [ip]);
    if (result.rows && result.rows.length > 0) return result.rows[0];
  } catch (e) {
    console.error("[ip-lookup-store] get error:", e.message);
  }
  return null;
}

async function saveToStore(ip, merged, individual) {
  try {
    await pg.query(UPSERT_SQL, [
      ip,
      merged.country || "",
      merged.region || "",
      merged.city || "",
      merged.isp || "",
      merged.org || "",
      merged.asn || "",
      merged.lat || 0,
      merged.lon || 0,
      merged.timezone || "",
      merged.source || "",
      JSON.stringify(individual || []),
    ]);
  } catch (e) {
    console.error("[ip-lookup-store] save error:", e.message);
  }
}

module.exports = { getFromStore, saveToStore };