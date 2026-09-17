# IP 统计：去掉 Cron，纯 AJAX + Supabase 持久化方案

## 1. 当前架构的问题

### 数据流

```
访客请求 → activate.js / api/visit
       │
       ├─ 写入 Redis stats:recent（含 IP、Vercel 国家/地区/城市）
       └─ 返回 200 OK

Cron 任务（每天凌晨 2 点）→ /api/admin/health?section=ip-lookup&cron=1
       │
       ├─ 从 stats:recent 读取 IP → 查询 5 个 API
       ├─ 结果写入 ip:detail:<IP> 缓存（Redis）
       └─ 结束（每天只跑一次）

管理后台打开"IP 对比"→ /api/admin/health?section=stats&sub=ip-compare
       │
       ├─ 读 ip:detail:<IP> 缓存
       ├─ 有缓存 → 秒出
       └─ 无缓存 → 显示"暂无 IP 数据"
```

### 为什么数据没了

IP 详情缓存 `ip:detail:*` **只靠每天凌晨 2 点的 Cron 填充**。如果：
- 部署时间在凌晨 2 点之后
- Vercel 平台维护跳过了 Cron
- 刚部署完还没到凌晨 2 点

→ 缓存就是空的，管理后台就显示"暂无 IP 数据（等待 Cron 任务执行）"

后备逻辑 `handleIpCompare2()` 虽然也可以实时查 API，但：
1. **5 个 API 串行查询**，最多 20 秒超时
2. 在 stats 这个大 handler 里跑，结构复杂

## 2. 核心思路：纯 AJAX + Supabase 持久化

**关键认知**：管理后台的"最近访客"标签**已经加载了访客 IP 列表**（通过 `section=stats&sub=visitor-recent` 获取）。切到"IP 对比"标签时，IP 已经在浏览器里了。

流程：

```
管理后台 → "最近访客"标签已加载（前端已有 IP 列表）
       │
用户点击 "IP 对比" 标签
       │
       ├─ 前端从已加载的访客数据中提取去重 IP 列表
       ├─ AJAX POST → /api/admin/health?section=ip-lookup-once
       │     ├─ body: { ips: ["1.2.3.4", "5.6.7.8", ...] }
       │     ├─ 后端：
       │     │   ├─ 1. 查 Supabase 看是否有已存的中文数据
       │     │   ├─ 2. 有 → 直接返回（秒级）
       │     │   ├─ 3. 无 → 调 5 个 IP 归属地 API（lang=zh-CN 优先）
       │     │   ├─ 4. 合并结果，中文优先
       │     │   ├─ 5. 存入 Supabase（下次直接命中）
       │     │   └─ 6. 返回结果
       │     └─ 返回：{ ip: "1.2.3.4", results: [各 API 结果] }
       ├─ 前端渲染 IP 对比表格
       └─ 前端存 localStorage 缓存（同页面秒切）
```

**全程不涉及**：
- ❌ Redis 队列（`ip:queue`）
- ❌ Redis 额外缓存（`ip:detail:*`）
- ❌ Cron 任务
- ❌ stats handler 里塞逻辑
- ❌ 访客请求里加额外操作

## 3. Supabase 持久化设计

### 3.1 建表

```sql
-- Supabase SQL Editor 执行
create table if not exists ip_lookups (
  ip            varchar(45) primary key,       -- IPv4 或 IPv6
  country       varchar(64) not null default '',
  region        varchar(64) not null default '',
  city          varchar(64) not null default '',
  isp           varchar(128) not null default '',
  org           varchar(128) not null default '',
  asn           varchar(32) not null default '',
  lat           float8 not null default 0,
  lon           float8 not null default 0,
  timezone      varchar(64) not null default '',
  sources       varchar(255) not null default '',
  raw_data      jsonb,                         -- 各 API 原始返回（调试用）
  updated_at    timestamptz not null default now()
);

-- 按更新时间查询（管理后台展示用）
create index if not exists idx_ip_lookups_updated on ip_lookups(updated_at desc);
```

也可以做成 `.sql` 脚本放在 `scripts/` 目录下，比如 `scripts/setup-ip-lookups.sql`。

### 3.2 查询 & 写入

```javascript
// lib/ip-lookup-store.js — Supabase 读写模块

var postgres = require("./postgres");

var UPSERT_SQL = `
  insert into ip_lookups (ip, country, region, city, isp, org, asn, lat, lon, timezone, sources, raw_data, updated_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())
  on conflict (ip) do update set
    country = excluded.country,
    region = excluded.region,
    city = excluded.city,
    isp = excluded.isp,
    org = excluded.org,
    asn = excluded.asn,
    lat = excluded.lat,
    lon = excluded.lon,
    timezone = excluded.timezone,
    sources = excluded.sources,
    raw_data = excluded.raw_data,
    updated_at = now()
`;

var SELECT_SQL = "select * from ip_lookups where ip = $1";

async function getFromStore(ip) {
  try {
    var pg = postgres.getPool();
    var result = await pg.query(SELECT_SQL, [ip]);
    if (result.rows.length > 0) return result.rows[0];
  } catch (e) {}
  return null;
}

async function saveToStore(ip, merged, individual) {
  try {
    var pg = postgres.getPool();
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
```

