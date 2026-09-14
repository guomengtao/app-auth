# 订单页面手动同步按钮可行性分析

## 1. 当前数据流全景

### 1.1 订单产生路径（服务端）

```
爱发电用户付款
    │
    ├──► 路径A: Webhook 实时推送
    │       api/afdian/webhook.js → processOrder() → 写入 Redis (afdian:order:*)
    │       ❌ 不调用 pushNotification()
    │       ❌ 不 PUBLISH 到 auth:push_channel
    │       └──► ev_notifier 收不到
    │
    └──► 路径B: Vercel Cron 每天凌晨 3:00
            api/afdian/query-orders.js → processOrder() → 写入 Redis (afdian:order:*)
            ❌ 不调用 pushNotification()
            ❌ 不 PUBLISH 到 auth:push_channel
            └──► ev_notifier 收不到
```

### 1.2 ev_notifier 订单页当前数据源

```
ev_notifier._html_orders()
    │
    └──► _build_order_list()
            │
            └──► load_messages() → ~/.ev_messages.json
                    │
                    └──► 过滤 type == "new_order"
```

`~/.ev_messages.json` 的数据来源只有一个：`handle_message()` 被调用时 `store_message()` 写入。

`handle_message()` 被调用的路径：`redis_loop` → `SUBSCRIBE auth:push_channel` → 收到 JSON → `handle_message()`

**关键断点**：没有任何服务端代码在订单处理完成后 PUBLISH 到 `auth:push_channel`。前面的测试是手动 PUBLISH 的假数据。

### 1.3 谁往 auth:push_channel 发消息？

| 代码位置 | 触发时机 | 消息类型 |
|----------|----------|----------|
| `lib/notify.js:pushNotification()` | 用户激活成功 | `new_activation` |
| `lib/notify.js:pushNotification()` | 用户激活失败 | `activation_failure` |
| `api/admin/health.js:pushToStream()` | 页面访问 | `page_visit`, `download`, `activate_view` |
| **无** | **爱发电订单** | **❌ 缺失** |

### 1.4 订单数据实际存放位置

| Redis Key | 内容 | 管理后台能否看到 |
|-----------|------|-----------------|
| `afdian:order:{out_trade_no}` | 单条订单详情 | ✅ 管理后台 Afdian Orders tab |
| `afdian:orders` (Hash) | 全部订单索引 | ✅ 管理后台 Afdian Orders tab |
| `afdian:processed` (Set) | 已处理订单号 | ✅ |
| `afdian:plan_map` (Hash) | 套餐→产品映射 | ✅ |

## 2. 问题诊断

### 2.1 ev_notifier 订单页面数据缺失的原因

```
实际订单数据:    Redis afdian:order:*   ← 管理后台能看到
                                           ↑
                                           │ 没有 PUBLISH
                                           │
ev_notifier:     auth:push_channel      ← 永远收不到订单消息
                  ~/.ev_messages.json   ← 订单栏目永远为空
```

### 2.2 影响范围

- **ev_notifier 订单页面**：不显示任何真实订单，只显示测试时手动 PUBLISH 的假数据
- **ev_notifier 订单统计**：总订单数、总收入、今日收入全部为 0
- **ev_notifier 订单通知**：弹窗和提示音不会为订单触发

## 3. 方案分析

### 方案A：修根因（推荐优先执行）

在爱发电订单处理完成后 PUBLISH 到广播通道，让 ev_notifier 被动接收。

**改动点**：

| 文件 | 改动 | 代码量 |
|------|------|--------|
| `api/afdian/webhook.js:L60` | `processOrder()` 后调用 `pushNotification("new_order", payload)` | ~5 行 |
| `api/afdian/query-orders.js` | `processBatchOrders()` 对每个新订单调用 `pushNotification("new_order", payload)` | ~10 行 |
| `lib/notify.js` | 已有 `pushNotification()` 函数，复用即可 | 0 |

**优点**：
- 实时性：Webhook 秒级，Cron 同步后也能收到
- 零 Redis 命令消耗（PUB/SUB 广播模式）
- 符合开发标准：禁止自动轮询

**缺点**：
- 历史数据不回填（ev_notifier 启动前的订单不会收到）
- 如果 ev_notifier 离线，消息丢失（PUB/SUB 不带持久化）

