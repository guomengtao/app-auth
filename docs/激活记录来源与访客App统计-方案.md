# 激活记录「激活来源」列 + 访客/App 统计升级方案

> 2026-10-01 · 需求来源：后台 `admin_Dx23.html?tab=records` / `?tab=visitors`
> 结论先行：**绝大部分数据服务端已经有了，本轮主要是「把已有数据摆出来」+ 少量埋点补齐**，不需要大改。

## ✅ 实施记录（2026-10-01 全部上线）

| 阶段 | commit | 内容 |
|---|---|---|
| P1 | `9c1cf98` | 激活来源列：activate.js 三条记录路径写 `act_source`；后台徽章列+筛选，老记录前台兜底推导 |
| P2 | `6b4ccec` | 访客 App/网页区分：比方案更省——永久表 `visitor_logs.device` jsonb（APK 埋点非空/网页恒 null）直接 SQL `filter` 拆分，**历史数据也生效**；dailyStats/dayOverview 加 pv_app/uv_app；走势图加橙色 App UV 线；UV/PV 卡片拆分行；最近访客 📱/🌐 徽章。无需新 Redis 键 |
| P3 | `81907be` | App 统计页新增：装机量（install_id 首见日口径，近30天每日新装机+累计，老 APK 不计入有标注）；连接手环失败分析（近14天 stage×reason 归因 TOP + 最近20条明细 + 导入/导出成败计数） |
| P4 | 未做 | APK `codeSource` 精确标注深链/手输（下一版 APK 顺车；当前用 trace 参数推导已够用） |

---

## 1. 先回答小疑问：访客统计里的 🔊 语音按钮控制什么？

- 位置：`admin_Dx23.html` 访客统计面板顶部（`voiceToggleBtn` / `toggleVoice()`）。
- 作用：**纯管理后台本地的 TTS 播报**。开启后，只要「最近访客」列表里出现一个没见过的新 IP，浏览器就用 `speechSynthesis` 朗读一条「新访客来自 xxx」，方便你写代码时后台挂着、耳朵听新访客。开关状态存 localStorage（`voiceEnabled`），下次打开记住。
- 影响范围：**只影响这个后台网页自己**，不碰 App、不碰手环、不碰服务端，零副作用。
- 用途评价：盯后台有用；不用就关掉（点了变灰色即关闭）。想删也可以，删掉只影响这一处 UI。

---

## 2. 激活记录：增加「激活来源」列（同步器 vs 手输）

### 2.1 现状盘点（数据已存在大半）

激活时客户端会上报 `deviceInfo.source`，服务端 `api/activate.js` 的 `activationClient()` 已分两类：

| client 值 | 含义 | 数据位置 |
|---|---|---|
| `apk` | **同步器 APK 代激活**（FastActivateActivity，`source:"apk"` 写死） | `tracking_events.client`；主记录 `auth:activation:<码>` 的 `device_info.source` 也可推导 |
| `evapp` | 手环端自发 / 网页激活页 | 同上（老客户端不带 source 也落这里） |

同步器内部又分两种来源（用户要求的细分）：

| 细分 | 现有判据 |
|---|---|
| 同步器**深链自动填码**（爱发电私信链接拉起，只点激活） | 深链带 trace 参数 `uid/channel/orderNo`，服务端已存进记录的 `order_no / order_uid / channel`（P1 §4.1 加的字段），**三者为空 → 手输，有值 → 深链** |
| 同步器**手工输入 4 位兑换码** | 同上反向判断 |

⚠️ 边界：老版深链可能不带 trace 参数，会被误判成手输（概率低，可接受）。

### 2.2 实现方案（两级精度）

**A. 纯后台可立即做（零客户端改动，历史记录也能显示）：**
- `api/activate.js` 激活成功写主记录时追加一个顶层字段（**只加不改**，遵守 §6.1 向下兼容铁律）：
  ```js
  act_source: "apk-deeplink" | "apk-manual" | "band" | "web"
  // 推导逻辑：activationClient()==="apk" ? (channel||uid||order_no 有值 ? "apk-deeplink" : "apk-manual") : "evapp"
  ```
