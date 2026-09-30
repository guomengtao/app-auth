# 全链路追踪：App 同步器维度 + 订单激活链接跟踪 —— 代码分析与落地方案

> 日期：2026-09-30
> 需求来源（用户原话拆解）：
> 1. 在画像/追踪里**增加「app 同步器」维度** —— 用户与手环连接后，要能确认「这台手机上的 App」与「这只手环的激活用户」是同一个人；同时要能容纳**一个用户多只手环**的情况。
> 2. 从**发订单激活链接**起就带上渠道等跟踪信息，订单链接可带**用户独立识别码**（订单已收到，识别码可确定性地绑定订单）；**使用指南 / 激活页 / 下载页**的访问按「画像汇总」的口径做跟踪对接；**App 的访问也要配合**；App 内新增**导入成功次数 / 导出成功次数**等关键操作跟踪，并把这类动作发成 **EV Ops 消息通知**（如「某用户导出课程表成功」）；**App 下载量与升级**的每日统计加到后台 `admin_Dx23.html`。
>
> 本文是**分析 + 落地方案**，不含代码改动。所有「位置」都带文件与行号，可直接照着改。

---

## 0. 结论摘要（先看这 8 条）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **App ↔ 手环的合并钥匙已经存在，不用猜**：APK 已实现 `get_device_id` 指令，可从手环上的 EV 快应用索取**与激活同一个 `deviceId`** | `ev-schedule-android/apk/src/.../SyncEngine.java:342-344`；`FastActivateActivity.java:457` |
| 2 | 但这条钥匙**没有被上报**：埋点里 `deviceId` 字段被塞成了 `nodeId`（XMS 数字 ID），既丢了手环激活 ID，也会污染 `tracking_events.device_full` | `Analytics.java:73` vs `SyncEngine.java:186` |
| 3 | **多手环目前是数据黑洞**：`SyncEngine` 只保存**单个** `nodeId`，后连接的手环覆盖前一只，历史不留 | `SyncEngine.java:65 / 167 / 1061` |
| 4 | **订单激活链接的落地页 `deep-link-test.html` 完全没有埋点**（`visitor-track` 命中 0），所以「订单链接被点开」这一步今天根本采不到 | 全页扫描，见 §3.3 |
| 5 | 订单激活链接现在**只有 `code` 参数**，没有渠道、没有订单号；深链 `evsched://activate?code=` 也只转发 code | `lib/afdian-processor.js:216`；`deep-link-test.html:55`；`FastActivateActivity.java:162-185` |
| 6 | 服务端**已有**统一事件流（`tracking_events` 带 `channel / out_trade_no / device_full` 列）与 4 张画像视图，新需求是**加列 + 加 kind + 加两个 sub 接口**，不是重写 | `lib/tracking.js:22-40`；`api/admin/health.js:3494-3681` |
| 7 | **不能新建 api 文件**：Vercel 函数数硬上限 10，新端点只能挂进 `api/activate.js` / `api/go.js` / `api/admin/health.js` | `api/admin/health.js:3643` 注释 |
| 8 | 下载量目前**统计不到**：APK 是静态直链 `/ev/EVSyncProbe-vX.Y.Z.apk`；升级侧则已有 `update-found` / `update-installed` 两个上报点 | `ev/update-ev.json`；`UpdateChecker.java:85 / 255` |

> ⚠️ **全局前置铁律：向下兼容（老客户端不可升级，必须新旧双轨共存）**
> 老用户手机上**已经装着**旧版 APK、手环上**已经运行**旧版 rpk、用户私信里**已经收到**旧格式激活链接 —— 这三类都**无法强制更新，也无法改行为**。
> 因此：**所有新字段一律可选、只加不删；服务端字段落库必须先于客户端发版；任何"缺字段就报错"的实现都视为不可上线。** 详见 **§6.1**。

---

## 1. 涉及的项目与目录

| 项目 | 本地路径 | 角色 | 本次要不要改 |
|---|---|---|---|
| **app-auth**（后端 + 后台） | `/Users/Banner/Documents/guomengtao/app-auth` | 追踪/画像的服务端与后台页、爱发电订单链路、激活接口 | ✅ 主战场 |
| **ev-schedule-android**（安卓同步器 APK） | `/Users/Banner/Documents/guomengtao/ev-schedule-android` | 埋点上报、深链激活、导入导出、连接状态机 | ✅ 主战场 |
| **class/class**（EV 课程表快应用 · 手环端） | `/Users/Banner/Documents/guomengtao/tom/class/class` | 手环侧生成激活二维码/短链（渠道参数源头） | ⚠️ 只改 URL 拼接 |
| **ev-notifier**（EV Ops 桌面端） | `app-auth/tools/ev-notifier/ev_notifier.py` | Mac 弹窗 + 语音 + 面板；新事件类型的展示模板 | ✅ 加模板 |
| **EvOps 独立安卓端** | `/Users/Banner/WorkBuddy/EvNotiferAPP/ev-android` | 订阅 `auth:push_channel`，Mac 关机也能收 | ⚠️ 只确认类型白名单 |

> 后台页面入口：`https://app-auth.gudq.com/admin_Dx23.html?tab=direct-activate` → 子 tab `生成激活码 / 解密验证 / 👤 用户画像 / 📊 画像汇总`。
> 页面骨架：`admin_Dx23.html:4308-4313`（子 tab 按钮）、`:4486`（`daSubSummary` 容器）。

---

## 2. 现状盘点（改之前必须知道的事实）

### 2.1 现有追踪链路（已经跑通的）

```
快应用/手环生成 QR ──► activate.html?deviceId=…&c=<渠道>&r=<EV版本>
        │                      │
        │                      └─► /api/activate?section=visitor-track  → visitor_logs + tracking_events(kind=visit)
        │                          （channel 直接取 query 里的 c，api/activate.js:246-255）
        │
        └─► /go/<slug>?c=… ──► api/go.js 302 到爱发电 + stats:go:* + tracking_events(kind=go_click)

爱发电付款 ──► afdian:order:<no> ──生成──► auth:redeem:<CODE4> ──私信──► deep-link-test.html?code=CODE4
                                                                              │
                                                        evsched://activate?code=CODE4 ──► APK
                                                                              │
                                             /api/activate {deviceId, redeemCode, deviceInfo} ──► 18 位激活码
                                                                              │
                                                   auth:activation:<CODE18> + tracking_events(kind=activation)
```

### 2.2 现有身份锚点（哪些能join，哪些不能）

| 锚点 | 来源 | 强度 | 备注 |
|---|---|---|---|
| `device_id_full`（手环 deviceId 原文，如 `uuid-e45f…`/32hex） | `api/activate.js` 激活记录、`visitor_logs.params.deviceId` | **强** | 手环的「身份证」，激活与页面访问共用 |
| `device_id`（后 4 位） | `lib/validate.js normalizeDeviceId()` | ⚠️ 极弱 | 5000 用户碰撞率 ≈85%，只做候选筛 |
| `node_id`（XMS 数字 ID，如 `2137618976`） | APK `SyncEngine.getNodeId()` | 中 | 手机侧视角的手环标识，**与手环 deviceId 是两套编号** |
| `visitor_hash`（ip+ua 的 32bit hash） | `api/activate.js:185` | 弱 | 网页访客的临时身份 |
| `out_trade_no` / `redeem_code` | `afdian:order:*` / `auth:redeem:*` | **强** | 订单↔兑换码↔激活 三跳外键已齐 |
| **`app_install_id`（手机安装实例 ID）** | **目前不存在** | — | 本次要新建；APK 侧随机 UUID 即可，无需硬件权限 |

### 2.3 埋点覆盖现状（实测各页面 `visitor-track` 命中数）

| 页面 | 命中 | 缺口 |
|---|---|---|
| `apk-download.html`（下载页） | 2 | 已有（含下载点击 beacon，:220） |
| `index.html` / `activate.html` / `user-guide.html` / `course-guide.html` | 1 | 已有 |
| `ev-schedule.html` / `ev-timetable.html` / `redeem-counts.html` / `my-ip.html` | 1 | 已有 |
| **`activation-guide.html`（激活指南）** | **0** | ❌ 需补 |
| **`android-apk.html`（备用下载页）** | **0** | ❌ 需补 |
| **`deep-link-test.html`（订单激活链接落地页）** | **0** | ❌ **最关键缺口** |
| `pages.html` / `ev-login.html` / `login_aXs12.html` | 0 | 按需补 |

### 2.4 五大缺口（本文要解决的）

