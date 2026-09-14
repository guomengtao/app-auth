# EvNotifier 开发标准

## 一、架构原则

### 1.1 核心原则

```
Redis 免费额度有限 → 每一笔命令消耗都必须真实记录、严格限制
广播模式为日常路径 → PUB/SUB 推送，零轮询消耗
手动恢复为异常手段 → 丢失时才手动触发一次队列拉取
```

### 1.2 架构图

```
Vercel Serverless                  Upstash Redis                Mac 本地
┌──────────────────┐              ┌─────────────┐              ┌──────────────┐
│ activate.js      │──PUBLISH────►│             │              │              │
│ afdian/orders.js │   (广播)     │ auth:push    │──SUBSCRIBE──►│ ev_notifier  │
│ visitor.js       │              │ _channel     │   (TLS TCP)  │   .py        │
│                  │              │             │              │              │
│                  │──XADD───────►│ auth:stream  │              │  本地存储    │
│                  │   (持久化)   │             │              │  received    │
│                  │              │             │              │  .json       │
└──────────────────┘              └─────────────┘              └──────┬───────┘
                                                                     │
                                                              ┌──────▼───────┐
                                                              │ macOS 通知   │
                                                              │ + 菜单栏图标 │
                                                              │ + 手动恢复按钮│
                                                              └──────────────┘
```

- **PUB/SUB**：日常消息推送，广播模式，零额外消耗（不算命令次数）
- **Stream**：消息持久化备份，仅手动恢复时使用
- **本地 JSON**：记录已收消息，用于完整性校验

---

## 二、Redis 使用规范

### 2.1 最高禁令

> **🚫 绝对禁止一切形式的自动轮询。无论是 Stream xrange、List lrange、Queue rpop、BLPOP 阻塞读，只要是由代码定时触发而非用户主动操作，一律禁止。**

### 2.2 禁止事项

| 禁止项 | 原因 |
|--------|------|
| ❌ 任何定时 xrange/rpop/lrange | 自动轮询消耗 Redis 命令次数，违反最高禁令 |
| ❌ 任何 `while True: sleep(N); xrange()` 模式 | 这是变相轮询，无论间隔多长 |
| ❌ 后台补偿/兜底轮询 | 哪怕每小时1次也是自动轮询，丢失由用户手动恢复 |
| ❌ `auto` 类型的 record_auto_poll 记录 | 记录本身说明存在自动轮询，一并清除 |
| ❌ WebSocket 重连时的自动 resubscribe 中隐含的额外命令 | 连接管理应精简 |

### 2.3 允许事项

| 允许项 | 消耗 | 条件 |
|--------|------|------|
| ✅ PUB/SUB 订阅 | 计连接数，不算命令次数 | 保持长连接 |
| ✅ 手动恢复：1次 xrange | 1次命令 | 用户主动点击按钮 |
| ✅ 手动恢复：1次 lrange | 1次命令 | 用户主动点击按钮 |
| ✅ PING 心跳 | 按需 | 仅连接建立时 |

### 2.3 每日消耗模型

```
正常日（广播模式，无丢失）：
  PUB/SUB 订阅: 0 次命令（仅占连接数）
  手动恢复:       0 次（无丢失不触发）
  ─────────────────────────────
  日总计:         0 次命令

丢失日（消息有缺口，用户手动恢复）：
  PUB/SUB 订阅: 0 次命令
  手动恢复:       1 次（xrange 或 lrange）
  ─────────────────────────────
  日总计:         1 次命令

极端日（用户疯狂点恢复按钮）：
  手动恢复:       N 次
  ─────────────────────────────
  日总计:         N 次（完全由用户控制）
```

---

## 三、消息格式规范

### 3.1 服务端 PUBLISH 消息格式

每条 PUBLISH 的消息必须携带当日累计序号：

```json
{
  "type": "new_order",
  "idx": 15,
  "total_daily": 15,
  "date": "2026-09-14",
  "payload": {
    "order_id": "xxx",
    "amount": "29.90"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | string | ✅ | 消息类型：new_order / new_activation / page_visit / test |
| `idx` | int | ✅ | 当日消息序号，从 1 开始递增 |
| `total_daily` | int | ✅ | 当日累计消息总数 |
| `date` | string | ✅ | 日期，格式 `YYYY-MM-DD` |
| `payload` | object | ✅ | 消息具体内容 |

### 3.2 服务端发送流程

```
1. INCR auth:daily:YYYY-MM-DD:count     → 得到 total_daily
2. XADD auth:stream * type ... idx ... total_daily ...   → 持久化到 Stream
3. PUBLISH auth:push_channel "{json}"   → 广播给所有客户端
```

**关键规则**：
- `INCR` 和 `XADD` 是服务端消耗，不算在客户端额度内
- `PUBLISH` 广播不计命令次数
- Stream 持久化仅作备份，客户端日常不读取

---

## 四、客户端完整性校验

### 4.1 本地存储格式

`~/.ev_received.json`：

```json
{
  "2026-09-14": {
    "total_server": 15,
    "received_idx": [1, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13, 15],
    "last_check": "14:30:05"
  }
}
```

### 4.2 丢失检测算法

```
收到消息 { idx: 15, total_daily: 15 }