## 4. API 中文优先

### 4.1 ip-api.com 支持中文

当前请求 URL：
```
http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query
```

加 `&lang=zh-CN` 后：
```
http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query&lang=zh-CN
```

返回示例（中文）：
```json
{
  "country": "中国",
  "regionName": "山东省",
  "city": "潍坊市",
  "isp": "中国联通",
  "org": "中国联通",
  "as": "AS4837"
}
```

不加 lang 参数返回的是英文：
```json
{
  "country": "China",
  "regionName": "Shandong",
  "city": "Weifang",
  "isp": "China Unicom Shandong",
  "org": "China Unicom Shandong",
  "as": "AS4837"
}
```

### 4.2 修改 ip-lookup.js

在 `lib/ip-lookup.js` 中为 ip-api 的 fetch URL 加上 `&lang=zh-CN`：

```javascript
{
  name: "ip-api",
  fetch: function(ip) {
    return fetch("http://ip-api.com/json/" + encodeURIComponent(ip)
      + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query"
      + "&lang=zh-CN",  // ← 加这行，中文优先
      { signal: AbortSignal.timeout(API_TIMEOUT) }
    ).then(function(r) { return r.json(); }).then(function(o) {
      // ...
    });
  }
}
```

### 4.3 其他 API 的中文支持

| API | 支持中文 | 方式 |
|-----|---------|------|
| ip-api.com | ✅ 完美支持 | `&lang=zh-CN` 参数 |
| ip.sb | ❌ 不支持 | 始终英文 |
| ipinfo.io | ❌ 不支持 | 始终英文 |
| ipwhois.app | ❌ 不支持 | 始终英文 |
| ipapi.is | ❌ 不支持 | 始终英文 |

**策略**：ip-api.com 作为主力 API（加 `lang=zh-CN`），返回中文优先。其他 API 作为后备补充 ASN/经纬度等信息。

## 5. 具体实现

### 5.1 后端：新增 `section=ip-lookup-once`

在 `health.js` 新增独立端点：

```javascript
if (req.query && req.query.section === "ip-lookup-once") {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Use POST" });
  }
  try {
    var body = req.body || {};
    var ips = body.ips || [];
    if (!Array.isArray(ips) || ips.length === 0) {
      return res.json({ success: true, results: [] });
    }

    var ipLookup = require("../../lib/ip-lookup");
    var ipStore = require("../../lib/ip-lookup-store");
    var results = [];

    for (var i = 0; i < ips.length; i++) {
      var ip = ips[i];
      if (ipLookup.isPrivateOrInvalid(ip)) continue;

      // 1. 先查 Supabase 缓存
      var stored = await ipStore.getFromStore(ip);
      if (stored) {
        results.push({
          ip: ip,
          fromCache: true,
          results: (stored.raw_data || []).map(function(r) {
            return {
              source: r.source || "cache",
              country: r.country || stored.country || "",
              region: r.region || stored.region || "",
              city: r.city || stored.city || "",
              isp: r.isp || stored.isp || "",
              org: r.org || stored.org || "",
              asn: r.asn || stored.asn || "",
              lat: r.lat || stored.lat || 0,
              lon: r.lon || stored.lon || 0,
            };
          }),
        });
        continue;
      }

      // 2. 无缓存 → 实时查询 API（中文优先）
      var individual = await ipLookup.getIpIndividualResults(null, ip);
      if (!individual || individual.length === 0) {
        results.push({
          ip: ip,
          results: [{ source: "no-data", country: "-", region: "-", city: "-", isp: "-" }],
        });
        continue;
      }

      // 3. 合并结果
      var merged = {
        country: "", region: "", city: "", isp: "", org: "",
        asn: "", lat: 0, lon: 0, timezone: "", source: "",
      };
      if (individual.length > 0) {
        var first = individual[0];
        merged.country = first.country || "";
        merged.region = first.region || "";
        merged.city = first.city || "";
        merged.isp = first.isp || "";
        merged.org = first.org || "";
        merged.asn = first.asn || "";
        merged.lat = first.lat || 0;
        merged.lon = first.lon || 0;
        merged.timezone = first.timezone || "";
        merged.source = first.source || "";
        // 用其他 API 补充缺失字段
        for (var j = 1; j < individual.length; j++) {
          var r2 = individual[j];
          if (!merged.isp && r2.isp) merged.isp = r2.isp;
          if (!merged.org && r2.org) merged.org = r2.org;
          if (!merged.asn && r2.asn) merged.asn = r2.asn;
          if (!merged.lat && r2.lat) { merged.lat = r2.lat; merged.lon = r2.lon; }
          merged.source += "+" + r2.source;
        }
      }

      // 4. 存入 Supabase
      ipStore.saveToStore(ip, merged, individual);

      results.push({
        ip: ip,
        fromCache: false,
        results: individual.map(function(r) {
          return {
            source: r.source || "unknown",
            country: r.country || "",
            region: r.region || "",
            city: r.city || "",
            isp: r.isp || "",
            org: r.org || "",
            asn: r.asn || "",
            lat: r.lat || 0,
            lon: r.lon || 0,
          };
        }),
      });
    }

    return res.json({
      success: true,
      results: results,
      sources: ipLookup.IP_APIS.map(function(a) { return a.name; }),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
```

