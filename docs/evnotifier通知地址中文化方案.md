# EvNotifier 通知「地址中文化」方案

> 目标：网站后台（Vercel）推到 ev-notifier 的所有通知，归属地一律为中文
> （`Beijing` → `北京`、`Guangzhou` → `广州`），
> 且**在服务端读取 IP 归属地的那一刻就转成中文**，后续链路（payload → 弹窗 → 语音 → 消息列表 → 详情）全程不再出现英文地名。

---

## 1. 现状数据流

```
浏览器                Vercel 函数                        Upstash              Mac ev_notifier.py
+--------+  POST  +--------------------+             +----------------+  SUB  +-----------------------+
| 访客   | -----> | health.js          |  XADD/PUB   | auth:notifications| ---> | handle_message()      |
|        |        |  section=visit     | ----------> | :stream           |      |  ├ 弹窗(notify_macos) |
+--------+        |  pushToStream()    |             | auth:push_channel |      |  ├ 语音(say/afplay)   |
                   +--------------------+             +----------------+      |  ├ store_message()    |
+--------+  GET   +--------------------+                                      |  └ _format_message_   |
| 点击购买| -----> | go.js              |  XADD/PUB                            |     detail()          |
+--------+  302   |  pushPurchaseClick()| ------------------------------------>|                       |
                  +--------------------+                                      +-----------------------+
+--------+  POST  +--------------------+
| 激活   | -----> | activate.js        |  pushNotification()  (经 lib/notify.js)
+--------+        +--------------------+
```

三种会带归属地的通知：

| 通知类型 | 推送位置 | 归属地字段来源 |
|---|---|---|
| `page_visit` | `api/admin/health.js` L613-643（`pushToStream`） | Vercel 请求头 `x-vercel-ip-country` / `-region` / `-city`（**英文**） |
| `purchase_click` | `api/go.js` `pushPurchaseClick()` L103-160 | 上面同一批头部，写入 Redis 后取 `record.c/rg/ci`（**英文**） |
| `new_activation` / `activation_failure` | `api/activate.js` L585-595 | Vercel 头部 + 本地 `CITY_ZH_MAP` → 已产出 `city_zh` |

消费端：`tools/ev-notifier/ev_notifier.py` `handle_message()` L737 起。

---

## 2. 为什么「之前改过，还是发英文」（根因）

| # | 现象 | 证据 | 结论 |
|---|---|---|---|
| 1 | notifier 从来不读 `city_zh` | 全仓 `city_zh` 只出现在 `api/activate.js`（L62/592）和方案文档里；`ev_notifier.py` **0 处** | 🔴 **主因**：服务端算了中文，但显示/播报仍读 `p.get("city")`（英文） |
| 2 | 中文化只做了 1/3 条链路 | `health.js`（visit）与 `go.js`（purchase）payload 里根本没有 `city_zh` | `page_visit` / `purchase_click` 永远只能出英文 |
| 3 | 映射表是硬编码白名单且写在业务文件里 | `api/activate.js` L7-39，约 48 个城市；`resolveChineseCity()` 未命中直接回落 `cityEn` | 非白名单城市（如 `Neijiang`、`Xi'an`）必然英文 |
| 4 | 映射 key 与 Vercel 原值未必相等 | Vercel 可能给 `Xi'an` / `Xian`、`Zibo City` 等写法 | 即使城市在白名单里也会漏掉 |
| 5 | 语音路径也读 `city` | `ev_notifier.py` L922-925（激活）、L938-944（激活失败）、L948-952（购买）、L959-961（访问） | TTS 直接念英文地名 |
| 6 | `new_activation` 弹窗正文**完全没有归属地行** | L776-788 只拼激活码/兑换码/设备/来源/渠道 | 用户对「地址通知」的感知主要来自语音与 page_visit / purchase_click 弹窗 |

一句话：**中文只在 `activate.js` 内部算过一次，既没覆盖全部推送源，也没有被消费端使用；且判定靠白名单硬匹配。**

---

## 3. 方案总原则

1. **单一真源**：中文转换只在一个新模块里实现（`lib/geo-zh.js`），所有推送源 `require` 它；`api/activate.js` 里的本地映射表删除。
2. **源头转换**：在「读 Vercel 头部拿到 geo」的那一步就产出中文，payload 里直接带中文结果，下游不再做地名映射。
3. **字段收敛**：统一新字段 **`location_zh`**（如 `广东 广州`）。
   - 兼容期同时保留 `city_zh`（`activate.js` 已有），notifier 侧按 `location_zh → city_zh → 英文兜底` 顺序取。