1. 记录 idx 到 received_idx[]
2. 更新 total_server = total_daily
3. 对比: len(received_idx) vs total_server
4. 如果 len < total → 有丢失
5. 计算: missing = total_server - len(received_idx)
6. 显示在手动恢复按钮上: "恢复(2)"  ← 表示丢失2条
```

### 4.3 手动恢复流程

```
用户点击 [恢复(N)] 按钮:

1. 调用 XRANGE auth:stream <last_id> + COUNT N
   或 LRANGE auth:queue 0 -1 (按当日过滤)
2. 拉回丢失的消息，逐条回放
3. 更新 received_idx[]，去重
4. 重新检查: 如果 still_missing > 0，继续显示在按钮上
5. 弹出通知: "已恢复 X 条，剩余 Y 条"
```

**消耗控制**：
- 每次点击只消耗 1 次 Redis 命令
- 无冷却限制（用户自己决定点几次）
- 菜单栏实时显示丢失条数

---

## 五、菜单栏规范

### 5.1 菜单项布局

```
┌─────────────────────────┐
│ Ev v2.0.0(23)           │  ← 图标 + 今日消息数
├─────────────────────────┤
│ 打开面板                │  ← 仪表盘窗口
│ 恢复(5)                 │  ← 手动恢复按钮，括号内为丢失条数
├─────────────────────────┤
│ 暂停/恢复               │
│ 重置计数                │
│ 拉取日志                │
│ 状态                    │
├─────────────────────────┤
│ 版本: v2.0.0            │
│ 退出                    │
└─────────────────────────┘
```

### 5.2 恢复按钮显示规则

| 状态 | 显示文本 | 说明 |
|------|---------|------|
| 无丢失 | `恢复` | 灰色/正常状态 |
| 有丢失 | `恢复(N)` | N = 丢失条数，红色高亮 |
| 恢复中 | `恢复中...` | 正在拉取，防止重复点击 |
| 已全部恢复 | `恢复 ✓` | 短暂显示后变回 `恢复` |

---

## 六、连接管理规范

### 6.1 PUB/SUB 连接

```
连接策略:
  - 使用原生 Redis TCP TLS 连接（非 HTTP REST）
  - 保持单一长连接
  - 断线自动重连（指数退避: 1s → 2s → 4s → ... → 30s 上限）

重连时的处理:
  - 重新 SUBSCRIBE
  - 不触发自动恢复（消息丢失就丢失，等用户手动恢复）
  - 恢复按钮上的数字保持不变（来自本地 JSON 计算）
```

### 6.2 连接状态指示

| 状态 | 菜单栏显示 | 说明 |
|------|-----------|------|
| 已连接 | `Ev(23)` | 正常 |
| 连接中 | `Ev 连接中...` | 初次连接/重连 |
| 断开 | `Ev 离线` | 网络断开，等待重连 |
| 重试中 | `Ev 重试(5s)...` | 正在等待重连 |

---

## 七、面板（仪表盘）规范

### 7.1 标签页

| 标签 | 标题 | 功能 |
|------|------|------|
| 消息中心 | 消息中心 | 最近消息列表、统计卡片 |
| 订单列表 | 订单列表 | 爱发电订单汇总 |
| 访客浏览 | 访客浏览 | 网站访问统计、设备分布 |
| 走势图 | 走势图 | 数据趋势图表 |
| 设备信息 | 设备信息 | 设备详情统计 |
| 轮询统计 | 轮询统计 | **仅记录手动恢复操作**（广播接收不算轮询） |
| 设置 | 设置 | 版本信息、存储路径、启动项 |

### 7.2 性能要求

- 面板按需加载，仅构建当前标签页
- 其他标签页使用 loading 占位符
- 首次打开面板延迟 < 1 秒

---

## 八、文件结构规范

```
tools/ev-notifier/
├── ev_notifier.py                          ← 当前运行版本
├── ev_notifier_vX.Y.Z.py                   ← 历史版本归档（独立可运行）
├── build_app.sh                            ← 构建脚本
├── evnotifier-development-standards.md     ← 本文档
├── version-plan.md                         ← 版本规划
├── redis-push-vs-queue.md                  ← Push vs Queue 分析
├── 面板技术说明.md                          ← 面板技术细节
└── README.md                               ← 使用说明
```

### 8.1 版本号规则

- `v1.0.1` → `v1.0.2`：小改进，递增末位
- `v1.1.0`：里程碑（多个功能合入）
- `v2.0.0`：架构级变更
- 每次改动后更新 VERSION 常量
- 每次改动后 push 到远程仓库

---

## 九、数据文件规范

| 文件 | 路径 | 用途 |
|------|------|------|
| 环境变量 | `~/.ev-notifier.env` | Redis 连接配置 |
| 消息记录 | `~/.ev_received.json` | 已收消息去重 + 完整性校验 |
| 轮询日志 | `~/.ev_poll_log.json` | Redis 命令消耗明细 |
| 消息存储 | `~/.ev_messages.json` | 面板展示用消息缓存 |
| 访客存储 | `~/.ev_visitors.json` | 访客统计数据 |
| last_id | `~/.ev_last_id_v1.5.0` | Stream 消费位置 |
| 启动项 | `~/Library/LaunchAgents/com.evnotifier.agent.plist` | 开机自启 |
| 桌面版 | `~/Desktop/EvNotifier.app/ev_notifier.py` | LaunchAgent 加载副本 |

### 9.1 数据清理规则

- 轮询日志：自动删除 30 天前的记录
- 消息存储：保留最近 200 条
- 访客存储：保留最近 30 天

---

## 十、部署规范

### 10.1 桌面版同步

```
# 项目文件修改后，必须同步到桌面版
cp tools/ev-notifier/ev_notifier.py ~/Desktop/EvNotifier.app/ev_notifier.py

