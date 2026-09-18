# 兑换规则系统设计

> 为兑换码增加条件约束，实现渠道控制、设备限制、版本门槛等场景
> 更新日期：2026-09-18

---

## 一、背景

### 1.1 当前兑换码结构

目前每个兑换码只记录：

```json
{
  "code": "A1B2",
  "product_id": "01",
  "duration_months": 12,
  "used": false,
  "used_device_id": null,
  "generated_activation_code": null,
  "created_at": 1756646400000,
  "used_at": null
}
```

**没有条件约束**——任何设备、任何版本、任何渠道的用户都能用。

### 1.2 出现的新需求

| 场景 | 需求 | 示例 |
|------|------|------|
| **渠道控制** | 某批兑换码仅限米坛用户激活 | `channel IN ('t-9p-d', 't-10-r')` |
| **版本门槛** | 某次活动仅限 v1.6.0+ 用户参与 | `romVersion >= "1.6.0"` |
| **设备限定** | 某批码仅限 Watch S4 使用 | `deviceModel IN ("Watch S4")` |
| **限时活动** | 兑换码仅在指定日期范围内有效 | `validFrom <= now <= validUntil` |
| **总量封顶** | 某活动码只能兑前 500 次 | `maxActivations: 500` |
| **地区限制** | 仅限中国大陆 IP 激活 | `country IN ("CN")` |

---

## 二、设计方案

### 2.1 兑换码扩展字段

每个兑换码新增 `rules` 字段（**可选**，不设置 = 无条件限制，完全向后兼容）：

```json
{
  "code": "A1B2",
  "product_id": "01",
  "duration_months": 12,
  "used": false,
  "used_device_id": null,
  "generated_activation_code": null,
  "created_at": 1756646400000,
  "used_at": null,
  "rules": {
    "version": ">=1.6.0",
    "channel": ["t-9p-d", "t-10-r"],
    "deviceModel": ["Watch S4", "Watch S4 Pro"],
    "validFrom": 1757000000000,
    "validUntil": 1759680000000,
    "maxActivations": 500,
    "country": ["CN"],
    "osVersion": ">=10"
  }
}
```

### 2.2 规则字段说明

| 字段 | 类型 | 含义 | 默认值 |
|------|------|------|--------|
| `version` | string | 客户端版本要求，支持 `>=`, `>`, `=`, `<`, `<=` 前缀 | 无限制 |
| `channel` | string[] | 允许的渠道码列表（对应 `c` 参数） | 全部允许 |
| `deviceModel` | string[] | 允许的设备型号列表 | 全部允许 |
| `validFrom` | number | 可用起始时间戳（ms） | 创建即刻可用 |
| `validUntil` | number | 可用截止时间戳（ms） | 永久有效 |
| `maxActivations` | number | 最大激活次数（全局计数） | 不限次数 |
| `country` | string[] | 允许的国家/地区代码列表（ISO 3166-1 alpha-2） | 全部允许 |
| `osVersion` | string | 系统版本要求，格式同 `version` | 无限制 |

### 2.3 计数 key 设计

对于 `maxActivations` 规则，需要一个全局计数器：

```
auth:redeem:cnt:{code} → number（当前已激活次数）
```

每次命中规则检查时 INCR，达到 `maxActivations` 后拒绝后续激活。

---

## 三、规则检查引擎

### 3.1 检查流程（在 activate.js 中插入）

