# 爱发电订单 · 订单私信模板 Tab 方案

> 状态：**已过审 · 已实施**（2026-11-05 12:22 +0800 用户「同意」）
> 单号：`evtask-D-evapp-auth-261105-ta38xn`（认领 `20261105-122506-89887`，repo=ev/app-auth）
> 配套原型：对话内内联交互原型（开工登记门禁拦下第 2 个未认领文件，按 §3.11a「留痕说明理由」改为内联展示，未落盘）

---

## 一、目标与边界

**目标**：在后台「爱发电订单」栏目新增子 Tab「💬 私信模板」，把目前硬编码在 `lib/afdian-dm.js` 的 3 条「购买后自动发订单私信」文案，改成后台可逐条编辑、实时预览、保存后即时生效的模板配置。**每条消息一个独立 textarea**，互不影响。

**「预览」的定义**：编辑时由服务端按「与真实发送完全相同」的渲染函数，用一组示例订单变量替换占位符，在每条 textarea 下方实时展示买家最终收到的消息全文；变量说明与示例值在页头列出。

**明确不解决（边界）**：

1. 不改私信**条数**（固定 3 条）、发送顺序、1.2s 间隔、断点续发，以及 `afdian:dm_sent:<单号>` 按条数去重/续发的语义 —— 这是可靠性链路，动它会重发或漏发。
2. 不追加第 4 条、不做单条启用/停用、不做定时发布、AB 测试、多语言。
3. 不改已入 `afdian:dm_pending` 队列的 job —— `job.messages` 是入队时的快照，**保存模板只影响之后产生的新订单**，历史/待发任务保持原样。
4. 不动 webhook、订单同步、cron 链路；**不新增 Serverless Function**（Vercel Hobby 12 个上限），复用 `api/afdian.js` 分派器。
5. 不追回、不重写任何已发出的历史私信。

---

## 二、现状侦察结论（基于实读文件，非臆测）

| 位置 | 事实 |
| --- | --- |
| `lib/afdian-dm.js:34-53` | `buildOrderMessages(o)` 同步函数，3 条文案以字符串拼接硬编码；变量有 `product_name` / `code` / `activate_url` / `guide_url`。注释标明 #1 在 2026-11-04 刚调整过主推手工兑换码 —— 正是「需要及时调整」的痛点来源。 |
| `lib/afdian-dm.js:55-72` | `buildOrderJob(o)` 同步，内部调 `buildOrderMessages(job)`，把 `messages` 数组写进 job 快照并供 `enqueue`。 |
| `lib/afdian-dm.js:140-144` | `attemptNow` 从 `job.sent_count` 起按索引发送；队列里已有 `messages` 时才不重建，**保证改动不波及待发队列**。 |
| `lib/afdian-dm.js:269-316` | 已有 `kind=dm-retry` 的 HTTP 入口范式：cron 用 `CRON_SECRET`，后台用 `auth.requireAuth`。可直接照抄鉴权结构。 |
| `lib/afdian-processor.js:335` | 唯一调用点：`dmJob = afdianDm.buildOrderJob({...})`（同步，无 await）。 |
| `api/afdian.js:1-22` | 聚合分派器：`kind=webhook/query/dm-retry`；无 kind 时 POST 走 webhook —— **新入口必须显式带 kind**，否则会被吞进 webhook。 |
| `admin/admin_Dx23.html:4820-4832` | `#panel-afdian-orders` 已有两个子 Tab：`📋 订单列表` / `🔗 购买点击日志`，用 `.visitor-sub-tab` 样式 + `switchAfdianSubTab(sub)` 两态切换。 |
| `admin/admin_Dx23.html:11809-11838` | `switchAfdianSubTab` 硬编码两态（orders/purchase），同时切换标题、副标题、同步按钮显隐、刷新按钮 onclick。 |
| `admin/admin_Dx23.html:5683` | `switchTab('afdian-orders')` 会强制回到 `orders` 子 Tab —— 现状行为，本次**保持不变**（不引入「记住上次子 Tab」的新状态）。 |
| `admin/admin_Dx23.html:5581` | 全局 `api(path, opts)` 封装：401 跳登录、403 提示、非 2xx 抛错。 |
| `api/admin/catalog.js:24-40,125-131` + `lib/bandbbs.js:657-665` | 项目已有「奖励私信模板」的 Redis 读写范式（`redis.get/set` 单个文本 key，默认常量兜底），但**它是单条纯文本、无占位符、无预览**；本次按同样存储风格扩展为 3 条结构化模板。 |
| `lib/redis.js:152-175` | `get/set` 底层是 Postgres `kv_strings`，`set` 为 upsert、值为字符串 —— 存 JSON 字符串即可，无需建表。 |
| `test/admin-panel.inline-js.test.js` | 现成检查：用 `new Function()` 编译后台所有内联 `<script>`，并在尾部做「面板四件套」正则断言。可直接追加新 Tab 的断言。 |
| `vercel.json` | `api/afdian.js` 已配 `maxDuration: 60`；无新增函数需求。 |