4. **兜底不阻断**：白名单未命中 → 可选异步调 `ip-api.com?lang=zh-CN`（`lib/ip-lookup.js` 已用此参数，返回中文）补一次，失败就用原文，**绝不阻塞通知发送**。

---

## 4. 改动清单

### 4.1 新增 `lib/geo-zh.js`（唯一真源）

```js
// lib/geo-zh.js —— 英文地名 → 中文归属地（唯一实现）
var CITY_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Guangzhou": "广州", "Shenzhen": "深圳",
  "Zibo": "淄博", "Qingdao": "青岛", "Hangzhou": "杭州", "Chengdu": "成都",
  "Wuhan": "武汉", "Nanjing": "南京", "Jinan": "济南", "Tianjin": "天津",
  "Chongqing": "重庆", "Suzhou": "苏州", "Xian": "西安", "Changsha": "长沙",
  "Zhengzhou": "郑州", "Dalian": "大连", "Xiamen": "厦门", "Fuzhou": "福州",
  "Kunming": "昆明", "Hefei": "合肥", "Shenyang": "沈阳", "Dongguan": "东莞",
  "Wuxi": "无锡", "Ningbo": "宁波", "Foshan": "佛山", "Harbin": "哈尔滨",
  "Shijiazhuang": "石家庄", "Nanchang": "南昌", "Taiyuan": "太原", "Guiyang": "贵阳",
  "Lanzhou": "兰州", "Hohhot": "呼和浩特", "Urumqi": "乌鲁木齐", "Lhasa": "拉萨",
  "Yinchuan": "银川", "Xining": "西宁", "Haikou": "海口", "Zhuhai": "珠海",
  "Zhongshan": "中山", "Huizhou": "惠州", "Yangzhou": "扬州", "Wenzhou": "温州",
  "Nantong": "南通", "Luoyang": "洛阳", "Weifang": "潍坊", "Yantai": "烟台",
  "Quanzhou": "泉州", "Shaoxing": "绍兴", "Jiaxing": "嘉兴", "Neijiang": "内江",
  /* …按实际日志里的漏网城市持续追加… */
};

var REGION_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津", "Chongqing": "重庆",
  "Shandong": "山东", "Guangdong": "广东", "Zhejiang": "浙江", "Jiangsu": "江苏",
  "Sichuan": "四川", "Hubei": "湖北", "Fujian": "福建", "Hunan": "湖南",
  "Henan": "河南", "Hebei": "河北", "Liaoning": "辽宁", "Shaanxi": "陕西",
  "Yunnan": "云南", "Anhui": "安徽", "Jiangxi": "江西", "Guangxi": "广西",
  "Shanxi": "山西", "Guizhou": "贵州", "Hainan": "海南", "Jilin": "吉林",
  "Heilongjiang": "黑龙江", "Gansu": "甘肃", "Xinjiang": "新疆",
  "Inner Mongolia": "内蒙古", "Ningxia": "宁夏", "Qinghai": "青海",
  "Tibet": "西藏", "Hong Kong": "香港", "Macau": "澳门", "Taiwan": "台湾",
};

// key 归一：去空白/撇号、忽略大小写、去 " City"/" Shi" 后缀
function normKey(v) {
  return String(v || "").trim().replace(/[’'`]/g, "").replace(/\s+(City|Shi)$/i, "");
}

// 主入口：country/region/city 英文 → 中文归属地
function resolveZhLocation(geo) {
  var city = String((geo && geo.city) || "").trim();
  var region = String((geo && geo.region) || "").trim();
  var cityZh = CITY_ZH_MAP[city] || CITY_ZH_MAP[normKey(city)] || "";
  var regionZh = REGION_ZH_MAP[region] || REGION_ZH_MAP[normKey(region)] || "";
  if (cityZh) return regionZh && regionZh !== cityZh ? regionZh + " " + cityZh : cityZh;
  if (regionZh) return city ? regionZh + " " + city : regionZh;
  return city || regionZh || "";
}

