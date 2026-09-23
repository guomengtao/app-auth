// lib/geo-district.js — 区县级归属地（腾讯位置服务 IP 定位）+ Supabase 落库缓存
//
// 背景：Vercel 头部 / ip-api 只能到「市」，拿不到区县（"朝阳区"）。
//      腾讯位置服务 IP 定位能返回 ad_info.district，但**免费额度有限**，必须做缓存。
//
// 额度保护策略：
//   1. 先查 Supabase `ip_lookups`（district + district_checked_at）：30 天内命中直接返回，**不调接口**；
//   2. 只有「没查过 / 缓存过期」才调腾讯接口，成功后立刻落库；
//   3. 接口失败（超时 / status 121 配额用尽 / 110 来源未授权 / 网络错误）**一律不写缓存**，
//      避免把空结果缓存 30 天；下次请求仍会重试。
//
// 环境变量：
//   TENCENT_MAP_KEY      必填。腾讯位置服务 key（WebService API）
//   TENCENT_MAP_REFERER  可选，默认 https://gudq.com/
//                        —— 该 key 在控制台走「域名白名单」校验，服务端调用**必须带 Referer**，
//                           否则报 status 110「来源域名未被授权」。
//   TENCENT_MAP_SK       可选。若控制台把校验方式改成「SN 签名」，填 SK，代码会自动加 sig 参数。
//
// 任何失败都静默返回 `""`，绝不影响通知发送。

var crypto = require("crypto");
var pg = require("./postgres");

var TENCENT_KEY = process.env.TENCENT_MAP_KEY || "";
var TENCENT_REFERER = process.env.TENCENT_MAP_REFERER || "https://gudq.com/";
var TENCENT_SK = process.env.TENCENT_MAP_SK || "";
var TENCENT_API = "https://apis.map.qq.com";
var TENCENT_PATH = "/ws/location/v1/ip";
// ⚠️ Vercel 函数部署在 iad1（美东），跨洋调腾讯国内接口 >800ms，超时太紧会一直 abort（已在线上实测到）
var API_TIMEOUT_MS = 2500;
var CACHE_FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 查到区县：30 天内不重复调用
var CACHE_EMPTY_MS = 24 * 60 * 60 * 1000; // 查到但是空（无区县数据/配额异常）：只信 1 天，避免把偶发空值锁 30 天
var FAIL_BACKOFF_MS = 10 * 60 * 1000; // 失败后同实例 10 分钟内不再重试（防「每页一次 visit」打爆接口）

var ensurePromise = null;
var inflight = {};
var failUntil = {};

// "1.2.3.4, 5.6.7.8" / "::ffff:1.2.3.4" / "1.2.3.4:5678" → "1.2.3.4"
function normalizeIp(raw) {
  if (!raw) return "";
  var v = String(raw).split(",")[0].trim();
  if (v.indexOf("::ffff:") === 0) v = v.slice(7);
  var m = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (m) v = m[1];
  return v;
}

function isPrivateOrInvalid(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "unknown") return true;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  if (/^(fc|fd|fe80)/i.test(ip)) return true;
  return false;
}

// 自愈式建列：借用已有的 ip_lookups 表，补两列（幂等）
function ensureColumns() {
  if (!ensurePromise) {
    ensurePromise = (async function () {
      await pg.query("alter table ip_lookups add column if not exists district varchar(64) not null default ''");
      await pg.query("alter table ip_lookups add column if not exists district_checked_at timestamptz");
      console.log("[geo-district] ip_lookups columns ready");
    })().catch(function (e) {
      console.warn("[geo-district] ensure columns failed:", e && e.message);
      ensurePromise = null;
      throw e;
    });
  }
  return ensurePromise;
}

async function readCache(ip) {
  var r = await pg.query(
    "select district, district_checked_at from ip_lookups where ip = $1",
    [ip]
  );
  if (!r || !r.rows || !r.rows.length) return null;
  var row = r.rows[0];
  if (!row.district_checked_at) return null;
  var ts = new Date(row.district_checked_at).getTime();
  if (!ts) return null;
  var district = String(row.district || "");
  var ttl = district ? CACHE_FRESH_MS : CACHE_EMPTY_MS; // 空结果只信 1 天
  if (Date.now() - ts > ttl) return null; // 过期 → 重查
  return district;
}

async function writeCache(ip, district) {
  await pg.query(
    "insert into ip_lookups (ip, district, district_checked_at, updated_at) values ($1, $2, now(), now()) " +
      "on conflict (ip) do update set district = excluded.district, " +
      "district_checked_at = now(), updated_at = now()",
    [ip, district || ""]
  );
}

function buildUrl(ip) {
  var query = TENCENT_PATH + "?ip=" + encodeURIComponent(ip) + "&key=" + encodeURIComponent(TENCENT_KEY);
  if (TENCENT_SK) {
    // SN 签名：sig = md5(path?query + SK)
    var sig = crypto.createHash("md5").update(query + TENCENT_SK).digest("hex");
    query += "&sig=" + sig;
  }
  return TENCENT_API + query;
}

// 成功 → 字符串（可能为空，表示该 IP 无区县）；失败 → null（调用方不得写缓存）
async function fetchDistrict(ip) {
  var r = await fetch(buildUrl(ip), {
    headers: {
      "Referer": TENCENT_REFERER,
      "User-Agent": "app-auth/geo-district",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  var o = await r.json().catch(function () { return null; });
  if (!o || o.status !== 0) {
    console.warn("[geo-district] tencent failed status=" + (o && o.status) + " msg=" + (o && o.message));
    return null;
  }
  var ad = (o.result && o.result.ad_info) || {};
  // 打全 ad_info，便于排查「为什么没有区县」（海外请求 / 该 IP 无区县数据 / 配额异常）
  console.log("[geo-district] tencent ok", ip, "ad_info=" + JSON.stringify(ad));
  return String(ad.district || "").trim();
}

async function getDistrict(rawIp) {
  if (!TENCENT_KEY) return ""; // 未配置 → 静默降级，只出省市
  var ip = normalizeIp(rawIp);
  if (isPrivateOrInvalid(ip)) return "";
  if (failUntil[ip] && failUntil[ip] > Date.now()) return ""; // 退避期内不再打接口
  if (inflight[ip]) return inflight[ip]; // 同实例并发去重

  var task = (async function () {
    try {
      await ensureColumns();
      var cached = await readCache(ip);
      if (cached !== null) {
        console.log("[geo-district] cache hit", ip, "->", cached || "(empty)");
        return cached;
      }
      var district = await fetchDistrict(ip);
      if (district === null) {
        // 失败：不写缓存（下次仍会重试），但本实例内先退避，避免每个页面都来一次
        if (Object.keys(failUntil).length > 500) failUntil = {};
        failUntil[ip] = Date.now() + FAIL_BACKOFF_MS;
        return "";
      }
      delete failUntil[ip];
      await writeCache(ip, district);
      console.log("[geo-district] queried", ip, "->", district || "(empty)");
      return district;
    } catch (e) {
      console.warn("[geo-district] getDistrict error:", e && e.message);
      return "";
    } finally {
      delete inflight[ip];
    }
  })();

  inflight[ip] = task;
  return task;
}

module.exports = {
  getDistrict: getDistrict,
  normalizeIp: normalizeIp,
  isPrivateOrInvalid: isPrivateOrInvalid,
  CACHE_FRESH_MS: CACHE_FRESH_MS,
};