---

## 三、文件级改动清单

| # | 文件 | 改动 | 量级 | 接口签名变化 |
| --- | --- | --- | --- | --- |
| 1 | `lib/afdian-dm.js` | 新增 `TEMPLATES_KEY` / `DEFAULT_TEMPLATES`（3 条，由现有文案逐字抽出占位符）/ `renderTemplate` / `getTemplates`(async) / `saveTemplates`(async) / `handleTemplates(req,res)`；`buildOrderMessages(o, templates)` 改为纯渲染；**`buildOrderJob` 改 async**（内部 `await getTemplates()`） | +130 行 / 改 20 行 | 是：`buildOrderJob` 同步→Promise |
| 2 | `lib/afdian-processor.js` | 唯一调用点改为 `dmJob = await afdianDm.buildOrderJob({...})` | 1 行 | 否 |
| 3 | `api/afdian.js` | 新增 `if (kind === "dm-templates") return afdianDm.handleTemplates(req, res);` | 1 行 | 否（新增分派） |
| 4 | `admin/admin_Dx23.html` | ① 子 Tab 条加第 3 个按钮；② 新增 `#afdian-sub-templates` 面板（变量说明 + 3 个独立 textarea + 各自实时预览框 + 保存/恢复默认）；③ `switchAfdianSubTab` 扩为三态；④ 新增 `loadDmTemplates / previewDmTemplates(debounce 300ms) / saveDmTemplates / resetDmTemplates` | +180 行 | 否 |
| 5 | `test/admin-panel.inline-js.test.js` | 追加新 Tab「四件套」断言（按钮 / 容器 / 函数 / API 路径） | +10 行 | 否 |
| 6 | `test/afdian-dm-templates.test.js`（新建） | L1 单元：占位符渲染、缺值兜底、未知变量保留、默认模板与旧文案逐字一致、3 条结构校验 | +90 行 | 否 |
| 7 | `docs/爱发电订单-私信模板Tab-方案.md` + 原型 html | 本方案 + 可交互原型；过审后回填单号 | — | 否 |
| 8 | `version.json` | `patch + 1`（跟随 EVTIDY 版本纪律） | 1 行 | 否 |

**模板与渲染规则（唯一实现，前后端零漂移）**

- 存储 key：`afdian:dm_templates`，值为 JSON：`{ "v": 1, "updated_at": <ms>, "templates": [{ "i": 1, "content": "..." }, ...] }`
- 占位符：`{{product_name}}` `{{code}}` `{{activate_url}}` `{{guide_url}}`（另允许 `{{user_name}}` `{{out_trade_no}}`，默认文案不用）
- 渲染：`/\{\{\s*([a-z_]+)\s*\}\}/g` 纯文本替换；`code` 缺失回落「（发货异常请回复本消息）」；未知变量**保留原文**便于排查，且后台变量说明区给出警告
- 默认模板逐字来自现有 3 条文案，仅把拼接处替换为占位符（保证不改模板时线上文案一字不差）
- 前端不做渲染，编辑时把 3 条原文 POST 到 `op=preview`，由服务端同一函数返回 `rendered[]` —— **所见即所得 = 实际发送内容**

**API（`api/afdian.js?kind=dm-templates`，全部走 `auth.requireAuth`，未登录 401）**

| 方法 / op | 行为 |
| --- | --- |
| `GET` | 返回 `{success, templates[3], rendered[3], updated_at, is_default, vars}` |
| `POST op=preview` | body `{templates:[...]}` → 返回 `rendered[3]`，不落库 |
| `POST op=save` | body `{templates:[...]}` → 校验「正好 3 条、条号 1/2/3、每条非空且 ≤4000 字符」，落库 |
| `POST op=reset` | 删 key 回内置默认，返回默认模板 |

---

## 四、分阶段预算 + 验证标准

