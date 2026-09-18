# 渠道参数集成方案

> 围绕激活 URL 中新增的 `c` 参数（渠道来源），实现全链路采集、存储、展示、统计、通知
> 更新日期：2026-09-18

---

## 一、数据流总览

```
手表生成二维码
  │
  ├── QR 内容: activate.html?deviceId=xxx&c=t-9p-d&m=Watch S4&...
  │
  └── 用户扫码 → 浏览器打开 activate.html
        │
        ├── 解析 URL 参数 → deviceInfo.source = "t-9p-d"
        │
        ├── 用户输入兑换码 → 点击激活
        │     │
        │     ├── POST /api/activate
        │     │   body: { deviceId, redeemCode, deviceInfo: { ..., source: "t-9p-d" } }
        │     │
        │     └── activate.js 处理
        │           │
        │           ├── 1. 激活记录存储
        │           │   record.device_info.source = "t-9p-d"  ← 自动保留
        │           │
        │           ├── 2. 通知推送到 Redis PUB/SUB
        │           │   pushNotification("new_activation", {
        │           │     device_info: { source: "t-9p-d", ... },
        │           │     ...
        │           │   })
        │           │     │
        │           │     ├── EvNotifier 接收
        │           │     │   → 通知栏显示 "[t-9p-d]"
        │           │     │   → message_delivery payload 中包含 source
        │           │     │
        │           │     └── Supabase message_delivery 存储
        │           │         payload->>'source' = "t-9p-d"
        │           │
        │           └── 3. 响应返回前端
        │               activate.html 显示激活结果
        │
        └── 管理后台查看
            admin_Dx23.html → GET /api/admin/records
              → 每条记录显示渠道来源
              → 统计面板按渠道分组
```

---

## 二、改动清单

### 2.1 activate.html — 从 URL 提取 `c` 参数并传递

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/activate.html`

**改动 1**：`getDeviceInfoFromUrl()` 增加 `source` 字段

```javascript
function getDeviceInfoFromUrl() {
  var params = parseQueryParams(window.location.search);
  return {
    model: params['m'] || '',
    product: params['p'] || '',
    osVersionCode: params['o'] || '',
    platformVersionCode: params['v'] || '',
    deviceType: params['t'] || '',
    screenShape: params['s'] || '',
    screenWidth: params['w'] || '',
    screenHeight: params['h'] || '',
    apiLevel: params['a'] || '',
    language: params['l'] || navigator.language || '',
    romVersion: params['r'] || '',
    source: params['c'] || '',           // ← 新增：渠道来源
  };
}
```

**改动 2**：设备信息面板增加渠道字段显示（可选，用户不需要看到这个）

在设备信息面板中增加一行——推荐不加，渠道是内部统计字段，对用户无意义。

但可以在激活成功后返回的响应中附带渠道信息，供后续调试使用。

### 2.2 activate.js — 渠道参数已自动保留（零改动验证）

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/api/activate.js`

当前代码已经自动保留了 `deviceInfo` 中的所有字段：

| 位置 | 是否自动包含 `source` | 说明 |
|------|:---------------------:|------|
| 激活记录 `record.device_info` | ✅ | `record = { ..., device_info: deviceInfo || null }` |
| 失败记录 `saveFailureRecord()` | ✅ | 同上传入 `deviceInfo` |
| `pushNotification("new_activation")` | ✅ | 已包含 `device_info: deviceInfo || {}` |
| `pushNotification("activation_failure")` | ✅ | 同上 |

**结论：activate.js 无需任何改动。** 只要 activate.html 在 POST body 中传了 `deviceInfo.source`，后端自动存储和推送。

### 2.3 notify.js — 推送通知中已包含渠道参数（零改动验证）

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/lib/notify.js`

`pushNotification()` 接收 `device_info` 对象并原样放入消息 payload。渠道信息随着消息发布到 `auth:push_channel`，EvNotifier 接收时从 `device_info.source` 读取。

### 2.4 admin_Dx23.html — 管理后台展示渠道

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/admin_Dx23.html`

**改动 1**：激活记录表格增加"渠道"列

在表格头部和数据行中插入渠道列：

