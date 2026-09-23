# 前台「我的 IP 信息」页面方案

> 目标：新增一个前台页面，展示**访客自己的 IP** + 我们能拿到的**完整 IP 详情**
> （国家 / 省 / 市 / 区县 / 运营商 / ASN / 时区 / 经纬度 / 设备信息），并标注数据来源。
>
> 场景：用户自查网络定位是否正常（排查"为什么通知里没有地区"）、客服核对、也顺便验证腾讯接口是否可用。

---

## 一、页面要展示什么

| 分组 | 字段 | 数据来源 | 备注 |
|---|---|---|---|
| 你的 IP | IPv4 / IPv6、协议 | `x-forwarded-for`（服务端） | 前端拿不到真实公网 IP，必须由后端回传 |
| 地区（中文） | 国家、省、市、**区县** | **腾讯位置服务** → `ip_lookups.region_zh/city_zh/district` | 唯一能给区县的源 |
| 地区（兜底） | 国家、省/州、市、时区 | Vercel 头部 `x-vercel-ip-*` | **对国内 IP 常常只有国家**，需在页面注明 |
| 地区（兜底2） | 中文省/市 | `ip_lookups.region/city`（ip-api `lang=zh-CN`） | 永久表，可能没有该 IP |
| 网络 | ISP、org、ASN | `ip_lookups.isp/org/asn` | 腾讯不提供，只有 ip-api 有 |
| 坐标 | lat / lon | `ip_lookups.lat/lon` | 精度低（IP 级），建议折叠展示 |
| 设备 | OS / 浏览器 / 设备类型、UA | `lib/notify.js collectRequestInfo(req)` | 现成函数，直接复用 |
| 元信息 | 每个字段的「来源 + 更新时间」 | 后端拼 | 让用户知道为什么某字段是空的 |

---

## 二、数据来源与调用方式（关键约束）

```
浏览器 ──GET /api/visitor/ip──► Vercel 函数 ──┬─► Vercel 头部（国家/时区，免费）
                                              ├─► Supabase ip_lookups（中文 geo / ISP / ASN，永久表）
                                              └─► 腾讯位置服务 IP 定位（省 + 市 + 区县，需带 Referer）
```

⚠️ 必须由**后端**调腾讯，浏览器直连不行：
1. 腾讯 key 走**域名白名单**校验，服务端调用必须带 `Referer: https://gudq.com/`（`api/*` 已在做）；
2. 浏览器直连会撞 CORS，且会把 key 暴露在前端。

---

## 三、后端设计

### 3.1 新端点

`api/visitor/ip.js` → `GET /api/visitor/ip`（`api/visitor/` 目录已存在且为空，正好放这里）

| 参数 | 说明 |
|---|---|
| `?force=1` | 忽略缓存重新查腾讯（限流 **1 次/分钟/IP**），默认不带 |

**安全约束（很重要）**：
- **只查调用者自己的 IP**（从 `x-forwarded-for` 取第一段），**不接受 `?ip=` 任意查询**——
  否则会被当成免费 IP 查询代理刷我们的腾讯额度（6000/日）。
- 若以后要做「查任意 IP」，必须放到**管理员登录后**的接口（如 `admin/health?section=ip-lookup-once`，已有）。
- 响应 `Cache-Control: no-store`。

### 3.2 缓存与额度保护（复用现有机制）

`lib/geo-district.js` 现有三档读取（内存 → Supabase → 后台预热）。本页面需要**新增一个"同步"入口**：

```js
// lib/geo-district.js 新增（用户显式查询时允许阻塞等待）
// 与 getDistrict() 的区别：这里会 await 腾讯接口（最多 2.5s）并落库，而不是丢后台。
async function resolveNow(rawIp, force) {
  var ip = normalizeIp(rawIp);
  if (isPrivateOrInvalid(ip)) return null;
  var stored = force ? null : await getStoredGeo(ip);
  if (!force) {
    var fresh = districtFromStored(stored);
    if (fresh !== null) return { ...stored, cached: true };
  }
  var ad = await fetchAdInfo(ip);          // 2.5s 超时；失败返回 null
  if (ad === null) return stored ? { ...stored, cached: true, tencentFailed: true } : null;
  await writeCache(ip, ad);
  return { region: ad.province, city: ad.city, district: ad.district, checkedAt: Date.now(), cached: false };
}
```

**额度账**：同一 IP **30 天只消耗 1 次**腾讯调用（`writeCache` 落库 + 内存缓存）；
页面刷新走缓存 0 消耗；只有 `force=1` 且有冷却控制时才可能重复调用。

### 3.3 响应结构

