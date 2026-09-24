# 访客记录 IP 归属地异常 + URL 参数丢失 分析

> 分析日期：2026-09-24
> 触发样本：`/go/ev-timetable` 与 `/admin_Dx23.html?tab=dashboard` 的「最近访客」列表
> 涉及代码：`api/go.js`、`api/activate.js`、`api/admin/health.js`、`lib/visitor-log.js`、`lib/geo-zh.js`、`lib/geo-district.js`、`lib/ip-lookup.js`

---

## 0. 结论速览

| # | 现象 | 真正根因 | 与「跳转太快」有关吗 |
|---|---|---|---|
| 1 | 国外 IP 显示成 `IL · 芝加哥`、`CA · Irvine`、`06 · Ankara`、`Z · Magh%C4%81r` | **访客链路从来不会自动写入 `ip_lookups`**；只能回落到 Vercel 请求头，而 Vercel 的 `region` 是 ISO 代码、`city` 是英文且 percent-encoded | ❌ 无关。与时间无关，是**数据源缺失** |
| 2 | 详情页显示「该 IP 还没有中文归属地记录（未落入 ip_lookups）」，手工点「重新查询」后立刻正常 | 唯一的自动写入源是**腾讯位置服务**，它对境外 IP 直接返回 `status != 0` → 不写库；而 5 个境外源（ip-api/ip-sb/ipinfo/ipwhois/ipapi.is）**只在你手工点查询时才跑** | ❌ 无关。手工查询走的是另一套代码 |
| 3 | 国内 IP（如 `36.113.30.111 → 上海`）看起来正常 | 不是因为查到了，而是 `REGION_CODE_ZH_MAP` 把 Vercel 的省级代码 `SH/BJ/GD` 翻译成了中文；**只有省级，没有市级/区级** | ❌ |
| 4 | `/go/ev-timetable?deviceId=666` 进后台变成 `/go/ev-timetable` | `api/go.js` 把路径**硬编码**成 `"/go/" + slug`，query string 从一开始就没进库；且表里**没有承载参数的字段** | ❌ 无关 |
| 5 | （附带真 bug）`/go/` 的访客记录写在 `res.end()` 之后、且**没有走 `waitUntil`** | Vercel 响应后会冻结实例，这条 INSERT 有被截断的风险 | ✅ 这个是真的「太快」 |

一句话总结：**不是"来不及分析"，而是"压根没有自动分析"**——中文归属地这张表（`ip_lookups`）在访客链路上只有腾讯一个写入源，而腾讯不管境外 IP；境外 IP 永远只能显示 Vercel 原始头部的英文/代码，直到有人手工点一次「重新查询」。

---

## 1. 数据链路：写完什么、读时补什么

### 1.1 写入侧（访问发生的那一刻）

```text
浏览器请求 /go/ev-timetable?deviceId=666
   │
   ├─ api/go.js:248-250  country/region/city ← Vercel 请求头（x-vercel-ip-*）  ← 毫秒级、零外呼
   ├─ api/go.js:291-296  visitorLog.logVisit({ path: "/go/" + slug, ... })      ← path 硬编码，无 query
   └─ api/go.js:113      geoDistrict.getDistrict(ip) → 只在腾讯成功时写 ip_lookups
```

`lib/visitor-log.js:8-10` 的注释写明了设计意图：

```js
//   3. 写库不做任何外呼（不查腾讯、不查 ip-api）——中文地区在**读取时**用
//      `lib/geo-district.getStoredGeo()` 富化，保证写入快且稳定；
```

**注意这句话只兑现了一半**：写入确实不外呼，但"读取时富化"依赖 `ip_lookups` 里**已经有数据**，而这个"有数据"在访客链路上从来没被保证过。

### 1.2 读取侧（后台打开「最近访客」的那一刻）

`api/admin/health.js:3096-3136`（`section=stats&sub=visitor-recent`）：

