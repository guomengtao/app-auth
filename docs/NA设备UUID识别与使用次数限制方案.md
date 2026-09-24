# NA 设备（UUID 型设备ID）识别与兑换码使用次数限制方案

> 日期：2026-09-23 · 涉及文件：`lib/validate.js`、`api/activate.js`、`activate.html`
> 背景：部分设备（如手环）无法获取稳定的设备唯一标识，只能生成 UUID 作为临时标识。用户重装应用后 UUID 变化，导致同一兑换码无法在新 UUID 上激活。本方案让系统识别这类「NA 设备」并为兑换码设置使用次数上限。

---

## 一、问题分析

### 1.1 为什么会有 UUID 型设备 ID

手环/手表等嵌入式设备在特定条件下（固件版本、权限限制、蓝牙 MAC 不可读）无法获取系统级唯一标识，只能回落生成本地随机 UUID，例如：

```
550e8400-e29b-41d4-a716-446655440000
UUID:3f8a912c-b71e-4d52-9c31-d8e5f2a1476b
```

**重装应用 → 本地存储清空 → 生成全新 UUID → 设备 ID 变了**。

### 1.2 当前行为

| 场景 | 当前行为 | 问题 |
|------|---------|------|
| 兑换码未使用 | 正常激活 ✅ | — |
| 同一设备再次激活 | 复用旧激活码 ✅ | — |
| **不同设备**（UUID 变了）使用同一兑换码 | ❌ `该兑换码已被其他设备使用过` | 用户换不了设备，码废了 |

### 1.3 现状：已有的 NA 拦截

当前 `lib/validate.js` 里已有 `INVALID_DEVICE_TOKENS` 对 `"NA"`、`"null"` 等字符串做了拦截：

```javascript
var INVALID_DEVICE_TOKENS = {
  NA: 1, "N/A": 1, NULL: 1, UNDEFINED: 1, NONE: 1, UNKNOWN: 1, ...
};
```

但这只拦截了**字符串形式的无效值**，没有处理「看起来合法但实际不稳定」的 UUID 型 ID。UUID 是**合法的设备标识格式**（36 字节 → `normalizeDeviceId` 取后 4 位 → 看起来和正常设备一样），所以**不会被当前逻辑拦截**，会正常激活。

---

## 二、方案设计

### 2.1 核心思路

```
正常设备：1 个兑换码 ↔ 1 个设备（当前行为，不变）
NA 设备：  1 个兑换码 → N 个 NA 设备（N ≤ 上限，默认 5）
```

**两个关键动作**：
1. **识别**：判断设备 ID 是否为 UUID 型（→ 打上 NA 标签）
2. **放行**：兑换码已用时，如果是 NA 设备且使用次数未到上限，允许再次激活

### 2.2 UUID 识别规则

满足以下任一条件即视为 NA 设备：

| 条件 | 示例 | 正则 |
|------|------|------|
| 标准 UUID v4 格式 | `550e8400-e29b-41d4-a716-446655440000` | `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` |
| 带 `UUID:` 前缀 | `UUID:3f8a912c-b71e-4d52-9c31` | `/^uuid:/i` |
| 纯 32 位 hex（无连字符 UUID） | `3f8a912cb71e4d529c31d8e5f2a1476b` | `/^[0-9a-f]{32}$/i` |

> **注意**：「纯 32 位 hex」需要谨慎——有些正常设备可能恰好用 32 位 hex 作为 ID。如果担心误伤，可以先只启用前两条规则，把纯 32 位 hex 放在观察名单。

### 2.3 兑换码使用次数上限

在兑换码 Redis 记录中新增字段：

```json
{
  "code": "A1B2",
  "product_id": "01",
  "duration_months": 12,
  "used": true,
  "used_device_id": "abc123...",
  "na_usage_count": 2,
  "na_usage_limit": 5
}
```

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `na_usage_count` | number | 已有多少个 NA 设备用此码激活过 | 0 |
| `na_usage_limit` | number | NA 设备最大可激活次数 | 5 |

**计数规则**：
- 同一 NA 设备（同一 UUID）重复激活**不累计** `na_usage_count`（等同于「同一设备再次激活 → 复用」）
- 不同 NA 设备用同一兑换码激活**累计** `na_usage_count`
- 正常设备（非 NA）激活**不累计** `na_usage_count`，一个码绑一个设备不变

### 2.4 管理后台可配上限

- 兑换码生成时允许设置 `na_usage_limit`（默认 5）
- 后台兑换码列表显示 `NA设备已用次数 / 上限`
- 管理员可手动调整单码的 `na_usage_limit`

---