```
用户提交激活请求
  │
  ├── 1. 现有检查：兑换码存在性、是否已使用、商品/时长有效性 ✓
  │
  ├── 2. 【新增】规则检查引擎 checkRules(code, context)
  │     │
  │     ├── 2a. 兑换码无 rules 字段 → 跳过，直接通过
  │     │
  │     ├── 2b. 版本检查（若 rules.version 存在）
  │     │     └── deviceInfo.romVersion 不满足条件 → 拒绝
  │     │
  │     ├── 2c. 渠道检查（若 rules.channel 存在）
  │     │     └── deviceInfo.source 不在 rules.channel 列表中 → 拒绝
  │     │
  │     ├── 2d. 设备型号检查（若 rules.deviceModel 存在）
  │     │     └── deviceInfo.model 不在 rules.deviceModel 列表中 → 拒绝
  │     │
  │     ├── 2e. 时间检查（若 rules.validFrom/validUntil 存在）
  │     │     └── now < validFrom || now > validUntil → 拒绝
  │     │
  │     ├── 2f. 激活次数检查（若 rules.maxActivations 存在）
  │     │     ├── GET auth:redeem:cnt:{code}
  │     │     ├── count >= maxActivations → 拒绝
  │     │     └── INCR auth:redeem:cnt:{code}
  │     │
  │     ├── 2g. 地区检查（若 rules.country 存在）
  │     │     └── 请求 IP 所属国家不在 rules.country 中 → 拒绝
  │     │
  │     └── 全部通过 → 继续正常激活流程
  │
  └── 3. 正常激活流程 ✓
```

### 3.2 引擎函数签名

```javascript
// lib/redeem-rules.js
async function checkRules(code, context) {
  var raw = await redis.get("auth:redeem:" + code);
  if (!raw) return { ok: false, reason: "REDEEM_NOT_FOUND" };

  var data = parseRedisJson(raw);
  if (!data || !data.rules) return { ok: true }; // 无规则 = 通过

  var rules = data.rules;

  // 2b. 版本检查
  if (rules.version && context.deviceInfo) {
    var ok = checkSemver(rules.version, context.deviceInfo.romVersion);
    if (!ok) return { ok: false, reason: "VERSION_TOO_LOW", detail: "need " + rules.version };
  }

  // 2c. 渠道检查
  if (rules.channel && rules.channel.length > 0) {
    var userChannel = context.deviceInfo && context.deviceInfo.source;
    if (!userChannel || rules.channel.indexOf(userChannel) === -1) {
      return { ok: false, reason: "CHANNEL_NOT_ALLOWED", detail: "allowed: " + rules.channel.join(", ") };
    }
  }

  // 2d. 设备型号检查
  if (rules.deviceModel && rules.deviceModel.length > 0) {
    var userModel = context.deviceInfo && context.deviceInfo.model;
    if (!userModel || rules.deviceModel.indexOf(userModel) === -1) {
      return { ok: false, reason: "DEVICE_NOT_ALLOWED", detail: "allowed: " + rules.deviceModel.join(", ") };
    }
  }

  // 2e. 时间检查
  var now = Date.now();
  if (rules.validFrom && now < rules.validFrom) {
    return { ok: false, reason: "TOO_EARLY", detail: "valid from " + new Date(rules.validFrom).toISOString() };
  }
  if (rules.validUntil && now > rules.validUntil) {
    return { ok: false, reason: "EXPIRED", detail: "expired at " + new Date(rules.validUntil).toISOString() };
  }

  // 2f. 激活次数检查
  if (rules.maxActivations) {
    var cntKey = "auth:redeem:cnt:" + code;
    var cur = await redis.get(cntKey);
    var count = parseInt(cur, 10) || 0;
    if (count >= rules.maxActivations) {
      return { ok: false, reason: "MAX_ACTIVATIONS_REACHED", detail: count + "/" + rules.maxActivations };
    }
  }

  return { ok: true };
}
```

### 3.3 版本比较辅助函数

```javascript
function parseSemver(ver) {
  if (!ver || typeof ver !== "string") return null;
  var parts = ver.split(".");
  return parts.map(function(p) {
    var n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function checkSemver(rule, current) {
  if (!current) return false;

  // 解析规则前缀
  var op = ">=";
  var verStr = rule;
  if (rule.startsWith(">=")) { op = ">="; verStr = rule.slice(2); }
  else if (rule.startsWith(">")) { op = ">"; verStr = rule.slice(1); }
  else if (rule.startsWith("<=")) { op = "<="; verStr = rule.slice(2); }
  else if (rule.startsWith("<")) { op = "<"; verStr = rule.slice(1); }
  else if (rule.startsWith("=")) { op = "="; verStr = rule.slice(1); }

  var ruleParts = parseSemver(verStr);
  var curParts = parseSemver(current);
  if (!ruleParts || !curParts) return false;

  for (var i = 0; i < 3; i++) {
    var r = ruleParts[i] || 0;
    var c = curParts[i] || 0;
    if (op === ">=" || op === ">") {
      if (c > r) return true;
      if (c < r) return false;
    } else if (op === "<=" || op === "<") {
      if (c < r) return true;
      if (c > r) return false;
    } else if (op === "=") {
      if (c !== r) return false;
    }
  }
  // ">=" 和 "<=" 走到这里说明相等
  return (op === ">=" || op === "<=" || op === "=");
}
```