```json
{
  "success": true,
  "ip": "36.113.30.111",
  "ipVersion": 4,
  "geo": {
    "region": "浙江", "city": "杭州", "district": "西湖区",
    "country": "中国", "source": "tencent", "cached": true
  },
  "vercel": { "country": "CN", "region": "", "city": "", "timezone": "Asia/Shanghai" },
  "network": { "isp": "Chinanet", "org": "China Telecom", "asn": "4134", "lat": 30.29, "lon": 120.17, "source": "ip-api" },
  "device": { "os": "macOS", "browser": "Chrome", "device": "Desktop" },
  "notes": ["区县来自腾讯位置服务；IP 定位精度上限到区县，运营商出口 IP 可能覆盖多个区"]
}
```

- 腾讯失败（`121` 配额未分配 / `110` 未授权 / 超时）时：`district` 为空 + `notes` 里写明原因，
  **页面照常显示省市**，不报错（降级友好）。
- 命中缓存时把 `cached: true` 回传，页面显示「已缓存 · 30 天内不再查询」。

### 3.4 后端骨架

```js
// api/visitor/ip.js
var rateLimit = require("../../lib/rate-limit");
var notify = require("../../lib/notify");
var geoDistrict = require("../../lib/geo-district");
var geoZh = require("../../lib/geo-zh");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Use GET" });

  var ip = rateLimit.getClientIp(req);                    // 只查调用者自己
  var info = notify.collectRequestInfo(req);              // 复用现成 UA 解析
  var force = req.query && req.query.force === "1";

  if (force) {                                            // 强制刷新要做冷却
    var hit = await rateLimit.checkMyIpForceLimit(req);   // 需在 lib/rate-limit.js 新增：1 次/分钟/IP
    if (hit.blocked) return res.status(429).json({ success: false, error: "刷新过于频繁，请稍后再试" });
  }

  var tencent = await geoDistrict.resolveNow(ip, force).catch(function () { return null; });
  var stored = await geoDistrict.getStoredGeo(ip).catch(function () { return null; });

  var regionZh = (tencent && tencent.region) || (stored && stored.region) || "";
  var cityZh = (tencent && tencent.city) || (stored && stored.city) || "";
  var districtZh = (tencent && tencent.district) || (stored && stored.district) || "";

  return res.status(200).json({
    success: true,
    ip: ip,
    ipVersion: ip.indexOf(":") >= 0 ? 6 : 4,
    geo: {
      country: geoZh.resolveZhLocation({ country: req.headers["x-vercel-ip-country"] }),
      region: regionZh, city: cityZh, district: districtZh,
      full: geoZh.resolveZhLocationFull({ zh_region: regionZh, zh_city: cityZh, district: districtZh }).location_full_zh,
      source: tencent ? "tencent" : (stored ? "cache" : ""),
      cached: Boolean(tencent && tencent.cached),
    },
    vercel: {
      country: req.headers["x-vercel-ip-country"] || "",
      region: req.headers["x-vercel-ip-country-region"] || "",
      city: req.headers["x-vercel-ip-city"] || "",
      timezone: req.headers["x-vercel-ip-timezone"] || "",
    },
    network: stored ? { isp: stored.isp, org: stored.org, asn: stored.asn } : null,   // 需要 getStoredGeo 一并返回
    device: { os: info.os, browser: info.browser, device: info.device },
    notes: ["区县来自腾讯位置服务", "IP 定位精度上限到区县，运营商出口 IP 可能覆盖多个区"],
  });
};
```

> `getStoredGeo()` 需顺带返回 `isp/org/asn/lat/lon`（现在只查 4 列，扩成 8 列即可，仍然只 1 次 SELECT）。

---

## 四、前端设计

### 4.1 文件与兼容约定

- 新增单文件静态页 **`my-ip.html`**（与 `activate.html` 同风格，无构建、无框架）。
- ⚠️ **必须遵守项目既有兼容约定**（见 QA 报告 P1-7）：手环端老旧 WebView 不支持 ES6+，
  因此**只用 `var`、用 `XMLHttpRequest`（不要 `fetch`/`const`/箭头函数/`IntersectionObserver`）**，
  可复用 `activate.html` 里的 `xhrFetch()` helper。
- 样式：`prefers-color-scheme` 深浅色自适应；移动端优先（手环/手机也会打开）；无外部依赖字体/图标。

### 4.2 布局

```
┌─────────────────────────────────────┐
│  我的 IP 信息                        │
│  36.113.30.111          [复制]       │
│  IPv4 · 中国                         │
├─────────────────────────────────────┤
│  归属地                              │
│  浙江 杭州 西湖区                    │
│  来源：腾讯位置服务 · 已缓存         │
├─────────────────────────────────────┤
│  网络                │  设备         │
│  运营商 Chinanet     │  OS macOS     │
│  ASN 4134            │  浏览器 Chrome│
│  时区 Asia/Shanghai  │  类型 Desktop │
├─────────────────────────────────────┤
│  Vercel 头部原文（国家 CN / 省市空）  │  ← 折叠，用于排查
│  坐标 30.29, 120.17（精度有限）      │
├─────────────────────────────────────┤
│  [ 重新查询 ]  说明文案…              │
└─────────────────────────────────────┘
```