## 三、代码改动

### 3.1 `lib/validate.js` — 新增 NA 设备判定

```javascript
// ======================== 新增：NA 设备识别 ========================
// NA = Not Available：设备无法提供稳定唯一标识，只能用临时 UUID
// 重装应用后 UUID 改变，需要允许兑换码被多个 NA 设备使用（上限控制）

// UUID 标准格式（含连字符）
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 部分设备在前面加 UUID: 前缀
var UUID_PREFIX_PATTERN = /^uuid:/i;

// 纯 32 位 hex（观察中，可能误伤，先放注释）
// var UUID_HEX32_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * 判断设备 ID 是否为 NA 类型（无法获取稳定标识，使用临时 UUID）
 * @param {string} rawDeviceId - 原始设备 ID
 * @returns {boolean}
 */
function isNaDeviceId(rawDeviceId) {
  var s = String(rawDeviceId == null ? "" : rawDeviceId).trim();
  if (!s) return false;
  if (UUID_PREFIX_PATTERN.test(s)) return true;
  if (UUID_PATTERN.test(s)) return true;
  return false;
}

// 导出
module.exports = {
  // ... 原有导出 ...
  isNaDeviceId: isNaDeviceId,
  UUID_PATTERN: UUID_PATTERN,
};
```

### 3.2 `api/activate.js` — 激活逻辑改造

#### 3.2.1 引入判定函数

文件顶部引入：

```javascript
var validate = require("../lib/validate.js");
var isNaDeviceId = validate.isNaDeviceId;  // 新增
```

#### 3.2.2 NA 设备使用次数上限常量

```javascript
var NA_USAGE_LIMIT_DEFAULT = 5;  // NA 设备默认最大使用次数
```

#### 3.2.3 改造「兑换码已用」分支

当前代码（`activate.js:545-681`）的 `if (info.used)` 分支需要改造：

**改动前（简化）**：

```javascript
if (info.used) {
  if (info.used_device_id === deviceHash) {
    // 同一设备 → 复用激活码
  } else {
    // 不同设备 → 拦截，报错
    saveFailureRecord("该兑换码已被其他设备使用过", ...);
    return res.status(400).json({ success: false, error: "该兑换码已被其他设备使用过…" });
  }
}
```

**改动后**：