| # | 缺口 | 位置 | 影响 |
|---|---|---|---|
| G1 | App 埋点把 `nodeId` 当 `deviceId` 上报 | `Analytics.java:73` | 画像里出现「数字设备 ID」，且无法与手环合并 |
| G2 | `sanitizeDevice()` 白名单没有手环 deviceId、没有手机侧 ID | `api/activate.js:110-145` | 就算 APK 传了也会被丢掉 |
| G3 | `tracking_events` 没有 app 维度列 | `lib/tracking.js:22-40` | `portrait()` 只能按机型/渠道/地区聚合，没有 app 视图 |
| G4 | `user-journey` 锚点不认 `node_id` / 安装实例 ID，合并规则只有 5 类 | `lib/user-journey.js:52-63`、`:406-431` | 用户画像页搜不到「这台手机」 |
| G5 | 订单激活链接无渠道、无订单标识；落地页无埋点 | `afdian-processor.js:216`、`deep-link-test.html` | 「订单→激活」只能靠 redeem_code 反查，且「链接被点开」不可见 |

---

# 任务一：画像 / 全链路追踪里加入「App 同步器」维度

## 3.1 核心原理：两个 ID 一起上报，就能把「手机」和「手环」钉在一起

```
        ┌──────────────── 手机（APK） ────────────────┐
        │ install_id = apk-3f9c2a1b（自生成 UUID）      │
        │        │                                     │
        │        └── XMS 连接 ──► node_id = 2137618976 │
        │                          │                   │
        │                          └─ get_device_id ──┼──► watch.device_id = d4cd…c786
        └──────────────────────────────────────────────┘            │
                                                                    │  ✅ 与激活用的是同一串
   手环 EV 快应用激活 / 访问页面 ──► device_id_full = d4cd…c786 ◄────┘
```

**一句话**：APK 在「已连接」状态下同时持有 `install_id + node_id + watch.device_id`，只要把这三个一起上报，服务端就能把「手机维度的事件」与「手环维度的激活/访问」归并成同一个 canonical user —— **不需要 IP，不需要时间窗猜测**。

现有代码已具备取数能力，只差上报：

- 取手环 deviceId：`SyncEngine.java:342-344`（`{"action":"get_device_id"}` → 回包 `{ok, deviceId, deviceId4, fallback}`）
- 取 nodeId / 手环名 / EV 版本：`SyncEngine.java:186` / `:63` / `:62`
- APK 侧已有告警：**"索取手环设备ID（APK 侧拿不到）"** —— 注意这是**手机自身**拿不到，不是手环拿不到；手环的 deviceId 一直是有的。

## 3.2 多手环 / 多手机场景矩阵（必须显式支持）

| 场景 | 真实含义 | 当前数据表现 | 目标表现 |
|---|---|---|---|
| **1 手机 : 1 手环** | 绝大多数用户 | 有 nodeId，无手环 deviceId | 一条绑定边，画像页显示「手机 ↔ 手环」 |
| **1 手机 : N 手环**（换表/多表） | 用户买了两只手环 | ❌ **只留最后一只**（`SyncEngine.java:1061` 覆盖） | `watch.history[]` 留全部，画像页列出 N 只并各自标注「激活/未激活」 |
| **N 手机 : 1 手环**（换机、家人共用） | 同一只手环被多台手机连过 | 靠 `device_id_full` 天然合并，但看不到手机数 | 画像页显示「该手环被 N 台手机连接过」+ 各自 install_id |
| **模拟器/开发机**（`Emulator-Vela`） | 一台环境多人共用 | 会误合并 | 沿用现有降权规则（`lib/user-journey.js:761-764`），app 维度同样降权 |

> ⚠️ 场景 2 是**当前唯一的"永久丢数据"**：`SyncEngine` 是单 nodeId 覆盖写。这个不修，后面做多少统计都补不回来。

## 3.3 改造清单（任务一）

### A. APK 侧（`ev-schedule-android`）

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| A1 | `apk/src/.../Stats.java:23`（`PREF="ev_stats"`） | 新增 `install_id`：首次生成随机 UUID（形如 `apk-3f9c2a1b`）并持久化；新增 `fillApp()`（:111）里输出 `install_id` |
| A2 | `apk/src/.../Analytics.java:73` | **`body.put("deviceId", nodeId)` 改为**：`body.put("install_id", …)` + `body.put("watch_node_id", nodeId)`；**不再**把手环 nodeId 填进 `deviceId`（消除 G1 污染） |
| A3 | `apk/src/.../Analytics.java:171-184`（`watchInfo`） | 增加 `device_id` / `device_id4`（取自 `get_device_id` 回包）+ `watch.history[]` |
| A4 | `apk/src/.../SyncEngine.java:342-344` | 取到 deviceId 后**缓存到 Stats**（现在只在激活页临时用一次） |
| A5 | `apk/src/.../SyncEngine.java:65 / 167 / 1061` | 单 `nodeId` 改为「当前 + 历史列表」：`watch_history: [{node_id, device_id, model, ev_version, first_seen, last_seen, ok, fail}]`，连接成功/失败（`Stats.connectEnd()` :90）时更新对应项 |
| A6 | `apk/src/.../FastActivateActivity.java` | 激活成功后补一次 `Analytics.event("app_activate_ok", …)`（见任务二 §4.4） |

### B. 服务端（`app-auth`）

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| B1 | `api/activate.js:110-145` `sanitizeDevice()` | 白名单增加：`install_id`、`watch_device_id`、`watch_device_id4`、`watch_history[]`（逐项截断 + 数量上限，例如最多 10 只） |
| B2 | `lib/visitor-log.js:20-59` | `visitor_logs` 加两列：`install_id varchar(64)`、`watch_device_id varchar(128)`（高频聚合用；细节仍在 `device` jsonb 里，写法照抄现有 4 个 `alter table … add column if not exists`） |
| B3 | `lib/visitor-log.js:63-96 / 99-128` | `logVisit()` 落新列；`listRecent()` 带出（后台「最近访客」可显示「📱 app 用户 · 已连手环 X」） |
| B4 | `lib/tracking.js:22-40`（`CREATE_SQL`） | `tracking_events` 加三列：`install_id varchar(64)`、`watch_id varchar(128)`、`client varchar(16)`（`web`/`apk`/`evapp`），并在 `:46-57` 加索引 `idx_te_install`、`idx_te_watch`；`record()`（:89-120）与 `recordMany()`（:124-169）同步写入 |
| B5 | `lib/tracking.js:404-492`（`portrait()`） | 增加 app 维度聚合：按 `client / app_variant / app_version`、`watch.model × ev_version`、以及**绑定关系**（`install_id ↔ watch_id` 的 1:1 / 1:N / N:1 计数） |
| B6 | `lib/tracking.js`（新增函数） | `bindings(days)`：返回安装实例数、已连接手环数、连接成功率、卡点步号 Top、鸿蒙高危占比 |
| B7 | `lib/user-journey.js:52-63`（`detectAnchor`） | 锚点识别增加两类：`node_id`（纯数字且长度 ≥ 8）、`install_id`（`apk-` 前缀） |
| B8 | `lib/user-journey.js:406-431`（播种/合并）、`:666-706`（画像卡） | 合并 pass 增加：同 `install_id` 的 app 事件、同 `watch_id` 的手环事件互拉；输出 evidence「该手机（apk-3f9c2a1b）在 09-30 连接手环 2137618976，其 deviceId 与激活记录 d4cd…c786 相同 → 同一人」 |
| B9 | `lib/user-journey.js:229-378`（事件构造） | 新增事件构造器：`appEvent()`（app 打开/导入/导出/连接/升级）→ 时间线出现 📱 节点 |
| B10 | `lib/user-journey.js:722-785`（冲突/证据） | 新增 warning：同一 install_id 出现 >1 个 `watch_id` → 「该手机连接过 N 只手环，已按手环分列」；`nodeId` 缺失时提示「手机侧未上报安装实例 ID」 |
| B11 | `api/admin/health.js:3494-3681` | 新增 `sub=app-bindings`（做 B6 的出口），沿用现有 `sub=portrait`（:3634）写法 |
| B12 | `admin_Dx23.html:8688`（`renderUserJourney`） | 用户画像页新增「📱 App 同步器」卡：安装实例 ID / 变体 / 版本 / 装机时长 / 打开次数 / 前台时长 / 连接次数与成功率 / 卡点步号 / 手环清单（多只时逐行列出） |
| B13 | `admin_Dx23.html:8391`（`renderPortraitSummary`）、`:8246`（`loadPortraitSummary`） | 画像汇总页新增「App 维度」区块：变体×版本分布、鸿蒙高危占比、连接成功率、绑定关系 1:1/1:N/N:1、导入导出次数 |

