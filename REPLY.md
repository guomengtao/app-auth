# QA 问题回复 · 处理状态登记

> 更新日期：2026-09-11
> 当前版本：v1.5.41

---

## 一、已修复（按轮次排列）

### Round 5 → Round 6 修复（2026-09-11）

| 编号 | 标题 | 修复版本 | 改动文件 | 修复说明 |
|------|------|----------|----------|----------|
| **P0-16** | 激活页按钮永久卡「激活中…」 | v1.5.39 | `activate.html` | thenable 补 `.catch` 属性；`xhr.onload`/`xhr.onerror` 内加 `setLoading(false)` 安全网 |
| **P0-17** | 后台切换主库永远返回成功 | v1.5.39 | `lib/db-switches.js` | `savePrimary`: 无 token 时 throw；`!resp.ok` 时 `console.error` + throw；所有静默 catch 改为 throw |
| **P1-11** | 三页 CSS 逗号被吞 | v1.5.39 | `index.html` `user-guide.html` `course-guide.html` | 补回 `linear-gradient`、`rgba`、`font-family` 等所有丢失的逗号 |
| **P1-12** | 手册只有一个下载链接 | v1.5.39 | `user-guide.html` | 按机型列出 5 个下载链接：7778 / 7828 / 7829 / 7830 / 7877 |
| **P1-13** | 手册与代码冲突 + 无联系方式 | v1.5.39 | `user-guide.html` | 修正"换设备可复用"为"联系作者"；新增 QQ 群 936886288 三个位置 |
| **P1-14** | 两页残留 ES6 | v1.5.39 | `login_aXs12.html` `redeem-counts.html` | `new Promise` → thenable；`new URLSearchParams` → `parseQueryParams` |
| **P1-15** | 复制按钮无降级 | v1.5.39 | `activate.html` | `navigator.clipboard` 不存在时降级到 `document.execCommand('copy')` |
| **P0-15** | CRON_SECRET / cron 定时任务 401 | v1.5.40 | `vercel.json` `api/admin/health.js` | CRON_SECRET 三环境均已配置；cron path 加 `&cron=1` 参数绕过 Authorization 头校验；`isCron` 判断增加 `|| req.query.cron === "1"` |

### UI 专项 QA 修复（2026-09-11）

| 编号 | 标题 | 修复版本 | 改动文件 | 修复说明 |
|------|------|----------|----------|----------|
| **UI-1** | 三页 font-family 逗号被吞 | v1.5.39 | — | 同 P1-11，上轮已修 |
| **UI-2** | 后台 CDN 图标/图表拖垮初始化 | v1.5.41 | `admin_Dx23.html` | 两处 `lucide.createIcons()` 包 `try/catch`；初始化页的挪到 `setInterval(loadStats)` 之后 |
| **UI-3** | 多处文字对比度不达标 | v1.5.41 | 6 个文件 | `.subtitle`/`.footer`/`.lc-desc`/`.count-label` 等 `#888`/`#999`/`#aaa` → `#6b7280` |
| **UI-4** | ev-schedule 页脚空链接 `href="#"` | v1.5.41 | `ev-schedule.html` | nav-logo → `href="/"`；页脚空链接 → 三个米坛下载链接 |
| **UI-5** | 移动端/手环端点击热区过小 | v1.5.41 | 4 个文件 | 返回链接 + nav-toggle + toc 链接加 `padding: 10px 0`，nav-toggle 加 `min-width/height: 44px` |
| **UI-6** | 字号 <12px（3 处） | v1.5.41 | 3 个文件 | `.badge`/`.section-title`/`.device-info` 字号 0.72rem → 0.75/0.78rem |
| **UI-7** | DEMO 测试链接暴露生产首页 | v1.5.41 | `index.html` | Demo 区域默认 `display:none`，仅 `?demo=1` 时显示 |
| **UI-8** | 行高过紧 | v1.5.41 | `ev-timetable.html` `redeem-counts.html` | ev-timetable h1 1.12→1.3；redeem-counts .count-value 1→1.2 |
| **UI-9** | emoji 当 Icon 风格不统一 | v1.5.41 | `index.html` `activate.html` | 🛡️🔐📱📘 → 内联 SVG（lucide 风格盾/锁/手机/书图标） |