### 5.2 前端：从已有数据提取 IP，AJAX 查询

修改 `loadIpCompare()`：

```javascript
function loadIpCompare() {
  var el = document.getElementById('visitorIpCompare');
  if (!el) return;

  // 1. 从已加载的访客数据中提取 IP
  var visitorData = window._cachedVisitorData || [];
  var ipSet = {};
  visitorData.forEach(function(v) {
    if (v.ip && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$)/.test(v.ip)) {
      ipSet[v.ip] = true;
    }
  });
  var ips = Object.keys(ipSet);

  if (ips.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:20px">暂无访客 IP 数据</div>';
    return;
  }

  // 2. 检查 localStorage 缓存（同一批 IP 24 小时内有效）
  var cacheKey = 'ip_lookup_' + ips.sort().join('_');
  var cached = null;
  try {
    var raw = localStorage.getItem(cacheKey);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed.expires > Date.now()) cached = parsed.data;
    }
  } catch(e) {}

  if (cached) {
    renderIpCompareTable(el, cached.results, cached.sources);
    return;
  }

  // 3. 发 AJAX
  el.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:20px">正在查询 IP 归属地（' + ips.length + ' 个 IP）...</div>';

  api('/api/admin/health?section=ip-lookup-once', {
    method: 'POST',
    body: JSON.stringify({ ips: ips }),
    headers: { 'Content-Type': 'application/json' },
  }).then(function(data) {
    if (!data || !data.success) {
      el.innerHTML = '<div style="color:#dc2626;font-size:0.85rem;padding:20px">查询失败</div>';
      return;
    }
    // 4. localStorage 缓存（同页面快速切换用）
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        expires: Date.now() + 86400000,
        data: { results: data.results, sources: data.sources },
      }));
    } catch(e) {}
    renderIpCompareTable(el, data.results, data.sources);
  }).catch(function(e) {
    el.innerHTML = '<div style="color:#dc2626;font-size:0.85rem;padding:20px">查询失败: ' + e.message + '</div>';
  });
}
```

### 5.3 缓存访客数据

在 `loadVisitorRecent()` 成功回调加一行：

```javascript
api('/api/admin/health?section=stats&sub=visitor-recent').then(function(data) {
  if (data && data.success) {
    window._cachedVisitorData = data.visitors || [];  // ← 加这行
    // ... 原有渲染逻辑 ...
  }
});
```

## 6. Supabase 存储优势

| 场景 | localStorage | Supabase |
|------|-------------|----------|
| 同一浏览器再次打开 | ✅ 秒出 | ✅ 秒出 |
| 不同浏览器/设备 | ❌ 无缓存 | ✅ 秒出 |
| 部署后数据丢失 | ❌ localStorage 清空 | ✅ 数据不丢 |
| 长期积累 | ❌ 24 小时过期 | ✅ 永久保存 |
| 数据分析 | ❌ 无法查询 | ✅ 可 SQL 查历史 IP |
| 刷新按钮"重新查询" | ❌ 只能等过期 | ✅ 直接更新即可 |

## 7. 实施步骤

| 步骤 | 操作 | 涉及文件 |
|------|------|---------|
| 1 | ip-lookup.js 中 ip-api 加上 `&lang=zh-CN` | `lib/ip-lookup.js` |
| 2 | 新建 `lib/ip-lookup-store.js`（Supabase 读写） | 新文件 |
| 3 | 创建 `scripts/setup-ip-lookups.sql` | 新文件 |
| 4 | 在 Supabase SQL Editor 执行建表 SQL | Supabase Dashboard |
| 5 | health.js 新增 `section=ip-lookup-once`（查 Supabase → 查 API → 存 Supabase） | `api/admin/health.js` |
| 6 | admin_Dx23.html 的 `loadVisitorRecent()` 缓存 `window._cachedVisitorData` | `admin_Dx23.html` |
| 7 | 重写 `loadIpCompare()` | `admin_Dx23.html` |
| 8 | vercel.json 移除 ip-lookup Cron | `vercel.json` |
| 9 | health.js 移除 `section=ip-lookup` 和 `section=stats&sub=ip-compare` 后备逻辑 | `api/admin/health.js` |

## 8. 总结

**核心改动**：

1. **去掉 Cron**：不再依赖每天凌晨 2 点的批量查询
2. **AJAX 按需查询**：管理后台已有 IP，切标签时发给后端实时查
3. **Supabase 持久化**：查过的 IP 存数据库，永久有效，跨设备共享
4. **中文优先**：ip-api.com 加 `&lang=zh-CN`，城市/运营商显示中文

**结果**：
- ✅ 部署后立即能用
- ✅ 数据持久化（Supabase 不丢）
- ✅ 中文显示（中国联通、山东省、潍坊市）
- ✅ 零 Cron 依赖
- ✅ 零 Redis 额外存储
- ✅ 实现极简（一个 POST 端点 + 前端改两个函数）