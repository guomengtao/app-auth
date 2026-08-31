# 兑换码管理页面打不开问题分析（第二次）

## 问题描述

后台管理页面中，点击左侧菜单"兑换码管理"后，内容区域无法显示兑换码面板，页面内容区域为空或显示"暂无兑换码"但实际有数据。

## 根因分析

### 1. 前端 filterUsed 参数值与后端期望值不匹配（致命Bug）

**前端代码**（admin.html）：
```html
<select id="filterUsed" onchange="loadCodes()">
  <option value="">全部状态</option>
  <option value="0">未使用</option>
  <option value="1">已使用</option>
</select>
```

前端发送 `used=0` 或 `used=1`。

**后端代码**（api/admin/redeem-codes.js）：
```javascript
function matchCode(data, filterProductId, filterUsed, filterDuration) {
  if (filterUsed === "true" && !data.used) return false;
  if (filterUsed === "false" && data.used) return false;
  // ...
}
```

后端期望 `used=true` 或 `used=false`。

**影响**：filterUsed 始终不匹配，导致该过滤条件不生效，所有状态的兑换码都返回。虽然不会导致页面空白，但过滤功能完全失效。

### 2. api() 函数缺少响应状态码校验（严重Bug）

**前端代码**（admin.html）：
```javascript
async function api(path, opts) {
  var res = await fetch(path, opts);
  if (res.status === 401) { /* redirect */ }
  if (res.status === 403) { /* redirect */ }
  return res.json();  // 如果 res.status 是 500/502/504，res.json() 可能失败
}
```

**问题**：当 API 返回 500、502、504 等非 401/403 错误状态码时：
- 如果响应体是 JSON（如 `{ success: false, error: "..." }`），`res.json()` 成功，函数返回 `{ success: false, ... }`
- 如果响应体不是 JSON（如 Vercel 超时页面 HTML），`res.json()` 抛出异常，页面 JavaScript 出错

**触发场景**：Vercel Serverless Function 超过 10 秒执行时间限制（Hobby 计划）时，返回 HTML 格式的 504 超时页面，导致 `res.json()` 解析失败。

### 3. loadCodes() 在 data.success 为 false 时静默返回

**前端代码**（admin.html）：
```javascript
var data = await api('/api/admin/redeem-codes?' + params.toString());
if (!data.success) return;  // 直接返回，不显示任何错误信息
```

**问题**：当 API 返回 `{ success: false, error: "Internal server error" }` 时，用户看到的是一张空表格，没有任何错误提示。用户无法知道是 API 出错还是真的没有数据。

### 4. redeem-codes.js API 全量扫描后再分页（性能Bug）

**后端代码**（api/admin/redeem-codes.js）：
```javascript
// 先扫描所有 member
var allMemberKeys = [];
var memberCursor = 0;
do {
  var memberResult = await redis.sscan("auth:redeem_codes", memberCursor, { count: 200 });
  memberCursor = memberResult[0];
  allMemberKeys = allMemberKeys.concat(memberResult[1]);
} while (memberCursor !== 0);

// 再用 pipeline 获取所有值
var pipeline = redis.pipeline();
allMemberKeys.forEach(function (code) {
  pipeline.get("auth:redeem:" + code);
});
var values = await pipeline.exec();

// 最后才在内存中排序和分页
allCodes.sort(...);
var pageCodes = allCodes.slice(offset, offset + limit);
```

**问题**：
- 无论请求第几页，都扫描所有兑换码并获取全部数据
- 当兑换码数量很大（如 10000+）时，Redis 操作和 Pipeline 传输的数据量巨大
- 容易触发 Vercel 10 秒超时限制，导致 504 错误
- 前端 `api()` 函数收到 504 HTML 响应后，`res.json()` 抛出异常

**这是导致"页面打不开"的最可能原因**：当兑换码数量较多时，API 请求超时，前端收到非 JSON 响应，JavaScript 异常，页面显示空白。

### 5. stats.js 使用 sscan 但未处理游标分页（统计不准确Bug）

**后端代码**（api/admin/stats.js）：
```javascript
const codes = await redis.sscan("auth:redeem_codes", 0, { count: 1000 });
```

**问题**：`sscan` 只取第一页（最多 1000 个），当兑换码超过 1000 个时，`usedCount` 统计不准确。但不会导致页面打不开。

