# EvNotifier 消息投递追踪方案分析

## 1. 问题：手动恢复为什么不管用

### 1.1 当前架构的投递链路

```
Server (Vercel)
  │
  ├── Resend/SMTP ──► QQ邮箱 (邮件通知，有SMTP回执)
  │
  └── Redis PUB/SUB ──► auth:push_channel ──► EvNotifier (Mac通知)
       │
       └── Redis Stream (XADD持久化) ──► 手动恢复时 XRANGE 拉取
```

### 1.2 手动恢复的缺陷

当前手动恢复的逻辑：
1. 用户点击菜单栏「恢复(N)」按钮
2. `do_recovery_poll()` 调用 `XRANGE auth:stream - + COUNT 500`
3. 遍历 Redis Stream 中的所有消息，与本地 `received_idx` 对比
4. 丢失的消息重新 handle_message()

**为什么不管用：**

| 问题 | 根因 |
|------|------|
| **Stream 数据有窗口期** | Redis Stream 有 `maxlen` 限制，旧消息会被自动裁剪，超过窗口期的消息 XRANGE 也拉不到 |
| **PUB/SUB 断线期间的消息** | PUB/SUB 不持久化，断线期间 Server 发的消息直接丢失，Stream 里可能也没有（如果 Server 没写 Stream） |
| **本地 JSON 文件损坏** | `~/.ev_received.json` 是单文件存储，写入时崩溃会导致整个文件损坏，恢复时无法判断丢失了哪些 |
| **idx/total_daily 不准确** | 依赖 Server 端的 `total_daily` 计数，如果 Server 重启后计数器重置，客户端会误判为大量丢失 |
| **无服务端确认机制** | Server 不知道自己发的消息 Mac 端是否收到，也无法主动补发 |
| **无状态可审计** | 没有一条消息的完整生命周期记录，排查问题时只能靠本地 debug 日志 |

### 1.3 核心矛盾

```
Server 视角：  "我发出去了"  (PUBLISH 成功 = 发送完成)
Client 视角：  "我没收到"    (Mac 没弹出通知)
                      ↕
       没有中间状态来对齐这两个视角
```

---

## 2. 方案：Supabase 消息投递明细表

### 2.1 设计目标

在 Supabase PostgreSQL 中建立一张消息投递明细表，记录每条消息从生成到确认的全生命周期。

```
┌─────────────────────────────────────────────────────────┐
│                  消息生命周期                             │
│                                                         │
│  Created → Published → Delivered → Confirmed            │
│    │          │            │           │                │
│    ▼          ▼            ▼           ▼                │
│  生成消息   推送到Redis  Mac端收到  用户看到通知         │
│              PUB/SUB                 (点击/关闭)         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 表结构设计

```sql
-- Supabase PostgreSQL
create table message_delivery (
  -- 主键
  id            bigserial primary key,
  message_id    varchar(64) not null,     -- 消息唯一ID (uuid or server_generated)
  
  -- 消息内容
  message_type  varchar(32) not null,     -- new_order / activation / activation_failure / page_visit / system
  payload       jsonb not null default '{}',  -- 消息体内容
  source        varchar(64) not null,     -- 来源：activate.js / afdian/orders.js / admin
  
  -- 投递目标
  channel       varchar(64) not null default 'auth:push_channel',  -- Redis channel
  target_client varchar(128),             -- 目标客户端标识 (Mac序列号/设备指纹)
  
  -- 时间线（核心）
  created_at    timestamptz not null default now(),  -- 消息生成时间
  published_at  timestamptz,              -- PUBLISH 到 Redis 的时间
  delivered_at  timestamptz,              -- Mac EvNotifier 收到并回调确认的时间
  confirmed_at  timestamptz,              -- 用户实际看到/点击通知的时间
  
  -- 状态
  status        varchar(16) not null default 'pending',  
                -- pending → published → delivered → confirmed
                -- 或: failed (投递失败)
  
  -- 错误信息
  error_message text,                     -- 投递失败时的错误描述
  retry_count   int not null default 0,   -- 已重试次数
  
  -- 关联信息
  related_code  varchar(32),              -- 关联的兑换码/订单号
  related_device varchar(128)             -- 关联设备ID
);

-- 索引
create index idx_message_delivery_status on message_delivery(status);
create index idx_message_delivery_created on message_delivery(created_at desc);
create index idx_message_delivery_message_id on message_delivery(message_id);
create index idx_message_delivery_related_code on message_delivery(related_code);
```

### 2.3 状态流转

```
pending ──► published ──► delivered ──► confirmed
  │            │              │
  ▼            ▼              ▼