# 重启进程
launchctl unload ~/Library/LaunchAgents/com.evnotifier.agent.plist
launchctl load ~/Library/LaunchAgents/com.evnotifier.agent.plist
```

### 10.2 推送流程

```bash
git add -A
git commit -m "type(scope): description"
git push
```

Commit 格式：`type(scope): description`
- type: feat / fix / refactor / docs
- scope: ev-notifier / 其他模块名

---

## 十一、开发禁忌

> **首要铁律：禁止一切自动轮询。查阅 [2.1 最高禁令](#21-最高禁令)。**

| 禁忌 | 说明 |
|------|------|
| 🚫 **任何形式的自动轮询** | `while True` + `sleep` + `xrange`/`lrange`/`rpop` 永远不能在代码中出现 |
| 🚫 **变相轮询** | Vercel CRON 定时触发 xrange / API 接口间接触发轮询 / WebSocket 心跳伪装 |
| 🚫 隐藏 Redis 消耗 | 每次手动恢复调用必须记录到 poll_log |
| 🚫 代码中出现中文 | 注释、变量名、字符串一律英文 |
| 🚫 改动后不 push | 每次改动必须 push 到远程 |
| 🚫 改动后不更新版本号 | VERSION 常量必须与改动同步 |
| 🚫 文档写英文 | MD 文档内容使用中文书写 |

---

## 十二、当前版本 vs 目标版本

> **v2.0.0 已实现。当前运行 PUB/SUB 广播模式。**

| 项目 | v1.5.x (旧) | v2.0.0 (当前) |
|------|------------|---------------|
| 通信方式 | Stream XRANGE 轮询 | PUB/SUB 广播 + TCP 长连接 |
| 轮询间隔 | 30秒/次 | **无（禁止自动轮询）** |
| Redis 日消耗 | ~2880 次 | **正常 0 次**，丢失时 N 次（手动恢复） |
| 丢失检测 | check_integrity (旧) | idx/total_daily 实时比对 |
| 丢失恢复 | 自动（每小时最多1次） | **手动**（用户点击菜单栏按钮） |
| 恢复按钮 | 无 | 菜单栏实时显示丢失条数 ⚠N |
| 消息格式 | 无 idx/total_daily | 每条消息携带 idx + total_daily |
| 客户端连接 | HTTP REST (每30秒) | **TCP TLS 长连接** (redis-py SUBSCRIBE) |
| 服务端发送 | XADD to Stream | **XADD (持久化) + PUBLISH (广播)** |

---

## 十三、迁移路线（已完成）

```
v1.5.9
  │  Stream XRANGE 轮询 30s/次
  │  日消耗 ~2880 Redis 命令
  │
  ▼
v1.6.0                                  ← 2026-09-14
  │  服务端添加 idx + total_daily 字段
  │  客户端解析 idx/total_daily 做完整性校验
  │  手动恢复按钮可用
  │  仍使用 XRANGE 轮询（过渡期）
  │
  ▼
v2.0.0                                  ← 当前
  │  PUB/SUB 广播模式 (redis-py TCP TLS)
  │  移除所有自动轮询代码 (xrange/sleep loop)
  │  仅保留手动恢复按钮 (按需调用 xrange via HTTP)
  │  Redis 日消耗降至 0（丢失按需恢复 N 次）
```