### C. 数据修复（一次性）

历史行里 `tracking_events.device_full` 已有被 `nodeId` 污染的记录（`Analytics.java:73` 造成的）。建议在 `lib/tracking.js` 的 `enrichIdentityCore()`（:174-201）旁加一条一次性清洗：`client='apk' 且 device_full ~ '^[0-9]{8,}$'` 的行迁移到 `install_id/watch_id` 语义；后台展示时对纯数字 `device_full` 打「⚠ 疑似手环 nodeId」标记。

---

# 任务二：订单激活链接 + 页面 + App 事件 + 下载/升级统计

## 4.1 订单激活链接：带渠道 + 带用户独立识别码

**现状**（`lib/afdian-processor.js:216`）：

```
https://app-auth.gudq.com/deep-link-test.html?code=<CODE4>        ← 只有兑换码
```

**目标格式**：

```
https://app-auth.gudq.com/deep-link-test.html?code=A7K2&u=od-1f3k9q&o=<out_trade_no>&c=t-9p-d&g=activate
```

| 参数 | 含义 | 取值 |
|---|---|---|
| `u` | **用户独立识别码**（订单已收到 → 可确定性生成） | `od-` + `base36(out_trade_no)` 后 8 位；后台直开用 `da-<批次号>` |
| `o` | 订单号原文 | 仅内部/后台排查用，页面上可不显示 |
| `c` | 渠道 | 见下方优先级 |
| `g` | 页面分组 | `activate`（配合画像汇总的页面分组统计） |

**订单渠道取值优先级**（订单记录 `afdian:order:<no>` 新增 `channel` 字段）：

1. 备注里解析出的 `deviceId`（`extractDeviceIdFromRemark()`，`lib/afdian-processor.js:156`）→ 反查该设备最近一次 `/go/` 或 `activate.html` 访问的 `params.c`；
2. 同 IP 在 `paid_at` 前 24h 内的 `go_click` 渠道（`api/go.js` 已记录，`tracking_events.channel` 可查）；
3. 兜底 `afdian-dm`（私信来源）；
4. 其他入口固定值：后台直开 `admin-direct`、App 内购买 `apk-fast`（`FastActivateActivity.java:256` 已在用 `?c=apk-fast`）。

**链路打通后的收益**：激活事件可直接带 `out_trade_no`（`tracking_events` 已有该列）→ 「支付 → 激活」从「靠 redeem_code 反查」升级为**外键级确定关系**，`funnel()`（`lib/tracking.js:301-401`）的最后一跳样本立刻变准。

**改动点**：

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| C1 | `lib/afdian-processor.js:216`（DM #1） | 链接拼接加 `&u=&o=&c=&g=`；`orderRecord`（:183-198）新增 `channel`、`uid` 字段 |
| C2 | `lib/afdian-processor.js:264`（DM #3） | 使用指南链接加 `?u=<uid>&c=<channel>&g=guide` |
| C3 | **`deep-link-test.html`**（整页 73 行） | ① 加 `visitor-track` 埋点（**当前为 0**，这是「链接被点开」唯一的采集点）；② `:55` 深链改为 `scheme://activate?code=…&u=…&c=…`；③ 可选展示「溯源码」 |
| C4 | `FastActivateActivity.java:162-185` `handleDeepLink()` | 解析 `u/c/o` 并保存（现在只取 `code`） |
| C5 | `FastActivateActivity.java:526-532`（activate body） | 增加 `uid` / `orderNo` / `channel`（或在 `deviceInfo.source` 里带 `afdian:<c>`，**两者都建议**：`source` 供现有展示，`uid` 供归因） |
| C6 | `api/activate.js`（激活记录写入，:690-806 复用分支 / :881-915 普通分支） | 激活记录顶层加 `order_uid` / `channel`；`tracking.record({kind:"activation", outTradeNo: uid, channel: c})` |
| C7 | `admin_Dx23.html:9878`（`doDirectActivate`）、`:10038`（`daCopyAllCodes`） | 后台直开结果卡增加「🔗 复制激活链接（带溯源码）」按钮，生成 `deep-link-test.html?code=…&u=da-<批次>&c=admin-direct` |
| C8 | `api/activate.js` 直开分支 | 直开记录写入 `channel=admin-direct` 与批次 `uid` |

## 4.2 使用指南 / 激活页 / 下载页：按「画像汇总」口径统一对接

**问题**：现在是「每个页面各自复制一段 XHR」，所以出现 `activation-guide.html`、`android-apk.html`、`deep-link-test.html` 三个页面漏埋（§2.3）。

**做法**：抽一个公共脚本，避免继续复制粘贴。

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| D1 | **新增** `app-auth/js/track.js`（`js/` 目录已有 `review-widget.js` 先例） | 约 15 行：`var` + `XMLHttpRequest`（遵守老 WebView 兼容约定，**不用** fetch/箭头函数），`POST /api/activate?section=visitor-track`，自动带上 `path + location.search + data-*` |
| D2 | `activation-guide.html` / `android-apk.html` / `deep-link-test.html` / `pages.html` | 各加一行 `<script src="/js/track.js" data-page="…" data-group="guide\|download\|activate">` |
| D3 | 已有埋点的页面（`user-guide` / `course-guide` / `apk-download` / `ev-schedule` / `ev-timetable` / `redeem-counts` / `my-ip` / `index` / `activate`） | 替换为统一脚本（保留原有 `query` 参数，不动行为） |
| D4 | `api/activate.js:73`（`pageTitleForPath`） | 补齐新页面的中文名（通知/后台展示用） |
| D5 | `api/activate.js:246-255` | `tracking.record(kind="visit")` 的 `payload` 增加 `group`（来自 `g=` 参数），画像汇总即可按「指南/激活/下载」分组出报表 |

> **✅ D1–D5 已全部实施并上线**（commit `92354c8`，2026-09-30）。实施过程中的 3 处调整与实情记录见 **§7.5**：
> ① `group` 取值改为「`body.group` 优先 → 退回 URL `g=`」；② 分组白名单限定 5 类；
> ③ `apk-download.html` 原有埋点因用了 `fetch` 而**一直静默失效**，本次顺带修好。

**统一 URL 参数约定**（贯穿网页 + APK + 快应用）：

| 参数 | 含义 | 例 |
|---|---|---|
| `c` | 渠道（沿用现有渠道码规范） | `t-9p-d` |
| `u` | 用户/订单识别码 | `od-1f3k9q` |
| `d` | 手环 deviceId | `d4cd0dab…c786` |
| `g` | 页面分组 | `guide` / `activate` / `download` |
| `from` | 客户端来源 | `web` / `apk` / `evapp` |

> 快应用侧（手环）源头在 `tom/class/class/src/pages/activation/activation.ux:277-278`（`ACTIVATION_URL` / `AFDIAN_REDIRECT_URL`）与 `:515`（`APK_DL_URL`），现有的 `docs/渠道识别与升级转化统计方案-参数对接分析.md` 已经定义过 `c` 的拼法，本次只是把 `u/g/from` 也统一进去。

## 4.3 App 访问配合

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| E1 | `Analytics.java:45-80` | `pageView()` 的 `body.query` 增加 `install_id / watch_id / uid`（若从链接进入）；`path` 规范见下表 |
| E2 | `FastActivateActivity.java`（onCreate） | 补 `Analytics.pageView(this, "/apk/activate")` —— **当前激活页没有 pageView**，是 App 侧最大盲区 |
| E3 | `HomeActivity.java:1245`、`MessageActivity.java:136`、`SettingsActivity.java:231`、`TransferActivity.java:132`、`BandActivity.java:192`、`ToolboxActivity.java:154`、`ScheduleListActivity.java:69`、`ThemePickerActivity.java:87`、`UpdateChecker.java:85/255` | 已有，无需改；仅在统一脚本口径后核对 `query` 字段 |

页面路径规范（已有 + 建议补充）：

```
/apk/home  /apk/message  /apk/settings  /apk/transfer/import  /apk/transfer/export
/apk/band  /apk/toolbox  /apk/schedules  /apk/theme
/apk/activate            ← 新增
/apk/update-found  /apk/update-installed   （已存在）
```

## 4.4 App 关键操作跟踪 + EV Ops 消息通知

### 事件清单（新增 kind，写入 `tracking_events`）

