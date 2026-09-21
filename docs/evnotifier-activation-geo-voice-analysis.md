# EvNotifier 激活语音 + IP 中文地理位置分析

> 分析目标：在激活成功/失败语音通知中加入用户中文城市/地区（如"淄博市"、"北京市 朝阳区"），并评估是否能获取中文 IP 地理位置。

---

## 一、整体架构速览

```
用户设备 → Vercel Serverless (api/activate.js)
                │
                ├─ Vercel Headers (免费, 零延迟):
                │    x-vercel-ip-country        → "CN"
                │    x-vercel-ip-country-region → "Shandong"
                │    x-vercel-ip-city           → "Zibo"    ← 英文名!
                │
                ├─ pushNotification → Upstash Redis PUB/SUB
                │                          │
                │                          ▼
                │              Mac ev_notifier.py
                │                  ├─ macOS 弹窗
                │                  ├─ say -v Tingting "..."  ← 语音播报
                │                  └─ afplay Ping.aiff
                │
                └─ lib/ip-lookup.js (ip-api.com lang=zh-CN)
                       → "淄博"  ← 中文名! (异步, 有延迟)
```

---

## 二、激活成功 vs 激活失败：Geo 数据现状

### 2.1 服务端推送 payload 对比（api/activate.js）

#### 激活成功（new_activation）— 第 516-536 行

