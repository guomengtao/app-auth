# EvNotifier 通知丢失问题诊断与 Stream 架构迁移方案

## 一、问题诊断：为什么收不到通知？

### 1.1 核心发现：PUBLISH 端完全缺失

经过对全量代码的排查，**整个 app-auth 项目中没有任何一行代码调用 `redis.publish()`**。

```
grep 结果:
  - lib/redis.js:      无 publish 方法
  - api/activate.js:   只调 notify.sendActivationNotification() → 仅发邮件
  - api/admin/health.js?section=visit:  收集访问数据后直接 return，无任何推送
  - 全局搜索 .publish: 零匹配
```

### 1.2 当前实际数据流（与设计文档的差异）

**设计文档（README.md 中的架构图）声称的流程：**

```
activate.js      ──PUBLISH──►  Upstash Redis  ──SUBSCRIBE──►  ev_notifier.py
afdian/orders.js ──PUBLISH──►  auth:push_channel             (Mac 通知)
redeem-codes.js  ──PUBLISH──►
```

**实际情况：**

```
activate.js      ──EMAIL──►  Resend/SMTP  ──►  QQ邮箱 (仅邮件通知)
health.js?section=visit ──►  收集数据 → return {success:true} (无任何推送)
ev_notifier.py   ──SUBSCRIBE──►  Upstash Redis auth:push_channel
                                  ↑
                                  └── 无人 PUBLISH，永远收不到消息
```

### 1.3 根本原因分析

| 层面 | 问题 | 详情 |
|------|------|------|
| **lib/redis.js** | 无 `publish` 方法 | 当前 `lib/redis.js` 使用 Postgres 代理模式，`client` 对象未暴露 `publish`。即使启用 Upstash 模式，`@upstash/redis` SDK 是基于 REST API 的，**REST API 不支持 PUBLISH 命令**（Pub/Sub 需要持久 TCP 连接） |
| **api/activate.js** | 只发邮件 | 激活成功仅调用 `notify.sendActivationNotification()` → Resend/SMTP 发邮件，不推送 Redis |
| **api/admin/health.js** | visit 端点空壳 | `section=visit` 接收 `POST` 请求，收集 IP/UA/页面信息后直接 `return {success:true}`，不做任何推送 |
| **api/afdian/orders.js** | 无推送 | 订单同步仅写数据库，不发通知 |

### 1.4 通知是否依赖数据库记录？

**不是。** ev_notifier 不查询数据库，它只订阅 Redis Pub/Sub 频道 `auth:push_channel`。即使数据库有记录，只要没人往这个频道 PUBLISH，ev_notifier 就永远收不到消息。

---

## 二、当前架构分析

### 2.1 网站后台与 evnotifier 的关系

```
┌─────────────────────────────────────────────────────────────┐
│                      Vercel (Serverless)                     │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │ activate.js  │   │ health.js    │   │ redeem-codes │    │
│  │ (激活处理)   │   │ (visit端点)  │   │ (兑换码生成) │    │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘    │
│         │                  │                   │             │
│         ▼                  ▼                   ▼             │
│  ┌──────────────────────────────────────────────────┐      │
│  │              lib/redis.js (Postgres 代理)         │      │
│  │         ❌ 无 publish 方法                        │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────┐                                          │
│  │ lib/notify.js│──► Resend/SMTP ──► QQ邮箱                 │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
                              ✕ 断开 ✕
┌─────────────────────────────────────────────────────────────┐
│                     Upstash Redis                            │
│                                                             │
│  auth:push_channel  ←── SUBSCRIBE ──  ev_notifier.py       │
│  (无人 PUBLISH)                      (Mac 菜单栏应用)       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键结论：evnotifier 完全可以脱离网站后台独立运行

**答案是：可以。** ev_notifier.py 通过原始 RESP 协议直接 TCP/TLS 连接 Upstash Redis，完全不依赖 Vercel Serverless 或网站后台：

- ev_notifier.py 直接连 `UPSTASH_HOST:6379`（TLS TCP）
- 使用原生 Redis SUBSCRIBE 命令，不经过 HTTP/REST
- 只要有人往 `auth:push_channel` 发布消息，它就能收到
- 与 Vercel Serverless 是否运行、网站是否在线无关

**问题不在于 evnotifier 是否独立，而在于没有任何服务向该频道发布消息。**

---

## 三、Stream 架构方案设计

### 3.1 为什么选择 Stream 而非 Pub/Sub？

| 特性 | Pub/Sub（当前） | Stream（推荐） |
|------|----------------|----------------|
| **消息持久化** | ❌ 无订阅者时消息丢弃 | ✅ 消息持久存储在 Redis |
| **离线消息** | ❌ 断线期间消息全部丢失 | ✅ 重连后可回放历史消息 |
| **消费确认** | ❌ 无确认机制 | ✅ XACK 确认消费 |
| **多消费者** | ❌ 所有订阅者收到相同消息 | ✅ 消费者组，各自独立消费 |
| **消息回溯** | ❌ 不支持 | ✅ 可按时间/ID 回溯 |
| **REST API 支持** | ❌ 需要 TCP 连接 | ✅ Upstash REST API 支持 XADD/XREAD |

### 3.2 推荐架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Vercel Serverless                         │
│                                                              │
│  activate.js ──► XADD auth:notifications:stream * type ...   │
│  health.js   ──► XADD auth:notifications:stream * type ...   │
│  afdian/*.js ──► XADD auth:notifications:stream * type ...   │
│                       │                                      │
│                  Upstash REST API (HTTP)                      │
│                  支持 XADD/XREAD/XACK                         │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                    Upstash Redis                              │
│                                                              │
│  auth:notifications:stream                                   │
│  ┌──────┬──────┬──────┬──────┬──────┐                      │
│  │ msg1 │ msg2 │ msg3 │ msg4 │ msg5 │  ← 持久化消息队列     │
│  └──────┴──────┴──────┴──────┴──────┘                      │
│                                                              │
│  Consumer Group: ev-notifiers                                │
│  ┌────────────┐  ┌────────────┐                             │
│  │ mac-client  │  │ web-admin  │   ← 独立消费者             │
│  └────────────┘  └────────────┘                             │
└──────────────────────┬───────────────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           │           │           │
           ▼           ▼           ▼
   ┌───────────┐ ┌───────────┐ ┌───────────┐
   │ Mac 通知  │ │ 语音播报  │ │ Web 后台  │
   │ (原生弹窗)│ │ (say命令) │ │ (SSE推送) │
   └───────────┘ └───────────┘ └───────────┘
```

