# 多端实时通知系统方案分析

## 🎯 需求背景

| 需求 | 说明 |
|------|------|
| **触发事件** | 新订单（爱发电）、新激活、访问量变化、异常告警 |
| **接收终端** | Mac 语音播报、Web 后台推送、手机（可选） |
| **现有架构** | Vercel Serverless Functions + Upstash Redis |
| **预算** | 免费或极低成本 |
| **核心要求** | 稳定、低延迟、多端同时收到 |

---

## 方案一：WebSocket（Vercel Edge Runtime）

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Vercel 平台                           │
│                                                         │
│  ┌─────────────────┐                                    │
│  │  Edge Function   │◄──── 保持长连接 ──── Mac 客户端    │
│  │  /api/ws         │                     (浏览器/终端)  │
│  └────────┬────────┘                                    │
│           │                                             │
│           ▼                                             │
│  ┌─────────────────┐                                    │
│  │  Upstash Redis   │                                   │
│  │  Pub/Sub 模式    │                                   │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────┴────────┐                                    │
│  │  Serverless API  │─── 触发时发布消息 ───┐            │
│  │  (订单/激活等)   │                      │            │
│  └─────────────────┘                      │            │
└─────────────────────────────────────────────┼────────────┘
                                              │
                  Redis Pub/Sub 广播 ──────────┘
```

### Vercel WebSocket 支持现状

Vercel 在 **2024 年正式支持 WebSocket**，但仅限 **Edge Runtime**：

```
✅ 支持: Vercel Edge Functions (WebSocket API)
❌ 不支持: Vercel Serverless Functions (Node.js 运行时)
❌ 限制: 免费版 Hobby 有一定连接数/时间限制
```

| Vercel 计划 | 并发 WebSocket 连接 | 连接时长 | 费用 |
|-------------|-------------------|---------|------|
| Hobby（免费） | ~100 | 最长 24 小时 | $0 |
| Pro ($20/月) | ~1000 | 最长 24 小时 | $20 |
| Enterprise | 定制 | 定制 | 按需 |

### 实现方式（伪代码）

```typescript
// api/ws.ts - Edge Runtime
export const runtime = 'edge';

export default async function handler(req: Request) {
  const upgradeHeader = req.headers.get('upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected websocket', { status: 400 });
  }

  // Vercel 特有的 upgrade 方法
  // @ts-ignore
  const { socket, response } = await req.upgrade();

  socket.onclose = () => console.log('client disconnected');
  socket.onmessage = (ev) => console.log('from client:', ev.data);

  // 从 Upstash Redis Pub/Sub 订阅
  // 收到消息时 socket.send(msg)

  return response;
}
```

### 优点

| ✅ 优点 | 说明 |
|--------|------|
| **零额外成本** | 利用现有 Vercel + Upstash，无需新增服务 |
| **架构统一** | 全部在 Vercel，域名、DNS、HTTPS 一次搞定 |
| **直连低延迟** | 客户端直接连 Vercel，绕开第三方 broker |
| **开发简单** | 一个 Edge Function + Redis Pub/Sub 就搞定 |
| **Mac 端极简** | 浏览器打开 admin 页面即可收到通知，用 Web Speech API 语音播报 |

### 缺点

| ❌ 缺点 | 说明 |
|---------|------|
| **Edge Runtime 限制** | 不能用 Node.js 原生库，部分 npm 包不兼容 |
| **连接数限制** | 免费版 Hobby 连接数有限（但个人使用绰绰有余） |
| **无离线消息** | WebSocket 断开期间的消息会丢失 |
| **较新** | Vercel 的 WebSocket 支持还比较新，文档不算完整 |

---

## 方案二：MQTT（公共 Broker + 自建 Mac 客户端）

### 架构图

```
┌─────────────────────────────┐      ┌─────────────────────┐
│        Vercel               │      │    MQTT Broker       │
│                             │      │                     │
│  Serverless API             │      │  (免费公共服务)       │
│  (订单/激活)                │──pub──►│                     │
│                             │      │  broker.emqx.io:1883 │
│  cron 定时触发              │      │  broker.hivemq.com   │
└─────────────────────────────┘      └──────────┬──────────┘
                                                 │
                    ┌────────────┬───────────────┼──────────────┐
                    │            │               │              │
                    ▼            ▼               ▼              ▼
              ┌─────────┐  ┌─────────┐    ┌─────────┐    ┌─────────┐
              │ Mac 终端 │  │ Mac 终端 │    │ iPhone  │    │ 树莓派   │
              │ 订阅+播报│  │ 后台页面 │    │ 推送    │    │ 灯闪烁  │
              └─────────┘  └─────────┘    └─────────┘    └─────────┘