```js
var sg = storeGeo[obj.ip] || null;                          // ← ip_lookups 里查
var pair = geoZh.pickCnPair(sg || {});                      // ← 腾讯整组优先，其次 ip-api 整组
var region = pair.region || geoZh.regionZhOf(obj.rg, obj.c) || obj.rg || "";   // L3126
var city   = pair.city   || geoZh.cityZhOf(obj.ci)          || obj.ci   || ""; // L3127
```

前端 `admin_Dx23.html:9516-9527`（`fmtVisitorLoc`）按 `region · city · district` 拼接。

**关键：这四层回落里，只要 `ip_lookups` 没命中，就必然落到 Vercel 原文。** 这就是全部问题的交汇点。

---

## 2. 现象一详解：为什么只有国外 IP"错了"

先把这批样本逐条拆开看（注意：**地理位置本身基本是对的，错的是"语言"和"来源混搭"**）：

| IP | 面板显示 | 真实含义 | 拆解 |
|---|---|---|---|
| `36.113.30.111` | `上海` | 上海 | ✅ 走 `REGION_CODE_ZH_MAP`（Vercel 给了 `SH`） |
| `95.20.124.13` | `加那利群岛 · 圣克鲁斯-德特内里费` | 西班牙 · 特内里费 | ✅ **它之前被手工查过，已落 `ip_lookups`**（ip-api `lang=zh-CN`） |
| `70.187.232.130` | `CA · Irvine` | 美国加州尔湾 | ⚠️ region=原始州码 `CA`，city=英文 `Irvine`（不在中文字典里） |
| `24.98.59.221` | `GA · Mableton` | 美国佐治亚州 | ⚠️ 同上 |
| `73.209.37.101` | `IL · 芝加哥` | 美国伊利诺伊州芝加哥 | ⚠️ **混搭**：州是英文码 `IL`，市被翻译成 `芝加哥` |
| `93.175.48.3` | `Z · Magh%C4%81r` | 以色列 · Maghār | ⚠️ 州码 `Z` + **percent-encoded 的城市名** |
| `31.223.13.19` | `06 · Ankara` | 土耳其安卡拉（车牌区号 06） | ⚠️ region 是土耳其省份数字码 |
| `37.114.148.54` | `BA · Baku` | 阿塞拜疆巴库 | ⚠️ 同上 |

这八条里**唯一显示中文的境外 IP，正是唯一被手工查过的那条**——这是最直接的证据。

### 2.1 根因 ①（核心）：`ip_lookups` 在访客链路没有自动写入源

全仓库检索 `ip_lookups` 的写入点，只有 4 处：

| 写入点 | 触发条件 |
|---|---|
| `lib/geo-district.js:179-197` `writeCache()` | **只在腾讯返回 `status === 0` 时写**（`L211-231`，`o.status !== 0` → `return null` → 不写） |
| `api/admin/health.js:2252` `section=ip-lookup` | 后台批量操作，人工触发 |
| `api/admin/health.js:2427` `section=ip-lookup-once` | 后台 IP 详情页「重新查询」，人工触发 |
| `scripts/setup-ip-lookups.sql` | 建表 |

**腾讯位置服务的 IP 定位对境外 IP 返回失败/空**（这不是配置问题，是接口能力边界），于是：

```
境外 IP 访问 → getDistrict() → 腾讯返回 status != 0 → fetchAdInfo 返回 null
            → geo-district.js:257  failUntil[ip] = Date.now() + 10min（本实例退避）
            → 不写 ip_lookups
            → 该 IP 永远停留在"未落入 ip_lookups"
```

而 5 个境外源（`lib/ip-lookup.js`）**在访客链路上一次都没被调用过**——它只服务于 `/api/admin/health?section=ip-lookup-once`（后台手工）和 `/my-ip` 页面。

> 补充：`lib/geo-district.js:284-301` 的 `getDistrict()` 在 DB 未命中时会 `runInBackground(fetchAndCache(ip))` 然后**立刻返回 `""`**——也就是说即使腾讯能查到，本次请求的区县也是空的，要等下一次访问才补上。国内 IP 之所以"看起来没问题"，靠的是第二次访问时补上的数据 + 省级代码翻译，而不是本次。