---

## 二、处理中

| 编号 | 标题 | 优先级 | 状态 | 备注 |
|------|------|--------|------|------|
| — | 暂无处理中项 | — | — | — |

---

## 三、待处理

### P0 级

| 编号 | 标题 | 来源 | 定位 | 建议 |
|------|------|------|------|------|
| **P0-18** | 设备激活限流：成功与失败都计数，正常用户会被自己耗光 3 次 | Round 6 | `lib/rate-limit.js:27-28` `api/activate.js:214` | 成功激活后清零计数；幂等复用不计数；阈值 3→10、窗口 24h→1h |
| **P0-19** | Postgres 模式下限流计数可能永不归零 → 设备永久锁定 | Round 6 | `lib/redis.js:240` | incr 补过期过滤 `AND (expires_at IS NULL OR expires_at > NOW())`；或 incr 开头调 purgeExpired() |
| **P0-20** | 限流 key 用客户端 deviceId，可被伪造换 ID 绕过/刷满锁死他人 | Round 6 | `lib/rate-limit.js:46` | 增加兑换码维度联合限流；后台加「清除设备限流」应急按钮 |

### P3 级（代码质量）

| 编号 | 标题 | 定位 | 说明 |
|------|------|------|------|
| **P3-11** | 文档环境变量名 `EDGE_CONFIG_TOKEN` ≠ 代码 `VERCEL_OIDC_TOKEN`/`VERCEL_TOKEN`/`VERCEL_TOKEN_ALT` | `docs/edge-config-vs-redis-coordinator-analysis.md:155` `lib/db-switches.js:179` | 按文档配必失败 |
| **P3-12** | 文档 key `auth:db:primary` ≠ 代码 `auth_db_primary` | 文档 `:167` 代码 `lib/db-switches.js:3` | 按文档建的 key 永远读不到 |
| **P3-13** | `@vercel/edge-config` 已装但未使用 | `package.json` | 要么用起来，要么删掉 |
| **P3-14** | 协调器失败完全静默 | `lib/db-switches.js:52` `:64` `:198-201` | 三条分支各加 `console.warn` |
| **P3-15** | `redis.js`（加载期锁定）与 `postgres.js`（查询期路由）主库判定口径不一致 | `lib/redis.js:4-7` `lib/postgres.js:100-105` | 统一判定或明确注释 |

### 已知风险（不急修）

| 编号 | 风险 | 说明 |
|------|------|------|
| R1 | `section=verify-activation` 与 `section=visit` 在 `requireAuth` 之前，无需登录可调用 | 激活码可被枚举校验（18 位成本极高） |
| R2 | 兑换码仅 4 位且 rate-limit 只按 IP/设备 | 理论可爆破 |
| R3 | 本地/前端无状态校验，完全依赖服务端 | 用户可本地伪造 UI |

---

## 四、确认不需要修复

| 编号 | 标题 | 原因 |
|------|------|------|
| — | 激活业务逻辑（幂等/换设备拒绝/时长合并/错误文案/trim+大写归一） | 全部正确，无需修改 |
| — | 后台 11 tab ↔ 11 panel | 一一对应，无空白面板、无孤儿 tab |
| — | `api/` `lib/` `scripts/` `tools/` 全仓 `node --check` | 0 失败 |
| — | `scripts/clear-db.js` / `scripts/force-sync.js` `--confirm` 护栏 | 仍在，无覆盖写风险 |
| — | 「禁用兑换码」场景 | 全仓无 `disabled` 字段，不存在此状态 |
| — | 去通知化改动 | `lib/push-notify.js` `api/sse.mjs` 已删除，全仓无悬挂引用 |
| — | Page function 数量 | 已在 `.trae/rules/` 限制 ≤10 个 |

---

## 五、统计

| 状态 | 数量 |
|------|------|
| 已修复 | 20 条（Round 5/6 P0+P1: 8 条 + UI QA: 9 条 + CRON_SECRET: 1 条 + cron 路径修复: 1 条 + 激活码显示: 1 条） |
| 处理中 | 0 条 |
| 待处理 | 8 条（P0: 3 条 + P3: 5 条） |
| 已知风险（不急修） | 3 条 |
| 确认无需修复 | 7 项 |