```

### 免费 MQTT Broker 对比

| Broker | 免费额度 | TLS | 消息保留 | 说明 |
|--------|---------|-----|---------|------|
| **EMQX Public** | 无限连接 | ✅ | QoS 1 保留 | 国内厂商，稳定 |
| **HiveMQ Public** | 无限连接 | ✅ | QoS 1 保留 | 老牌 MQTT 厂商 |
| **Mosquitto (自建)** | 自己服务器 | ✅ | 自己控制 | 最自由但要运维 |
| **CloudMQTT** | 5 设备 / 1000 消息 | ✅ | 有限 | 有免费额度 |

### 实现方式（伪代码）

**Vercel Serverless 发布消息：**

```javascript
// 在任意 API 里（如 api/admin/health.js）
const mqtt = require('mqtt');

async function publishNotification(topic, payload) {
  const client = mqtt.connect('mqtts://broker.emqx.io:8883', {
    clientId: 'app-auth-' + Date.now(),
    connectTimeout: 3000,
  });
  
  return new Promise((resolve, reject) => {
    client.on('connect', () => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, () => {
        client.end();
        resolve();
      });
    });
    client.on('error', reject);
  });
}
```

**Mac 终端订阅器：**

```javascript
// mac-notifier.js - 用 launchd 开机自启
const mqtt = require('mqtt');
const { exec } = require('child_process');

const client = mqtt.connect('mqtts://broker.emqx.io:8883', {
  clientId: 'mac-' + require('os').hostname(),
});

client.subscribe('app-auth/#');