| kind | 触发点（APK） | payload 关键字段 |
|---|---|---|
| `app_open` | `EvApp.onCreate` → `Stats.onProcessStart()` :39 | app_version/code/variant、upgrade_count、open_count |
| `app_connect_ok` / `app_connect_fail` | `HomeActivity` 连接状态机 → `Stats.connectEnd()` :90 | stage(1-4)、reason、connect_last_ms |
| **`app_import_ok` / `app_import_fail`** | **`TransferActivity.doImport()` :991（成功 :1000 / 失败 :1018）** | courseCount、format、source |
| **`app_export_ok` / `app_export_fail`** | **`TransferActivity` 保存 :693/703、复制 :578/:624-629** | courseCount、target（file/clip） |
| `app_activate_ok` | `FastActivateActivity.onBackend()` :560-597 | activation_code、uid、channel |
| `app_update_found` / `app_update_installed` | `UpdateChecker.java:85 / 255` | from_code、to_code |

### 服务端接入

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| F1 | `api/activate.js`（新增 `section=client-event` 分支，挂在 `:425` 的 section 路由旁） | 校验 kind 白名单 → `tracking.record({kind, deviceId: watch_id, installId, channel:"apk", payload, dedupeKey})`；**不新建文件**（Vercel 10 函数上限，`health.js:3643`） |
| F2 | `api/activate.js:261-272`（`VISIT_PUSH_MAX` 节流范式） | 新增 `APP_EVENT_PUSH_MAX`（建议：成功类每 kind 每分钟 ≤ 5 条；`connect_fail` 每 IP 每小时 ≤ 1 条），超限只落库不推送 |
| F3 | `lib/notify.js:981`（`pushNotification(type, payload)`） | 新消息类型 `app_event`（`message_delivery.message_type` 是自由字符串，`lib/message-delivery.js:33` 无需迁移） |
| F4 | `tools/ev-notifier/ev_notifier.py` | 加 `app_event` 模板，**四处都要加**：弹窗分发（`:2326/2360/2375/2420` 同一处 `if/elif`）、语音（`:2497-2560`）、面板/摘要（`:2687-2730`）、激活记录页（`:5200`） |
| F5 | EvOps 安卓端（`EvNotiferAPP/ev-android`） | 只确认消息类型白名单是否放行 `app_event`（订阅同一 `auth:push_channel`，一般无需改） |

**通知文案示例**（Mac 弹窗 / 语音 / 手机）：

```
📥 导出成功 · 小米手环 10 Pro
用户 apk-3f9c2a1b 导出了 23 门课（格式 sgschedule） · 深圳 · 0.5.98
语音：「安卓用户从深圳导出了课程表，23 门课」
```

## 4.5 App 下载量与升级：每日统计

### 下载量

现在 APK 是静态直链（`ev/update-ev.json` 的 `downloadUrlMirror/Origin` 都是 `/ev/EVSyncProbe-v0.5.98.apk`），**静态文件统计不到**。

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 新增重定向：`vercel.json`（`:2-11`）加 `{ "source": "/dl/:file", "destination": "/api/go?dl=:file" }`；在 `api/go.js`（已有 `stats:go:*` 计数范式 `:325-326`）加分支：文件名白名单校验 → `stats:dl:<date>:<version>` incr + `tracking.record({kind:"download", channel, payload:{file, version, from}})` → 302 到 `/ev/<file>`。再把 `update-ev.json` 的两个 URL 与 `apk-download.html:166` 的 `FALLBACK_ORIGIN` 换成 `/dl/…` | 零 APK 改动，`UpdateChecker` 自动走新链路 |
| B（辅助） | 下载页点击埋点（`apk-download.html:220` 已有 `query: 'dl=…'`） | 作为交叉校验，不作主口径 |

### 升级量

已有两个上报点：`UpdateChecker.java:85`（`/apk/update-found?from=<旧版本码>`）、`:255`（`/apk/update-installed?to=<新版本码>&c=inapp`）。补三件事：

1. **确认环**：升级后首次启动上报 `app_open` 时带 `upgrade_count`（`Stats.fillApp()` :111 已实现），服务端用「`versionCode` 变化 + `upgrade_count` 递增」确认升级真正落地；
2. **存量分布**：`visitor_logs.app_version` / `tracking_events.payload->>'app_version'` 直接 group by，得到「今天各版本各有多少活跃安装」；
3. **日聚合表**（新增）：

```sql
create table if not exists app_daily_stats (
  day date not null, variant varchar(16) not null default '', version varchar(24) not null default '',
  downloads int default 0, installs int default 0, upgrades int default 0, dau int default 0,
  connect_ok int default 0, connect_fail int default 0, import_ok int default 0, export_ok int default 0,
  primary key (day, variant, version)
);
```

由 `vercel.json` 的 `crons`（`:16-29`，已有 3 条）加一条 `0 6 * * *` → `api/admin/health?section=stats&sub=app-daily-rollup&cron=1` 汇总写入。

> ⚠️ **升级链路本身的向下兼容（老客户端不可改，务必守）**（配合 §6.1）：
> 1. **旧版 APK 包不能下架。** 老客户端的 `UpdateChecker` 只认服务端 `update-ev.json` 里给的地址，但用户的更新请求可能被缓存/重试/或来自旧清单 —— `/ev/EVSyncProbe-v*.apk` 的**静态直链必须保持可访问**，`/dl/` 重定向只是**新增**入口，不是替换掉老地址。
> 2. **`update-ev.json` 字段名与结构冻结，只加不删。** 老 APK 按字段名解析，删/改名会让老客户端"发现不了更新"或解析异常 → 直接断掉老用户的升级通道。
> 3. **老客户端不会上报新事件。** `app_update_found / app_update_installed`（`UpdateChecker.java:85 / 255`）只在**已升级到新版**的客户端里才有；所以升级漏斗对老用户**必然缺样本**，后台要把它标注为「仅新版可见」，别当成转化率暴跌。
> 4. **升级提示不要做成强制。** 老版本仍要能正常收通知、能正常激活；"不升级就不让用"会同时触发 §6.1-K2/K3 的回退风险。

### 后台入口

| # | 文件 · 位置 | 改什么 |
|---|---|---|
| G1 | `api/admin/health.js:3494-3681` | 新增 `sub=app-stats`（App 维度总览：装机/日活/版本分布/升级/导入导出次数）与 `sub=download-daily`（下载与升级按天曲线） |
| G2 | `admin_Dx23.html:3387-3399`（侧栏） | 新增 tab「App 统计」（或在「访客统计」下加子 tab，参照 `:3394`） |
| G3 | `admin_Dx23.html` | 新面板：日下载量（按版本/渠道）、版本存量分布、升级漏斗（发现→下载→安装→确认）、导入/导出成功次数日曲线 |

---

## 5. 全部改动点速查（按文件）

### app-auth（后端/后台）

| 文件 | 位置 | 改 |
|---|---|---|
| `lib/tracking.js` | `:22-40` 建表、`:46-57` 索引、`:89-169` 写入、`:404-492` portrait | 加 `install_id/watch_id/client` 三列 + 索引；新增 `bindings()` |
| `lib/user-journey.js` | `:52-63` 锚点、`:229-378` 事件、`:406-431` 合并、`:666-706` 画像卡、`:722-785` 冲突 | 新增锚点/事件/绑定与多手环 warning |
| `lib/visitor-log.js` | `:20-59` 建表、`:63-128` | 加 `install_id/watch_device_id` 两列 |
| `api/activate.js` | `:110-145`、`:147-306`、`:425`、`:690-915` | 白名单加字段；新增 `section=client-event`；激活记录带 `uid/channel` |
| `api/admin/health.js` | `:3494-3681` | 新增 `sub=app-stats / app-bindings / download-daily / app-daily-rollup` |
| `api/go.js` | `:266-330` | 新增 `/dl/:file` 下载重定向 + 计数 |
| `vercel.json` | `:2-11`、`:16-29` | 加 `/dl/:file` rewrite；加日聚合 cron |
| `lib/afdian-processor.js` | `:153-198`、`:216`、`:264` | 订单 `channel/uid`；私信链接带参数 |
| `deep-link-test.html` | 全页（`:44-71` 脚本、`:55` 深链） | 补埋点 + 深链带 `u/c` |
| `js/track.js` | 新增 | 统一网页埋点脚本 |
| `activation-guide.html` / `android-apk.html` / `pages.html` | 页尾 | 补埋点 |
| `admin_Dx23.html` | `:3387-3399`、`:4308-4313`、`:4486`、`:8207`、`:8246`、`:8391`、`:8688`、`:9878`、`:10038` | 画像页 App 卡、画像汇总 App 区块、直开带溯源码、App 统计 tab |
| `ev/update-ev.json` | `downloadUrl*` | 改走 `/dl/` |