```javascript
if (info.used) {
  if (info.used_device_id === deviceHash) {
    // 同一设备 → 复用激活码（行为不变）
    // ... 原有代码 ...
  } else {
    // 不同设备 → 先判断是否为 NA 设备
    var deviceIsNa = isNaDeviceId(rawDeviceId);
    var naLimit = Number(info.na_usage_limit) || NA_USAGE_LIMIT_DEFAULT;
    var naCount = Number(info.na_usage_count) || 0;

    if (deviceIsNa && naCount < naLimit) {
      // ========== NA 设备尚未达上限，允许激活 ==========

      var activationCodeNa = crypto.generateActivationCode(productId, device, months, code);
      var naNow = Date.now();
      var naSeq = Number(info.activation_seq) || 0;
      var naPrevRecord = parseRedisJson(await redis.get("auth:activation:" + activationCodeNa));
      var naFirstActivatedAt = naNow;
      if (naPrevRecord) {
        naFirstActivatedAt = naPrevRecord.first_activated_at || naPrevRecord.generated_at || naNow;
        if ((Number(naPrevRecord.activation_seq) || 0) > naSeq) naSeq = Number(naPrevRecord.activation_seq);
      }
      var naFinalSeq = naSeq + 1;
      var naMember = activationCodeNa + ":" + naFinalSeq;

      var naExpiresAt = null;
      if (months !== 99) {
        var naBaseTs = naNow;
        if (naPrevRecord && naPrevRecord.expires_at && Number(naPrevRecord.expires_at) > naBaseTs) {
          naBaseTs = Number(naPrevRecord.expires_at);
        }
        var naExpiryDate = new Date(naBaseTs);
        naExpiryDate.setUTCMonth(naExpiryDate.getUTCMonth() + months);
        naExpiresAt = naExpiryDate.getTime();
      }

      // 更新兑换码记录：递增 NA 使用次数
      var naUpdated = JSON.parse(JSON.stringify(info));
      naUpdated.na_usage_count = naCount + 1;
      naUpdated.used_device_id = deviceHash;       // 记录最新 NA 设备
      naUpdated.used_at = naNow;
      naUpdated.activation_seq = naFinalSeq;
      naUpdated.generated_activation_code = activationCodeNa;

      var naRecord = {
        activation_code: activationCodeNa,
        activation_member: naMember,
        activation_seq: naFinalSeq,
        is_repeat: true,
        is_na: true,                               // ← 标记 NA 设备激活
        na_device_index: naCount + 1,              // ← 第几个 NA 设备
        first_activated_at: naFirstActivatedAt,
        device_id_hash: deviceHash,
        device_id: device,
        device_id_full: rawDeviceId,
        product_id: productId,
        duration_months: months,
        redeem_code: code,
        generated_at: naNow,
        expires_at: naExpiresAt,
        device_info: deviceInfo || null,
        visitor_info: visitorInfo,
      };

      var naPipeline = redis.pipeline();
      naPipeline.set("auth:redeem:" + code, JSON.stringify(naUpdated));
      naPipeline.set("auth:activation:" + naMember, JSON.stringify(naRecord));
      naPipeline.sadd("auth:activation_codes", naMember);
      naPipeline.set("auth:device:" + deviceHash, activationCodeNa);
      await naPipeline.exec();

      // 追踪
      background.run(tracking.record({
        ts: naNow, kind: "activation",
        deviceId: rawDeviceId || device,
        ip: (visitorInfo && visitorInfo.ip) || "",
        redeemCode: code,
        activationCode: activationCodeNa,
        payload: {
          product_id: productId, months: months,
          is_na: true, na_device_index: naCount + 1,
          model: (deviceInfo && tracking.pickModel(deviceInfo.model, deviceInfo.product)) || "",
        },
        dedupeKey: "ac:" + naMember,
      }), "tracking");

      // 通知
      await notify.pushNotification("new_activation", {
        redeem_code: code,
        activation_code: activationCodeNa,
        product_id: productId,
        device_id: device,
        months: months,
        is_na: true,
        na_usage: (naCount + 1) + "/" + naLimit,
        source: "user-na",
        ip: visitorInfo ? visitorInfo.ip : "",
      }).catch(function () {});

      rateLimit.clearDeviceRateLimit(device).catch(function () {});
      return res.json({
        success: true,
        activationCode: activationCodeNa,
        naDevice: true,
        naUsage: (naCount + 1) + "/" + naLimit,
      });
    }

    // 不是 NA 设备，或已达上限 → 报「已被其他设备使用」
    saveFailureRecord("该兑换码已被其他设备使用过", device, code, productId, months, visitorInfo, deviceInfo);
    var alreadyUsedNotifyResult = await notify.sendActivationFailure(req, {
      reason: "该兑换码已被其他设备使用过，无法重复激活" + (deviceIsNa ? "（NA设备使用次数已达上限 " + naCount + "/" + naLimit + "）" : ""),
      redeemCode: code,
      deviceId: device,
      productId: productId,
      months: months,
      source: "user",
    }).catch(function () {});
    // ... 原有通知 ...
    return res.json({ success: false, error: "该兑换码已被其他设备使用过，无法重复激活。如需解绑请联系作者（QQ群/微信）" });
  }
}
```

### 3.3 `activate.html` — 前端提示（可选）

当激活接口返回 `naDevice: true` 时，前端可以给出提示，让用户知道：

```javascript
if (data.naDevice) {
  showResult('success',
    '激活成功！激活码：' + data.activationCode +
    '\n⚠️ 您的设备使用临时标识，重装应用后可能需要重新激活（该兑换码还可使用 ' +
    (5 - data.naUsage.split('/')[0]) + ' 次）'
  );
}
```

---

## 四、数据流示意

```
用户 A（正常设备 ID: Aa09）
  └→ 兑换码 B1C2 → 激活成功 ✅
       redeemed: { used: true, used_device_id: "hash(Aa09)", na_usage_count: 0 }

用户 B（NA 设备 UUID: 550e8400-e29b-...）
  └→ 同一兑换码 B1C2
       → isNaDeviceId() = true ✅
       → na_usage_count(0) < na_usage_limit(5) ✅
       → 激活成功 ✅
       redeemed: { na_usage_count: 1 }

用户 B 重装应用（新 UUID: 7f3b621a-c84d-...）
  └→ 同一兑换码 B1C2
       → isNaDeviceId() = true ✅
       → na_usage_count(1) < na_usage_limit(5) ✅
       → 激活成功 ✅
       redeemed: { na_usage_count: 2 }

...第 6 次重装后...
  └→ na_usage_count(5) = na_usage_limit(5) ❌
       → 拦截：该兑换码已被其他设备使用过（NA设备已达上限 5/5）
```

---

## 五、管理后台展示（可选改进）

在 `admin_Dx23.html` 兑换码管理面板中：