client.on('message', (topic, message) => {
  const data = JSON.parse(message);
  if (topic.includes('new-order')) {
    exec(`say "叮！收到新订单，金额 ${data.amount / 100} 元"`);
    exec(`osascript -e 'display notification "新订单 ¥${data.amount/100}" with title "app-auth"'`);
  }
  if (topic.includes('new-activation')) {
    exec(`say "新设备激活"`);
  }
});
```

### 优点

| ✅ 优点 | 说明 |
|--------|------|
| **架构解耦** | Vercel 只管发布，Broker 管分发，终端自己订阅 |
| **离线消息** | MQTT QoS 1 + 持久会话，终端离线期间的消息不会丢 |
| **多端天然支持** | 手机、平板、IoT 设备、Mac 都能加，架构不变 |
| **成熟稳定** | MQTT 是 IoT 行业标准，协议非常成熟 |
| **不占 Vercel 连接数** | 长连接全在 Broker 上，Vercel 只有瞬时 pub |
| **免费 Broker 够用** | 个人用公共 Broker 完全免费 |

### 缺点

| ❌ 缺点 | 说明 |
|---------|------|
| **多了一个外部依赖** | Broker 挂了就通知不了 |
| **Vercel Serverless 每次冷启动开销大** | `mqtt.connect()` 每次新建 TCP 连接（300ms+），发一条就断 |
| **macOS 要额外跑进程** | 需要在 Mac 上跑 Node.js 脚本，或做成 launchd 服务 |
| **公共 Broker 隐私问题** | 消息明文，不要放敏感信息 |
| **Web 端难直接用** | 浏览器 MQTT over WebSocket 需要 Broker 支持 ws 端口 |

---

## 方案三（推荐）：SSE + Upstash Pub/Sub + 可选轮询守护进程

### 为什么选 SSE？

WebSocket 在 Vercel 上还比较新，MQTT 在 Vercel Serverless 里每次冷启动都要新建 TCP 连接（开销大）。**SSE（Server-Sent Events）是最佳平衡点**：

| 对比项 | SSE | WebSocket | MQTT |
|--------|-----|-----------|------|
| Vercel Edge 支持 | ✅ 完美 | ✅ 支持 | ⚠️ 每次冷启动 |
| 协议复杂度 | 单向，极简 | 双向，复杂 | 复杂 |
| Mac 语音播报 | 浏览器直接用 Web Speech API | 同左 | 需 Node 守护进程 |
| 消息推送方向 | 服务器→客户端（通知场景足够） | 双向 | 双向 |
| 带宽/连接开销 | 最低 | 中 | 低 |
| 离线消息 | ❌ 不支持 | ❌ 不支持 | ✅ 支持 |
| 免费程度 | 100% 免费 | Hobby 免费 | 公共 Broker 免费 |

### 组合方案架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         组合方案                                  │
│                                                                  │
│  场景 1: 浏览器开着（后台管理页面）                                │
│  ┌─────────┐    SSE     ┌─────────────┐    Pub/Sub   ┌─────────┐
│  │ 后台页面 │◄──────────│ Edge Function│◄────────────│ Upstash  │
│  │ Mac 浏览器│  单向推送  │  /api/sse   │   发布消息    │  Redis   │
│  └─────────┘            └─────────────┘              └────┬────┘
│                                                            │
│  场景 2: 浏览器关着，但 Mac 还开着                          │    │
│  ┌─────────┐    HTTP     ┌─────────────┐   轮询(1s)     │    │
│  │ 本地脚本 │◄───────────│ Serverless  │◄────────────────┘    │
│  │ say +   │  检查新消息  │ /api/poll   │   或 Webhook         │
│  │ 通知中心 │             └─────────────┘                     │
│  └─────────┘                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 核心实现要点

**① SSE 端点** — 浏览器打开后台时实时推送

```javascript
// api/sse.js - Edge Runtime
export const runtime = 'edge';