failed     failed         expired
(重试上限)   (网络错误)    (超时未确认)
```

| 状态 | 含义 | 触发时机 |
|------|------|----------|
| `pending` | 消息已创建，等待投递 | Server 端调用 `createMessage()` |
| `published` | 已 PUBLISH 到 Redis | `PUBLISH auth:push_channel` 成功后回调 |
| `delivered` | Mac 端已收到 | EvNotifier 收到消息后，调用 HTTP API 回调确认 |
| `confirmed` | 用户已查看 | 用户点击通知或打开面板后回调 |
| `failed` | 投递失败 | PUBLISH 失败、或超时未 delivered |

---

## 3. 实现方式

### 3.1 Server 端写入（Vercel Serverless）

在 `lib/notify.js` 或新增 `lib/message-delivery.js`：

```javascript
// lib/message-delivery.js
// 在 supabase 中创建消息投递记录

async function createMessageDelivery({ type, payload, source, relatedCode, relatedDevice }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  
  var messageId = generateUUID();  // 或使用有序ID
  
  var record = {
    message_id: messageId,
    message_type: type,
    payload: JSON.stringify(payload),
    source: source,
    created_at: new Date().toISOString(),
    status: 'pending'
  };
  if (relatedCode) record.related_code = relatedCode;
  if (relatedDevice) record.related_device = relatedDevice;
  
  // 写入 Supabase
  await supabase.from('message_delivery').insert([record]);
  
  return messageId;
}

async function markPublished(messageId) {
  await supabase.from('message_delivery')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('message_id', messageId);
}

async function markFailed(messageId, error) {
  await supabase.from('message_delivery')
    .update({ status: 'failed', error_message: error })
    .eq('message_id', messageId);
}
```

在发送消息的地方集成：

```javascript
// api/activate.js - 激活成功时
var msgId = await createMessageDelivery({
  type: 'activation',
  payload: { deviceId, productId, months },
  source: 'activate.js',
  relatedCode: redeemCode,
  relatedDevice: deviceId
});

// PUBLISH 到 Redis
await publishToRedis(channel, { messageId: msgId, ...data });
await markPublished(msgId);
```

### 3.2 EvNotifier 端回调确认（Mac）

EvNotifier 收到消息后，调用 HTTP API 回调标记 delivered：

```python
# ev_notifier.py - 收到消息后回调确认

def handle_message(msg):
    message_id = msg.get("message_id")
    
    # 弹出 Mac 通知
    notify_macos(title, subtitle, body)
    
    # 异步回调确认（不阻塞通知显示）
    if message_id:
        threading.Thread(target=delivery_callback, args=(message_id,), daemon=True).start()

def delivery_callback(message_id):
    """回调确认消息已送达"""
    try:
        url = f"{BASE_URL}/api/message-delivery/callback"
        data = json.dumps({
            "message_id": message_id,
            "event": "delivered",       # delivered / confirmed
            "client_id": CLIENT_ID,     # 本地机器标识
            "received_at": datetime.now().isoformat()
        })
        # POST 到 Serverless API
        req = urllib.request.Request(url, data=data.encode(), 
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        debug_log(f"delivery callback failed: {e}")
```

### 3.3 Server 端回调 API

```javascript
// api/message-delivery/callback.js
// EvNotifier 回调确认的 API

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  var { message_id, event, client_id, received_at } = req.body;
  if (!message_id || !event) return res.status(400).json({ error: 'Missing fields' });
  
  var update = {};
  if (event === 'delivered') {
    update.status = 'delivered';
    update.delivered_at = received_at || new Date().toISOString();
  } else if (event === 'confirmed') {
    update.status = 'confirmed';
    update.confirmed_at = received_at || new Date().toISOString();
  } else {
    return res.status(400).json({ error: 'Invalid event' });
  }
  
  await supabase.from('message_delivery')
    .update(update)
    .eq('message_id', message_id)
    .eq('status', 'published');  // 只更新 published 状态的消息
  
  res.json({ success: true });
}
```

---

## 4. 方案优势与收益

### 4.1 解决手动恢复不管用的问题

| 当前问题 | 解决方式 |
|----------|----------|
| 不知道消息是否送达 | 查看 `delivered_at` 字段，Server 端可明确看到每条消息的送达状态 |
| 丢失后无法准确恢复 | 查询 `status != delivered AND created_at > now() - 24h` 即可知道哪些消息需要补发 |
| 没有回执 | EvNotifier 的回调提供了「已送达」确认，比单纯 PUBLISH 成功可靠得多 |
| 排查困难 | 后台管理页面可直接查询 message_delivery 表，按状态/时间筛选，定位问题 |

### 4.2 新增能力

```
管理后台新增「消息投递」页面，可查看：
┌──────────────────────────────────────────────────┐
│ 时间         │ 类型      │ 状态      │ 关联       │
├──────────────────────────────────────────────────┤
│ 2026-09-17   │ activation │ ✅ delivered │ 兑换码 A1B2  │
│ 2026-09-17   │ new_order  │ ✅ confirmed│ 订单 12345   │
│ 2026-09-16   │ new_order  │ ❌ failed    │ 订单 12344   │
│ 2026-09-16   │ page_visit │ ⏳ pending   │ 设备 xxx     │
└──────────────────────────────────────────────────┘