### ev-schedule-android（APK）

| 文件 | 位置 | 改 |
|---|---|---|
| `Analytics.java` | `:45-80`、`:171-184` | 上报 `install_id / watch.device_id / watch.history`；不再用 nodeId 冒充 deviceId；新增 `event()` |
| `Stats.java` | `:23`、`:111`、`:123` | `install_id`；导入/导出成功计数、连接历史 |
| `SyncEngine.java` | `:65 / 167 / 186 / 342-344 / 1061` | deviceId 缓存到 Stats；nodeId 单值 → 历史列表 |
| `FastActivateActivity.java` | `:162-185`、`:526-532`、`:560-597` | 解析 `u/c/o`；激活请求带上；成功事件；补 pageView |
| `TransferActivity.java` | `:132`、`:578`、`:624-629`、`:667-703`、`:991-1018` | 导入/导出成功与失败事件 |
| `AndroidManifest.xml` | `:106-117` | 深链 scheme 已就绪（`evsched://activate`），无需改；若要带 `u` 参数也只是 query 变长 |
| `apk/build.sh` | — | 若采用「打包注入渠道」路线，在此写 `ev.channel` meta-data |

### class/class（手环快应用）

| 文件 | 位置 | 改 |
|---|---|---|
| `src/pages/activation/activation.ux` | `:277-278`、`:515` | 激活 URL / 爱发电短链 / APK 下载 URL 补 `u/g/from` |

---

## 6. 风险与约束（动手前必须认这几条）

1. **Vercel 函数数硬上限 10** → 所有新端点必须挂进现有三个文件，禁止新建 `api/*.js`（`api/admin/health.js:3643` 有原话）。
2. **Redis 是 Postgres 代理**（`kv_*` 表），全扫极贵 → 新增统计一律走 `tracking_events` 的索引列（`device_full/install_id/watch_id/ts`），别去扫 `auth:activation_codes`。
3. **`deviceId` 语义冲突**：修掉 `Analytics.java:73` 之前，任何按 `device_full` 的合并都可能把「手机 nodeId」和「手环 deviceId」混为一谈 —— 这是本次**第一个必须修**的点。
4. **4 位 deviceId 碰撞率极高**（5000 用户 ≈85%）→ 绑定判定一律用 `watch_device_id`（完整串），4 位只做候选筛。
5. **多手环会永久丢数据**：`SyncEngine` 单 nodeId 覆盖写，必须在做统计之前先把历史列表补上（A5）。
6. **通知必须节流 + 只报成功**：埋点是高频动作（每次开 App、每次导出），不节流会把 Mac 和手机通知刷爆；失败类只做采样。
7. **老 WebView 兼容**：埋点脚本只能用 `var` + `XMLHttpRequest`（本仓既有约定，见 `docs/全链路追踪` §8.2 的实现说明）。
8. **隐私边界**（沿用 `apk-tracking-telemetry-spec.md` §8）：`install_id` 用随机 UUID（非 IMEI/序列号）；只收设备/版本/连接状态/课程数量，**不收课程内容**；所有字段入库前截断。
9. **向下兼容是硬约束（新增，见 §6.1）**：老版 APK / 手环旧 rpk / 已发出的旧激活链接**都改不了、也强升不了** → 新字段一律**可选**、接口**只加不删**、**服务端先于客户端上线**。任何"收不到新字段就报错 / 拒绝请求"的实现都不许上线。

### 6.1 升级期的向下兼容（老客户端已经在跑，无法更改）

> **前提事实**：本改造**不是"发个新版大家一起升"**。老用户手机上装的是旧 APK（`Analytics.java:73` 那个版本），除非他自己升级否则**永远**会以旧格式上报；手环上的旧 rpk、用户私信里的旧激活链接同理。所以新老客户端会在很长一段时间里**同时存在**，服务端必须同时伺候两套。

**A. 各老对象会继续发什么 → 服务端必须怎么接**

| # | 老对象（无法升级） | 它会继续发什么 | 服务端必须怎么做 | 不做会怎样 |
|---|---|---|---|---|
| K1 | **旧版 APK**（无 `install_id`） | `deviceId = nodeId`（纯数字 8–10 位），没有 `install_id / watch_node_id / watch.history` | `sanitizeDevice()`（`api/activate.js:110-145`）**继续接受**纯数字 `deviceId`，把它**归一到 `watch_node_id`** 语义并标 `client=legacy-apk`；缺 `install_id` 就留空 | 老用户上报被 400 拒 → **老用户直接不能用**（最严重回退） |
| K2 | **旧版 APK 的激活请求** | 只有 `deviceId / redeemCode / deviceInfo`，没有 `uid / orderNo / channel` | 激活分支里新字段**全部 optional**；缺省走原逻辑；**响应体只加不改**（老 APK 按字段名解析，改名/删字段会崩） | 激活失败，或老 APK 解析响应异常 |
| K3 | **已发出的旧激活链接**（用户私信里） | `deep-link-test.html?code=CODE4`，无 `u/c/o/g` | 页面**无参数也必须正常跑**（`u/c/o/g` 全 optional）；深链 `evsched://activate?code=` 保持原样可用 | 用户点旧链接白屏 / 无法激活 |
| K4 | **浏览器缓存的旧版网页** | 旧 `visitor-track` 代码，或根本没有埋点 | `js/track.js` 只用 `var` + `XMLHttpRequest`；`/api/activate?section=visitor-track` 的**入参与响应结构冻结**，新参数只加不删 | 老页面埋点静默失效 |
| K5 | **手环上的旧快应用 rpk** | 激活 URL 不带 `u/c/g` | 渠道缺失时走兜底（`afdian-dm` / `unknown`），画像里**单列「未带渠道」桶**；**不能因为没渠道就不落库** | 老快应用用户被整体丢弃 |
| K6 | **新版客户端**（灰度中） | 新字段齐全 | 按新逻辑处理（`client=apk`） | — |

**B. 三条硬规则**

1. **服务端先上，客户端后上。** 字段落库（B1/B2/B4）与兼容分支**必须先于** APK 发版上线：老 APK 的请求在新服务端上要**照常成功**，新 APK 的新字段要能被接收。顺序颠倒会有一段时间"服务端等字段、客户端还没发"→ 数据断档。
2. **只加不删（Additive-only）。** 加列一律 `add column if not exists` + 可空 + 默认值；**现有列语义不变**（`device_full` 保留原文，新语义走新列，不就地改含义）；老接口**响应字段名与层级冻结**，新增只能追加。
3. **污染清洗必须是长期规则，不是一次性。** 老 APK 会**持续**上报 `deviceId=nodeId`（直到用户自然升级/换机），所以 §3.3-C 那条清洗**不能只跑一次** —— 要在**写入时**（`lib/tracking.js` `record()` / `enrichIdentityCore()`）常态化判定：`client=apk 且 device_full ~ '^[0-9]{8,}$'` → 归一到 `watch_node_id` 并标 `legacy-apk`。**一次性脚本只用于回填历史行**。

**C. 对统计口径的影响（必须先说清，否则会被当成 bug）**

- **覆盖率不是 100%。** `install_id` / App 事件 / 导入导出计数**只覆盖升级后的新客户端**。后台每个 App 维度指标都要同时显示「已知安装实例数」与「覆盖率」，**不能把"没数据"当成"没行为"**。
- **绑定边会长期稀疏。** 老 APK 用户只有手环侧（`device_full`）有数据、手机侧为空 → 画像里显示「📱 未见安装实例（旧版客户端）」，而不是"这个用户没有手机"。
- **升级是渐进的，曲线会"两轨并行"。** P5 的日聚合要能区分 `new`（带 `install_id`）与 `legacy`（不带）两轨，否则发版当天会出现"断崖式下跌"的假象。
- **不要用"是否有 install_id"反推用户是否活跃。** 老客户端永久不带该字段，二者无因果。

---

## 7. 分期实施建议