export default async function handler(req) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 心跳保持连接
      const hb = setInterval(() => {
        controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 30000);

      // 订阅 Upstash Pub/Sub (通过 REST API)
      // 收到消息时 controller.enqueue(encoder.encode('data: ' + msg + '\n\n'))
      
      req.signal.addEventListener('abort', () => clearInterval(hb));
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
```

**② 消息发布** — 订单/激活 API 里触发

```javascript
// 在 api/afdian/query-orders.js 有新订单时
await redis.publish('notify', JSON.stringify({
  type: 'order',
  amount: order.amount,
  user: order.user_id,
  time: Date.now()
}));
```

**③ Mac 桌面常驻脚本**（浏览器关了也能收）

```javascript
// mac-daemon.js - 用 launchd 开机自启
const https = require('https');
const { exec } = require('child_process');

let lastCheck = Date.now();
setInterval(async () => {
  const res = await fetch('https://app-auth.gudq.com/api/admin/notifications?since=' + lastCheck);
  const data = await res.json();
  
  for (const notify of data.items) {
    if (notify.type === 'order') {
      exec(`say "叮！新订单 ${notify.amount} 元"`);
      exec(`osascript -e 'display notification "¥${notify.amount}" with title "app-auth"'`);
    }
    if (notify.type === 'activation') {
      exec(`say "新设备激活"`);
    }
  }
  lastCheck = Date.now();
}, 3000);
```

**④ 前端语音播报**（admin_Dx23.html 里）

```javascript
const evtSource = new EventSource('/api/sse');
evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  new Notification('app-auth', { body: getText(data) });
  
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(getSpeechText(data));
    u.lang = 'zh-CN';
    u.rate = 1.1;
    speechSynthesis.speak(u);
  }
};
```

---

## 📊 三方案综合对比

| 维度 | SSE (Edge) | WebSocket (Edge) | MQTT (公共 Broker) |
|------|-----------|------------------|-------------------|
| **Vercel 兼容性** | ⭐⭐⭐⭐⭐ 完美 | ⭐⭐⭐⭐ 较新但OK | ⭐⭐ 每次冷启动开销大 |
| **免费程度** | 100% Hobby 够用 | 100% Hobby 够用 | 公共 Broker 免费 |
| **延迟** | <100ms | <100ms | <50ms |
| **离线消息** | ❌ | ❌ | ✅ QoS 1 |
| **多端扩展** | 浏览器优秀，其他需额外工作 | 同左 | ⭐⭐⭐⭐⭐ IoT 天然支持 |
| **开发复杂度** | 低 | 中 | 中高 |
| **macOS 原生语音** | 浏览器直接 say | 浏览器直接 say | 需 Node 守护进程 |
| **额外依赖** | 无 | 无 | MQTT Broker |
| **稳定性** | Vercel 托管 | Vercel 托管 | 依赖第三方 Broker |
| **适合终端** | Web 为主 | Web 为主 | 全终端 |

---

## 🎯 分阶段实施计划

### 第一阶段（立即可做，零成本）

**SSE + Web Speech API** — 让浏览器开着的时候能收到通知 + 语音播报

```
改动点（预计 2-3 小时）:
1. 新建 /api/sse.js (Edge Runtime, ~50 行)
2. 改 api/afdian/query-orders.js: 新订单时 redis.publish
3. 改 api/admin/direct-activate.js: 新激活时 redis.publish  
4. 改 admin_Dx23.html: 加 EventSource + speechSynthesis
```

### 第二阶段（进阶，还是零成本）

**Mac 本地轮询脚本** — 浏览器关了也能收到

```
改动点:
1. 新建 /api/admin/notifications.js (返回未读通知列表)
2. 写 mac-daemon.js 放在 ~/Library/LaunchAgents/ 下开机自启
3. 用 osascript 弹系统通知 + say 语音播报
```

### 第三阶段（远期，可选）

如果将来需要更多终端（手机推送、IoT 灯闪烁、微信推送），再加 MQTT。届时 Vercel 作为 MQTT publisher，MQTT Broker 做 message broker，多端各自订阅。

---

## 💰 成本估算

| 阶段 | 服务 | 费用 |
|------|------|------|
| 一 | Vercel Hobby + Upstash Free | **$0** |
| 二 | 同上 | **$0** |
| 三 | 同上 + EMQX 公共 Broker | **$0** |

**全部免费，零额外支出。**

---

## 📌 风险提示

| 风险 | 应对 |
|------|------|
| Upstash Pub/Sub 在 Edge Runtime 里是否稳定 | 实测一下，Edge Runtime 支持 fetch 调用 Upstash REST API |
| Vercel Hobby 的 SSE 连接会断 | 前端自动重连（EventSource 自带重连机制） |
| Mac 轮询脚本耗电 | 3 秒一次 HTTP 请求，忽略不计 |
| 公共 MQTT Broker 隐私 | 不发布敏感信息，或用 topic 混淆 |
| Edge Function 冷启动 | SSE 是长连接，一旦建立就常驻，冷启动只在首次 |

---

## 📝 总结

| 你的场景 | 推荐方案 | 理由 |
|---------|---------|------|
| **只想先让 Mac 浏览器收到订单语音** | **SSE** | 浏览器直接 Web Speech API，改几个文件就行 |
| **浏览器关了也要能收** | **SSE + 轮询守护进程** | 零成本，靠 `say` 命令实现语音 |
| **将来想接手机/微信/IoT** | **第三阶段加 MQTT** | 架构天然支持多端扩展 |

**核心结论：MQTT 和 WebSocket 都不如 SSE 适合当前阶段。** SSE 是 Vercel Edge 上最简单、最稳定、最免费的实时推送方案，而且 Mac 端语音播报在浏览器里直接用 `speechSynthesis` API 就能实现，连本地脚本都不用写（第一阶段）。