**Redis 影响**：0（PUBLISH 不计入命令配额限制）

### 方案B：手动同步按钮（弥补离线丢失）

在 ev_notifier 订单页面增加「同步订单」按钮，按需一键拉取全量订单。

**工作流**：

```
用户点击「同步订单」
    │
    └──► ev_notifier HTTP GET /api/afdian/query-orders?action=export
            │
            └──► 查询 Redis afdian:orders (Hash)
            │   返回所有订单列表 JSON
            │
            └──► ev_notifier 收到后：
                  ├── 与本地 ~/.ev_messages.json 比对新旧
                  ├── 新订单 store_message(type="new_order", ...)
                  ├── 写入 ~/.ev_messages.json
                  └── 刷新订单页面
```

**服务端改动**：

| 文件 | 改动 | 代码量 |
|------|------|--------|
| `api/afdian/query-orders.js` | 新增 `?action=export` 分支，从 Redis `afdian:orders` Hash 读取全量并返回 JSON | ~25 行 |

**客户端改动**：

| 位置 | 改动 | 代码量 |
|------|------|--------|
| ev_notifier.py `_html_orders()` | 渲染「同步订单」按钮 | ~10 行 HTML |
| ev_notifier.py WebNavDelegate | 新增 `ev://order-sync` 路由 | ~5 行 |
| ev_notifier.py DashboardWindow | 新增 `_sync_orders()` 方法，HTTP GET export 接口，去重写入本地 | ~40 行 |

**Redis 影响**：1 次 HGETALL（1 命令/次点击）。

**优点**：
- 按需操作，不影响自动流程
- 可以拉取历史全量订单
- 去重逻辑确保不重复写入
- 符合开发标准：手动操作，不是自动轮询

**缺点**：
- 每次点击 1 次 Redis 命令
- 需要新增一个 API 端点分支
- 如果订单数量极大（>1000条）需要分页

### 方案C：完整方案（推荐）

两个方案互补，同时执行：

1. **方案A（先做）**：修根因，Webhook + Cron 都 PUBLISH 订单 → ev_notifier 实时收
2. **方案B（再做）**：手动同步按钮作为兜底 → 离线期间丢失的订单可一键拉回

| 阶段 | 实施 | Redis 消耗 | 覆盖率 |
|------|------|-----------|--------|
| 方案A | Webhook/Cron PUBLISH | 0 命令/天 | 在线消息 100% |
| 方案B | 手动按钮 | 1 命令/次点击 | 离线丢失 100% |

## 4. 与现有开发标准的兼容性

| 标准条款 | 方案A | 方案B | 判定 |
|----------|------|------|------|
| 禁止一切自动轮询 | ✅ PUB/SUB 被动接收 | ✅ 手动按钮触发 | 符合 |
| 正常日消耗为 0 | ✅ 0 次命令 | ✅ 0 次（不点击） | 符合 |
| 消息携带 idx + total_daily | 需在 PUBLISH 时加入 | export 接口的数据来自 Redis 原始记录 | 可行 |
| 手动恢复机制处理丢失 | 无需（已经 PUB/SUB） | 按钮本身就是手动恢复 | 符合 |
| 广播为日常路径 | ✅ | N/A | 符合 |

## 5. 推荐实施顺序

```
  方案A ──────► 测试 ──────► 方案B
  (30分钟)     (1天)        (45分钟)

1. api/afdian/webhook.js 加 pushNotification("new_order", ...)
2. api/afdian/query-orders.js processBatchOrders 内加 pushNotification
3. 部署，等一天正常订单验证
4. 如果确认 Webhook 能 PUBLISH 到 ev_notifier，加手动按钮作为兜底
```

## 6. 风险与注意事项

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| processBatchOrders 在 Cron 时可能一次处理多条订单，每条都 PUBLISH | 低 | 每条 PUBLISH 一次是合理行为，ev_notifier 本地有去重 |
| export API 无鉴权被滥用 | 中 | 加 `requireAuth` 或简单 token 校验 |
| HGETALL 大 Hash 性能 | 低 | 当前订单量 <500，HGETALL 毫秒级完成 |
| ev_notifier 收到订单但 plan_map 缺失导致字段不完整 | 低 | payload 附带原始字段，ev_notifier 展示原样 |