### 2.2 根因 ②：Vercel 的 `region` 是 ISO 代码，中文映射只对 CN 生效

`lib/geo-zh.js:235-244`：

```js
function regionZhOf(value, country) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  var mapped = lookup(REGION_ZH_MAP, REGION_ALIAS[raw] || raw);
  if (mapped) return mapped;
  if (isChinaCode(country)) {                       // ← L240：只有 CN 才翻译代码
    return REGION_CODE_ZH_MAP[raw.toUpperCase()] || "";
  }
  return "";                                        // ← 境外：直接返回空
}
```

`lib/geo-zh.js:228-232` 的 `isChinaCode()` 只认 `CN/CHN/China/中国`。所以美国 `IL`、土耳其 `06`、以色列 `Z`、阿塞拜疆 `BA` 全部翻译失败，`health.js:3126` 的最后一个 `|| obj.rg` 把**原始代码原样展示**出来。

> 注释（`lib/geo-zh.js:217-219`）说明了这个设计：「只在国家为 CN 时启用，避免与美国州码撞车（SD 南达科他 / MO 密苏里…）」。设计上没错，但**没有为非 CN 准备任何替代方案**，结果是代码裸奔到 UI。

### 2.3 根因 ③：城市翻译靠 128 个城市的白名单字典

`lib/geo-zh.js:17-128` 的 `CITY_ZH_MAP` 是**手工维护的静态字典**，只覆盖中国主要城市 + 约 20 个国际大都市。
`Chicago` 命中 → `芝加哥`；`Irvine` / `Mableton` / `Ankara` / `Baku` / `Maghār` 未命中 → **原样显示英文**。

于是出现 `IL · 芝加哥` 这种"英文州码 + 中文市名"的怪胎组合。

### 2.4 根因 ④：`x-vercel-ip-city` 是 percent-encoded，全链路没有 decode

`Magh%C4%81r` 里的 `%C4%81` 正是 UTF-8 的 `ā`（U+0100）。Vercel 对非 ASCII 的城市名会做百分号编码后放进 `x-vercel-ip-city` 头。

全仓库检索：`api/go.js:250`、`api/activate.js:16`、`api/admin/health.js:579`、`api/visitor/ip.js:62` 都是直接 `String(req.headers["x-vercel-ip-city"] || "")`，**没有任何一处 `decodeURIComponent`**（唯一的 `decodeURIComponent` 出现在 `lib/auth.js:61` 解 cookie）。

所以编码串被原样写进 `visitor_logs.city`，再原样渲染到面板。
⚠️ 这个问题对**国内 IP 同样存在**（上海会被写成 `%E4%B8%8A%E6%B5%B7`），只是国内恰好靠 `region` 翻译出了「上海」，`fmtVisitorLoc` 的 `region !== city` 判断本应把两者都拼出来——样本里没出现，说明该 IP 的 city 头为空或已是 ASCII。

### 2.5 为什么"国内可以、国外不行"——一句话

| | 国内 IP | 境外 IP |
|---|---|---|
| 腾讯位置服务 | ✅ 能查到省/市/区 → 写 `ip_lookups` | ❌ 直接失败 → 永不写库 |
| Vercel 头部 region | `SH/BJ/GD` → `REGION_CODE_ZH_MAP` 翻译成中文 | `IL/06/Z/BA` → 不翻译，原样显示 |
| Vercel 头部 city | 多为 ASCII 或空 | 英文 / percent-encoded |
| 5 个境外源 | 不跑 | **也不跑**（只手工触发） |

---

## 3. 现象二：是不是跳转太快，来不及分析 IP？

### 3.1 结论：不是。

三条独立证据：