### 3.3 消息格式设计

```json
{
  "type": "activation|order|visit|error|system",
  "title": "新设备激活",
  "body": {
    "redeemCode": "XXXX-XXXX-XXXX",
    "productId": "premium_12m",
    "deviceId": "abc123",
    "ip": "1.2.3.4",
    "userAgent": "Mozilla/5.0...",
    "timestamp": "2026-09-11T14:30:00Z"
  },
  "priority": "high|normal|low",
  "id": "1726065000000-0"
}
```

### 3.4 核心实现要点

**① Serverless 端 - 发布消息（XADD）**

`lib/redis.js` 需要新增 `xadd` 方法。因为 `@upstash/redis` REST SDK 支持 `XADD`，且在 Postgres 代理模式下也可以模拟 Stream：

```javascript
// lib/redis.js 新增方法
async function xadd(key, id, fields) {
  // Upstash REST 模式：直接调 SDK
  // Postgres 代理模式：写入 kv_streams 表
}

async function xread(count, block, streams) {
  // 读取 Stream 消息
}
```

**② ev_notifier.py - 改为 Stream 消费（XREAD + Consumer Group）**

替换当前的 SUBSCRIBE 为 XREADGROUP：

```python
# 替换 SUBSCRIBE auth:push_channel
# 改为 XREADGROUP GROUP ev-notifiers mac-client BLOCK 5000 STREAMS auth:notifications:stream >

# 关键优势：
# 1. 消息持久化，断线不丢
# 2. XACK 确认消费
# 3. 支持 > 读取未消费消息
# 4. 支持 0 重读历史消息
```

**③ section=visit 端点 - 添加推送**

```javascript
// api/admin/health.js 中 section=visit 处理
// 在 return 之前添加:
await redis.xadd('auth:notifications:stream', '*', 
  'type', 'visit',
  'title', '网站访问',
  'body', JSON.stringify(visitMsg),
  'priority', 'low',
  'timestamp', new Date().toISOString()
);
```

### 3.5 防丢失机制

| 机制 | 说明 |
|------|------|
| **持久化存储** | Stream 消息写入 Redis 持久化，不会因无消费者而丢弃 |
| **消费者组** | 每个消费者独立 ACK，互不影响 |
| **Pending 消息** | XREADGROUP 未 ACK 的消息进入 Pending 列表，可重新消费 |
| **死信队列** | 消费失败超过 N 次的消息转死信队列，人工处理 |
| **消息 TTL** | 设置 MAXLEN ≈ 10000 限制 Stream 大小，防止无限增长 |
| **心跳检测** | ev_notifier.py 定期 XPENDING 检查未确认消息 |

---

## 四、evnotifier 独立运行能力分析

### 4.1 当前状态