module.exports = { CITY_ZH_MAP: CITY_ZH_MAP, REGION_ZH_MAP: REGION_ZH_MAP, resolveZhLocation: resolveZhLocation };
```

> 归一化（改动点 4 的对策）与 `Neijiang` 这类补录（改动点 3 的对策）都在这里一次性解决。

### 4.2 `api/activate.js`

- 删除 L7-64（`CITY_ZH_MAP` / `REGION_ZH_MAP` / `resolveChineseCity` / `getGeoFields` 内联实现）。
- 顶部 `var geoZh = require("../lib/geo-zh");`
- `getGeoFields()` 改为调用 `geoZh.resolveZhLocation({ region, city })`。
- 推送 payload（L585-595）改为：

```js
country: geo.country, region: geo.region, city: geo.city,
location_zh: geo.location_zh,   // 新增，统一字段
city_zh: geo.location_zh,       // 兼容期保留旧字段名
```

### 4.3 `api/admin/health.js`（`page_visit`）

- 顶部新增 `var geoZh = require("../../lib/geo-zh");`
- `section=visit`（L623-632）`visitMsg` 增加：

```js
location_zh: geoZh.resolveZhLocation({
  region: visitHeaders["x-vercel-ip-country-region"],
  city: visitHeaders["x-vercel-ip-city"],
}),
```

> 注意：`health.js` 的 `pushToStream()` 是**独立实现**（L16-73，直连 Upstash REST），不走 `lib/notify.js`，
> 所以这里必须自己算中文，不能指望别的模块。

### 4.4 `api/go.js`（`purchase_click`）

- 顶部新增 `var geoZh = require("../lib/geo-zh");`
- `pushPurchaseClick()` L103-160：进 payload **前**算一次，`createMessageDelivery`（L115-131）与 `msg.payload`（L143-159）两处都要加：

```js
location_zh: geoZh.resolveZhLocation({ region: record.rg, city: record.ci }),
```

> 也可考虑在写入 `stats:recent` 时就把 `ci` 换成中文（影响面更大，第一版先不动，避免影响 admin 页面展示）。

### 4.5 `tools/ev-notifier/ev_notifier.py`

新增一个 helper（放在 `handle_message` 之前）：

```python
def _zh_loc(p):
    """归属地优先取中文：location_zh → city_zh → ''（不做英文拼接）。"""
    return (p.get("location_zh") or p.get("city_zh") or "").strip()
```

| 位置 | 行号 | 改法 |
|---|---|---|
| `page_visit` 弹窗 | L804-829 | `zh = _zh_loc(p)`；`IP: x.x.x.x (广东 广州)`；无中文时才回落到 `country/region/city` 英文拼接 |
| `purchase_click` 弹窗 | L852-881 | 同上 |
| `new_activation` 弹窗 | L776-788 | **补一行** `lines.append(f"归属地: {zh}")`（当前完全没有） |
| `activation_failure` 弹窗 | L830-851 | 同样补「归属地」行（payload 有 geo 时） |
| 激活语音 | L922-925 | `geo_str = _zh_loc(p) or region or country or ""`（即 `来自广东 广州`） |
| 激活失败语音 | L938-944 | `city = _zh_loc(p) or p.get("city","") or ""` |
| 购买点击语音 | L948-952 | 同上 |
| 页面访问语音 | L959-961 | `geo_str = _zh_loc(p) or city or region or ""` |
| 消息列表详情 | L1073-1082 | `city = _zh_loc(p) or p.get("city","")` |
| （可选）面板 Geo 按钮 | L3452-3457 | ip-api URL 加 `&lang=zh-CN`，面板点 Geo 也出中文 |

> 关键：**notifier 侧只认中文结果，不做地名映射**，否则又变成两边维护、两边不一致（就是这次失败的原因）。

---

## 5. 验证步骤

1. **单元验证**（服务端映射）：
   ```bash
   node -e "var g=require('./lib/geo-zh');['Beijing','Guangzhou','Zibo','Xian',\"Xi'an\",'Neijiang','Unknown City'].forEach(function(c){console.log(c,'->',g.resolveZhLocation({region:'Guangdong',city:c}))})"
   ```
   期望：`Guangzhou -> 广东 广州`、`Beijing -> 北京`、`Neijiang -> 广东 内江`。
2. **链路验证**（不经浏览器）：用 `curl` 打 `POST /api/admin/health?section=visit`（Vercel 部署后），
   再到 Upstash / admin「消息」面板确认 stream 里那条 `page_visit` 的 `payload.location_zh` 是中文。
3. **消费端验证**：`~/.ev_debug.log` 看是否收到该消息；Mac 弹窗标题/正文 + 语音是否为中文。
   （notifier 无落日志能力时，直接看面板消息详情 `_format_message_detail` 的渲染结果）
4. **回归**：
   - `new_activation` 弹窗新增的「归属地」行不遮挡其它行（通知 body 行数有限，注意别超长）。
   - `api/activate.js` 删表后激活流程正常（`city` 英文原值仍在 payload 里，admin/邮件不受影响）。
   - 老消息（无 `location_zh`）仍能正常渲染 → 必须保留 `city` 字段做回落。

---

## 6. 风险与注意事项

| 风险 | 应对 |
|---|---|
| Vercel 英文地名不固定（`Xi'an` / `Xian` / `Zibo City`） | `normKey()` 归一 + 白名单持续补录；必要时接 `ip-api?lang=zh-CN` 二级兜底 |
| 加了 `location_zh` 但消费端忘了读 → 又是英文（本方案的核心坑） | 消费端**只读中文字段**并统一走 `_zh_loc()`；上线后按 §5.3 验一条真实通知 |
| 兜底 API 慢/挂 → 拖慢通知 | 兜底必须 fire-and-forget（不 await）或超时 300-500ms，失败即回落原文 |
| 改动 `stats:recent` 里的 `ci` 会影响 admin 页面/统计 | 第一版**不改存量写入**，只在推送 payload 上加中文字段 |
| 邮件通知（`lib/notify.js`）正文里的 IP 展示 | 本次不在范围内；如需中文化，同样 `require lib/geo-zh` 复用 |
| `health.js` 自带 `pushToStream`，与 `lib/notify.js` 是两套 | 两个入口都要接 `geo-zh`，别只改一个 |