1. **访客记录里的地理字段根本不是"分析"出来的**，而是 `api/go.js:248-250` 直接读 Vercel 请求头，`req.headers[...]` 是同步取值，耗时 ≈ 0。**停留时间再短也不影响它。**
2. **真正耗时的中文归属地压根没在请求路径上执行。** `getDistrict()`（`lib/geo-district.js:284-301`）走的是「内存 → DB 一次 SELECT → 未命中就丢后台、本次返回 `""`」，它既不 `await` 腾讯（2.5s）也不 `await` 那 5 个境外源（4s×5）。所以"来不及"这件事在设计上就被规避了——代价是**本次永远拿不到**。
3. **手工点「重新查询」之所以能拿到**，是因为它走的是完全不同的代码：`api/admin/health.js:2390` 调 `ipLookup.getIpIndividualResults(null, ip)`，`null` = 绕过 Redis 缓存，**同步 await 打 5 个外部源**（`lib/ip-lookup.js:118-131` 串行 `for` 循环，最坏 5×4000ms ≈ 20s），然后把结果 `saveToStore` 写进 `ip_lookups`。这条路径在访客链路上不存在。

两条链路对比：

| 维度 | 访客首次访问 | 后台「重新查询」 |
|---|---|---|
| 入口 | `api/go.js:113` / `api/activate.js:13-38` | `api/admin/health.js:2300`（`section=ip-lookup-once` + `force:true`） |
| 函数 | `geoDistrict.getDistrict()` | `ipLookup.getIpIndividualResults()` |
| 数据源 | 腾讯 **1 个**（不支持境外） | ip-api/ip-sb/ipinfo/ipwhois/ipapi.is **5 个** |
| 超时 | 2500ms（且不阻塞，后台跑） | 4000ms × 5，串行，同步 await |
| 失败重试 | 无；失败后本实例退避 10 分钟 | 无；但你可以反复点 |
| 写 `ip_lookups` | 仅腾讯成功时 | 任一源有结果就写 |

### 3.2 但确实有一个真实的"太快"风险（顺带发现的 bug）

`api/go.js:319-326`：

```js
    // fire-and-forget: stats failure never blocks redirect
    Promise.all(tasks).catch(function (e) { ... });

    // 3) 302 跳转
    res.setHeader("Location", entry.target_url);
    return res.status(302).end();
```

`tasks` 里包含 `visitorLog.logVisit(...)`（一次 Postgres INSERT），**它既没有 await，也没有包 `background.run()`**。对比 `api/activate.js:109-123` 是正确包了 `background.run(..., "visitor-log")` 的。

Vercel 在 `res.end()` 之后会冻结函数实例，未完成的 I/O 有被**中途掐断**的概率 → 结果是**整条访问记录丢失**（不是地理信息丢失）。
`lib/background.js:1-6` 的注释已经写明了这个坑，只是 `go.js` 没遵守。`api/go.js:299-318` 对推送加了 5s `Promise.race` 上限，但**超时后并不取消** `pushTask`，它依旧裸奔在响应之后。

建议：把 `tasks` 里所有持久化动作（至少 `logVisit`）改成 `background.run(...)`。

---

## 4. 现象三：`?deviceId=666` 丢失

### 4.1 结论：是「记录时就没记」，不是显示截断，也不是故意剥掉

1. **`/go/` 链路路径是硬编码的**（`api/go.js:281 / 285 / 293`）：

```js
    tasks.push(redis.zincrby("stats:pages:" + dateKey, 1, "/go/" + slug)...);   // L281
    var visitorRecord = { h: vHash, p: "/go/" + slug, ... };                    // L285
        path: "/go/" + slug,                                                     // L293
```

   `slug` 经 `SLUG_RE`（`api/go.js:35`）校验，物理上不可能含 `?`。所以 query string **从未进入** `visitor_logs.path`，也从未进入 `stats:recent` / `stats:pages`。

2. **后端也没有任何地方剥 query。** 全链路检索确认：`lib/visitor-log.js` 的 `path` 处理只有 `String(entry.path || "/").slice(0, 500)`（`L61`），**没有 `split('?')[0]`、没有 `indexOf('?')`、没有 `new URL().pathname`**。全仓库 `split('?')` 只出现在 3 处，且都在**展示层**（`admin_Dx23.html:6434` 消息详情、`tools/ev-notifier/ev_notifier.py` 通知端解析）。

