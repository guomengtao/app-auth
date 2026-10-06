# 米坛运营「三 Tab」重设计方案

> 任务：把 `admin_Dx23.html?tab=bandbbs` 的「米坛运营」栏目从**单页长滚动**拆成**三个 Tab**：运营 / 详情 / 奖品管理。
> 交互范式对齐设置页（`#panel-settings`）已有的多 Tab 结构 —— 用户 2026-10-06 明确要求「tab 类似其他页面，比如设置页，多个 tab 组成」。
> 设计原型：`docs/米坛运营三tab重设计-原型.html`（1dp=1px，支持 `?tab=ops|detail|prize&theme=&mode=`）
> 逐态截图：`docs/米坛运营三tab-原型-运营页-深空蓝.png`、`-运营页-深色.png`、`-详情页-深空蓝.png`、`-奖品管理页-深空蓝.png`
> 背景：本 md 为事后补齐落盘（原型与截图先于本文件产出，用户已口头确认「开工」）。

---

## 1. 背景与目标

**要解决什么**：米坛运营栏目当前是一整条长滚动页（资源帖配置 → 抓取结果 → 测试私信 → 抓取记录 → 评论详情 → 奖品池），六类语义完全不同的内容堆在一列，运维时要在长页里反复滚动找块；且**奖励池区块因历史结构错误在任意栏目下都会显示**（见 §2）。

**目标**：
- 三个语义 Tab：**运营**（监控/抓取/记录/调试）、**详情**（评论明细与筛选）、**奖品管理**（库存/模板/批量导入/发放日志）。
- 视觉与交互**零漂移**：Tab 签条直接复用设置页 `.settings-tabs` / `.settings-tab` / `.settings-sub-panel` 规格与令牌，不引入新设计语言。
- 顺手修复 §2 的结构 bug。

**明确不解决**（边界）：
- 不改 `admin-bandbbs.js`（**零改动**，472 行全部逻辑原样复用）。
- 不动任何后端 API、接口契约、数据结构。
- 不改写文案为中文以外的语言切换（模板正文保持英文原文）。
- 不做响应式断点之外的额外适配（沿用页面既有 `@media` 行为）。

## 2. 现状侦察结论

| 结论 | 依据（文件:行） |
|---|---|
| 栏目容器是单个 `.panel`，内部为扁平长滚动 | `admin_Dx23.html:4832` `<div class="panel" id="panel-bandbbs">` |
| 现含 6 个语义块：KPI 统计、资源帖配置、最近抓取结果、测试私信、抓取记录、评论详情 | `admin_Dx23.html:4847 / 4867 / 4895 / 4904 / 4916 / 4924` |
| **结构 bug**：`4944` 行 `</div>` 已闭合 `#panel-bandbbs`，`#bbRewardPoolSection`（`4951–4999`）落在面板**外**，成为 `<main>` 直接子元素 → 在后台**每个栏目**下都渲染 | `admin_Dx23.html:4944` 与 `4951`；`5001` 另有一个游离 `</div>` |
| 设置页 Tab 的 CSS 已存在，可直接复用：`.settings-tabs` / `.settings-tab` / `.settings-tab.active` / `.settings-sub-panel` | `admin_Dx23.html:1195–1201` |
| 设置页 Tab 的 JS 范式：`switchSettingsTab(tab)`，以 `data-stab` 定位签条、`settings-sub-<tab>` 定位面板 | `admin_Dx23.html:7943–7970` |
| 主导航进入本栏目时调 `loadBandBBS()` | `admin_Dx23.html:5415` `if (tab === 'bandbbs') loadBandBBS();` |
| 外部脚本仅 `admin-bandbbs.js` 一个，末尾引入 | `admin_Dx23.html:12406` |
| JS 依赖的 DOM id 共 24 个（**必须逐个保留**） | `admin-bandbbs.js` 第 6–417 行：`bbStatResources` `bbStatReviews` `bbStatRewards` `bbStatLastPoll` `bbResourcesTable` `btnPoll` `bbPollResult` `bbResourceId` `bbResourceTitle` `bbDmRecipient` `bbDmTitle` `bbDmMessage` `btnSendDm` `bbDmResult` `bbPollLogResult` `bbDetailResourceSelect` `bbRewardFilter` `bbReviewSection` `bbReviewTable` `bbRewardTemplate` `bbTemplateStatus` `bbRewardImportArea` `bbImportStatus` `bbPoolTotal` `bbPoolUsed` `bbPoolRemaining` `bbRewardLogResourceFilter` `bbRewardLogStatusFilter` `bbRewardLogTable` |
| JS 会 `scrollIntoView` 到 `bbReviewSection`（从资源行点「详情」跳转） | `admin-bandbbs.js:187–189` → 拆分后必须**同时切换 Tab**，否则滚到隐藏面板 |
| `admin_Dx23.html` 是**硬链接**（inode `230660094`，link count = 2，双胞胎在 `.vercel/output/static/`） | `ls -li` → 编辑不得 unlink 重建 |

## 3. 改动清单（文件级）

**唯一改动文件：`ev/app-auth/admin_Dx23.html`**（`admin-bandbbs.js` 零改动）

