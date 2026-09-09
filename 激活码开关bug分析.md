# 激活码系统开关 Bug 分析：为什么改动始终失败

## 现象

打开激活码系统开关 → 刷新页面 → 开关自动回到关闭状态。

## 完整执行流程

```
用户点击开关(打开)
  │
  ▼
toggleActivationSystem()
  el.checked = true → enabled = true → 无需确认 → saveSettings()
  │
  ▼
saveSettings()
  ├─ 读取 checkbox 状态: activationSystemEnabled = true
  ├─ 写入 localStorage: { activationSystemEnabled: true, ... }        ← 本地保存成功
  └─ syncActivationSystemSetting(true)                                ← 异步 POST，不等待结果
       │
       ▼
     POST /api/admin/health?section=activation-system
     Body: { "enabled": true }
       │
       ├─ ✅ 成功 → Redis 写入 "auth:activation_system_enabled" = "enabled"
       │
       └─ ❌ 失败 → syncActivationSystemSetting 的 .catch() 静默吞掉错误
                    Redis 中仍然是旧值(可能是 "disabled" 或 key 不存在)
                    用户完全不知道 POST 失败了！

═══════════════════════════════════════════════════════════════════

用户刷新页面
  │
  ▼
initSettingsPanel()
  │
  ├─ 1. readSettings()
  │     localStorage 返回 { activationSystemEnabled: true }           ← 本地是正确的
  │
  ├─ 2. setCheck('settingActivationSystemEnabled', true)
  │     临时移除 onchange → 设置 el.checked = true → 恢复 onchange
  │     ✅ 不会触发 saveSettings()，不会发起多余的 POST
  │
  ├─ 3. fetchActivationSystemState()                                 ← 这是 Bug 的根源！
  │     GET /api/admin/health?section=activation-system
  │     │
  │     ├─ 如果 POST 之前成功了 → Redis 返回 "enabled"
  │     │   → enabled: true → 设置 el.checked = true → 正常 ✅
  │     │
  │     └─ 如果 POST 之前失败了 → Redis 返回 "disabled" 或 null
  │         → enabled: false → 设置 el.checked = false
  │         → 并且！！！覆盖 localStorage:
  │           s.activationSystemEnabled = false
  │           localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  │         → 结果：开关显示为关闭，本地存储也被污染为 false ❌
  │
  └─ 4. switchSettingsTab('appearance')
```

## 根本原因：双重状态源冲突

系统存在**两个状态源**，且 `fetchActivationSystemState()` 无条件让服务器覆盖本地：

| 状态源 | 写入时机 | 读取时机 |
|--------|----------|----------|
| **localStorage** | `saveSettings()` 同步写入 | `readSettings()` 初始化时读取 |
| **Redis (服务器)** | `syncActivationSystemSetting()` 异步 POST | `fetchActivationSystemState()` 刷新时 GET |

**关键代码** (`fetchActivationSystemState`，第 6882-6903 行)：

```javascript
function fetchActivationSystemState() {
  if (typeof api !== 'function') return;
  api('/api/admin/health?section=activation-system', { method: 'GET' })
    .then(function(data) {
      if (data && typeof data.enabled === 'boolean') {
        var el = document.getElementById('settingActivationSystemEnabled');
        if (el) {
          var prev = el.onchange;
          el.onchange = null;
          el.checked = data.enabled;        // ← 设置复选框
          el.onchange = prev;
        }
        var s = readSettings();
        if (s.activationSystemEnabled !== data.enabled) {
          s.activationSystemEnabled = data.enabled;   // ← 覆盖本地状态！
          try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
        }
      }
    })
}
```

**服务器始终是权威**，即使服务器的值可能是错误的（因为 POST 静默失败导致未更新）。

## 为什么 POST 会失败

`syncActivationSystemSetting`（第 6807-6819 行）：

```javascript
function syncActivationSystemSetting(enabled) {
  if (typeof api !== 'function') return;
  api('/api/admin/health?section=activation-system', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  }).then(function(data) {
    if (data && data.success) {
      console.log('...');                    // ← 只有 console.log，用户看不到
    }
  }).catch(function(e) {
    console.error('...', e.message);         // ← 静默吞掉所有错误！
  });
}
```

可能的失败原因：
- **网络波动**：Vercel Serverless 冷启动超时
- **认证过期**：Cookie 过期导致 401，但 `api()` 会跳转登录页，用户可能没注意到
- **Redis 连接失败**：Upstash Redis 限流或连接断开
- **Serverless 实例未就绪**：POST 先于 GET 但被路由到不同实例

## 之前两次修复为什么不够

### 修复 1（v1.5.3）：`setCheck` 不触发 onchange

```javascript
// 修复前
function setCheck(id, v) {
  var el = document.getElementById(id);
  if (el) el.checked = !!v;          // ← 触发 onchange → saveSettings → 多余的 POST
}

// 修复后
function setCheck(id, v) {
  var el = document.getElementById(id);
  if (el) {
    var prev = el.onchange;
    el.onchange = null;
    el.checked = !!v;                // ← 不触发 onchange
    el.onchange = prev;
  }
}
```