3. **后台渲染也没有截断**。`admin_Dx23.html:9632-9634` 原样输出 `v.path`，还给了 `title` 全量提示 + Copy 按钮。

4. **表结构里也没有承载参数的字段**。`lib/visitor-log.js:23-36` 的 `visitor_logs` 只有 `path/ua/ref/country/region/city/hash/source`，**没有 `query` / `params` / `utm_*` 列**。而 `api/go.js:264-266` 只挑了 `utm_source` / `utm_medium` / `utm_campaign` 三个已知参数（且只用于推送 payload，**没有落 visitor_logs**）。`deviceId` 既不在白名单里，也没有地方存。

### 4.2 为什么你会觉得"有的页面带参数、有的不带"

两条埋点链路行为不一致：

| 链路 | path 来源 | 是否保留 query |
|---|---|---|
| `/go/:slug`（`api/go.js`） | `"/go/" + slug` 硬编码 | ❌ **永远丢** |
| 普通页面埋点（`index.html:152`、`activate.html:477`） | `location.pathname + location.search` | ✅ 保留（服务端 `api/activate.js:66,77` 只截断到 120 字符） |

`/go/ev-timetable` 是服务端 302，**没有前端埋点**，所以这条访问只可能来自 `go.js` → 必然丢参。

### 4.3 影响

- 渠道归因（`deviceId` / `ref` / 自定义参数）在 `/go/` 链路**完全失效**，而这恰恰是转化漏斗最关键的那一跳。
- `stats:pages` 用 `/go/ev-timetable` 单一 key 聚合，无法按渠道拆分点击量。
- 反向问题：普通页面埋点**保留**了完整 search，会导致"热门页面"排行被 `?deviceId=1`、`?deviceId=2`… 无限分裂（`api/activate.js:89` 直接把这个字符串当 ZSET member）。

---

## 5. 修复建议（按优先级）

### P0 —— 让 `ip_lookups` 在访客链路自动补齐（根治现象一、二）

在 `api/go.js` / `api/activate.js` 的响应之后，用 `background.run()` 补一次：

```js
// 伪代码：仅对 ip_lookups 里不存在的 IP 跑一次
background.run((async function () {
  var stored = await require("../lib/ip-lookup-store").getFromStore(ip);
  if (stored) return;
  var r = await require("../lib/ip-lookup").getIpIndividualResults(null, ip);
  if (r && r.length) await ipStore.saveToStore(ip, merged, r);   // ⚠️ 记得 await
})(), "ip-lookup-warmup");
```

配套必须做两件事，否则会拖垮函数：

- `lib/ip-lookup.js:118-131` 的**串行 `for` 循环改成 `Promise.allSettled`**，整体加一个 6~8s 总闸（现在是 5×4s = 20s 串行，冷启动下极易撞 `maxDuration`）；
- 优先只用 `ip-api`（`lang=zh-CN`，中文质量最好）先落库，其余 4 源作为补充异步再补。

### P1 —— 修展示层的三个"看起来像错"的点

1. **decode Vercel 头部**：`api/go.js:248-250`、`api/activate.js:14-16`、`api/admin/health.js:577-579` 加一个 `safeDecode()`（`try { decodeURIComponent(v) } catch { v }`）。同时建议**刷历史数据**：`update visitor_logs set city = ...` 把已有的 `%XX` 解回来。
2. **境外 region 代码别裸奔**：`lib/geo-zh.js:235-244` 的 `regionZhOf` 在 `isChinaCode(country) === false` 时，改为返回「国家中文名 + 原始代码」或直接返回空并把**国家中文名**顶上来（现在是 `IL · 芝加哥`，至少应该变成 `美国 · 芝加哥`）。要彻底解决就补一张常见国家的一级行政区中文表（美国 50 州 + 加拿大省 + 日本都道府县足够覆盖 90% 流量）。
3. **消除混搭**：`health.js:3126-3127` 的 `region` 和 `city` 各自独立回落，会出现「ip_lookups 的省 + Vercel 的市」。建议在 `lib/geo-zh.js` 里加一个 `resolveDisplay(geo)` 统一按「来源成组」输出，禁止跨源拼接（现有 `pickCnPair()` 只管了 `ip_lookups` 内部两组，没管 Vercel 这一组）。

