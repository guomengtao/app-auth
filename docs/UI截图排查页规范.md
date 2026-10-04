# UI 截图排查页规范（app-auth 项目规则）

> 用途：给「把某个设备型号的页面截图挂到线上做排查/评审」这类页面定死规矩。
> 相关单一来源：`/js/ui-review-stats.js`（统计 + 型号隔离守卫）、`/js/review-widget.js`（反馈组件）。
> 已接入页面：`ui-gallery-9.html`、`ui-gallery-10-pro.html`、`ui-gallery-sound-mini.html`。

---

## 一、硬规矩（违反即视为 bug）

1. **一个页面 = 一个设备型号**。
   该页的**文字、图片、反馈**三者都只能属于这一种型号；
   **禁止**出现其它型号的文字描述、截图文件、反馈记录（哪怕是"对比参考"也不行）。
2. **图片只放自己型号的目录**：`images/ev-schedule-<型号>/pages/…`，不跨目录引用。
3. **反馈只落自己型号的 projectId**：`ReviewWidget.mountAll({ projectId: "ev-schedule-<型号>" })`。
4. **必须声明型号元信息**，且整页只允许一个：
   ```html
   <script>window.UI_REVIEW_MODEL = { projectId:"ev-schedule-soundmini", model:"小爱音箱 Mini", lcd:"800x480" };</script>
   ```
5. **必须挂统计 JS**：`<script src="/js/ui-review-stats.js"></script>`（放在 review-widget 之后）。
   它会：① 校验全页 `.shot-unit[data-project]` 是否同属一个型号（混了就控制台报错 + 顶部红条告警）；
   ② 拉 `GET /api/admin/review?projectId=…` 出统计条（截图数 / 已反馈 / 待修 / 待重采 / 已修）；
   ③ 给有反馈的截图打角标。接口拿不到时降级本地计数，不挡页面。

---

## 二、新增一个型号排查页的 5 步

1. 截图落到 `images/ev-schedule-<型号>/pages/`（命名 `<页面>.png`，多屏 `<页面>-s2.png`）。
2. 复制 `ui-gallery-sound-mini.html` 当模板（它是最新、带型号隔离与统计条的样板）。
3. 改三处：**标题/型号名**、**`window.UI_REVIEW_MODEL`**、**`IMG_BASE` 与 `ReviewWidget` 的 projectId**。
4. 填 `DATA.pages`（页面名 / 分组 / 路由 / 屏数），不要照抄别的型号条目。
5. 末尾保留：访问埋点（`/api/admin/health?section=visit`）+ `<script src="/js/track.js" data-group="home">`。

## 三、projectId 命名

`ev-schedule-<型号标识>`，已用：`ev-schedule-watch9`、`ev-schedule-watch10pro`、`ev-schedule-soundmini`。
新增型号先在这里登记，再建页面，避免两个页面抢同一个 projectId（反馈会串）。

---

## 四、为什么这么严

- 反馈是按 `projectId` 存的：两个型号共用一个 ID，待修/已修会互相覆盖，排查结果直接失真。
- 不同型号屏幕尺寸/排版完全不同（如 192×490 与 800×480），把别的型号的图放进来会误导判断：
  看到的问题可能根本不存在于本型号。
- 历史教训：`ui-gallery-10-pro.html` 曾混入大量手环 9 的旧截图（54 条 404），已按型号清洗干净。

## 五、采集侧要求（总纲 §3.8b）

批量截图 / 打开任意页这类任务，动手前必读 `docs/vela-批量截图20张-最快方案对比.md`。
当前可用的确定性姿势：**每页 guest 冷重启 → 前台驻留挂 `vapp` → 等画面稳定 → 截图 → 按需上滑补多屏（md5 变了才存）**。
（`am stop/start` 对已在跑应用无效；`vapp` 后台化必黑屏；批量任务别加 `--ttl`。）