**解决了什么**：初始化时不再触发多余的 POST 请求。

**没解决什么**：`fetchActivationSystemState()` 仍然会 GET 服务器状态，仍然会覆盖 localStorage。如果服务器状态是错的，本地状态仍然会被污染。

### 修复 2（v1.5.4）：确认弹窗 + fetchActivationSystemState 不触发 onchange

```javascript
function toggleActivationSystem() {
  var el = document.getElementById('settingActivationSystemEnabled');
  var enabled = !!el.checked;
  if (!enabled) {
    if (!confirm('确定要关闭激活码系统吗？...')) {
      el.checked = true;
      return;
    }
  }
  saveSettings();
}
```

**解决了什么**：防止用户误点关闭。`fetchActivationSystemState` 设置复选框时不弹窗。

**没解决什么**：核心问题没有变——`fetchActivationSystemState()` 仍然会覆盖 localStorage。而且增加了一个新问题：`toggleActivationSystem` 关闭时弹确认框，但如果用户点确定关闭，`saveSettings()` 会 POST 到服务器。如果 POST 失败，服务器保持旧状态。下次刷新时 `fetchActivationSystemState` 从服务器读到旧状态，又会覆盖 localStorage。

## 本质问题

```
┌──────────────┐     POST (可能失败)     ┌──────────────┐
│  localStorage │ ──────────────────────→ │    Redis     │
│  (本地状态)   │                          │  (服务器状态) │
└──────────────┘                          └──────────────┘
       ↑                                        │
       │          GET (无条件覆盖)                │
       └────────────────────────────────────────┘
              fetchActivationSystemState()
```

**设计缺陷**：`fetchActivationSystemState()` 无条件将服务器状态写回 localStorage。当 POST 失败时，服务器状态是过时的，覆盖导致本地正确状态丢失。

## 为什么这个问题难以发现

1. **POST 静默失败**：`syncActivationSystemSetting` 的 `.catch()` 只写 `console.error`，用户界面无任何提示
2. **间歇性**：POST 成功时一切正常，只有 POST 失败时才触发 bug，难以复现
3. **Vercel Serverless 特性**：冷启动、实例切换等因素可能导致 POST 和 GET 命中不同实例，增加不确定性
4. **没有状态同步确认**：用户操作后没有"同步成功/失败"的 UI 反馈

## 正确的修复方向

### 方案 A：localStorage 优先，服务器作为备份（推荐）

```javascript
function fetchActivationSystemState() {
  if (typeof api !== 'function') return;
  api('/api/admin/health?section=activation-system', { method: 'GET' })
    .then(function(data) {
      if (data && typeof data.enabled === 'boolean') {
        var el = document.getElementById('settingActivationSystemEnabled');
        var localState = readSettings().activationSystemEnabled;
        
        // 只在本地没有明确设置时，才用服务器状态初始化
        var raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) {
          // 首次使用，用服务器状态
          if (el) {
            var prev = el.onchange;
            el.onchange = null;
            el.checked = data.enabled;
            el.onchange = prev;
          }
        }
        // 如果本地已有设置，以本地为准，不同步覆盖
        // 服务器状态仅用于显示不一致提示
        if (localState !== data.enabled) {
          console.warn('[settings] 本地激活码状态与服务器不一致，以本地为准');
        }
      }
    });
}
```

### 方案 B：POST 失败时给用户反馈

```javascript
function syncActivationSystemSetting(enabled) {
  if (typeof api !== 'function') return;
  api('/api/admin/health?section=activation-system', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  }).then(function(data) {
    if (data && data.success) {
      showToast('激活码系统已' + (enabled ? '启用' : '关闭'), 'success');
    }
  }).catch(function(e) {
    showToast('⚠️ 同步到服务器失败，请检查网络后重试', 'error');
    console.error('[settings] Failed to sync activation system setting:', e.message);
  });
}
```

### 方案 C：POST 失败时重试

```javascript
function syncActivationSystemSetting(enabled, retryCount) {
  retryCount = retryCount || 0;
  if (retryCount > 3) return;
  if (typeof api !== 'function') return;
  api('/api/admin/health?section=activation-system', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  }).then(function(data) {
    if (data && data.success) {
      console.log('[settings] Activation system synced');
    }
  }).catch(function(e) {
    console.error('[settings] Sync failed, retrying...');
    setTimeout(function() {
      syncActivationSystemSetting(enabled, retryCount + 1);
    }, 1000 * (retryCount + 1));
  });
}
```

## 建议采用组合方案

1. **方案 A（核心）**：localStorage 优先，首次加载才从服务器初始化，后续以本地为准
2. **方案 B（辅助）**：POST 失败时给用户 toast 提示
3. **方案 C（兜底）**：POST 失败自动重试 3 次

这样才能从根本上解决"打开了，刷新一下又关闭了"的问题。