## 7. 待确认

1. 是否所有非中国大陆 IP 也强制中文化（如 `Singapore` → `新加坡`）？否则对海外 IP 保持英文更可读。
2. 输出格式统一为「省 市」，直辖市只出市名（`北京`），是否接受？
3. `location_zh` 兼容期保留 `city_zh` 多久（建议 1~2 个版本后移除）。

---

## 8. 实现状态（已按本方案落地）

| 文件 | 状态 |
|---|---|
| `lib/geo-zh.js` | ✅ 新增（含 `CITY_ZH_MAP` / `REGION_ZH_MAP` / `COUNTRY_ZH_MAP` / `resolveZhLocation`） |
| `api/activate.js` | ✅ 删除本地映射表，改用 `geo-zh`，payload 加 `location_zh`（保留 `city_zh`） |
| `api/admin/health.js` | ✅ `section=visit` 的 `visitMsg` 加 `location_zh` |
| `api/go.js` | ✅ `pushPurchaseClick()` 两处 payload 加 `location_zh` |
| `tools/ev-notifier/ev_notifier.py` | ✅ 新增 `_zh_loc()`；弹窗（page_visit / purchase_click / new_activation / activation_failure）、语音（4 处）、消息列表摘要、面板 Geo 按钮全部优先中文 |

**落地时做的取舍（对应 §7 待确认项）**：

1. 海外 IP **也中文化**：白名单命中用「城市中文名」（`Tokyo` → `东京`），否则用国家中文名（`US` + `California` → `美国`）。
2. 输出格式固定「省 市」，直辖市只出市名（`北京`），只有省时出省（`广东`）。
3. **国内裸国家码不显示**：`{CN, '', ''}` → `""`（避免通知里出现 `CN`）；海外未收录的国家码同样回空而不是回 `US` 之类。
4. 白名单未命中的中文城市（如小城）仍会回落英文，但**已带省的中文前缀**（`广东 SomeUnknownTown`）——继续按实际日志补 `CITY_ZH_MAP` 即可。

**待部署**：`api/*` 改动需 `git push` 到 `origin/main` 触达 Vercel 才生效；`ev_notifier.py` 为本地文件，改完需重启 Ev Notifier 进程。

---

## 附：本次相关文件

| 文件 | 作用 |
|---|---|
| `lib/geo-zh.js` | **新增**，中文地名唯一真源 |
| `api/activate.js` L7-64 / L585-595 | 删本地映射表，改用 `geo-zh`，payload 加 `location_zh` |
| `api/admin/health.js` L16-73 / L613-643 | `page_visit` payload 加 `location_zh` |
| `api/go.js` L103-160 | `purchase_click` payload 加 `location_zh` |
| `tools/ev-notifier/ev_notifier.py` | 弹窗 / 语音 / 列表 全部优先读中文 |
| `docs/evnotifier-activation-geo-voice-analysis.md` | 上一轮「只改了 activate.js」的方案（本文档的失败复盘来源） |
| `docs/evnotifier-ip-geo-notification.md` | 最初引入 geo 的文档 |