每条消息可展开查看完整时间线：
┌─────────────────────────────────────────────┐
│ Message ID: msg_abc123                       │
│ 创建时间:   2026-09-17 10:00:00             │
│ PUBLISH:    2026-09-17 10:00:01 (+1s)      │
│ 送达:       2026-09-17 10:00:03 (+2s)      │  ← 有就用，没有就是丢了
│ 确认:       2026-09-17 10:00:30 (+30s)     │  ← 用户看到了
└─────────────────────────────────────────────┘
```

### 4.3 精确的补发机制

不再使用 XRANGE 全量扫描做对比，而是通过查询 Supabase 获取明确未送达的消息：

```sql
-- 获取近24小时内未送达的消息，用于补发
select * from message_delivery
where status in ('pending', 'failed')
  and created_at > now() - interval '24 hours'
order by created_at;
```

EvNotifier 的「手动恢复」按钮变更为「获取未送达消息」：

```
旧：XRANGE 全量扫描 + 本地对比  →  慢、不准、依赖本地 JSON
新：查询 Supabase 未送达列表      →  快、准、服务端权威
```

---

## 5. 成本与风险

### 5.1 Supabase 成本

| 项目 | 估算 |
|------|------|
| **存储** | 每条消息 ~500B，日均 1000 条 = ~500KB/天，年 ~180MB（Supabase 免费 500MB，够用） |
| **查询** | 按时间/状态查询，创建索引后压力很小 |
| **写入** | 每条消息写入 1 次 + 更新 1~2 次（状态变更） |

### 5.2 风险与应对

| 风险 | 应对 |
|------|------|
| **Supabase 休眠** | 如果项目进入免费版休眠，写入会失败。需要配合 keep-alive 机制 |
| **回调延迟** | EvNotifier 回调网络延迟可能导致状态更新不及时，可加入超时机制（如 30 秒未回调自动标记 failed） |
| **消息量暴增** | 每天自动清理 7 天前的记录，或归档到历史表 |
| **EvNotifier 离线** | 如果 Mac 关机，回调永远不会触发，消息会一直 stuck 在 published。可加入过期策略：超过 1 小时未 delivered 自动标记为 failed |

### 5.3 对 Redis 命令消耗的影响

| 操作 | 当前 | 新增 |
|------|------|------|
| PUBLISH 消息 | 1 次 | 1 次（不变）|
| 写入 Stream | 1 次 XADD | 可选移除 |
| 手动恢复 | N 次 XRANGE | 0 次（改为查 Supabase）|
| **总计变化** | — | **减少 Redis 命令消耗** |

---

## 6. 实施路线

### Phase 1：表结构与写入（1天）

- [ ] 在 Supabase 创建 `message_delivery` 表
- [ ] 在 `lib/` 新增 `message-delivery.js`
- [ ] 在 `api/activate.js` 集成：生成消息 → 写入 Supabase → PUBLISH → 更新状态
- [ ] 在 `api/afdian/orders.js` 集成：订单同步时生成消息记录
- [ ] 在 `lib/notify.js` 集成：发邮件时也写入记录（邮件也有投递状态）

### Phase 2：EvNotifier 回调（1天）

- [ ] 在 EvNotifier `handle_message()` 中加入回调确认逻辑
- [ ] 新增 `api/message-delivery/callback.js` 处理回调
- [ ] 测试：Server 发消息 → Supabase 记录 → EvNotifier 收到 → 回调确认 → 状态更新

### Phase 3：管理后台（1天）

- [ ] 在 `admin_Dx23.html` 新增「消息投递」Tab
- [ ] 投递列表：按时间/类型/状态筛选
- [ ] 详情展开：显示完整时间线
- [ ] 补发按钮：手动补发未送达的消息（调用 PUBLISH 重试）

### Phase 4：补发机制替换（0.5天）

- [ ] EvNotifier 的「手动恢复」改为查询 Supabase 未送达列表
- [ ] 移除 XRANGE 全量扫描逻辑（或降级为兜底方案）
- [ ] 移除 `~/.ev_received.json` 的完整性校验依赖

---

## 7. 总结

| 维度 | 当前方案（PUB/SUB + XRANGE） | 新增 Supabase 投递追踪 |
|------|-----------------------------|----------------------|
| 消息投递状态 | 不可知 | 全量可追踪 |
| 丢失检测 | 本地 JSON 对比，不可靠 | 服务端 SQL 查询，精确 |
| 丢失恢复 | XRANGE 全量扫描，慢且受窗口期限制 | 查询未送达列表，直接补发 |
| 排查效率 | 翻本地 debug 日志 | 管理后台直接查数据库 |
| 成本 | Redis 命令消耗（XRANGE） | Supabase 存储（免费额度足） |
| 架构复杂度 | 低 | 中（新增一张表 + 一个回调 API） |

**结论：推荐实施。** 核心价值不是「增加一个表」，而是**让消息投递从不可知变成可知**。当前手动恢复不管用的根本原因是没有服务端视角的投递状态，有了这张表，丢失检测、补发、排查都变得可观测、可管理。