```javascript
// renderRecordsTable() — table header
tableHtml += '<thead><tr>';
tableHtml += '<th>状态</th>';
tableHtml += '<th>激活码</th>';
tableHtml += '<th>兑换码</th>';
tableHtml += '<th>设备</th>';
tableHtml += '<th>渠道</th>';               // ← 新增列
tableHtml += '<th>产品</th>';
tableHtml += '<th>时长</th>';
tableHtml += '<th>激活时间</th>';
tableHtml += '<th>到期时间</th>';
tableHtml += '<th></th>';
tableHtml += '</tr></thead>';
```

```javascript
// renderRecordsTable() — data row
// 渠道来源
var sourceChannel = '';
if (r.device_info && r.device_info.source) {
  sourceChannel = escapeHtml(r.device_info.source);
} else if (r.visitor_info && r.visitor_info.referer) {
  // 回退：从 referer 猜测渠道
  var ref = r.visitor_info.referer || '';
  if (ref.indexOf('ifdian') >= 0) sourceChannel = 'afdian';
  else if (ref) sourceChannel = 'web';
}
tableHtml += '<td>' + sourceChannel + '</td>';
```

**改动 2**：`renderRecordDetail()` 中显示渠道信息

```javascript
function renderRecordDetail(r) {
  var di = r.device_info || {};
  var vi = r.visitor_info || {};
  var isFailure = r.status === 'failure';
  var hasDevice = di.model || di.product || di.deviceType;
  var hasVisitor = vi.ip || vi.os || vi.browser;
  var hasChannel = di.source;

  if (!hasDevice && !hasVisitor && !isFailure && !hasChannel) return '<span style="color:#aaa">No detail</span>';

  var html = '<div class="record-detail">';

  // 渠道来源卡片（新增，放在最前面）
  if (hasChannel) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Channel Source</div>';
    html += '<table class="detail-table">';
    html += '<tr><td>Channel</td><td><span class="channel-badge">' + escapeHtml(di.source) + '</span></td></tr>';
    // 解析渠道含义
    var channelParts = (di.source || '').split('-');
    var platformMap = { t: '米坛', q: '轻腕', g: 'GitHub' };
    var deviceMap = { '9p': '手环9 Pro', '10': '手环10', s4: 'Watch S4', w: 'Watch' };
    var typeMap = { d: '讨论帖', r: '资源页' };
    if (channelParts.length >= 1 && platformMap[channelParts[0]]) {
      html += '<tr><td>Platform</td><td>' + platformMap[channelParts[0]] + '</td></tr>';
    }
    if (channelParts.length >= 2 && deviceMap[channelParts[1]]) {
      html += '<tr><td>Device</td><td>' + deviceMap[channelParts[1]] + '</td></tr>';
    }
    if (channelParts.length >= 3 && typeMap[channelParts[2]]) {
      html += '<tr><td>Post Type</td><td>' + typeMap[channelParts[2]] + '</td></tr>';
    }
    html += '</table></div>';
  }

  // 失败信息（不变）
  if (isFailure) {
    // ... existing failure info ...
  }

  // 设备信息（不变）
  if (hasDevice) {
    // ... existing device info ...
  }

  // 浏览器信息（不变）
  if (hasVisitor) {
    // ... existing visitor info ...
  }

  html += '</div>';
  return html;
}
```

**改动 3**：统计面板增加渠道分布

```javascript
// loadStats() — 新增渠道统计数据
function loadChannelStats() {
  api('/api/admin/stats?section=channels').then(function(data) {
    if (!data || !data.success || !data.channels) return;
    var html = '<div class="stats-card">';
    html += '<div class="stats-card-title">渠道分布</div>';
    html += '<div class="channel-list">';
    data.channels.forEach(function(ch) {
      var pct = data.total ? (ch.count / data.total * 100).toFixed(1) : 0;
      html += '<div class="channel-row">';
      html += '<span class="channel-label">' + escapeHtml(ch.channel || 'unknown') + '</span>';
      html += '<div class="channel-bar-bg"><div class="channel-bar" style="width:' + pct + '%"></div></div>';
      html += '<span class="channel-count">' + ch.count + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
    var el = document.getElementById('channelStats');
    if (el) el.innerHTML = html;
  }).catch(function() {});
}
```