| # | 位置 | 改什么 | 预期增减 |
|---|---|---|---|
| 1 | `1195` 附近 CSS 区 | 复用现有 `.settings-tabs` 系；仅追加 `.settings-tab .cnt` 计数徽章样式 + `#panel-bandbbs .settings-tabs` 的 `margin-bottom` 微调 | +约 8 行 |
| 2 | `4832–4844` 面板头 | 保留头（标题 + 刷新/手动抓取），其后插入 **三 Tab 签条**（`data-btab="ops\|detail\|prize"`，含计数徽章） | +约 6 行 |
| 3 | `4846–4942` 现有块 | **按语义装进三个 `.settings-sub-panel` 容器**（`bb-sub-ops` / `bb-sub-detail` / `bb-sub-prize`），元素**原地搬迁、id 与事件属性一字不改** | 包裹层 +6 行，块本身内容不变 |
| 4 | `4944` / `4951–4999` | 修复 §2 的结构 bug：把 `#bbRewardPoolSection` **移入** `#panel-bandbbs` 的 `bb-sub-prize` 面板内，消除游离 `</div>` | 迁移，不增删内容 |
| 5 | `~5415` 导航钩子 | `if (tab === 'bandbbs') loadBandBBS();` 后补一行默认 Tab 复位 | +1 行 |
| 6 | `~7970` 内联 JS 区 | 新增 `switchBandBBSTab(tab)`：**只以 `[data-btab]` 限定作用域**，避免误伤设置页签条 | +约 12 行 |

**分组归属**：
- **运营（ops）**：KPI 统计行、资源帖配置、最近抓取结果、抓取记录、测试私信（折叠为 `<details>`）
- **详情（detail）**：评论详情（筛选栏 + 评论表，原 `#bbReviewSection` 整块）
- **奖品管理（prize）**：奖励产品、私信模板、批量导入、池库存统计、发放日志（原 `#bbRewardPoolSection` 整块）

## 4. 分阶段实施与验证标准

| 阶段 | 内容 | 预算 | 验证标准 |
|---|---|---|---|
| **P1** | 结构改造：签条 + 三 `settings-sub-panel` + 元素搬迁（id 全保留） | ~8 次工具调用 | ① 24 个 id 全部仍存在（JS 断言列表逐个核对，缺失即失败）；② 三签条点击切换正确显隐；③ console 无 error |
| **P2** | 修复 `#bbRewardPoolSection` 越界 + 默认 Tab 复位 + 计数徽章填数 | ~4 次调用 | ① 在其他任意栏目（如首页/设置）下**不再出现**奖励池区块；② 从资源行点「详情」能正确切到详情 Tab 并定位到评论区 |
| **P3** | 逐态验证 + 提交 | ~5 次调用 | ① headless Chrome 三 Tab 截图（浅色 + 深色）；② 与原型逐块比对无差异；③ 提交前复核 `ls -li` link count 仍 = 2 |

**会话预算提示（§3.6）**：本任务预计跨会话；P1→P3 若单会话超 10 积分 / 5 分钟，立即落盘并在认领行标注「进行中·已交接」，下个会话续做。

## 5. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| **硬链接断裂** | 线上静态产物与源文件脱钩 | 只用 Edit 原地改；改完 `ls -li` 复核 link count = 2；异常 → `git checkout -- admin_Dx23.html` |
| `.settings-tab` 全局选择器冲突 | 点设置页 Tab 时误清米坛签条 active | 新函数严格用 `[data-btab]`；不调用、不复用 `switchSettingsTab` |
| 元素搬迁漏改 id | `admin-bandbbs.js` 静默失效（拿到 null） | P1 验证第 ① 条：断言 24 个 id 全在 |
| `scrollIntoView` 指向隐藏面板 | 点「详情」无反应 | P2 验证第 ② 条（先切 Tab 再滚） |
| 游离 `</div>` 清理后结构错位 | 整页布局塌陷 | 改动后立即 headless 截图对比；异常 → `git revert` |

**回滚锚点**：改动前 HEAD（提交后新锚点为本次 commit hash）。全程单文件，`git checkout -- admin_Dx23.html` 即完全回退。

## 6. 连带待办

- 无跨端 / 跨仓改动；不涉及手环 rpk，**不需要刷常驻池**。
- 不涉及版本号 / 签名。
- app-auth 为 Vercel 自动部署，**无需打 Release 包**（按用户 2026-10-06 裁决：线上版本以 GitHub Release 为准，站点以自动部署为准）。
- 可选后续（本方案不含）：把 `admin-bandbbs.js` 内的中英混排文案统一（用户未拍板，暂不动）。

## 7. 验收 checklist

- [ ] 进入「米坛运营」默认停在**运营** Tab
- [ ] 三个签条：运营 / 详情 / 奖品管理，视觉与设置页签条一致（44px 高、4px 内衬、选中主色填充）
- [ ] 每个 Tab 只显示自己的块，切换无残留
- [ ] 24 个 JS 依赖 id 全在，资源表 / 评论表 / 发放日志均能正常加载
- [ ] 资源行点「详情」→ 自动切到详情 Tab 并定位评论表
- [ ] 奖励池（模板 / 批量导入 / 发放日志）只在**奖品管理** Tab 出现，其他栏目下不出现
- [ ] 浅色（深空蓝 / 纯白 / 夜幕黑）与深色模式均正常
- [ ] `ls -li admin_Dx23.html` link count 仍为 2