---

## 四、整合点

### 4.1 activate.js 改动

在兑换码有效性检查之后、激活码生成之前插入规则检查：

```javascript
// activate.js — 在 parseRedisJson 和 product_id/months 检查之后

// 【新增】规则检查
var ruleCheck = await checkRules(code, {
  deviceInfo: deviceInfo,    // 来自 QR 参数的设备信息
  ipCountry: req.headers["x-vercel-ip-country"],
});
if (!ruleCheck.ok) {
  saveFailureRecord(ruleCheck.reason, device, code, productId, months, visitorInfo, deviceInfo);
  // 发送失败通知 + pushNotification
  return res.status(403).json({
    success: false,
    error: "兑换码不满足激活条件: " + ruleCheck.detail,
    debug: { reason: ruleCheck.reason, detail: ruleCheck.detail }
  });
}
```

### 4.2 激活计数递增

在激活成功后（写入 pipeline 中）增加一行：

```javascript
// activate.js — 激活成功写入
if (data.rules && data.rules.maxActivations) {
  writePipeline.incr("auth:redeem:cnt:" + code);
}
```

### 4.3 管理后台生成兑换码时支持规则

在 `POST /api/admin/redeem-codes` 中接受可选 `rules` 参数：

```javascript
// POST body 新增
{
  "productId": "01",
  "count": 10,
  "durationMonths": 12,
  "rules": {
    "channel": ["t-9p-d"],
    "version": ">=1.6.0",
    "maxActivations": 100
  }
}
```

存入兑换码记录：

```javascript
var record = {
  code: code,
  product_id: productId,
  duration_months: months,
  used: false,
  used_device_id: null,
  generated_activation_code: null,
  created_at: now,
  used_at: null,
};
if (body.rules) {
  record.rules = body.rules;  // 规则字段
}
```

---

## 五、管理后台 UI 改动

### 5.1 生成弹窗增加规则配置

在现有生成弹窗中增加 "规则配置" 折叠面板：

```
┌─ 生成兑换码 ─────────────────────┐
│  产品:  [Ev课程表]                  │
│  时长:  [12 个月]                  │
│  数量:  [100]                      │
│                                    │
│  ▼ 规则配置（可选）                  │
│  ┌──────────────────────────────┐  │
│  │ 渠道限制: [t-9p-d]  +         │  │
│  │ 版本要求: [>=1.6.0]           │  │
│  │ 设备型号: [Watch S4]  +       │  │
│  │ 有效起始: [2026-10-01]        │  │
│  │ 有效截止: [2026-12-31]        │  │
│  │ 激活上限: [500]               │  │
│  │ 地区限制: [CN]  +             │  │
│  └──────────────────────────────┘  │
│                                    │
│  [取消]              [生成 100 个]  │
└────────────────────────────────────┘
```

### 5.2 兑换码列表展示规则

每行兑换码增加规则标签：

```
┌──────┬──────┬──────┬──────────────────────┬────────┐
│ 兑换码│ 产品  │ 时长  │ 规则                   │ 状态    │
├──────┼──────┼──────┼──────────────────────┼────────┤
│ A1B2 │ 01   │ 12m  │ 📱渠道 t-9p-d         │ ✅可用  │
│      │      │      │ 📱版本 >=1.6.0         │        │
│      │      │      │ ⏳上限 100/500         │        │
├──────┼──────┼──────┼──────────────────────┼────────┤
│ C3D4 │ 01   │ 3m   │ — 无限制              │ ✅可用  │
└──────┴──────┴──────┴──────────────────────┴────────┘
```