### 2.5 EvNotifier — 通知中显示渠道

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py`

**改动**：消息处理中解析并显示渠道

```python
def handle_message(self, data: dict):
    msg = data
    payload = msg.get("payload", msg)
    msg_type = payload.get("type") or payload.get("message_type") or ""

    # 获取渠道来源
    channel = ""
    device_info = payload.get("device_info", {})
    if device_info and device_info.get("source"):
        channel = device_info["source"]
    elif payload.get("channel"):
        channel = payload["channel"]

    # 通知标题
    type_labels = {
        "new_activation": "New Activation",
        "activation_failure": "Activation Failure",
        "new_order": "New Order",
    }
    title = type_labels.get(msg_type, msg_type)

    # 通知副标题 + 渠道标识
    subtitle = ""
    if channel:
        subtitle += f" [{channel}]"
    if payload.get("product_id"):
        subtitle += f" Product #{payload['product_id']}"
    if payload.get("months"):
        subtitle += f" {payload['months']}m"

    # 发送系统通知
    self._show_notification(title, subtitle.strip(), payload)
```

### 2.6 API 新增 — 渠道统计数据接口

**文件**：`/Users/Banner/Documents/guomengtao/app-auth/api/admin/stats.js`（或集成到现有 stats API）

当 `section=channels` 时，扫描激活记录并统计渠道分布：

```javascript
// GET /api/admin/stats?section=channels
async function getChannelStats(req, res) {
  try {
    var cursor = 0;
    var channelCounts = {};
    var total = 0;

    do {
      var result = await redis.sscan("auth:activation_codes", cursor, { count: 500 });
      cursor = result[0];
      var keys = result[1];

      if (keys.length > 0) {
        var records = await redis.mget(keys.map(function(k) {
          return "auth:activation:" + k;
        }));

        records.forEach(function(raw) {
          if (!raw) return;
          try {
            var rec = JSON.parse(raw);
            total++;
            var ch = rec.device_info && rec.device_info.source ? rec.device_info.source : '__unknown__';
            channelCounts[ch] = (channelCounts[ch] || 0) + 1;
          } catch (_) {}
        });
      }
    } while (cursor !== 0);

    // 也统计失败记录中的渠道
    var failKeys = await redis.smembers("auth:activation_failures");
    if (failKeys.length > 0) {
      var failRecords = await redis.mget(failKeys);
      failRecords.forEach(function(raw) {
        if (!raw) return;
        try {
          var rec = JSON.parse(raw);
          total++;
          var ch = rec.device_info && rec.device_info.source ? rec.device_info.source : '__unknown__';
          channelCounts[ch] = (channelCounts[ch] || 0) + 1;
        } catch (_) {}
      });
    }

    var channels = Object.keys(channelCounts).map(function(ch) {
      return { channel: ch, count: channelCounts[ch] };
    });
    channels.sort(function(a, b) { return b.count - a.count; });

    return res.json({ success: true, total: total, channels: channels });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
```

---

## 三、管理后台 UI 设计

### 3.1 激活记录表格（新增渠道列）

```
┌──────┬──────────────┬────────┬──────────┬────────┬──────┬──────┬──────────────────┬──────────────────┬──────┐
│ 状态  │ 激活码          │ 兑换码   │ 设备      │ 渠道    │ 产品  │ 时长  │ 激活时间           │ 到期时间           │ 详情  │
├──────┼──────────────┼────────┼──────────┼────────┼──────┼──────┼──────────────────┼──────────────────┼──────┤
│ ✅   │ ACT-ABCD...   │ A1B2   │ 550e...  │ t-9p-d │ 01   │ 12m  │ 2026-09-18 08:47 │ 2027-09-18 08:47 │ Show │
│ ✅   │ ACT-EFGH...   │ C3D4   │ 123a...  │ q      │ 01   │ 3m   │ 2026-09-17 22:08 │ 2026-12-17 22:08 │ Show │
│ ❌   │ -             │ X9Z2   │ 789b...  │ g      │ -    │ -    │ 2026-09-16 10:30 │ -                │ Show │
└──────┴──────────────┴────────┴──────────┴────────┴──────┴──────┴──────────────────┴──────────────────┴──────┘
```

### 3.2 记录详情展开（渠道卡片置顶）

```
┌─ 记录详情 ─────────────────────────────────────────┐
│                                                      │
│  📡 渠道来源                                         │
│  ──────────────────────────────────────────────────  │
│  Channel       t-9p-d                                │
│  Platform      米坛                                   │
│  Device        手环9 Pro                              │
│  Post Type     讨论帖                                  │
│                                                      │
│  📱 设备信息                                         │
│  ──────────────────────────────────────────────────  │
│  Model         Watch S4                              │
│  ...                                                │
│                                                      │
│  💻 浏览器信息                                       │
│  ──────────────────────────────────────────────────  │
│  ...                                                │
└──────────────────────────────────────────────────────┘
```

### 3.3 统计面板（渠道分布卡片）

```
┌─ 渠道分布 ──────────────────────┐
│                                   │
│  t-9p-d    ████████████  156     │
│  t-10-r    ████████       89     │
│  q         ████            45     │
│  g         ██              22     │
│  t-s4      █               12     │
│  unknown   ▏                3     │
│                                   │
│  总计: 327 次激活                   │
└───────────────────────────────────┘
```

---

## 四、渠道参数含义解析表

渠道码 `c` 格式：`{平台}-{设备}[-{类型}]`

| 码 | 平台 | 说明 |
|----|------|------|
| `t` | 米坛 | `t-9p-d` = 米坛·手环9Pro·讨论帖 |
| `q` | 轻腕 | `q` = 轻腕社区 |
| `g` | GitHub | `g` = GitHub Release |

| 段位 | 取值 | 含义 |
|------|------|------|
| 平台 | `t` / `q` / `g` | 分发渠道来源 |
| 设备 | `10` / `10p` / `9` / `9p` / `b9` / `s4` / `w` | 目标设备型号 |
| 类型（可选） | `d` / `r` | 帖子类型（仅米坛） |

---

## 五、实现工作量

| 任务 | 文件 | 改动量 | 工时 |
|------|------|:------:|:----:|
| activate.html 解析 `c` 参数 | `activate.html` | 1 行 | 5 min |
| admin 表格新增"渠道"列 | `admin_Dx23.html` | 4 行 | 10 min |
| admin 详情展示渠道 + 解析 | `admin_Dx23.html` | ~20 行 | 20 min |
| admin 统计面板渠道分布 | `admin_Dx23.html` + stats API | ~40 行 | 30 min |
| EvNotifier 通知显示渠道 | `ev_notifier.py` | ~8 行 | 10 min |
| Supabase message_delivery 查询 | 无需改动（payload 已包含） | 0 | - |
| **总计** | | | **~1.2 小时** |

---

## 六、与现有系统的关系

| 系统组件 | 是否需要改动 | 原因 |
|----------|:----------:|------|
| 手表端 activation.ux（QR 生成） | ✅ 已讨论 | 追加 `&c=` 参数到 QR URL |
| activate.html（URL 解析） | ✅ 1 行 | 提取 `c` 作为 `deviceInfo.source` |
| activate.js（服务端处理） | ❌ 零改动 | `deviceInfo` 已全量自动保存和推送 |
| notify.js（推送通知） | ❌ 零改动 | 推送 payload 已包含 `device_info` |
| SUPABASE message_delivery | ❌ 零改动 | payload JSONB 自动包含所有字段 |
| admin_Dx23.html（管理后台） | ✅ 展示 + 统计 | 表格列、详情卡片、渠道分布 |
| EvNotifier（桌面通知） | ✅ 显示渠道标签 | 通知栏显示 `[t-9p-d]` |
| 统计 API | ✅ 新增 section | 按渠道分组计数 |

---

## 七、后续扩展可能

| 方向 | 说明 | 前提 |
|------|------|------|
| 渠道转化漏斗 | 扫码次数 → 激活次数 → 成功率的逐层统计 | 需要扫码事件埋点 |
| 渠道版本分布 | 各渠道用户的 app 版本分布 | `romVersion` 已存在 |
| 渠道活跃度 | 按渠道跟踪日活/周活 | 需要 device 关联渠道 |
| 渠道通知精准推送 | 只给某渠道用户群发通知 | EvNotifier 扩展消息类型 |
| 渠道兑换码规则 | 某兑换码仅限特定渠道使用 | 兑换码规则系统 |

---

## 八、总结

这个方案的核心思路是：**最少改动，全链路贯通**。

- 只需在 QR 参数中增加 1 个字符（`&c=t-9p-d`）
- 只需在 activate.html 增加 1 行解析
- 后端 activate.js 零改动（`deviceInfo` 自动透传）
- 推送系统零改动（`device_info` 自动携带）
- 管理后台增加约 60 行展示代码
- EvNotifier 增加约 8 行显示代码

总改动量约 1.2 小时，换来从 QR → 服务端 → 存储 → 管理后台 → 桌面通知的全链路渠道追踪能力。