| 期 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **P0** | 修 `Analytics.java:73` 语义 + A1/A2/A3 + B1/B2/B4（字段落库） | 手环 deviceId 与 install_id 进库，绑定边可查 | — |
| **P1** | 订单激活链接带 `u/c`（C1-C8）+ `deep-link-test.html` 埋点（C3） | 「订单→激活」变外键关系；「链接被点开」可采 | P0 |
| **P2** | 统一 `js/track.js` + 三个漏埋页面补齐（D1-D5） | 指南/激活/下载页访问全进画像汇总 | — |
| **P3** | App 事件（`client-event`）+ 导入导出计数 + EV Ops 通知（F1-F5、A6、E2） | 「某用户导出成功」实时推送 | P0 |
| **P4** | 多手环历史列表（A5）+ 画像页 App 卡（B12/B13） | 多手环用户不再丢数据 | P0 |
| **P5** | 下载重定向 + 日聚合 + App 统计 tab（G1-G3） | 每日下载量与升级统计上后台 | P3 |

> **上线顺序铁律（配合 §6.1）**：**服务端必须先行**。P0 先只发服务端那半（B1/B2/B4 + 兼容分支），确认"老 APK 请求照常成功、新字段能被接收"之后再发新 APK；P1/P2 同理（先上服务端兜底与页面，再让客户端带新参数）。**任何一期都不得要求"客户端先发"**。

### 7.1 P0 实施记录（2026-09-30，服务端与 APK **均已上线**）

**服务端（6 个文件）**

| 文件 | 改动 |
|---|---|
| `lib/validate.js` | 新增 `isWatchNodeId()`（纯数字 8–16 位 = XMS nodeId）+ 导出；供全链路共用同一判定口径 |
| `lib/tracking.js` | `tracking_events` 加 `install_id / watch_id / client` 三列 + `idx_te_install` / `idx_te_watch`；新增 **`resolveIdentity()`** 做写入时常态化归一；`record()` / `recordMany()` 同步写入 |
| `lib/visitor-log.js` | `visitor_logs` 加 `install_id / watch_device_id` 两列 + 两个索引；`logVisit()` 写入、`listRecent()` 带出 |
| `api/activate.js` | `sanitizeDevice()` 扩字段（`install_id` / `watch_device_id` / `watch_device_id4` / `watch_history[]`，历史最多 10 只并逐项截断）；新增 `sanitizeWatchHistory()`、`activationClient()`；`handleVisitorTrack` 把新字段接进 `visitor_logs` 与 `tracking_events`；3 处激活事件补 `client` |
| `api/go.js` | `purchase_click` 补 `client:"web"` |
| `lib/afdian-processor.js` | `order` / `redeem` 补 `client:"server"`（服务端回调无客户端身份） |

**APK（3 个文件）**

| 文件 | 改动 |
|---|---|
| `Stats.java` | A1：`installId()` 首次生成 `apk-xxxxxxxx` 并持久化；A4：`cacheWatchDeviceId()` / `watchDeviceId()`；`fillApp()` 输出 `install_id`、`fillWatch()` 输出 `device_id` |
| `SyncEngine.java` | A4：包装 `getDeviceId()`，取到真实 deviceId 后缓存（幂等，不改调用方语义；`cb` 传 null 自动补空实现） |
| `Analytics.java` | A2：**`deviceId` 不再填 nodeId**，改发手环真实 deviceId + `install_id`；A3：`watch.device_id` 就位 |

**验证**

- 服务端：`node --check` 6 文件全绿；兼容性自测 **77 项全部通过**（用源码切片直接跑真实函数），其中含**老 APK 报文 27 个老字段逐一回归**，确认"只加不删"。
- APK：`aapt2` + JDK8 `javac` 全量编译，**299 个 class，0 错误**（未打包、未 bump 版本号）。

**与原文案的 2 处偏差（有意为之）**

1. **`device_id4` 由服务端派生，客户端不发。** 原 A3 写"增加 device_id / device_id4"，实际只发 `device_id`，`device_id4` 在 `sanitizeDevice()` 里用 `normalizeDeviceId()` 算出 —— 避免同一派生值有两个数据源。
2. **没有在连接成功时自动刷新 deviceId。** `send()` 只有**单个 pending 槽位**，连上后紧跟的 pull 链路也在用槽位，硬插一次 `get_device_id` 有顶掉用户操作回包的风险。实际覆盖靠 A4 的 `getDeviceId()` 包装：用户装完必然要走激活流程（激活页会调它），所以绝大多数活跃用户都能拿到。**多手环历史清单（A5/P4）落地时再补一个"空闲时刷新"的调度**。

**发布前必做**

1. 先 `git push` 服务端（Vercel Git 集成自动部署）→ 观察老 APK 请求仍返回 `{success:true}`；
2. 再 `bash apk/build.sh` 出包 → 验证新字段真的进了 `visitor_logs.install_id` / `tracking_events.watch_id`；
3. 最后才更新 `ev/update-ev.json` 放量（在那之前老用户不会看到新版）。

---

### 7.2 上线记录（2026-09-30）

**① 服务端已上线** —— commit `112f38d` → `origin/main`，Vercel 自动部署；`/version.json` 由 1.7.97 变为 **1.7.98** 确认生效。

线上冒烟（真实请求打到生产）：

| 用例 | 请求 | 结果 |
|---|---|---|
| 老 APK 报文（`deviceId` = 纯数字 nodeId，无 `install_id`） | `POST /api/activate?section=visitor-track` | `{"success":true,"isNewVisitor":true}` / HTTP 200 |
| 新 APK 报文（`install_id` + `watch.device_id` + `watch.history[]`） | 同上 | `{"success":true,"isNewVisitor":true}` / HTTP 200 |

**② 落库核对（直连生产库 Supabase，`Ev_POSTGRES_URL`）**

- 结构：`tracking_events` 的 `install_id / watch_id / client` 三列与 `idx_te_install / idx_te_watch` 两索引均已自动建出；`visitor_logs` 的 `install_id / watch_device_id` 两列就位（`CREATE/ALTER ... IF NOT EXISTS` 在首次写时自动执行）。
- 老 APK 行为（**兼容核心，逐条核对**）：

  | 断言 | 实测 |
  |---|---|
  | `device_full` 保留原文 | ✅ `2137618976`（未被改成别的东西） |
  | `client` 标记 | ✅ `legacy-apk` |
  | nodeId 归一到 `watch_id` | ✅ `2137618976` |
  | 老客户端无 `install_id` | ✅ 空串 |
  | `visitor_logs.watch_device_id` | ✅ 空串（老 APK 不发） |

- 新 APK 行为：`client=apk`、`install_id=apk-7f3a9c21`、`watch_id` = 手环**真实** deviceId、`device_norm=7890`（末 4 位派生正确）、`visitor_logs.watch_device_id` 同步落库、`watch_history` 两只手环完整透传。
- 冒烟数据已清理（`path like '/p0-smoke-%'`，visitor_logs 4 条 + tracking_events 4 条，复查残留 0）。

**③ APK 已出包并放量** —— `bash apk/build.sh` 产出 `dist/EVSyncProbe-v0.5.101.apk`（versionCode 102，421KB，已签名）；`version.env` 已自动 bump 到 0.5.102。

放量 commit `e63c05b`：新增 `ev/EVSyncProbe-v0.5.101.apk`（sha256 `16abb54f…`，与构建产物逐字节一致）+ `update-ev.json` 指向新包（`isForce: false`）。**旧包 `EVSyncProbe-v0.5.98.apk` 保留可访问**（守住 §4.5 的"只新增不替换"）。

线上核验（部署后）：

| 检查 | 结果 |
|---|---|
| `ev/update-ev.json` | ✅ versionCode 102 / versionName 0.5.101 / 结构未变 |
| 新包直链 `/ev/EVSyncProbe-v0.5.101.apk` | ✅ HTTP 200，421072 B，sha256 一致，与构建产物 `cmp` 逐字节相同 |
| 旧包直链 `/ev/EVSyncProbe-v0.5.98.apk` | ✅ HTTP 200，sha256 仍为 `f972272a…`（老客户端更新通道未断） |

**④ 后续**：P1 已完成（见 §7.3），**尚未发布**。

---

### 7.3 P1 实施记录（2026-09-30，服务端 **已上线**）

**目标**：订单激活链接带上「渠道 + 用户独立识别码」，让「支付 → 激活」从"靠 redeem_code 反查"升级为外键级确定关系；并把 `deep-link-test.html` 这个**此前埋点命中为 0** 的页面补上采集。

**服务端 / 网页（5 个文件）**