- `admin_Dx23.html` `renderRecordsTable()`（约 :6079）在「渠道」列后加一列「激活来源」，徽章样式四选一：
  `同步器·深链`（蓝）/ `同步器·手输`（青）/ `手环端`（紫）/ `网页`（灰）。历史记录无此字段时，从 `device_info.source` 推导显示，推不出来的显示 `—`。
- 筛选条加一个「来源」下拉（全部/同步器/手输/手环/网页），`loadRecords()` 带上过滤参数。

**B. APK 配合的精确版（可选，下一版 App 再做）：**
- `FastActivateActivity` 其实明确知道码是「intent 深链带进来的」还是「用户键盘敲的」，在 `deviceInfo()` 里加 `d.put("codeSource", "deeplink"|"manual")`。
- 服务端 `activationClient()` 旁边加 `activationCodeSource(deviceInfo)`，有值直接用、无值回退 A 方案的推断。
- 好处：不受「深链没带 trace 参数」影响，100% 准确。

---

## 3. 访客统计：区分 App 访问 vs 网页访问 + 走势图

### 3.1 现状

- `handleVisitorTrack()`（api/activate.js :432）已经在埋点报文里带完整设备上下文（`device/app/watch` 三段），**服务端当场就能判断是 App 还是网页**：`dev.app_version || dev.app_variant || dev.watch_node_id` 非空 → App（:551 的 client 判断就是现成逻辑）。
- 但 UV/PV/pages/recent 四个统计键都没分渠道；`stats:recent` 条目里也只有 UA（能间接猜，不可靠）。
- **走势图的最大障碍**：`VISITOR_TTL = 7 天`（:44），日键 `stats:uv:<date>` / `stats:pv:<date>` 只活 7 天，想画 30 天走势必须持久化汇总。

### 3.2 实现方案

**（1）分渠道计数（改动很小）：**
- track 时判定 `vclient = "app" | "web"`，新增四个日键：
  `stats:uv:app:<date>` / `stats:pv:app:<date>` / `stats:uv:web:<date>` / `stats:pv:web:<date>`（ Sadd/incr + 同 TTL）。
- `stats:recent` 条目加一个字符字段 `k: "a"|"w"`，最近访客列表加「📱App / 🌐网页」小徽章。

**（2）每日汇总持久化（走势图的数据地基）：**
- 事件驱动 lazy rollup（本项目惯用手法，不依赖 cron）：每次 track 顺手把当天累计写进持久 Hash `stats:daily:<yyyymmdd>`（字段 `uv/pv/uv_app/pv_app/uv_web/pv_web`），用 `hset` 覆盖写，Hash 不设 TTL。
- 当天实时值优先读日键，历史值读 Hash，拼接成 14/30 天序列。
- 迁移：上线时把现存 ≤7 天的日键读出来补写进 Hash，历史趋势从上线日起积累（之前的数据本来就被 TTL 清了，无解，如实标注）。

**（3）后台 UI：**
- 访客统计面板顶部加一块「UV/PV 走势（近 14 天）」：纯 SVG 折线/柱状迷你图（双系列：总量 + App 量），无外部图表库（与后台现有风格一致）。
- UV / PV 大卡片下加一行「App x · 网页 y」拆分数字。
- 热门页面 zset 可顺手拆 app/web 两个 zset（`stats:pages:app:<date>`），或先不做、保持一个（建议先不做，避免键数翻倍）。

---

## 4. App 统计：装机量 / 访问量 / 连接手环失败分析

### 4.1 现状：独立 tab 已存在

侧边栏已有 **「App 统计」tab**（`panel-appstats`，子能力：下载 /dl/ 计数 · 版本分布 · 客户端事件 · 升级漏斗）。事件体系里**连接手环相关的上报早就有了**：

| 事件 / 字段 | 说明 |
|---|---|
| `app_connect_ok` / `app_connect_fail`（payload: `stage`,`reason`） | 连接成功/失败事件，失败还有 digest 合并推送 |
| `app_import_ok/fail`、`app_export_ok/fail` | 导入/导出课表成败 |
| `watch_connect_total / ok / fail / last_ms` | APK-Stats 累计计数 |
| `watch_last_fail_step / watch_last_fail_reason` | 最后一次失败卡在哪一步、什么原因（**「目前最大隐患」的定位关键**） |
| `install_id`（新 APK 必有）/ `first_install` / `app_open_count` | 装机实例与打开统计 |
| `watch_history[]`（最多 10 只，每只 `ok/fail` 计数） | 多手环场景逐只成败 |