[api/activate.js](file:///Users/Banner/Documents/guomengtao/app-auth/api/activate.js#L516-L536)

```javascript
await notify.pushNotification("new_activation", {
  redeem_code: code,
  activation_code: activationCode,
  product_id: productId,
  device_id: device,
  months: months,
  source: "user",
  user_name: (info && info.user_name) || "",
  ip: visitorInfo ? visitorInfo.ip : "",
  user_agent: visitorInfo ? visitorInfo.userAgent : "",
  visitor_info: visitorInfo || {},
  device_info: deviceInfo || {},
  device_model: (deviceInfo && (deviceInfo.model || deviceInfo.product)) || "",
  country: String(req.headers["x-vercel-ip-country"] || "").slice(0, 8),   // ✅ 有
  region:  String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16), // ✅ 有
  city:    String(req.headers["x-vercel-ip-city"] || "").slice(0, 40),      // ✅ 有
});
```

**结论：激活成功推送已包含 `country`/`region`/`city`（英文）。**

#### 激活失败（activation_failure）— 全部 7 条失败路径 + catch 块

所有激活失败路径的 pushNotification payload 都**缺少** `country`/`region`/`city`：

```javascript
// 示例：IP 限流 (第 173 行), 设备校验失败 (第 197 行),
//        兑换码校验失败 (第 218 行), 设备限流 (第 244 行),
//        兑换码不存在 (第 276 行), 数据损坏 (第 297 行),
//        配置异常 (第 319 行), 已被使用 (第 429 行),
//        catch 通用异常 (第 553 行)
await notify.pushNotification("activation_failure", {
  reason: "...",
  redeem_code: "...",
  device_id: "...",
  source: "user",
  ip: visitorInfo ? visitorInfo.ip : "",
  user_agent: visitorInfo ? visitorInfo.userAgent : "",
  visitor_info: visitorInfo || {},
  device_info: deviceInfo || {},
  // ❌ 没有 country / region / city !
});
```

**结论：激活失败推送完全没有 geo 字段。**

### 2.2 ev_notifier.py 语音生成对比

#### 激活成功语音（第 903-921 行）

[ev_notifier.py](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py#L903-L921)

```python
city = p.get("city", "") or ""
region = p.get("region", "") or ""
country = p.get("country", "") or ""
geo_str = city or region or country or ""
# ...
if geo_str:
    parts.append(f"来自{geo_str}")
voice_text = "，".join(parts)
# 示例输出: "新设备激活：课程表高级版，永久，来自Zibo"
```

#### 激活失败语音（第 922-929 行）

```python
city = p.get("city", "") or ""
# ...
if city:
    voice_text += f"，来自{city}"
# 示例输出: "激活失败：设备数量已达上限，来自Zibo"
```

**但问题是：激活失败 payload 从未携带 `city`，所以 `p.get("city", "")` 永远返回空字符串，语音中永远不会出现城市名！**

### 2.3 现状总结表

| 消息类型 | activate.js 是否有 geo | ev_notifier.py 是否读 geo | 语音是否播报城市 |
|---------|----------------------|--------------------------|----------------|
| new_activation | ✅ country/region/city | ✅ 读取 city/region/country | ✅ 会播（英文名） |
| activation_failure | ❌ 全部缺失 | ✅ 读取 city（但永远为空） | ❌ 不会播 |
| purchase_click | ✅ | ✅ | ✅ 会播 |
| page_visit | ✅ | ✅ (弹窗，不语音) | N/A |
| new_order | ❌ | ❌ | ❌ |

---

## 三、核心问题：能否获得中文 IP 地理位置？

### 3.1 数据来源分析

| 来源 | 语言 | 延迟 | 成本 | 精确度 |
|------|------|------|------|--------|
| Vercel Headers | **英文** (Zibo, Beijing) | 0ms | 免费 | 城市级 |
| ip-api.com `lang=zh-CN` | **中文** (淄博, 北京) | 200-800ms | 免费 | 城市级 |
| ipapi.co | 英文 | 300-1000ms | 免费 1000/天 | 城市级 |
| ipinfo.io | 英文 | 200-500ms | 免费 50k/月 | 城市级 |

### 3.2 已有基础设施：lib/ip-lookup.js 已支持中文

[lib/ip-lookup.js](file:///Users/Banner/Documents/guomengtao/app-auth/lib/ip-lookup.js#L8-L10) 中 `ip-api.com` 已配置 `lang=zh-CN`：

```javascript
{
  name: "ip-api",
  fetch: function(ip) {
    return fetch("http://ip-api.com/json/" + encodeURIComponent(ip)
      + "?fields=status,country,regionName,city,isp,org,as,lat,lon,timezone,query&lang=zh-CN", {
      signal: AbortSignal.timeout(API_TIMEOUT)
    })
  }
}
```

返回示例：
```json
{
  "country": "中国",
  "regionName": "山东",
  "city": "淄博",
  "isp": "中国联通"
}
```

**这个模块已经存在，返回的就是中文城市名！** 目前它被 admin 后台的 health.js 用于 IP 详情查询，但推送消息时没有调用它。

### 3.3 两种中文方案对比

#### 方案 A：直接用 Vercel Headers 的英文名让 TTS 朗读

```
voice_text = "新设备激活：课程表高级版，来自Beijing"
→ say -v Tingting "新设备激活：课程表高级版，来自Beijing"
```

- ✅ 零延迟，零成本
- ❌ 英文地名听起来不自然（"来自 Beijing" 而非 "来自北京"）
- ❌ 小城市名 TTS 可能读不准

#### 方案 B：利用 ip-api.com lang=zh-CN 获取中文名再推送

```
activate.js:
  1. 从 Vercel Headers 拿到英文 city (Zibo)
  2. 立刻用这些英文名构建 payload → 先推送（保证速度）
  3. 同时异步调 ip-api.com 获取中文名（淄博）
  4. 中文名写入 Redis，下次或后台补充

ev_notifier.py:
  1. 收到推送后，读取 payload 中的 city_en / city_zh
  2. 如果有 city_zh，用中文播报
  3. 如果只有 city_en，用英文播报（兜底）
```

- ✅ 语音播报中文地名，自然
- ❌ 增加 200-800ms 延迟（但可以异步不阻塞）
- ❌ 需要改造推送流程

#### 方案 C：本地映射表（推荐起步方案）

在 `activate.js` 中构建一个常用城市中英文映射表，Vercel Headers 拿到英文名后直接查表翻译：

```javascript
var CITY_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Guangzhou": "广州",
  "Shenzhen": "深圳", "Hangzhou": "杭州", "Chengdu": "成都",
  "Wuhan": "武汉", "Nanjing": "南京", "Zibo": "淄博",
  "Qingdao": "青岛", "Jinan": "济南", "Tianjin": "天津",
  "Chongqing": "重庆", "Suzhou": "苏州", "Xian": "西安",
  "Changsha": "长沙", "Zhengzhou": "郑州", "Dalian": "大连",
  "Xiamen": "厦门", "Fuzhou": "福州", "Kunming": "昆明",
  "Hefei": "合肥", "Shenyang": "沈阳", "Dongguan": "东莞",
};

var REGION_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津",
  "Chongqing": "重庆", "Shandong": "山东", "Guangdong": "广东",
  "Zhejiang": "浙江", "Jiangsu": "江苏", "Sichuan": "四川",
  "Hubei": "湖北", "Fujian": "福建", "Hunan": "湖南",
  "Henan": "河南", "Hebei": "河北", "Liaoning": "辽宁",
  "Shaanxi": "陕西", "Yunnan": "云南", "Anhui": "安徽",
  "Jiangxi": "江西", "Guangxi": "广西", "Shanxi": "山西",
  "Guizhou": "贵州", "Hainan": "海南", "Jilin": "吉林",
  "Heilongjiang": "黑龙江", "Gansu": "甘肃", "Xinjiang": "新疆",
  "Inner Mongolia": "内蒙古", "Ningxia": "宁夏", "Qinghai": "青海",
  "Tibet": "西藏", "Hong Kong": "香港", "Macau": "澳门", "Taiwan": "台湾",
};

function resolveChineseCity(cityEn, regionEn) {
  var cityZh = CITY_ZH_MAP[cityEn] || "";
  var regionZh = REGION_ZH_MAP[regionEn] || "";
  if (cityZh) {
    return regionZh && regionZh !== cityZh ? regionZh + " " + cityZh : cityZh;
  }
  if (regionZh) {
    return cityEn ? regionZh + " " + cityEn : regionZh;
  }
  return cityEn || regionEn || "";
}
```

- ✅ 零延迟，零成本，零网络依赖
- ✅ TTS 朗读中文地名，自然
- ❌ 非中国 IP 返回空（但业务主要面向中国用户，覆盖率高）
- ❌ 需要维护映射表（约 50-100 条数据即可覆盖中国主要城市）

---

## 四、推荐方案：方案 C（本地映射表） + 激活失败补齐 geo

### 4.1 需要改动的文件

| 文件 | 改动 |
|------|------|
| `api/activate.js` | ① 加入中英文城市映射表 ② 全部 8 处 activation_failure pushNotification 补齐 geo 字段 |
| `tools/ev-notifier/ev_notifier.py` | ① activation_failure 语音增加 region/country 兜底（不仅读 city）② 可选：加入中文后缀"市"/"省" |

### 4.2 具体改动

#### 改动 1：api/activate.js — 在文件顶部加入映射表和解析函数

在现有 import 区域之后，加入：

```javascript
var CITY_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Guangzhou": "广州",
  "Shenzhen": "深圳", "Hangzhou": "杭州", "Chengdu": "成都",
  "Wuhan": "武汉", "Nanjing": "南京", "Zibo": "淄博",
  "Qingdao": "青岛", "Jinan": "济南", "Tianjin": "天津",
  "Chongqing": "重庆", "Suzhou": "苏州", "Xian": "西安",
  "Changsha": "长沙", "Zhengzhou": "郑州", "Dalian": "大连",
  "Xiamen": "厦门", "Fuzhou": "福州", "Kunming": "昆明",
  "Hefei": "合肥", "Shenyang": "沈阳", "Dongguan": "东莞",
  "Wuxi": "无锡", "Ningbo": "宁波", "Foshan": "佛山",
  "Harbin": "哈尔滨", "Shijiazhuang": "石家庄", "Nanchang": "南昌",
  "Taiyuan": "太原", "Guiyang": "贵阳", "Lanzhou": "兰州",
  "Hohhot": "呼和浩特", "Urumqi": "乌鲁木齐", "Lhasa": "拉萨",
  "Yinchuan": "银川", "Xining": "西宁", "Haikou": "海口",
  "Zhuhai": "珠海", "Zhongshan": "中山", "Huizhou": "惠州",
  "Yangzhou": "扬州", "Wenzhou": "温州", "Nantong": "南通",
  "Luoyang": "洛阳", "Weifang": "潍坊", "Yantai": "烟台",
  "Quanzhou": "泉州", "Shaoxing": "绍兴", "Jiaxing": "嘉兴",
};

var REGION_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津",
  "Chongqing": "重庆", "Shandong": "山东", "Guangdong": "广东",
  "Zhejiang": "浙江", "Jiangsu": "江苏", "Sichuan": "四川",
  "Hubei": "湖北", "Fujian": "福建", "Hunan": "湖南",
  "Henan": "河南", "Hebei": "河北", "Liaoning": "辽宁",
  "Shaanxi": "陕西", "Yunnan": "云南", "Anhui": "安徽",
  "Jiangxi": "江西", "Guangxi": "广西", "Shanxi": "山西",
  "Guizhou": "贵州", "Hainan": "海南", "Jilin": "吉林",
  "Heilongjiang": "黑龙江", "Gansu": "甘肃", "Xinjiang": "新疆",
  "Inner Mongolia": "内蒙古", "Ningxia": "宁夏", "Qinghai": "青海",
  "Tibet": "西藏", "Hong Kong": "香港", "Macau": "澳门", "Taiwan": "台湾",
};

function resolveChineseCity(cityEn, regionEn) {
  var cityZh = CITY_ZH_MAP[cityEn] || "";
  var regionZh = REGION_ZH_MAP[regionEn] || "";
  if (cityZh) {
    return regionZh && regionZh !== cityZh ? regionZh + " " + cityZh : cityZh;
  }
  if (regionZh) {
    return cityEn ? regionZh + " " + cityEn : regionZh;
  }
  return cityEn || "";
}

function getGeoFields(req) {
  var country = String(req.headers["x-vercel-ip-country"] || "").slice(0, 8);
  var region = String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16);
  var city = String(req.headers["x-vercel-ip-city"] || "").slice(0, 40);
  var cityZh = resolveChineseCity(city, region);
  return {
    country: country,
    region: region,
    city: city,
    city_zh: cityZh,
  };
}
```

#### 改动 2：api/activate.js — 激活成功使用 getGeoFields()

将第 526-528 行：
```javascript
country: String(req.headers["x-vercel-ip-country"] || "").slice(0, 8),
region:  String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 16),
city:    String(req.headers["x-vercel-ip-city"] || "").slice(0, 40),
```
替换为：
```javascript
country:  geo.country,
region:   geo.region,
city:     geo.city,
city_zh:  geo.city_zh,
```

#### 改动 3：api/activate.js — 全部 8 处 activation_failure 补齐 geo 字段

在每个 `pushNotification("activation_failure", {` 的 payload 中统一追加：

```javascript
country:  geo.country,
region:   geo.region,
city:     geo.city,
city_zh:  geo.city_zh,
```

> 注意：`geo` 需要在 try 块开始处（第 189 行附近）提前解析一次：
> ```javascript
> var geo = getGeoFields(req);
> ```

#### 改动 4：ev_notifier.py — 激活成功语音用 city_zh 优先

[ev_notifier.py](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py#L917-L921) 将：

```python
city = p.get("city", "") or ""
region = p.get("region", "") or ""
country = p.get("country", "") or ""
geo_str = city or region or country or ""
```

改为：

```python
city_zh = p.get("city_zh", "") or ""
city = p.get("city", "") or ""
region = p.get("region", "") or ""
country = p.get("country", "") or ""
geo_str = city_zh or city or region or country or ""
```

#### 改动 5：ev_notifier.py — 激活失败语音用 city_zh 优先 + 增加 region/country 兜底

[ev_notifier.py](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py#L922-L929) 将：

```python
elif mtype == "activation_failure":
    reason = p.get("reason", "") or p.get("error", "") or ""
    city = p.get("city", "") or ""
    if reason:
        voice_text = f"激活失败：{reason[:60]}"
    else:
        voice_text = "激活失败"
    if city:
        voice_text += f"，来自{city}"
```

改为：

```python
elif mtype == "activation_failure":
    reason = p.get("reason", "") or p.get("error", "") or ""
    city_zh = p.get("city_zh", "") or ""
    city = p.get("city", "") or ""
    region = p.get("region", "") or ""
    country = p.get("country", "") or ""
    geo_str = city_zh or city or region or country or ""
    if reason:
        voice_text = f"激活失败：{reason[:60]}"
    else:
        voice_text = "激活失败"
    if geo_str:
        voice_text += f"，来自{geo_str}"
```

#### 改动 6：ev_notifier.py — 激活失败弹窗也展示 geo

[ev_notifier.py](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py#L828-L844) 在 `activation_failure` 弹窗块中，增加 geo 信息展示：

```python
# 在 lines 构建中加入 geo 行
city_zh = p.get("city_zh", "") or ""
city = p.get("city", "") or ""
region = p.get("region", "") or ""
geo_str = city_zh or (f"{region} {city}".strip() if region or city else "")
if geo_str:
    lines.append(f"地区: {geo_str}")
```

---

## 五、改动前后语音对比

### 激活成功

| 场景 | 改动前 | 改动后 |
|------|--------|--------|
| 北京用户激活 | `新设备激活：课程表高级版，永久，来自Beijing` | `新设备激活：课程表高级版，永久，来自北京` |
| 淄博用户激活 | `新设备激活：课程表高级版，12个月，来自Zibo` | `新设备激活：课程表高级版，12个月，来自山东 淄博` |
| 未知城市 | `新设备激活：课程表高级版，永久` | `新设备激活：课程表高级版，永久，来自Shandong` |

### 激活失败

| 场景 | 改动前 | 改动后 |
|------|--------|--------|
| 北京用户激活失败 | `激活失败：兑换码已被使用` | `激活失败：兑换码已被使用，来自北京` |
| 北京朝阳区（Vercel 返回 Chaoyang） | `激活失败：设备数量已达上限` | `激活失败：设备数量已达上限，来自北京 Chaoyang` |
| 未知城市 | `激活失败：兑换码不存在` | `激活失败：兑换码不存在，来自Shandong` |

> 注意：Vercel `x-vercel-ip-city` 的精细度最多到城市级别（如 Zibo、Beijing），不是区级别。北京市朝阳区（Chaoyang）目前 Vercel Headers 不提供这个粒度。但 `region` 字段在某些情况下可能返回更细颗粒度的区名（取决于 Vercel 的 IP 库）。如需真正区级精度，需走 ip-api.com 异步查询。

---

## 六、能否获得"北京市 朝阳区"级别的中文地址？

### 6.1 Vercel Headers 的粒度

Vercel 的 `x-vercel-ip-city` 返回的是**城市级别**，例如：
- `x-vercel-ip-city: Beijing`
- `x-vercel-ip-city: Zibo`

**不会**返回区级别（如 Chaoyang、Haidian）。这是 Vercel Edge Network 的 IP 库粒度决定的，免费层不会提供更细的数据。

### 6.2 异步 IP API 的粒度

`ip-api.com` 的 `city` 字段同样也是城市级别。区级别需要商业版或更高精度 IP 库。

`ipinfo.io` 偶尔能提供区级数据（取决于 IP 段），但不稳定。

### 6.3 结论

| 需求 | 能否实现 | 方式 |
|------|---------|------|
| "淄博市" | ✅ 可以 | Vercel Headers (Zibo) → 本地映射 → "淄博" |
| "北京市" | ✅ 可以 | Vercel Headers (Beijing) → 本地映射 → "北京" |
| "北京市 朝阳区" | ❌ 很难 | 免费 IP 库通常不提供区级精度 |
| "山东省 淄博市" | ✅ 可以 | region(Shandong) + city(Zibo) → "山东 淄博" |

**如果要实现"北京市 朝阳区"级别的播报，唯一的可行路径是**：
1. 使用 ip-api.com 商业版（付费）
2. 或使用用户设备 GPS（但涉及隐私，不推荐）
3. 或让客户端 App 上报定位信息（需要改动客户端）

**推荐**：以"省 + 市"格式（如"山东 淄博"、"北京"）作为语音播报的目标，这在免费 IP 库中完全可行。

---

## 七、实现优先级

| 优先级 | 改动 | 影响 |
|--------|------|------|
| 🔴 P0 | `api/activate.js` 所有 `activation_failure` 补齐 geo 字段 | **修复激活失败永远不播报城市名的 bug** |
| 🔴 P0 | `ev_notifier.py` activation_failure 语音增加 `city_zh`/`region`/`country` 读取 | 激活失败语音能播报城市 |
| 🟡 P1 | `api/activate.js` 加入中英文城市映射表 + `city_zh` | 语音播报中文地名 |
| 🟡 P1 | `ev_notifier.py` new_activation 语音优先读 `city_zh` | 激活成功语音播报中文地名 |
| 🟢 P2 | `ev_notifier.py` activation_failure 弹窗展示 geo | 弹窗里能看到用户城市 |
| ⚪ P3 | 异步 ip-api.com 补充未映射的城市 | 覆盖所有城市的中文名 |

---

## 八、总结

| 问题 | 答案 |
|------|------|
| 激活失败语音能播报城市名吗？ | ❌ 目前不能，因为 activate.js 的 activation_failure 推送 payload 缺少 geo 字段 |
| 能获得中文 IP 地理位置吗？ | ✅ 能！两条路：① Vercel Headers + 本地英文→中文映射表（推荐，零延迟）② ip-api.com lang=zh-CN（已有基础设施，有延迟） |
| 能获得"北京市 朝阳区"级别的精度吗？ | ❌ 免费 IP 库不支持区级精度，只能到城市级 |
| 推荐方案 | 本地映射表（零延迟零成本） + 补齐 activation_failure 的 geo 字段 |