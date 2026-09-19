# 消息投递失败分析

> 问题：`new_activation` 消息全部 `⏳ 待投递`，但 `new_order` 和 `activation_failure` 全部 `✅ 已送达`。
> 数据来源：管理后台 → 消息投递页面。

---

## 一、现象回顾

从消息投递面板的数据统计（2026-09-17 ~ 2026-09-19，共 44 条）：

| 消息类型 | 状态 | 数量 | 规律 |
|----------|------|:---:|------|
| `new_activation` (source=user) | ⏳ 待投递 | 7 条 | **全部卡在待投递** |
| `new_activation` (source=user-reuse) | ✅ 已送达 | 1 条 | 正常 |
| `activation_failure` | ✅ 已送达 | 全部 | 正常 |
| `new_order` | ✅ 已送达 | 全部 | 正常 |

抽取典型时间线对比：

```
类型                   来源           状态
─────────────────────────────────────────────────
new_activation         user           ⏳ 3:04:03 PM            ← 卡住
activation_failure     user           ✅ 3:03:45→📤3:03:45→✅3:03:46  ← 正常
new_activation         user           ⏳ 2:54:59 PM            ← 卡住
activation_failure     user           ✅ 2:54:16→📤2:54:16→✅2:54:20  ← 正常
new_order              user           ✅ 11:53:23→📤11:53:23→✅11:53:24 ← 正常
```

> 同一个 IP（112.224.192.42）的 `activation_failure` 全部正常送达，`new_activation` 全部卡在待投递。同一用户、同一网络环境、同一个 Serverless Function，排除网络/Redis 问题。

---

## 二、投递状态流转机制

```
pushNotification() 调用
       │
       ▼
  createMessageDelivery()  ──→  状态 = "pending"（⏳ 待投递）
       │
       ▼
  Redis XADD + PUBLISH
       │
       ▼
  markPublished()         ──→  状态 = "published"（📤 已发送）
       │
       ▼
  EvNotifier 收到消息
       │
       ▼
  delivery_callback()     ──→  状态 = "delivered"（✅ 已送达）
```

卡在 `pending` 意味着：**`createMessageDelivery()` 执行了，但 `markPublished()` 从未被调用。**

---

## 三、根因定位

### 文件：`api/activate.js`

正常激活成功路径（第 516-543 行）：

```javascript
// 先发送 HTTP 响应
res.json({ success: true, activationCode: activationCode, ... });

// 再 fire-and-forget 推送通知（无 await！）
notify.pushNotification("new_activation", {
    redeem_code: code,
    activation_code: activationCode,
    product_id: productId,
    device_id: device,
    months: months,
    source: "user",
    ...
}).catch(function () {});    // ← 没有 await
```

对比激活失败路径（第 202-210 行，以兑换码校验失败为例）：

```javascript
// pushNotification 在 res.json 之前，且带 await
await notify.pushNotification("activation_failure", {
    reason: codeCheck.error,
    redeem_code: redeemCode || "",
    device_id: deviceCheck.value || "",
    source: "user",
    ...
}).catch(function () {});    // ← 有 await
return res.status(400).json({ success: false, error: codeCheck.error, ... });
```

### 🔴 三个问题叠加导致失败

| # | 问题 | 说明 |
|---|------|------|
| 1 | **`pushNotification` 在 `res.json()` 之后** | Vercel Serverless 在发送 HTTP 响应后可能立即冻结函数 |
| 2 | **`pushNotification` 没有 `await`** | fire-and-forget，函数不等待推送完成就继续 |
| 3 | **Vercel 冻结时机不可控** | `createMessageDelivery()`（写 Postgres）先完成，记录状态为 `pending`；Redis 推送和 `markPublished()` 被冻结截断 |

### 验证：`user-reuse` 路径为什么正常

同一个文件中，已有设备复用的路径（第 410 行附近）：

```javascript
// user-reuse 路径：await 在 res.json 之前 ✅
await notify.pushNotification("new_activation", {
    ...
    source: "user-reuse",
}).catch(function () {});
```

这条路径有 `await`，所以表中唯一一条 `new_activation (source=user-reuse)` 显示 `✅ 已送达`。

---

## 四、完整对比：为什么其他类型正常

| 消息类型 | 文件 | await? | 在 res.json 前? | 投递结果 |
|----------|------|:---:|:---:|:---:|
| `new_activation` (user) | activate.js | ❌ | ❌ | ⏳ 卡住 |
| `new_activation` (user-reuse) | activate.js | ✅ | ✅ | ✅ 正常 |
| `activation_failure` (全部) | activate.js | ✅ | ✅ | ✅ 正常 |
| `new_order` | afd-order-webhook.js | ✅ | - | ✅ 正常 |

---

## 五、修复方案

### 方案 A：加 `await`（推荐，改动最小）

**文件**：`api/activate.js`，第 533-543 行

```javascript
// 改前（fire-and-forget）
notify.pushNotification("new_activation", {...}).catch(function () {});

// 改后（await）
await notify.pushNotification("new_activation", {...}).catch(function () {});
```

### 方案 B：将 pushNotification 移到 res.json() 之前

```javascript
// 先推送
await notify.pushNotification("new_activation", {...});

// 再响应
res.json({ success: true, ... });
```

### 建议

**方案 A 即可**，改一行字符（加 `await`）。但需同时检查 `api/activate.js` 中 catch 块的 `activation_failure` 推送是否也有同样问题——目前 catch 块里的 `pushNotification` 也是在 `res.json()` 之后且无 `await`。

---

## 六、副作用说明

- **不影响用户体验**：消息实际上可能已经被推送到了 Redis（取决于 Vercel 冻结时机），EvNotifier 能收到通知弹窗；只是数据库中投递状态未更新为 `delivered`
- **不影响 EvNotifier 功能**：EvNotifier 直接从 Redis PUB/SUB 接收消息，不依赖 Postgres 的投递状态表
- **仅影响后台"消息投递"页面的状态展示**：导致运维无法准确知道哪些消息已送达

---

## 七、额外发现：通用异常处理块也有同样问题

`api/activate.js` 最外层 `catch` 块（第 553-562 行）：

```javascript
res.status(500).json({ success: false, error: msg, ... });

// 以下两行都是 fire-and-forget，无 await
notify.sendActivationFailure(req, {...}).catch(function () {});
notify.pushNotification("activation_failure", {...}).catch(function () {});
```

虽然当前这个 catch 块极少触发，但也应该在修复时一并处理。