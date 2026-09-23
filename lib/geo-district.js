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

// 实例内存缓存：同一台热实例上重复访客 0 查询、0 网络（Vercel 实例会被复用）
var memCache = {};
var MEM_MAX = 500;

function memGet(ip) {
  var e = memCache[ip];
  if (!e) return null;
  if (e.exp < Date.now()) {
    delete memCache[ip];
    return null;
  }
  return e.value;
}

function memSet(ip, value, ttlMs) {
  if (Object.keys(memCache).length > MEM_MAX) memCache = {};
  var ttl = ttlMs || (value ? CACHE_FRESH_MS : CACHE_EMPTY_MS);
  memCache[ip] = { value: value, exp: Date.now() + ttl };
}

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

// 自愈式建列：借用已有的 ip_lookups 表，补腾讯字段（幂等）
function ensureColumns() {
  if (!ensurePromise) {
    ensurePromise = (async function () {
      await pg.query(
        "alter table ip_lookups " +
          "add column if not exists region_zh varchar(64) not null default '', " +
          "add column if not exists city_zh varchar(64) not null default '', " +
          "add column if not exists district varchar(64) not null default '', " +
          "add column if not exists district_checked_at timestamptz"
      );
      console.log("[geo-district] ip_lookups columns ready");
    })().catch(function (e) {
      console.warn("[geo-district] ensure columns failed:", e && e.message);
      ensurePromise = null;
      throw e;
    });
  }
  return ensurePromise;
}

// 腾讯返回的省市自带「省/市/自治区」后缀，去掉后与 ip-api 的中文值风格一致
function cleanZh(v) {
  return String(v || "")
    .trim()
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/g, "");
}

// ---------- ip_lookups 读取：一次 SELECT 同时拿到中文省市 + 区县缓存状态 ----------

var memGeo = {}; // ip -> { value: {region,city,district,checkedAt} | null }
var MEM_GEO_TTL_MS = 10 * 60 * 1000;

function geoMemGet(ip) {
  var e = memGeo[ip];
  if (!e) return undefined;
  if (e.exp < Date.now()) {
    delete memGeo[ip];
    return undefined;
  }
  return e.value;
}

function geoMemSet(ip, value, ttlMs) {
  if (Object.keys(memGeo).length > MEM_MAX) memGeo = {};
  memGeo[ip] = { value: value, exp: Date.now() + (ttlMs || MEM_GEO_TTL_MS) };
}

// 读 ip_lookups：中文省市 + 区县及其检查时间。
// 中文省市优先用腾讯的 region_zh/city_zh（更全），否则回落到 ip-api 的 region/city（同样是中文）。
// 没有该 IP → null。**不联网**，只 1 次 SELECT；结果进实例内存缓存。
async function getStoredGeo(rawIp) {
  var ip = normalizeIp(rawIp);
  if (isPrivateOrInvalid(ip)) return null;
  var mem = geoMemGet(ip);
  if (mem !== undefined) return mem;
  try {
    await ensureColumns();
    var r = await pg.query(
      "select region, city, region_zh, city_zh, district, district_checked_at from ip_lookups where ip = $1",
      [ip]
    );
    var out = null;
    if (r && r.rows && r.rows.length) {
      var row = r.rows[0];
      out = {
        region: String(row.region_zh || "").trim() || String(row.region || "").trim(),
        city: String(row.city_zh || "").trim() || String(row.city || "").trim(),
        district: String(row.district || "").trim(),
        checkedAt: row.district_checked_at ? new Date(row.district_checked_at).getTime() : 0,
        fromTencent: Boolean(String(row.region_zh || "").trim() || String(row.city_zh || "").trim()),
      };
    }
    geoMemSet(ip, out, out ? MEM_GEO_TTL_MS : 60 * 1000);
    return out;
  } catch (e) {
    return null; // DB 不可用 → 静默降级，绝不影响通知
  }
}

// 从 ip_lookups 行判断区县是否还新鲜：null = 没查过 / 已过期 → 需要重查
function districtFromStored(stored) {
  if (!stored || !stored.checkedAt) return null;
  var ttl = stored.district ? CACHE_FRESH_MS : CACHE_EMPTY_MS; // 空结果只信 1 天
  if (Date.now() - stored.checkedAt > ttl) return null;
  return stored.district;
}