| 列 | 说明 |
|---|------|
| NA 设备使用次数 | 显示 `na_usage_count / na_usage_limit` |
| NA 上限调整 | 管理员可调单个兑换码的 `na_usage_limit`（默认 5 → 可改为 10） |
| NA 设备列表 | 点击查看哪些 UUID 设备使用过该兑换码 |

实现方式：
- 在 `api/admin/redeem-codes.js` 返回兑换码列表时加上 `na_usage_count`、`na_usage_limit` 字段
- 在 `api/admin/redeem-codes.js` 添加调整 `na_usage_limit` 的 API

---

## 六、后台日志面板显示

激活记录中新增 `is_na` 字段后，后台「激活记录」面板可以新增一列或筛选：

- 显示标签：`🔵 NA设备`（第 N 次）
- 筛选：只看 NA 设备激活记录
- 统计：NA 设备激活占比

---

## 七、测试用例

| # | 场景 | 输入 | 预期 |
|---|------|------|------|
| 1 | 正常设备 + 未用兑换码 | deviceId=`Aa09`, code=`B1C2` | 激活成功 |
| 2 | NA 设备 + 未用兑换码 | deviceId=`550e8400-e29b-41d4-a716-446655440000`, code=`B1C2` | 激活成功，标记 `is_na: true` |
| 3 | 同一 NA 设备再次激活 | 同一个 UUID，同一兑换码 | 复用（不累计 na_usage_count） |
| 4 | NA 设备使用已被正常设备用过的码 | normal 用过后 NA 设备来用 | 激活成功，na_usage_count=1 |
| 5 | NA 设备使用已达上限的码 | na_usage_count=5, na_usage_limit=5 | 拦截：「该兑换码已被其他设备使用过」 |
| 6 | 正常设备使用已被 NA 设备用过的码 | NA 用过后 normal 设备来用 | 拦截（正常设备不能共享码） |
| 7 | UUID: 前缀设备 ID | deviceId=`UUID:3f8a912c-b71e-...` | 正确识别为 NA 设备 |
| 8 | NA 设备 + 已达上限 → 拦截后文案 | 上限 5/5 | 错误提示包含「NA设备已达上限 5/5」 |
| 9 | 正常设备短 ID | deviceId=`Aa09` | `isNaDeviceId()` 返回 false |

---

## 八、改动清单

| 文件 | 改动内容 | 风险 |
|------|---------|------|
| `lib/validate.js` | 新增 `isNaDeviceId()` + UUID 正则 | 零风险（纯新增函数） |
| `api/activate.js` | `info.used` 分支加 NA 设备判断 + 使用次数逻辑 | 中等（需仔细测试不影响正常设备） |
| `activate.html` | 前端接收 `naDevice` 字段，展示友好提示 | 低 |
| `api/admin/redeem-codes.js` | 兑换码列表返回 `na_usage_count`/`na_usage_limit` | 低 |
| `admin_Dx23.html` | 兑换码管理面板显示 NA 设备列 | 低 |

---

## 九、实施步骤

1. **Phase 1**：`lib/validate.js` 加 `isNaDeviceId()`，单元测试覆盖所有 UUID 变体
2. **Phase 2**：`api/activate.js` 改 `info.used` 分支，先在测试环境验证
3. **Phase 3**：`activate.html` 前端提示
4. **Phase 4**：后台面板展示 NA 设备列（可选）
5. **Phase 5**：观察数据——NA 激活占比、上限触发频率，决定是否调整默认上限值

---

## 十、风险与注意事项

1. **纯 32 位 hex 误伤**：`3f8a912cb71e4d529c31d8e5f2a1476b` 这种无连字符 UUID 如果被某些正常设备用作 ID，会误识别为 NA。建议初期只启用 UUID 标准格式和 `UUID:` 前缀两种规则，纯 32 位 hex 放观察名单。

2. **na_usage_count 递增的原子性**：当前用 `JSON.parse(JSON.stringify(info))` 做浅拷贝再 `naPipeline.set()`。Redis 单线程天然原子，但并发请求时可能有 race condition（两个 NA 设备同时激活同一码）。建议加一个简单的乐观锁或考虑 `WATCH` 事务（当前 QPS 低、概率极小，可暂不考虑）。

3. **NA 设备也能用未使用的兑换码**：未使用过的兑换码照样能激活（从 `!info.used` 走正常流程）。此时 `na_usage_count` 从 0 开始，第一个 NA 设备激活后变为 1。

4. **与现有「同一设备复用」逻辑不冲突**：`used_device_id === deviceHash` 判断仍在最前面，NA 设备如果恰好 hash 匹配（极不可能，UUID 碰撞概率几乎为零），还是走复用逻辑。