| 文件 | 改动 |
|---|---|
| `lib/tracking.js` | 新增 `latestChannelForDevice(deviceFull)` / `latestChannelForIp(ip, beforeTs, windowMs)` 两条渠道反查查询（均失败返回 `""`，不抛） |
| `lib/afdian-processor.js` | 新增 `orderUid()`、`resolveOrderChannel()`；`redeemData` / `orderRecord` 增 `uid` / `channel` / `channel_basis`；DM#1 激活链接 → `?code=&u=&o=&c=&g=activate`；DM#3 指导链接 → `?ev&u=&c=&g=guide`；`order` / `redeem` 两条 tracking 事件补上真实渠道（原为 `""`） |
| `api/activate.js` | 解析请求里的 `uid` / `orderNo` / `channel`（**全白名单清洗 + 限长**）；派生 `actOrderNo / actUid / actChannel`；三条激活记录（复用 / NA / 普通）都写入 `order_no / order_uid / channel`；三条 `kind:"activation"` 事件的 `outTradeNo` 改用 `actOrderNo`、`channel` 改用 `actChannel`（退回 `deviceInfo.source`），payload 带 `uid` |
| `api/admin/redeem-codes.js` | 直开批次生成 `da-<批次>`；`redeemData` / `recordData` / 返回结果都带 `uid` + `channel:"admin-direct"` |
| `deep-link-test.html` | ① **补上 `visitor-track` 埋点**（这是「链接被点开」唯一的采集点）；② 解析 `u/c/o` 并**清洗后**拼进深链 `evsched://activate?code=&u=&c=&o=`；③ 有 `u/c` 时显示「溯源：…」一行 |

**APK（1 个文件）**

| 文件 | 改动 |
|---|---|
| `FastActivateActivity.java` | `handleDeepLink()` 解析 `u/c/o`，经 `sanitizeTrace()` 清洗后存 SharedPreferences（`K_TRACE_*`）；`activate()` 在**非空时**才往 body 加 `uid/channel/orderNo`；成功后 `clearTrace()` 防串号 |

**验证**

- `node --check` 4 个服务端文件全绿；两个 HTML 的内联脚本语法检查全绿。
- **P1 自测 30 项全部通过**（`/tmp/p1-selftest.js`，用 `require.cache` 注入桩，直接跑**真实的 `processOrder()`** 并断言真发出去的私信内容）：`orderUid` 确定性/格式/唯一性、渠道优先级四档、异常降级、无备注订单走兜底、老链接兼容。样例产出：
  - `deep-link-test.html?code=A7K2&u=od-5o6aqt1&o=2026093012345678901&c=t-9p-d&g=activate`
  - `user-guide.html?ev&u=od-5o6aqt1&c=t-9p-d&g=guide`
- **P0 回归 77 项仍全绿**（确认 P1 没碰坏 P0 的解析）。
- APK `javac` 全量编译 **299 class / 0 错误**。

**与原文案的有意偏差**

1. **渠道优先级第 2 档「同 IP 24h」实际用不上** —— 爱发电订单回调里**没有**客户端 IP。代码已写成"有 `order.client_ip` 才查"，属防御式保留；实际主力是第 1 档（备注 deviceId 反查），兜底第 3 档。
2. **不改 `deviceInfo.source`** —— 文档 C5 建议顺带写成 `afdian:<c>`。实测 `activationClient()`（`api/activate.js:112`）就是读 `source` 判客户端类型，混入渠道会让客户端分类失真，所以渠道归因独立走 `channel` 字段，两者不共用。

**发布顺序**：服务端已先行上线（见 §7.4）。APK 侧（`FastActivateActivity` 解析 `u/c/o`）需要**新包**才生效 —— 但要说明：**APK 不发这三个参数也不影响任何功能**，服务端会退回读「兑换码记录里存的 uid/channel」（由发码时写入），所以「支付 → 激活」的关系**在只有服务端改动的情况下就已经成立**；出新 APK 只是让"用户点的是哪条链接"这种更细的信息也被带上。按 §4.5 增量放量即可，无时间压力。

---

### 7.4 P1 上线记录（2026-09-30）

**① 服务端已上线** —— commit `4469956` → `origin/main`，Vercel 自动部署。

**部署确认方式（重要）**：本次 P1 **没有改 `version.json`**，所以「看 version.json 是否变号」这个用在 P0 的探针**这次无效**（轮询 10 分钟一直是 1.7.98）。改用两条行为探针：

1. **静态页逐字比对**：`curl https://app-auth.gudq.com/deep-link-test.html` 与本地文件 `diff` → **完全一致**（5707 字节），说明新构建已生效。
2. **函数确实在跑新代码**：冒烟用**超长非法兑换码**打 `/api/activate`，拿到的是 `lib/validate.js` 的 400 文案。而 P1 的 `bodyUid/bodyOrderNo/bodyChannel` 解析在 `api/activate.js:512`，**早于**码校验（`api/activate.js:593`）→ 这两次请求已经执行过新代码且未抛错，证明线上 `api/activate.js` 就是新版本（Vercel 一次部署内函数与静态文件同为原子发布）。

**② 线上冒烟结果**

| 用例 | 期望 | 实测 |
|---|---|---|
| 新链路 `visitor-track`，path=`/p1-smoke?code=…&u=od-test001&o=20260930001&c=t-9p-d&g=activate` | 200 且 `success:true` | ✅ `{"success":true,"isNewVisitor":true}` |
| 老链接形状 `visitor-track`，只有 `code` | 200 且 `success:true` | ✅ `{"success":true,...}` |
| 老 APK 报文（无 `uid/orderNo/channel`）打激活 | 结构化响应、不崩 | ✅ 400 + 中文校验文案（码格式非法，属正常拒绝） |
| 新报文（带 `uid/orderNo/channel`）打激活 | 同上、不因新字段报错 | ✅ 同上 |
| 直连 Supabase 查 `visitor_logs.params` | `u/c/o/g` 四件套落库 | ✅ `{"c":"t-9p-d","g":"activate","o":"20260930001","u":"od-test001","code":"SMOKECODE"}`；老链接行只有 `{"code":"OLDLINKONLY"}` |

**③ 没有做「造一张真码跑完整激活」的端到端测试，原因是有副作用**：激活成功路径会 `pushNotification("new_activation")`（真推送到 Mac / 手机）+ 发邮件 + 在生产 Redis 留一条假激活记录。P1 的激活侧改动只是"多读三个可选字段"，且上面第 2 条已证明新代码在线上执行；因此判断**不值得为它制造假订单与假通知**。等真实订单自然发生时验证即可（`order_no/order_uid/channel` 会直接出现在激活记录里）。

**④ 冒烟数据已清理干净**

- 业务表：`visitor_logs` / `tracking_events` 中 `/p1-smoke*` 各行已删（残留 0）。
- 当日统计（**修正了一个认知错误**）：线上 KV **不在 Upstash**，而是在 Supabase 的 `kv_*` 表（`DB_PROVIDER=supabase`，走 `lib/redis.js` 的 Postgres proxy）。清理时先误操作了 Upstash（造出一个孤立的 `stats:pv:2026-09-30`），已 `DEL` 复原；真正的统计在 `kv_strings` / `kv_zsets` / `kv_sets` / `kv_lists` 里：
  - `kv_zsets` 去掉 `/p1-smoke`、`/p1-smoke-old`（2 行）
  - `kv_strings` `stats:pv:2026-09-30` 131 → **129**
  - `kv_lists` `stats:recent` 去掉 2 条含 `/p1-smoke` 的
  - `kv_sets` `stats:uv:2026-09-30` 去掉 1 个访客哈希（两条冒烟同 IP 同 UA，故只占 1 个 UV）
  - 复核残留：页面统计 0、recent 0

**⑤ 回归**：P1 自测 **30 项全绿**、P0 兼容回归 **77 项全绿**、APK `javac` **299 class / 0 错误**（本次未动 APK）。

**⑥ 环境坑（记一笔）**：`.env.local` 里 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 的值是 `[SENSITIVE]` 占位符，直接 `Object.assign(.env, .env.local)` 会**用占位符覆盖 `.env` 的真实值** → 读到 11 字符的假 URL，报 `Failed to parse URL from [SENSITIVE]`。本地脚本加载 env 时必须**跳过空值与 `[SENSITIVE]` 占位符**。

---

### 7.5 P2 实施记录（2026-09-30，**已上线**）

**目标（D1–D5）**：把「每个页面各自复制一段 XHR」收敛成全站唯一的埋点入口，补上三个**完全没有埋点**的页面，并让访问记录带上「页面分组」，画像汇总可以按「指南 / 激活 / 下载 / 站内 / 工具」出报表。

**D1 新增 `js/track.js`（全站唯一埋点入口）**