async function writeCache(ip, ad) {
  ad = ad || {};
  await pg.query(
    "insert into ip_lookups (ip, region_zh, city_zh, district, district_checked_at, updated_at) " +
      "values ($1, $2, $3, $4, now(), now()) " +
      "on conflict (ip) do update set region_zh = excluded.region_zh, city_zh = excluded.city_zh, " +
      "district = excluded.district, district_checked_at = now(), updated_at = now()",
    [ip, ad.province || "", ad.city || "", ad.district || ""]
  );
  memSet(ip, ad.district || "");
  var prev = geoMemGet(ip);
  geoMemSet(ip, {
    region: ad.province || (prev && prev.region) || "",
    city: ad.city || (prev && prev.city) || "",
    district: ad.district || "",
    checkedAt: Date.now(),
    fromTencent: true,
  }, MEM_GEO_TTL_MS);
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

// 成功 → { province, city, district }（中文，可能部分为空）；失败 → null（调用方不得写缓存）
// ⭐ 腾讯同时给「省 + 市 + 区县」，所以中文地区可以完全以它为准，不必依赖 Vercel 头部（国内常为空）
async function fetchAdInfo(ip) {
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
  // 打全 ad_info，便于排查「为什么没有区县」（海外请求 / 该 IP 无数据 / 配额异常）
  console.log("[geo-district] tencent ok", ip, "ad_info=" + JSON.stringify(ad));
  var province = cleanZh(ad.province);
  var city = cleanZh(ad.city);
  if (city && province && city === province) city = ""; // 直辖市：province===city，只留一个
  return { province: province, city: city, district: String(ad.district || "").trim() };
}

// ---------- 后台任务：保证「响应发出后」仍能跑完（Vercel 冻结实例也不会丢）----------

var background = require("./background");

function runInBackground(promise) {
  return background.run(promise, "geo-district");
}

// 联网查询 + 落库（只在后台执行，绝不放在用户的等待路径里）
async function fetchAndCache(rawIp) {
  var ip = normalizeIp(rawIp);
  if (!TENCENT_KEY || isPrivateOrInvalid(ip)) return "";
  if (failUntil[ip] && failUntil[ip] > Date.now()) return ""; // 退避期内不再打接口
  if (inflight[ip]) return inflight[ip]; // 同实例并发去重

  var task = (async function () {
    try {
      await ensureColumns();
      var fresh = districtFromStored(await getStoredGeo(ip));
      if (fresh !== null) return fresh;
      var ad = await fetchAdInfo(ip);
      if (ad === null) {
        // 失败：不写缓存（下次仍会重试），但本实例内先退避，避免每个页面都来一次
        if (Object.keys(failUntil).length > 500) failUntil = {};
        failUntil[ip] = Date.now() + FAIL_BACKOFF_MS;
        return "";
      }
      delete failUntil[ip];
      await writeCache(ip, ad);
      console.log(
        "[geo-district] queried",
        ip,
        "->",
        (ad.province || "") + (ad.city || "") + (ad.district || "") || "(empty)"
      );
      return ad.district || "";
    } catch (e) {
      console.warn("[geo-district] fetchAndCache error:", e && e.message);
      return "";
    } finally {
      delete inflight[ip];
    }
  })();

  inflight[ip] = task;
  return task;
}

// ⭐ 请求路径专用：**永不阻塞外部接口**
//   只做一次 DB 缓存查询（几十 ms）；未命中就把「联网 + 落库」丢后台，立刻返回 ""。
//   影响：某个 IP 的**第一次**通知可能没有区县（省/市 仍然有），之后 30 天内的通知都有。
async function getDistrict(rawIp) {
  if (!TENCENT_KEY) return ""; // 未配置 → 静默降级，只出省市
  var ip = normalizeIp(rawIp);
  if (isPrivateOrInvalid(ip)) return "";

  var memHit = memGet(ip);
  if (memHit !== null) return memHit; // ① 实例内存命中：0 查询 0 网络

  var fresh = districtFromStored(await getStoredGeo(ip)); // ② 数据库缓存：1 次 SELECT
  if (fresh !== null) {
    memSet(ip, fresh);
    return fresh;
  }

  memSet(ip, "", 60 * 1000); // 负缓存 60s：同一实例内不要连续查库（后台预热完成后会覆盖）
  runInBackground(fetchAndCache(ip)); // ③ 都没有 → 后台补，不占用用户等待时间
  return "";
}

module.exports = {
  getDistrict: getDistrict, // 请求路径用（不阻塞）
  getStoredGeo: getStoredGeo, // 读 ip_lookups 的中文省市/区县（1 次 SELECT，不联网）
  fetchAndCache: fetchAndCache, // 后台预热 / 手动补数据
  normalizeIp: normalizeIp,
  isPrivateOrInvalid: isPrivateOrInvalid,
  CACHE_FRESH_MS: CACHE_FRESH_MS,
  CACHE_EMPTY_MS: CACHE_EMPTY_MS,
};
