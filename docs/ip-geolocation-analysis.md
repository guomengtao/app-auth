# IP 地址识别分析与多接口异步查询方案

## 一、现状分析

### 1.1 当前架构

目前使用 Vercel 部署，IP 地理位置信息来源：

```
访客请求 → Vercel Edge Network → x-vercel-ip-country / x-vercel-ip-region / x-vercel-ip-city / x-vercel-ip-timezone → api/activate.js → Redis stats:recent
```

**数据流**（[api/activate.js](file:///Users/Banner/Documents/guomengtao/app-auth/api/activate.js#L62-L68)）：

```javascript
c: String(req.headers["x-vercel-ip-country"] || "").slice(0, 8),   // 国家代码
rg: String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16), // 省/州
ci: String(req.headers["x-vercel-ip-city"] || "").slice(0, 40),     // 城市
tz: String(req.headers["x-vercel-ip-timezone"] || "").slice(0, 40), // 时区
```

### 1.2 当前方案优缺点

| 维度 | 评价 |
|------|------|
| 速度 | ⭐⭐⭐⭐⭐ 零延迟，Vercel Edge 直接注入 HTTP Header |
| 覆盖 | ⭐⭐⭐ 仅覆盖核心字段（国家/地区/城市/时区） |
| 成本 | ⭐⭐⭐⭐⭐ 完全免费，无需额外 API 调用 |
| 精确度 | ⭐⭐⭐ 城市级别，偶有偏差 |
| 扩展性 | ⭐⭐ 无法获取 ISP、ASN、经纬度、代理检测等 |

### 1.3 缺失的关键字段

```
ISP/运营商    → 如 China Telecom、China Mobile
ASN/AS号     → 如 AS4134（中国电信）
经纬度        → 地理可视化
代理/VPN检测  → 识别欺诈流量
组织/公司名   → 如腾讯、阿里巴巴
```

---

## 二、免费 IP 地理位置 API 对比

### 2.1 候选接口

| # | 接口 | 免费额度 | 速率限制 | 需要 Key | 返回字段 |
|---|------|---------|---------|---------|---------|
| 1 | **ip-api.com** | 无限 | 45 req/min | ❌ | country/region/city/isp/org/as/lat/lon/timezone |
| 2 | **ipapi.co** | 1000/day | 无硬限 | ❌ (可选) | country/region/city/org/postal/lat/lon/timezone |
| 3 | **ipinfo.io** | 50k/month | 无硬限 | ✅ 免费 | country/region/city/org/loc/timezone |
| 4 | **ipwhois.io** | 10k/month | 无硬限 | ❌ (可选) | country/region/city/isp/org/lat/lon/timezone |
| 5 | **freeipapi.com** | 无限 | 60 req/min | ❌ | country/region/city/isp/org/as/lat/lon/timezone/proxy |

### 2.2 字段覆盖矩阵

| 字段 | Vercel Headers | ip-api | ipapi.co | ipinfo.io | ipwhois.io | freeipapi |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| Country | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Region | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| City | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Timezone | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ISP | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| ASN/Org | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Lat/Lon | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Postal Code | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Proxy/VPN | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### 2.3 推荐组合（3-5 个）

```
第一梯队（主力）：ip-api.com — 数据最全，无 Key，免费无限制
第二梯队（备份）：freeipapi.com — 含代理检测，数据全
第三梯队（补充）：ipapi.co — 简单可靠，速率不严格
第四梯队（兜底）：ipinfo.io — 稳定，商业级数据质量
第五梯队（可选）：ipwhois.io — 提供 ASN 信息
```

---

## 三、核心问题：如何不影响请求速度

### 3.1 问题本质

Vercel Serverless Function 的生命周期：

```
请求进入 → 函数启动（冷启动 50-300ms）
         → 业务逻辑（处理激活/领取码等，5-200ms）
         → 响应返回给客户端 ← 【此步骤后客户端不再等待】
         → 函数继续运行（但随时可能被冻结）
         → 空闲 5-10 秒后冻结
```

**核心约束**：Vercel Hobby 计划函数最大执行时间 **10 秒**，且 HTTP 响应必须在 10 秒内发出。

如果同步等待 3-5 个外部 API 返回（每个 200-800ms），总延迟 1-4 秒，严重影响用户体验。

### 3.2 解决方案对比

#### 方案 A：Promise.all 并发（不推荐）

```javascript
// 在激活/访问 API 中并发请求
var geoData = await Promise.all([
  fetch('http://ip-api.com/json/' + ip),
  fetch('https://freeipapi.com/api/json/' + ip),
  fetch('https://ipapi.co/' + ip + '/json/'),
]);
// 保存 geoData 到 Redis
res.json({ success: true });
```

| 优点 | 缺点 |
|------|------|
| 实现简单 | 响应延迟 500-2000ms |
| 数据实时 | 用户等待时间增加 |
| | 慢接口拖累快接口 |

#### 方案 B：非阻塞 + Redis 异步写入（推荐 ⭐）

```javascript
// api/activate.js — visitor track 部分
function trackVisitor(req, res) {
  var ip = getClientIp(req);
  var ts = Date.now();
  
  // 1. 先用 Vercel Headers 立即写入基础 geo 数据
  var immediateData = {
    h: vHash.slice(0, 8),
    p: trimmedPath,
    u: ua.slice(0, 80),
    t: ts,
    c: req.headers["x-vercel-ip-country"] || "",
    rg: req.headers["x-vercel-ip-country-region"] || "",
    ci: req.headers["x-vercel-ip-city"] || "",
    tz: req.headers["x-vercel-ip-timezone"] || "",
  };
  await redis.lpush(recentKey, JSON.stringify(immediateData));
  
  // 2. 立即返回（用户不等待）
  res.json({ success: true });
  
  // 3. 异步触发 IP 详细信息查询（不等待返回）
  //    写入 Redis 待处理队列，由独立任务处理
  enqueueIpLookup(ip, ts); // 不 await，直接返回
}
```

| 优点 | 缺点 |
|------|------|
| 用户无感知延迟 | IP 详情有 1-5 秒延迟 |
| Vercel 基础数据立即可用 | 需要额外的处理逻辑 |
| | 首次查看可能只有基础数据 |

#### 方案 C：Redis 队列 + Vercel Cron Job（最优 ⭐⭐⭐）

```
                    ┌─────────────────────────────┐
  访客请求          │    api/activate.js           │
  ──────────►       │                              │
                    │  1. 写入基础 geo 到 stats:recent
                    │  2. IP + ts 写入 ip:pending   │
                    │  3. 立即返回 200 OK           │
                    │                              │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
  Cron Job          │  api/admin/health?section=  │
  (每分钟)          │  ip-lookup                  │
  ──────────►       │                              │
                    │  1. 读取 ip:pending 队列     │
                    │  2. 并发查询 3 个 API        │
                    │  3. 合并结果写入 ip:cache    │
                    │  4. 回填 stats:recent        │
                    │                              │
                    └──────────────────────────────┘
```

| 优点 | 缺点 |
|------|------|
| 完全不影响用户请求 | 有 1 分钟延迟 |
| 可使用 Vercel 原生 Cron | 已查看的记录不会再更新 |
| 纯后台执行 | |
| 可控制并发数，不触发限流 | |

#### 方案 D：前端异步补充查询

```
  1. 管理后台加载访客列表（仅含基础 Vercel geo）
  2. 前端在渲染后异步请求 /api/admin/ip-info?ip=xxx
  3. 服务端查询缓存或实时查询 1 个快速 API
  4. 前端动态注入 ISP/ASN/经纬度等信息
```

| 优点 | 缺点 |
|------|------|
| 按需查询，不必全量 | 每个 IP 一次额外请求 |
| 实现简单 | 依赖前端逻辑 |
| 可做客户端缓存 | 不适合列表批量展示 |

---

## 四、推荐架构：方案 B + C 混合

### 4.1 整体流程

```
访客请求 → activate.js （用户响应 < 50ms）
              │
              ├─ 1. 写入 stats:recent（Vercel headers，立即可见）
              │
              ├─ 2. 写入 ip_queue（Redis LIST，待处理队列）
              │     格式：{ip, ts, recordIdx}
              │
              └─ 3. 返回 200

Cron Job（每 60 秒）→ ip-lookup 处理
              │
              ├─ 1. 从 ip_queue 取出最多 30 条
              ├─ 2. 批量去重（同一 IP 1 小时内不重复查）
              ├─ 3. Promise.allSettled 并发查询 3 个 API
              ├─ 4. 合并策略：优先 ip-api → 其次 freeipapi → 最后 ipapi.co
              ├─ 5. 结果写入 ip_cache（Redis HASH，TTL 24h）
              └─ 6. 回填 stats:recent 中对应记录

管理后台查询 → stats.js
              │
              └─ 优先读取 Redis 回填数据，如无则返回 Vercel 基础数据
```

### 4.2 关键代码结构

```javascript
// ========== lib/ip-lookup.js ==========

// 查询队列 Key
var IP_QUEUE_KEY = "ip:queue";
var IP_CACHE_PREFIX = "ip:cache:";
var IP_CACHE_TTL = 24 * 60 * 60; // 24 小时

// 配置所有 API
var IP_APIS = [
  {
    name: "ip-api",
    url: function(ip) { return "http://ip-api.com/json/" + ip + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query"; },
    rateLimitPerMin: 45,
    timeout: 3000,
  },
  {
    name: "freeipapi",
    url: function(ip) { return "https://freeipapi.com/api/json/" + ip; },
    rateLimitPerMin: 60,
    timeout: 3000,
  },
  {
    name: "ipapi.co",
    url: function(ip) { return "https://ipapi.co/" + ip + "/json/"; },
    rateLimitPerMin: 30,
    timeout: 4000,
  },
];

// 入队（不阻塞）
function enqueueIpLookup(ip, recordIdx) {
  // 先检查缓存
  var cacheKey = IP_CACHE_PREFIX + ip.replace(/[^a-fA-F0-9:.]/g, "_");
  redis.get(cacheKey).then(function(cached) {
    if (cached) {
      // 已有缓存，直接回填
      return backfillRecord(recordIdx, JSON.parse(cached));
    }
    // 无缓存，入队
    return redis.lpush(IP_QUEUE_KEY, JSON.stringify({
      ip: ip,
      ts: Date.now(),
      idx: recordIdx,
    }));
  }).catch(function() {});
}

// 批量处理（Cron Job 调用）
async function processIpQueue() {
  // 从队列取出 30 条
  var items = [];
  for (var i = 0; i < 30; i++) {
    var raw = await redis.rpop(IP_QUEUE_KEY).catch(function() { return null; });
    if (!raw) break;
    try { items.push(JSON.parse(raw)); } catch(e) {}
  }
  if (!items.length) return { processed: 0 };

  // 去重（同一 IP 只查一次）
  var uniqueIps = {};
  items.forEach(function(item) {
    if (!uniqueIps[item.ip]) uniqueIps[item.ip] = [];
    uniqueIps[item.ip].push(item);
  });

  var results = {};
  var ipList = Object.keys(uniqueIps);

  // 对每个 IP 并发请求 3 个 API
  for (var i = 0; i < ipList.length; i++) {
    var ip = ipList[i];
    var apiResults = await Promise.allSettled(
      IP_APIS.map(function(api) {
        return fetchWithTimeout(api.url(ip), api.timeout)
          .then(function(r) { return r.ok ? r.json() : null; })
          .catch(function() { return null; });
      })
    );

    // 合并策略：选第一个有数据的
    var merged = mergeGeoResults(apiResults.map(function(r) {
      return r.status === "fulfilled" ? r.value : null;
    }));

    // 写入缓存
    await redis.setex(IP_CACHE_PREFIX + ip.replace(/[^a-fA-F0-9:.]/g, "_"), IP_CACHE_TTL, JSON.stringify(merged));

    results[ip] = merged;
  }

  // 回填所有相关记录
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var data = results[item.ip];
    if (data) {
      await backfillRecord(item.idx, data);
    }
  }

  return { processed: items.length, ips: Object.keys(results).length };
}
```

### 4.3 Vercel Cron 配置

```json
// vercel.json 添加
{
  "crons": [
    {
      "path": "/api/admin/health?section=ip-lookup&cron=1",
      "schedule": "* * * * *"
    }
  ]
}
```

注意：Vercel Hobby 计划限制 **最多 10 个 functions**（含 cron），当前已有 3 个 cron，新增 1 个没问题。

---

## 五、性能分析

### 5.1 延迟对比

| 阶段 | 原方案 | 方案 B | 方案 C (Cron) |
|------|--------|--------|---------------|
| 用户响应时间 | 50ms | 50ms | 50ms |
| IP 基础数据可用 | 实时 | 实时 | 实时 |
| IP 详细数据可用 | ❌ | 1-5s | 1-60s |
| 额外 API 调用 | 0 | 每次 3 个 | 批量 3 个/次 |

### 5.2 并发安全

| 风险 | 对策 |
|------|------|
| 同一 IP 短时间多次查询 | Redis SETNX 缓存锁 |
| API 限流（45 req/min） | Cron 每批最多处理 30 条，分 API 独立计数 |
| Vercel 函数超时 | Cron 执行 30 条约需 8 秒（3 API × 200ms 平均 × 并发），在 10s 限制内 |
| Cron 重复执行 | 每批取 30 条后队列为空，不会重复 |

### 5.3 成本估算

| 项目 | 用量 | 费用 |
|------|------|------|
| ip-api.com | 30 次/分钟 → 43k/天 | 免费（45 req/min 限制内） |
| freeipapi.com | 同上 | 免费（60 req/min 限制内） |
| ipapi.co | 同上 | 免费（1000 req/day 限制内，需要控制） |
| Vercel Cron | 1440 次/天 | Hobby 不限制 cron 调用次数 |
| Redis 额外存储 | 每个 IP 缓存约 500B | 可忽略 |

---

## 六、实现步骤建议

| 步骤 | 内容 | 文件 | 难度 |
|------|------|------|------|
| 1 | 创建 `lib/ip-lookup.js` 核心模块 | 新文件 | 中 |
| 2 | 修改 `api/activate.js` 增加入队调用 | 修改 | 低 |
| 3 | 在 `api/admin/health.js` 增加 `section=ip-lookup` | 修改 | 低 |
| 4 | 修改 `api/admin/stats.js` 增加 IP 详情字段读取 | 修改 | 低 |
| 5 | 修改 `admin_Dx23.html` 增加 ISP/ASN/经纬度 显示 | 修改 | 低 |
| 6 | 修改 `vercel.json` 增加 Cron 配置 | 修改 | 低 |
| 7 | 本地测试 + Vercel 部署验证 | - | 低 |

### 7.1 数据字段扩展示例

Redis `stats:recent` 记录当前格式：
```json
{
  "h": "649fe143",
  "p": "/activate.html?deviceId=xxx",
  "u": "Mozilla/5.0...",
  "t": 1726500000000,
  "c": "CN",
  "rg": "Shandong",
  "ci": "Weifang",
  "tz": "Asia/Shanghai"
}
```

扩展后格式（新增 `isp`, `asn`, `lat`, `lon`, `proxy`）：
```json
{
  "h": "649fe143",
  "p": "/activate.html?deviceId=xxx",
  "u": "Mozilla/5.0...",
  "t": 1726500000000,
  "c": "CN",
  "rg": "Shandong",
  "ci": "Weifang",
  "tz": "Asia/Shanghai",
  "isp": "China Unicom Shandong",
  "asn": "AS4837",
  "lat": 36.71,
  "lon": 119.10,
  "proxy": false
}
```

### 7.2 管理后台展示示例

访客统计手风琴展开 → Visitor Info 区块，新增行：

```
ISP            China Unicom Shandong
ASN            AS4837
Coordinates    36.71, 119.10
Proxy/VPN      No
```

---

## 八、总结

| 结论 | 说明 |
|------|------|
| **推荐方案** | Cron Job 异步队列（方案 C），配合即时 Vercel Headers 兜底 |
| **不影响速度** | 用户请求在 50ms 内完成，IP 详细查询完全后台执行 |
| **选 3 个 API** | ip-api.com（主力）+ freeipapi.com（备份/代理检测）+ ipapi.co（兜底） |
| **缓存策略** | 同一 IP 24 小时内不重复查询，Redis 缓存 |
| **Vercel 兼容** | 1 个新增 Cron，当前 3 个 Cron + 1 个新增 = 4 个，远低于 10 个限制 |
| **反向兼容** | 保留 Vercel Headers 作为基础数据，API 查询失败不影响任何功能 |