### P2 —— URL / 参数留存（根治现象三）

1. `visitor_logs` 加列（幂等 DDL 放进 `lib/visitor-log.js:ensureTable()`）：
   ```sql
   alter table visitor_logs add column if not exists query text not null default '';
   alter table visitor_logs add column if not exists params jsonb;
   ```
2. `api/go.js` 写入时把完整 query 带上：
   ```js
   var qIndex = String(req.url || "").indexOf("?");
   var fullQuery = qIndex >= 0 ? String(req.url).slice(qIndex + 1) : "";
   // path 仍存 "/go/" + slug（保证页面聚合稳定），query 单独存 fullQuery
   ```
   并把 `deviceId` 等自定义参数一并塞进 `params` jsonb，而不是只认 utm 三件套。
3. 前端埋点改为**分开上报** `path` 与 `search`（`index.html:152`、`activate.html:477`），服务端 `api/activate.js:66` 拆成两列：`path` 只存 pathname（修掉"热门页面被参数分裂"），`query` 存 search。
4. 后台「最近访客」的 Page 列（`admin_Dx23.html:9632-9634`）加一个「带参原链接」的复制项 / hover 展示，方便运营直接拿完整 URL。

### P3 —— 其它

- `api/go.js:319` 的统计/日志 `tasks` 改走 `background.run()`（见 §3.2）；`api/go.js:306-315` 的 5s race 超时后应显式 `cancel`/忽略结果，避免重复推送。
- `api/admin/health.js:2427` 的 `ipStore.saveToStore(...)` **没有 await**，手工查询结果同样有丢写风险，建议 `await` 或用 `background.run()`。
- `lib/geo-district.js` 的 `memCache` / `failUntil` 都是**实例内存**，Vercel 冷启动即失效，"10 分钟退避"在弹缩环境下形同虚设；建议把失败标记也落到 `ip_lookups`（如 `district_checked_at` 已经是列，可直接复用做节流）。
- 长期看，建议**在写入 `visitor_logs` 时就顺手把 Vercel 头部 + 已解析的中文写入**（而不是只存英文原文再靠读取时富化），这样历史数据不会随时间"变味"。

---

## 6. 关键代码位置索引

| 关注点 | 位置 |
|---|---|
| 访客记录写入（go 链路，无 waitUntil） | `api/go.js:291-296, 319-326` |
| 访客记录写入（埋点链路，正确用 waitUntil） | `api/activate.js:107-125` |
| `visitor_logs` 建表 / path 处理 | `lib/visitor-log.js:23-36, 55-70` |
| 后台「最近访客」geo 回落四层 | `api/admin/health.js:3096-3136`（`L3126-3127` 是问题核心） |
| 前端拼接 `region · city · district` | `admin_Dx23.html:9516-9527` |
| 中文映射三张表 + `regionZhOf`（只认 CN） | `lib/geo-zh.js:17-170, 220-244` |
| 腾讯位置服务（2.5s、失败不写库、10min 退避） | `lib/geo-district.js:30-38, 211-231, 242-301` |
| 5 个境外源（4s×5 串行，仅手工触发） | `lib/ip-lookup.js:1-3, 118-131` |
| 后台「重新查询」入口 | `admin_Dx23.html:9846-9874` → `api/admin/health.js:2300-2456`（`L2390` 查 5 源，`L2427` 未 await 写库） |
| 「未落入 ip_lookups」提示文案 | `admin_Dx23.html:9995` |
| `/go/` 路径硬编码（丢 query 的源头） | `api/go.js:281, 285, 293` |
| 前端埋点保留 search（对比组） | `index.html:152`、`activate.html:477` → `api/activate.js:66, 77` |
| `waitUntil` 封装（无超时/无重试） | `lib/background.js:16-27` |