### 6. 导出功能 exportCodes 同样使用全量扫描

**问题**：导出 CSV 时同样扫描所有兑换码，当数据量大时也会超时。

## 修复方案

### 修复 1：统一 filterUsed 参数值

**修改前端**：保持前端 `value="0"`/`value="1"` 不变。
**修改后端**：将 `matchCode` 函数中的 `"true"`/`"false"` 改为 `"1"`/`"0"`。

```javascript
function matchCode(data, filterProductId, filterUsed, filterDuration) {
  if (filterProductId && data.product_id !== filterProductId) return false;
  if (filterUsed === "1" && !data.used) return false;  // 改为 "1"
  if (filterUsed === "0" && data.used) return false;   // 改为 "0"
  if (filterDuration && String(data.duration_months) !== filterDuration) return false;
  return true;
}
```

### 修复 2：api() 函数添加响应状态码校验

```javascript
async function api(path, opts) {
  var res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  if (res.status === 403) {
    var data = await res.json();
    alert(data.error || 'only guomengtao@gmail.com allowed');
    window.location.href = '/login.html';
    throw new Error('Forbidden');
  }
  if (!res.ok) {
    // 尝试解析 JSON 错误，失败则使用状态码文本
    try {
      var errData = await res.json();
      throw new Error(errData.error || 'HTTP ' + res.status);
    } catch (e) {
      if (e.message && !e.message.startsWith('HTTP')) throw e;
      throw new Error('API request failed: HTTP ' + res.status);
    }
  }
  return res.json();
}
```

### 修复 3：loadCodes() 在 data.success 为 false 时显示错误

```javascript
if (!data.success) {
  showToast(data.error || '加载兑换码失败', 'error');
  return;
}
```

### 修复 4：redeem-codes.js API 优化分页逻辑

将全量扫描改为按需获取，跳过不必要的成员扫描：

```javascript
// 获取所有成员（仍然需要全量扫描以支持排序和过滤）
var allMemberKeys = [];
var memberCursor = "0";
do {
  var memberResult = await redis.sscan("auth:redeem_codes", memberCursor, { count: 500 });
  memberCursor = memberResult[0];
  allMemberKeys = allMemberKeys.concat(memberResult[1]);
} while (memberCursor !== 0);

// 倒序排列（最新的在前），然后只获取当前页需要的数据
allMemberKeys.sort(function (a, b) {
  // 注意：无法在获取数据前按 created_at 排序
  // 所以先获取所有数据再排序分页，但可以增加 count 减少迭代次数
});
```

**更优方案**：使用 Redis Sorted Set 替代 Set，用 `created_at` 作为 score，直接按时间排序分页。

### 修复 5：stats.js 处理完整游标分页

```javascript
let totalRedeemCodes = 0;
let usedCount = 0;
let cursor = "0";
do {
  const codes = await redis.sscan("auth:redeem_codes", cursor, { count: 500 });
  cursor = codes[0];
  totalRedeemCodes += codes[1].length;
  if (codes[1].length > 0) {
    const pipeline = redis.pipeline();
    codes[1].forEach((code) => pipeline.get(`auth:redeem:${code}`));
    const results = await pipeline.exec();
    usedCount += results.filter((r) => {
      const data = typeof r === "string" ? JSON.parse(r) : r;
      return data && data.used;
    }).length;
  }
} while (cursor !== 0);
```

## 影响范围

| 影响 | 严重程度 | 说明 |
|------|----------|------|
| 兑换码管理页面空白 | **严重** | API 超时导致前端异常，页面显示空白 |
| 状态过滤功能失效 | **中** | 使用/未使用筛选不生效 |
| 统计数字不准确 | **低** | 超过 1000 个兑换码时统计偏差 |
| 导出功能超时 | **中** | 数据量大时导出 CSV 可能超时 |
| 错误提示缺失 | **中** | API 失败时用户看不到错误信息 |

## 验证方法

1. 点击"兑换码管理"标签，确认面板正常显示
2. 使用"已使用"/"未使用"筛选器，确认过滤功能正常
3. 打开浏览器开发者工具（F12），在 Network 选项卡中确认 `/api/admin/redeem-codes` 请求返回 200 状态码
4. 确认无兑换码时显示"暂无兑换码，请先生成"
5. 确认统计面板数字准确