### 4.3 状态与交互

| 状态 | 表现 |
|---|---|
| 加载中 | 骨架屏 + 「正在查询归属地…」（首次未缓存时最多 2.5s，需有 loading 提示） |
| 成功 | 上方卡片；`cached=false` 时提示「本次为新查询，已缓存 30 天」 |
| 腾讯失败 | 地区只显示省/市（或"暂不可用"），并给出原因文案（配额未分配 / 未授权 / 超时） |
| 强制刷新 | 按钮 60s 冷却（本地记录 + 后端 429 双重保护） |
| 复制 | 复制 IP（`document.execCommand('copy')` 兼容老内核，失败则选中文本让用户手动复制） |
| 失败 | 「查询失败，请稍后重试」+ 重试按钮，不显示技术堆栈 |

### 4.4 隐私说明（页面底部）

- 本页只查询**你自己的 IP**，不提供任意 IP 查询；
- 访问会记入站点统计（与其它页面一致，见 `visitor_logs` 表），用于访客分析。

---

## 五、实现步骤

| # | 文件 | 改动 |
|---|---|---|
| 1 | `lib/geo-district.js` | 新增 `resolveNow(ip, force)`（同步等待腾讯、可强制）、`getStoredGeo()` 扩展返回 `isp/org/asn/lat/lon` |
| 2 | `lib/rate-limit.js` | 新增 `checkMyIpForceLimit(req)`（1 次/分钟/IP，独立 key） |
| 3 | `api/visitor/ip.js` | 新端点（见 §3.4 骨架） |
| 4 | `my-ip.html` | 新页面（见 §4） |
| 5 | `vercel.json` | 可选：加 rewrite `"/my-ip" → "/my-ip.html"` 与 `"/ip" → "/my-ip.html"` |
| 6 | 站点导航 | 可选：在首页/使用指南加入口链接 |
| 7 | `docs/` | 本文档随实现更新「实现状态」章节 |

---

## 六、验证方法

```bash
# 1) 首次调（可能等腾讯，最多 2.5s）
curl -s "https://app-auth.gudq.com/api/visitor/ip" | python3 -m json.tool

# 2) 立刻再调一次：应命中缓存（快、且 source/cached 变化）
time curl -s "https://app-auth.gudq.com/api/visitor/ip" | python3 -m json.tool

# 3) 强制刷新：第一次 200、一分钟内再点应 429
curl -s "https://app-auth.gudq.com/api/visitor/ip?force=1" | python3 -m json.tool
curl -s "https://app-auth.gudq.com/api/visitor/ip?force=1" | python3 -m json.tool

# 4) 额度核对：看 Vercel 日志里 "[geo-district] queried" 只出现一次
vercel logs "$(vercel ls --prod | grep -m1 Ready | awk '{print $3}')" | grep geo-district

# 5) 落库核对
node -e "…select region_zh,city_zh,district,district_checked_at from ip_lookups where ip='你的IP'…"
```

需要确认的点：**首次调用应能拿到区县**（前提是腾讯 key 已「一键分配」配额）；若返回 `district: ""` 且 notes 提示配额问题，属预期降级。

---

## 七、风险与注意

| 风险 | 应对 |
|---|---|
| **腾讯额度被页面刷掉** | 只查自己 IP + 30 天落库缓存 + `force` 独立限流（1 次/分钟）；刷新页面走缓存 0 消耗 |
| 被当成「免费 IP 查询站」滥用 | 不接受任意 IP 参数；要查任意 IP 请用管理员接口 |
| 首次打开慢（跨洋 2.5s） | 骨架屏 + 文案说明；命中缓存后 < 300ms |
| 国内 IP 在 Vercel 头部没有省市 | 页面以腾讯/ip_lookups 为主，Vercel 只作为"国家+时区"补充并**明确标注来源** |
| IPv6 | 腾讯对 IPv6 支持有限，取不到就只显示 Vercel/ip_lookups 信息 |
| 经纬度误导 | 默认折叠，并注明「IP 级精度，仅到城市，不代表实际位置」 |
| 手环端打不开 | 遵守 §4.1 兼容约定（var + XHR + 不用 ES6） |

---

## 八、待确认

1. 页面路径：`/my-ip.html`、`/ip.html` 还是 `/myip`？标题用「我的 IP 信息」还是「网络诊断」？
2. 是否允许输入**任意 IP** 查询？建议：仅管理员登录后可见（复用 `admin/health?section=ip-lookup-once`）。
3. 是否要展示地图 / 经纬度？建议默认折叠（精度低易误导）。
4. 是否把入口加到首页导航与「使用指南」？
5. 页面本身是否也上报 `visitor-track`（与其它页一致）还是完全独立？（建议一致，便于统计）
