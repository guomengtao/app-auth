# 项目规则

> 汇总自所有 `.trae/rules/*.md` 和用户自定义规则。
> 最后更新：2026-09-17

---

## 1. 版本管理

- **格式**：`x.y.z`，每次 push +1（patch 位递增）
- **位置**：`package.json` + `version.json`，两边同步更新
- **界面体现**：admin 顶栏 `#topbarVersion` 自动读取 `version.json` 显示
- 发布前必须更新版本号

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
- Markdown 文档（`.md`）→ **用中文书写**
- Vercel：**Serverless Functions ≤ 10 个**，超过则合并到已有文件中

## 6. QA 管理（AI 负责）

- **REPLY.md** 位于项目根目录（`/REPLY.md`）
- AI 负责维护，与 QA 对接时整理，分 3 类：
  - ✅ 已处理
  - 🔄 处理中
  - ⏳ 待处理
- 这是 AI 与 QA 的独立对接场景，与用户无关

## 7. 数据库

- 产品详情页可自由连接线上数据库（无限制）