---

## 六、向后兼容性

| 场景 | 行为 | 兼容性 |
|------|------|--------|
| 旧兑换码（无 `rules`） | 规则检查跳过，与现在完全一致 | ✅ |
| 新兑换码（有 `rules`） | 按规则约束执行 | ✅ |
| 旧客户端（无 `deviceInfo.source`） | 渠道检查 → `source` 为空 → `CHANNEL_NOT_ALLOWED`（如果设了 channel 规则） | ⚠️ 需注意 |
| 旧客户端（无 `romVersion`） | 版本检查 → `romVersion` 为空 → `VERSION_TOO_LOW`（如果设了 version 规则） | ⚠️ 需注意 |

**注意**：如果兑换码设置了 channel/version 规则但客户端太旧无法提供这些信息，激活会被拒绝。这是预期行为——规则的目的就是限制条件。

---

## 七、存储与性能

### 7.1 存储位置

| 数据 | 位置 | 说明 |
|------|------|------|
| 兑换码规则 | `auth:redeem:{code}` JSON 的 `rules` 字段 | 与兑换码同记录 |
| 激活计数器 | `auth:redeem:cnt:{code}` String | 独立 key，方便 INCR |

### 7.2 性能影响

| 操作 | 当前 | 改动后 | 增量 |
|------|------|--------|------|
| 激活 | 5-7 次 Redis 操作 | +1 次 GET（读 rules）+ 按规则增加 0~2 次 | **低** |
| 生成兑换码 | 2 次 pipeline 操作 | 不变（rules 只是 JSON 多一个字段） | **无** |
| 列表查询 | 按原有扫描 | 不变（rules 是 JSON 内字段） | **无** |

---

## 八、实施步骤

| 阶段 | 内容 | 文件 | 工时 |
|------|------|------|------|
| **Phase 1** | 规则检查引擎 `checkRules()` | `lib/redeem-rules.js`（新文件） | 1h |
| **Phase 2** | activate.js 整合规则检查 | `api/activate.js` | 0.5h |
| **Phase 3** | 批量生成接口支持 rules 参数 | `api/admin/redeem-codes.js` | 0.5h |
| **Phase 4** | 管理后台 UI 规则配置 | `admin_Dx23.html` | 2h |
| **Phase 5** | 测试：各规则组合、边界条件、旧码兼容 | 手动测试 | 1h |

**总计约 5 小时。**

---

## 九、应用场景示例

### 场景 1：米坛渠道专享码

```
兑换码:  T9P-A1B2
产品:    Ev课程表 3个月
规则:
  channel: ["t-9p-d", "t-9p-r", "t-10-d"]
  maxActivations: 200
用途:    米坛手环9Pro讨论帖 + 资源帖 + 手环10 共 200 份
```

### 场景 2：新用户门槛码

```
兑换码:  NEW-V6
产品:    Ev课程表 1个月
规则:
  version: ">=1.6.0"
  maxActivations: 1000
用途:    仅限升级到 v1.6.0 的用户领取
```

### 场景 3：Watch S4 专属活动码

```
兑换码:  S4-EVENT
产品:    Ev课程表 12个月
规则:
  deviceModel: ["Watch S4", "Watch S4 Pro"]
  validFrom: 1757000000000       // 2026-10-01
  validUntil: 1759680000000      // 2026-12-31
用途:    Watch S4 用户限时活动
```

---

## 十、风险与注意事项

1. **客户端信息完整性**：规则依赖 `deviceInfo` 中的数据，旧客户端可能不包含 `source`（渠道）或 `romVersion`。设了规则但客户端不传 → 激活被拒。这是预期行为。
2. **maxActivations 精确性**：并发场景下 INCR 可能略微超限（+1~2），可接受。如需严格精确，改用 Lua 脚本原子操作。
3. **地区检测精度**：IP 地理定位依赖 Vercel Edge headers，精度到国家级别，部分 VPN 可能误判。
4. **版本号格式**：当前 `r` 参数格式为 `1.5.70`，需确保所有客户端统一格式。历史版本可能缺失或格式不同。