→ **不需要 App 再加任何配合，缺的只是服务端聚合成报表 + 后台展示。**

### 4.2 装机量口径（回答「可能需要 app 同步器里配合吗」）

- **新 APK**（v1.7.x 带 install_id）：不需要配合。服务端在 track/client-event 时：
  - `zadd stats:installs <first_seen_ts> <install_id>`（累计装机，zcard 即总数，天然去重）；
  - `sadd stats:installs:<yyyymmdd> <install_id>`（当日新装机 = 装机量走势，scard 出每日数）。
- **老 APK**（无 install_id）：用 `deviceId` 首见兜底计数（数字 nodeId 即 legacy），口径分开标「legacy 估算」，避免和新口径混在一起失真。
- 访问量：§3.2 的 `pv_app` 日序列直接就是 App 端日访问量。

### 4.3 连接手环失败分析（本轮重点，建议做成 appstats 子页签）

在「App 统计」tab 内加子页签 `连接手环`（沿用现有子页签样式），内容：

1. **成功率大盘**：`app_connect_ok / (ok+fail)`，按天序列（汇总进 `stats:daily:` Hash 一起做）。
2. **失败归因 TOP**：按 `stage`（卡在哪一步）× `reason` 聚合的二维计数表——这正是排查「最大隐患」的主视图；再按 `app_version`、`device model` 两个维度各出一列，看是否集中在某个版本/某机型（华为/荣耀 EMUI 系重点观察）。
3. **失败明细流**：现有失败合并桶 `auth:appfail:pending` 已存最近 50 条明细（kind/stage/reason/model/version），直接读出来做最近失败列表。
4. **导入/导出成功次数**：`app_import_ok` / `app_export_ok` 按天计数 + 总计（事件里都有，聚合同上）。

服务端聚合落点：`api/activate.js` 的 client-event 处理处顺手 `hincrby stats:daily:<date> connect_ok|connect_fail|import_ok|…`，读侧一次 `hgetall` 拉全天序列，Upstash 请求数增量极小（每事件 1 条命令，且可并入现有 pipeline）。

### 4.4 是否要独立主 tab

不建议新开主 tab——「App 统计」就是干这个的，加子页签（装机走势 / 连接手环 / 客户端事件）即可，侧边栏已经 11 项了。若你坚持独立主 tab，只需复制 panel-appstats 的骨架，成本低。

---

## 5. 实施顺序与工作量

| 阶段 | 内容 | 改动面 | 备注 |
|---|---|---|---|
| P1 | 激活来源列（服务端推导 + 后台渲染 + 筛选） | activate.js 小改 + admin 一处 | 纯后台，历史记录可显示 |
| P2 | 访客分渠道计数 + recent 徽章 + 每日 Hash 汇总 + 走势图 | activate.js + admin visitors | 趋势从上线日起积累 |
| P3 | 装机量 zset/sadd + appstats 装机子页 + 连接失败分析子页 + 导入导出计数 | activate.js + admin appstats | 不需要 APK 配合 |
| P4（可选） | APK `codeSource` 精确标注深链/手输 | ev-schedule-android FastActivateActivity + 服务端回退逻辑 | 下一版 App 顺车 |

预算口径：P1-P3 均为「小改动 × 多触点」，建议按阶段分 2-3 个会话执行，每会话控制在 10 积分预算内。

---

## 6. 关键文件索引

- `api/activate.js`：activationClient()(:342) · handleVisitorTrack()(:432) · 事件表(:60) · 失败合并桶(:74) · sanitizeDevice()(:385, install_id/watch 统计)
- `admin_Dx23.html`：records 面板(:3583) · renderRecordsTable()(:6077) · visitors 面板(:3785, 语音按钮 :3790) · appstats 面板(:3827) · 语音逻辑(:10507)
- `ev-schedule-android/apk/.../FastActivateActivity.java`：deviceInfo()(:589, source="apk") · 深链 trace 参数(:567-576)
- 前置方案：`docs/全链路追踪-App同步器维度与订单链接跟踪-分析方案.md`（P0-P5，本方案是其展示层延伸）