| 维度 | 当前状态 | 说明 |
|------|---------|------|
| **独立性** | ✅ 完全独立 | 直接 TCP 连 Upstash，不经过 Vercel |
| **依赖项** | Upstash Redis | 需要 KV_REST_API_URL + KV_REST_API_TOKEN |
| **网站后台依赖** | ❌ 无依赖 | 网站关了也能跑 |
| **实际可用性** | ❌ 不可用 | 无人 PUBLISH 到频道 |

### 4.2 改造后状态

| 维度 | 改造后状态 | 说明 |
|------|-----------|------|
| **独立性** | ✅ 完全独立 | 依然直接 TCP 连 Upstash |
| **离线容错** | ✅ 支持 | Stream 持久化，重连后回放 |
| **多端支持** | ✅ 支持 | 消费者组可添加更多终端 |
| **消息不丢** | ✅ 保证 | XACK 确认 + Pending 重试 |

### 4.3 需要的连接信息

ev_notifier.py 通过环境变量获取连接信息（已支持 `.env` 多路径查找）：

```bash
# ~/.ev-notifier.env 或项目 .env
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=your-token-here
```

这两个值与 Vercel 后台共用同一套 Upstash 实例，evnotifier 解析 URL 提取 host，直接 TCP 连接。

---

## 五、Serverless 端 PUBLISH 的技术难点

### 5.1 为什么 PUBLISH 难以实现？

| 方案 | 问题 |
|------|------|
| **Upstash REST SDK** | `@upstash/redis` 基于 HTTP/REST，**不支持 PUBLISH 命令**（Pub/Sub 需要持久 TCP） |
| **新建 TCP 连接** | Vercel Serverless 每次请求都是新实例，新建 TLS 连接耗时 300ms+，严重拖慢响应 |
| **ioredis** | 依赖 Node.js net 模块，Vercel Serverless 中不可靠 |

### 5.2 为什么 XADD (Stream) 可行？

- `@upstash/redis` REST SDK **支持 XADD 命令**（REST API `/pipeline` 端点支持）
- XADD 是一次性 HTTP 请求，不需要持久连接
- 与当前 `lib/redis.js` 的 Pipeline 模式兼容

---

## 六、实施计划

### 第一阶段：Serverless 端发布消息

**文件改动：**

| 文件 | 改动内容 | 预计工作量 |
|------|---------|-----------|
| `lib/redis.js` | 新增 `xadd`、`xread`、`xgroup` 方法 | 30 行 |
| `lib/notify.js` | 新增 `pushNotification(type, payload)` 函数 | 20 行 |
| `api/activate.js` | 激活成功/失败时调用 pushNotification | 5 行 |
| `api/admin/health.js` | `section=visit` 时调用 pushNotification | 5 行 |
| `api/afdian/query-orders.js` | 新订单时调用 pushNotification | 5 行 |

### 第二阶段：ev_notifier.py 改造

**文件改动：**

| 文件 | 改动内容 | 预计工作量 |
|------|---------|-----------|
| `ev_notifier.py` | SUBSCRIBE → XREADGROUP + Consumer Group | 80 行 |
| `build_app.sh` | 无需改动 | - |

### 第三阶段：多端扩展（可选）

| 终端 | 方案 |
|------|------|
| Mac 语音播报 | ev_notifier.py 内嵌 `say` 命令 |
| Web 后台 | admin_Dx23.html 加 SSE 端点或轮询 XREAD |
| 手机推送 | 后续可加 Bark/Server酱 Webhook |

---

## 七、风险提示

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Stream 消息膨胀 | 中 | 设置 MAXLEN ≈ 10000，定期清理 |
| Upstash REST API XADD 限制 | 低 | 已验证 `@upstash/redis` SDK 支持 XADD |
| Postgres 代理模式无原生 Stream | 中 | 用 `kv_streams` 表模拟，或限制 Stream 仅在 Upstash 模式可用 |
| Vercel Serverless 冷启动延迟 | 低 | XADD 是单次 HTTP 请求，与当前 Pipeline 延迟相当 |

---

## 八、总结

1. **当前 evnotifier 收不到通知的根本原因是：没有任何代码往 `auth:push_channel` 发布消息。** 所有 Serverless API 只发邮件，不推 Redis Pub/Sub。

2. **evnotifier 完全可以脱离网站后台独立运行**，它直接 TCP 连接 Upstash Redis，不依赖 Vercel。

3. **推荐将 Pub/Sub 改为 Stream 架构**，因为：
   - `@upstash/redis` REST SDK 不支持 PUBLISH 但支持 XADD
   - Stream 支持消息持久化，断线不丢通知
   - 消费者组支持多端独立消费
   - 支持消息回溯和历史查询

4. **最关键的改动只有两处**：
   - `lib/redis.js` 加 `xadd` 方法（Serverless 写消息）
   - `ev_notifier.py` 改用 XREADGROUP（Mac 读消息）