| 阶段 | 内容 | 验证标准（看什么现象算通过） |
| --- | --- | --- |
| S1 · 后端模板层 | 改 #1 #2 #3 | L0：`node -c` 三个 js 全过；L1：`node test/afdian-dm-templates.test.js` 全 PASS，其中「默认渲染结果 === 旧文案逐字」必须通过；用 mock req/res 调 `handleTemplates`，未登录返回 401、save 后立即 GET 返回新值、reset 回默认 |
| S2 · 后台 UI | 改 #4 #5 | L0：`node test/admin-panel.inline-js.test.js` 全 PASS（内联脚本可编译 + 新 Tab 四件套断言）；浏览器打开后台 → 爱发电订单 → 出现第 3 个 Tab，点开显示 3 个独立 textarea 与 3 个预览框；输入 `{{code}}` 300ms 后预览出现示例兑换码 |
| S3 · 联调与交付 | 改 #8，提交 + push + 线上复核 | L2：本地 `vercel dev`（或等价 mock）打 GET/POST 往返；L3：push 触发 Vercel 部署后 `curl` 线上 `/api/afdian?kind=dm-templates` 返回 401（未带 cookie）确认鉴权生效；带后台 cookie 读取成功；改一条文案保存再刷新仍为新值 |
| 预算 | 约 2–3 次 commit / 单会话完成 | 不超 §3.6 单轮积分；若触顶即按 §3.6 收尾 |

---

## 五、风险与回滚

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| `buildOrderJob` 由同步改 async，调用点漏 await | job 变 Promise，队列写入坏数据、发不出私信 | 唯一调用点已定位（`afdian-processor.js:335`）；L1 增加断言「`buildOrderJob` 返回 job 且 `messages.length === 3`」；`attemptNow` 对异常 job 走默认模板兜底 |
| Redis/Postgres 读失败 | 无法取模板，订单私信发不出 | `getTemplates` 全路径 try/catch 回落 `DEFAULT_TEMPLATES`（与现状逐字一致），**绝不因模板读取失败阻断发码** |
| 模板里写错占位符 | 买家收到 `{{cdoe}}` 之类原文 | 后台变量说明区列出合法占位符；GET 返回 `unknown_vars` 供前端黄条提示；`op=save` 不拦截但明确警告 |
| 模板条数被改成非 3 条 | 破坏 `dm_sent` 断点续发索引 | `op=save` 服务端硬校验正好 3 条、条号 1/2/3；前端只渲染 3 个 textarea，无增删入口 |
| 保存影响待发队列 | 重发/串条 | 边界已排除：`job.messages` 快照不变；`attemptNow` 优先用快照 |
| 线上 `/api/afdian` POST 无 kind 会走 webhook | 请求被吞 | 前端所有请求显式带 `kind=dm-templates`；分派器把该分支放在 `dm-retry` 之后、默认兜底之前 |
| 回滚 | — | `git revert` 单个 commit 即恢复硬编码文案；存储 key `afdian:dm_templates` 残留不产生副作用（代码不再读它）。后台提供「恢复默认」按钮做无部署回滚 |

---

## 六、连带待办

- `version.json` patch +1；commit message 带 `evtask-` 单号（§3.3 / §3.18）
- 方案文档过审后回填单号，与代码一并 `git add + commit` 入仓（§3.18）
- push 后 Vercel 自动部署，按项目备注「线上改动须 curl 复核」执行 L3
- PROJECT-MAP §〇 认领行：开工 `ev-claim.sh claim`，收尾改 ✅ + commit hash（§3.11）
- 关单走封装 `ev-task-close.sh --id ... --result ... --evidence ...`（§3.11）
- 不新增 cron、不新增环境变量、不新增 Serverless Function；`vercel.json` 不动
- 图标沿用 Lucide 风格（§3.14），新 Tab 使用现有 `.visitor-sub-tab` 样式，无新图标依赖

---

## 七、验收 checklist

- [ ] 后台「爱发电订单」出现第 3 个子 Tab「💬 私信模板」，与订单列表/购买点击日志互切正常
- [ ] 页面显示 **3 个独立 textarea**，分别对应 #1 激活与兑换码 / #2 收尾语 / #3 安装指导
- [ ] 每个 textarea 有独立实时预览框，编辑 `{{...}}` 后预览同步变化，且与真实发送渲染函数一致
- [ ] 页头列出全部合法占位符及示例值；出现未知占位符时有警告
- [ ] 「保存」后刷新页面仍为新文案；「恢复默认」可一键回到内置 3 条
- [ ] 未登录直接请求 `kind=dm-templates`（含 GET）一律 401
- [ ] 默认状态（未保存过模板）下，新订单私信文案与改动前**逐字一致**
- [ ] 待发队列 `afdian:dm_pending` 中已有 job 的 `messages` 不受保存影响
- [ ] `node test/admin-panel.inline-js.test.js` 与 `node test/afdian-dm-templates.test.js` 全 PASS
- [ ] 线上部署后 curl 复核通过；方案文档、原型、代码均已入 git

---

## 实施变更记录（实施中偏离时填写，需重新获同意）

| 时间 | 偏离内容 | 处理 |
| --- | --- | --- |
| — | — | — |
