# 米坛运营：筛选行高 + 发奖记录 Tab + 奖品池统计修复 方案

- 单号：`evtask-D-evapp-auth-261007-5g67ca`（认领 20261007-043717-5965）｜ 预算：约 12~15 次调用、~10 分钟
- 涉及文件：`admin_Dx23.html`、`admin-bandbbs.js`（2 文件）

## ① 筛选区域增加行高（纯 CSS）

现场：`.bbx-filters { gap:9px; padding:13px 18px }`、`.bbx-chip { padding:5px 12px }`（L1237/1241），行与行挤在一起。

改法：
- `.bbx-filters` gap 9px→13px、padding 13px→15px 18px
- `.bbx-frow` 加 `min-height:34px`
- `.bbx-chip` padding 5px→7px（行高直接撑起来）

## ② 新增「发奖记录」Tab（第 4 个子 Tab）

现状：奖品池 Tab 里的 `#bbRewardLogTable` 实际展示的是**全量奖品池**；真正的发放历史走 `op=reward-log`（只回已发放），目前没有独立入口。

改法：
- `admin_Dx23.html`：`#bbTabs` 加第 4 个签条「发奖记录」（data-btab="log"，lucide `scroll-text`，沿用奖品池色系）；新增 `<section id="bb-sub-log">`，内含统计卡（累计发放）+ 表格 `#bbRewardHistoryTable`（资源｜用户｜奖品 ID｜发放时间）。
- `admin-bandbbs.js`：新增 `loadRewardHistory()`（走 `op=reward-log`，失败显式报错不静默）；`switchBandBBSTab` 懒加载钩子补 `log` 分支；URL sub 映射同步。

## ③ 奖品池发了奖统计不变（真 bug，已定位）

根因：`bbAwardOne`（单人发奖，L502-545）和 `sendRewardForResource`（批量发奖，L640-669）的成功回调**都没刷奖品池**——只就地改了获奖名单那一行，奖品池的 `_bbPool` 与统计卡（未发放/已发放数字）全靠旧缓存，直到刷新页面才变。

改法：两个成功回调末尾补 `loadPoolStats(); loadRewardPool();`。

## 验证

- 语法 + 括号深度扫描（完整分词器）。
- headless 夹具：① 筛选区行高；② log Tab 懒加载出发放记录；③ 模拟发奖成功后统计卡变化。
- 落测试报告 md → commit → push 部署 → 线上复验。

## 风险与回滚

- 单 commit 独立可 revert；后端发放逻辑（`op=reward-one`/`send-rewards`）零改动，只动前端刷新链。
- reward-log 接口只回已发放——正是「发奖记录」语义，不算降级。
