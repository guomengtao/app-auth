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
- Commit 信息用英文

## 3. 终端

- **必须使用 tmux** 操作控制台（避免终端相互干扰）
- **只保留一个终端**；开新终端前用 `tmux kill-session` 关闭旧的
- 高风险命令（`pkill`、`rm`、删除等）→ 直接执行，不需要弹窗确认

## 4. 交互通知（macOS Dialog）

- 由 AI **自主判断**何时需要弹窗交互（觉得有必要时再弹，不是每次都弹）
- 不要在对话内提示（用户切换 tab 后看不到）
- **通用文案**（标准化）：
  ```bash
  res=$(osascript -e 'display dialog "操作已完成，是否需要继续？" buttons {"取消","继续"} default button "继续" with icon caution')
  if [[ $res == *"继续"* ]]; then
    echo "User chose continue"
  else
    echo "User cancelled"
  fi
  ```

## 5. 代码规范

- 代码中**不限制中英文**，按需使用
- Markdown 文档（`.md`）→ **用中文书写**
- 页面开发：**胶囊/手环版优先**，方屏版其次
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