# 项目规则

> 汇总自所有 `.trae/rules/*.md` 和用户自定义规则。
> 最后更新：2026-09-21

---

> ## ⚠️ 正式要求单一权威 = 总纲
> 所有「怎么干活」的正式要求一律以**总纲**为准；本文件不再重复维护/扩展要求，只保留「必须**阅读并遵守总纲**」这一条指针；与本文件冲突时以总纲为准。
> - 总纲路径：`/Users/Banner/Documents/guomengtao/多人多AI统一协调开发总纲.md`
> - 任务单号 / 开工登记：正式单号由 `task-register` API 领取（`evtask-` 前缀，写 Supabase `evops_tasks`）→ 告知用户 → 登记 → 才动手（总纲 §3.11 / §4.4）。

---

---

## 1. 版本管理（多组件）

项目包含多个独立组件，每个组件有自己的版本号，统一采用 `major.minor.patch` 语义化版本。

### 1.1 组件与版本文件对应

| 组件 | 版本文件 | 用途 |
|------|---------|------|
| **app-auth（主站后台）** | `version.json` | 网站后台、API、Serverless Functions |
| **ev-notifier** | `tools/ev-notifier/version.json` | macOS 桌面通知器 |
| **ev-schedule-sync** | `tools/ev-schedule-sync/astrobox-build/astrobox-plugin/manifest.json` | AstroBox 课程表同步插件 |

### 1.2 版本号规则

- **格式**：`x.y.z`（语义化版本）
- **patch 位（第三位）**：每次改动自动 +1（由 `scripts/bump-version.sh` 自动完成）
- **minor 位（第二位）**：功能新增/重要改进时手动修改，patch 归零
- **major 位（第一位）**：架构级变更时手动修改，minor 和 patch 归零
- **界面体现**：admin 顶栏 `#topbarVersion` 自动读取 `version.json` 显示

### 1.3 自动 bump 机制

`scripts/bump-version.sh` 会检测 git 变更文件所属组件，只 bump 有实际改动的组件版本号：

```
改了 api/activate.js          → bump version.json（主站）
改了 tools/ev-notifier/*.py   → bump tools/ev-notifier/version.json
改了 tools/ev-schedule-sync/* → bump manifest.json version
同时改了多个组件              → 各组件各自 bump
```

### 1.4 使用方式

```bash
# 一键 push（自动 bump + commit + push）
./scripts/push.sh "提交信息"

# 仅 bump 版本号（不 commit）
./scripts/bump-version.sh
```

- **每次 push 必须使用 `scripts/push.sh`**，确保版本号自动递增
- major/minor 版本号变更需手动编辑对应 version.json

## 2. Git

- 每次改动 → `git push` 到远程仓库
- Commit 信息用中文

## 3. 终端

- **必须使用 tmux** 操作控制台（避免终端相互干扰）
- **只保留一个终端**；开新终端前用 `tmux kill-session` 关闭旧的
- 高风险命令（`pkill`、`rm`、删除等）→ 直接执行，不需要弹窗确认

## 4. 开发完成通知（必须执行）

每次开发任务完成后，**必须同时执行**弹窗通知 + 语音播报，不可跳过。
详见 [mac_notification.md](.trae/rules/mac_notification.md)。

### 4.1 完整命令模板

```bash
osascript -e 'display notification "简述本次改动" with title "app-auth · 已改好"' ; say -v Tingting "简述本次改动"
```

- 弹窗用 `display notification`（通知中心），不用 `display dialog`（阻塞弹窗）
- 语音用 `say -v Tingting`（中文普通话）
- 中间用 `;` 连接：即使弹窗失败，语音也会播放

### 4.2 每次对话结束时

替换命令中的三处文案：
1. 弹窗正文 → `display notification "..."` 内
2. 弹窗标题 → `with title "..."` 内
3. 语音文本 → `say -v Tingting "..."` 内

先弹窗，再语音播报，两个命令都要执行。

## 5. 代码规范

- 代码中**不限制中英文**，按需使用
- Vercel：**Serverless Functions ≤ 10 个**，超过则合并到已有文件中

## ⚠️ 6. Markdown 文档必须使用中文（强制规则）

> **本规则优先级最高，覆盖任何其他关于语言的规则。**

- **所有 `.md` 文件必须用中文书写**
- 包括但不限于：`README.md`、`DESIGN.md`、文档、方案、说明文件
- 文件名可以用英文，但**内容必须是中文**
- AI 在创建或编辑 `.md` 文件时，必须输出中文内容，**不允许输出英文 markdown**
- 这条规则的优先级高于用户自定义规则中的 "use USA English"，因为 `.md` 是文档而非代码

**反例（不允许）：**
```markdown
# Design Document
This is the design for the EV Sync plugin.
```

**正例（必须）：**
```markdown
# 设计方案
这是 EV 同步插件的设计方案。
```

## 7. QA 管理（AI 负责）

- **REPLY.md** 位于项目根目录（`/REPLY.md`）
- AI 负责维护，与 QA 对接时整理，分 3 类：
  - ✅ 已处理
  - 🔄 处理中
  - ⏳ 待处理
- 这是 AI 与 QA 的独立对接场景，与用户无关

## 8. 数据库

- 产品详情页可自由连接线上数据库（无限制）

## 9. 任务单号领取（强制：开工前置条件）

> ⚠️ 本节已由**总纲 §3.11 / §4.4 取代**（正式要求单一权威 = 总纲）：任务单号唯一来源 = `task-register` API 领取 `evtask-` 前缀（写 Supabase `evops_tasks`），拿到单号 → 明确告知用户 → 登记 → 才动手。**旧 `TCK-` 自编号已作废，不再使用**（历史遗留 TCK- 记录不算正式单号）。
>
> 总纲路径：`/Users/Banner/Documents/guomengtao/多人多AI统一协调开发总纲.md`

## ev-sweeper 纠察记录

> 由 ev-sweeper 2026-10-08 清扫发现。

### 本次发现（2026-10-08）

| 问题 | 严重度 |
|------|:--:|
| `.env.bak` 敏感文件备份留存在根目录 | 🔴 |

### 防重复规则

1. **禁止 `.env*` 备份**：`.env` 文件**严禁**创建任何备份副本（`.env.bak`、`.env.old` 等），修改后直接覆盖
2. 如确需保留环境变量历史，使用 `1password` 或 `安全笔记` 存储，不得留文件在磁盘