| 要点 | 说明 |
|---|---|
| 接入方式 | `<script src="/js/track.js" data-group="guide"></script>`，一行 |
| 兼容约定 | 只用 `var` + `XMLHttpRequest`；**不用** `fetch` / 箭头函数 / `const` / 模板字符串 —— 老 WebView 遇到不支持的语法会**整段**脚本报错（不是这一句失效，是整块失效） |
| 配置来源 | 从**自己的 script 标签**读 `data-group` / `data-page` / `data-ref`；`document.currentScript` 在老 WebView 常为 `null`，实现里按 `src` 回退查找 |
| 容错 | 上报包在 `try/catch` 里，失败静默 —— 埋点绝不能影响页面功能 |
| 复用出口 | `window.WBTrack.send({path, query, group, ref})`，供点击级埋点（下载页的 `dl=`）复用 |

**D2 补齐三个漏埋页面 + 1 个改统一**

`activation-guide.html`（guide）、`android-apk.html`（download）、`pages.html`（home）；
`deep-link-test.html` 把 P1 加的内联 XHR 换成统一脚本（activate），**旧的必须同时删掉，否则同一页会发两次**。

**D3 已有页面切换统一脚本（9 个）**

`activate` / `user-guide` / `course-guide` / `apk-download` / `ev-schedule` / `ev-timetable` / `redeem-counts` / `my-ip` / `index`。

> **顺带发现并修掉一个实质故障**：`apk-download.html` 原先的访问埋点用的是 `fetch` —— 老 WebView（Chromium < 42）**根本没有 `fetch`**，这段等于**一直静默失败**。切到 XHR 后这条埋点才真正开始上报。（该页的版本拉取/测速仍在用 `fetch`，属页面自身逻辑，本次未动，见下方"遗留"。）

**D4 页面中文名**：`pageTitleForPath()` 补齐 13 个页面的中文名（此前 Mac 通知里显示的是裸路径 `/activation-guide.html` 这种）。只影响显示文案，缺名字仍退回原 path，不影响埋点与任何判断分支。

**D5 visit 事件带上 `group`**

- 取值优先级：`body.group`（track.js 的 `data-group`）→ URL 的 `g=`（P1 起的私信深链带 `g=activate`）→ 空串。
- `normalizeGroup()` 白名单限定 `guide / activate / download / home / tool`，未登记值/注入串/超长值一律记空（宁缺勿脏）。
- 落点选择依据：**画像汇总（`lib/user-score.js`）查的正是 `tracking_events.payload`**，所以写 `payload.group` 就能直接出分组报表，不必再动 `visitor_logs`。

**页面分组口径（本次定稿）**

| group | 页面 |
|---|---|
| `guide` | user-guide / course-guide / activation-guide |
| `activate` | activate.html / deep-link-test.html |
| `download` | apk-download.html / android-apk.html |
| `home` | index.html / ev-schedule.html / ev-timetable.html / pages.html |
| `tool` | my-ip.html / redeem-counts.html |

> `admin_Dx23.html` **有意保留**自己的手写埋点：它带 `keepalive: true`（请求要活过页面卸载），且语义是"后台被谁打开"的审计，不该和普通访客混到一个分组里。

**顺带修掉一个原有 bug（`index.html`）**

调查 `index.html` 时发现：本该是 `</script>` 的位置被写成了 `<script>`（只差一个斜杠）。它一直没报错，是因为**单独一行的 `<script>` 在 JS 里恰好是合法的比较表达式**（`undefined < undefined > undefined`），所以只是静默地多开了一层脚本块。本次一并修正为正确的闭合标签。

> 这个 bug 是被自测**抓出来的**：那套自测会把每个页面里每一段内联 `<script>` 抽出来单独 `node --check`。改 P2 之前它是"恰好合法"，改完就变成了真报错 —— 说明这类"看起来能跑"的标记错位只有靠逐块语法检查才拦得住。

**验证**

| 项 | 结果 |
|---|---|
| P2 自测 | **102 项全绿**（`/tmp/p2-selftest.js`） |
| ↳ `js/track.js` | 在 `vm` 里**真跑**：模拟 `document`/`location`/`XMLHttpRequest`，断言自动上报 1 次、path 带 search、group 取 `data-group`、`currentScript=null` 时按 src 回退、`WBTrack.send` 覆盖 path/query、无 `data-group` 时是空串；并剥注释后确认**代码区无任何 ES6 语法** |
| ↳ 服务端 | 从 `api/activate.js` **切真实源码**跑 `normalizeGroup` / `pageTitleForPath`：白名单、大写归一、超长脏值丢弃、`null`/数字/注入串→空、13 个页面中文名 |
| ↳ HTML | 13 个页面各**恰好 1 个**统一标签、**无手写 `visitor-track` 残留（防双发）**、`track.js` 标签位于"无未闭合脚本块"处 |
| ↳ 全局 | **17 个 HTML 的每一段内联脚本逐块 `node --check`** 全绿（正是它抓到 index.html） |
| P1 回归 | 全绿（其中 1 条断言按新口径更新：deep-link-test 的埋点由"页面内有 visitor-track 字符串"改为"已挂统一脚本且无残留"） |
| P0 回归 | **77 项全绿** |
| 服务端语法 | `api/activate.js` / `lib/tracking.js` / `lib/visitor-log.js` / `lib/afdian-processor.js` 全绿 |

**上线记录**

- commit `92354c8` → `origin/main`，Vercel 自动部署。
- 部署确认：`/js/track.js` 由 **404 → 200**，且线上内容与本地 **sha256 逐字节一致**（`829a2089bff1…`）—— 这是 P2 最直接的可用性证据（脚本没上线等于全站埋点全停）。
- 线上冒烟 **15 项全绿**：
  - 页面：`activation-guide` / `android-apk` / `pages` 三页确认已挂统一脚本且 group 正确；`apk-download` / `deep-link-test` 确认已无手写埋点、无双发。
  - 落库：4 条路径逐一核对 `tracking_events.payload.group` —— `body.group` 优先 → `guide`；退回 URL `g=` → `tool`；注入串 `HACK<script>x` → 空串；`body.group` 压过 URL `g=` → `download`。
- 冒烟数据已清理（`tracking_events` 4 + `visitor_logs` 4 + `kv_zsets` 4 + `kv_lists` 4 + `kv_sets` 1 + `stats:pv` 减 4），复核残留全 0。**KV 在 Supabase 的 `kv_*` 表**（`DB_PROVIDER=supabase`），不是 Upstash —— 清理别走错地方。

**遗留（未做，记在案）**

1. `apk-download.html` 的**版本拉取 / 多线路测速**仍在用 `fetch`。如果这页真的会在老 WebView 里打开，这两个功能同样是失效的；但那是页面自身业务逻辑，改动面比埋点大，建议单独确认「这页的实际打开环境」后再决定要不要一起改。
2. 分组目前只在 `tracking_events.payload.group`。若后台有哪个报表是读 `visitor_logs` 出分组的，需要在那边读取时走同样的 `payload`/`params` 口径（后台页面属 P4 范围）。

---

## 8. 需要你确认的 5 个问题

| # | 问题 | 我的默认建议 |
|---|---|---|
| 1 | 手机侧识别码用什么？ | 随机 UUID（`apk-xxxx`）+ 持久化，不用任何硬件标识 |
| 2 | 订单渠道取值优先级认可吗？ | 备注 deviceId 反查 > 同 IP 24h 短链 > `afdian-dm` 兜底 |
| 3 | 后台直开要不要一键复制「带溯源码的激活链接」？ | 要（`daCopyAllCodes` 旁加一个按钮） |
| 4 | 导入/导出成功通知：每条实时，还是每小时合并一条？ | 成功实时（有节流），失败整点合并 |
| 5 | 下载统计走 `/dl/` 重定向（需改 3 处 URL）能否接受？ | 接受，零 APK 代码改动 |

---

## 9. 参考文档

- `docs/用户全链路追踪与画像汇总-方案.md`（锚点/合并规则/冲突矩阵的权威定义，五期实现状态）
- `docs/channel-integration-plan.md`、`docs/channel-tracking-analysis.md`（渠道码规范与全链路渠道采集）
- `docs/跳转下载链接-方案设计.md`（`/go/:slug` 短链的现有实现与限制）
- `../ev-schedule-android/docs/apk-tracking-telemetry-spec.md`（APK 埋点字段总表、鸿蒙判定、下载渠道三条路线）
- `../ev-schedule-android/docs/analytics-tracking-plan.md`（**未实现的 `section=client-event` 设计**，本次 P3 直接照它落地）
- `../tom/class/class/docs/渠道识别与升级转化统计方案-参数对接分析.md`（手环侧 URL 参数对接）
