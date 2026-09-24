# 设备ID 为 NA 等无效值时：拦截激活 + 友好引导加群反馈

> 触发样本：
> `https://app-auth.gudq.com/activate.html?deviceId=NA&m=ap&p=Xiaomi%20Smart%20Band%209&o=198145&v=1200&t=band&s=pill-shaped&w=192&h=490&a=2&l=zh&r=1.6.21&c=t-9-r`
>
> 现状：`deviceId=NA` **能正常走完激活流程并下发激活码**，属于静默放行。本文给出拦截规则、前端提示改造、后端兜底与观测方案。

---

## 1. 问题复现与根因

### 1.1 复现路径

1. 手环端（快应用）读取设备唯一标识失败，回落成字符串 `NA`；
2. 手环把 `deviceId=NA` 拼进二维码 URL，用户浏览器打开激活页；
3. 页面 `getDeviceIdFromUrl()` 拿到 `"NA"`（非空字符串 → 真值），`!getDeviceIdFromUrl()` 判断不成立；
4. 提交到 `/api/activate`，后端 `validateDeviceId()` 只校验「是否为空」，`NA` 通过；
5. `normalizeDeviceId()` 取后 4 位并左补 0 → `"00NA"`，被当作**合法设备指纹**；
6. `generateActivationCode()` 把 `00NA` 编进 18 位激活码并在 `activation_records` 落库、发通知。

### 1.2 关键代码位置

| 环节 | 文件 | 说明 |
|------|------|------|
| 前端取参 | `activate.html:266` `getDeviceIdFromUrl()` | 只做 `params['deviceId'] \|\| ... \|\| ''`，不做有效性判断 |
| 前端兜底 | `activate.html:309-320` | 仅在**空值**时本地随机生成 4 位并写 `localStorage`；`NA` 不是空，直接跳过兜底 |
| 前端提交校验 | `activate.html:403` | `if (!getDeviceIdFromUrl())` → `"NA"` 为真值，不拦截 |
| 后端校验 | `lib/validate.js:31` `validateDeviceId()` | 只判断非空、长度 ≥ 1 |
| 后端归一化 | `lib/validate.js:14` / `lib/crypto.js:86` `normalizeDeviceIdSegment()` | 过滤非字母数字 → `"NA"` → 左补零 → `"00NA"` |

### 1.3 危害

| 危害 | 说明 |
|------|------|
| **设备指纹失真** | 所有取不到 ID 的设备共享同一归一化值 `00NA`，「该兑换码已被其他设备使用过」的判定会被误触发或误放行 |
| **激活码可跨设备复用** | 激活码内嵌的设备段恒为 `00NA`，任意一台同样取不到 ID 的设备都能通过校验，等于绕过一码一机 |
| **兑换码绑定关系错乱** | `device_id_full = NA` 的记录大量重复，后台「换绑 / 复用」排查失去参照 |
| **数据污染** | 漏斗、设备榜、失败原因统计被 `NA` 淹没，掩盖真实问题用户的规模 |
| **用户无感知** | 用户拿到"激活成功"却被手环提示无效，只会认为系统坏了，不会来反馈 → 问题被藏起来 |

---

## 2. 设计目标

1. **不再静默放行**：`NA` 这类明显无效值直接拦在激活之前。
2. **文案友好**：明确告诉用户「设备信息没读到，不是你的操作问题」，避免用户自责。
3. **动作明确**：给出清晰的加群入口 + 可复制的诊断信息，降低反馈门槛。
   - ⚠️ **群号不写进逻辑代码**（JS / 后端一律不出现群号与加群链接），只在 `activate.html` 底部的静态文本里出现一次（见 4.7）。群满换群时只改那一处 HTML，不涉及任何逻辑改动。
4. **可观测**：后端记录独立失败原因，能在后台看 `NA` 占比与趋势，用于判断是手环端 bug 还是个别机型。
5. **有限兼容**：老 WebView 约束不变（只用 `var` / `XMLHttpRequest`，禁 `fetch` / 箭头函数 / `const`）。

---

## 3. 无效设备ID 判定规则

### 3.1 判定原则

对**原始 deviceId 字符串**判定（不要先归一化再判断，否则 `NA` 已经被补成 `00NA` 看不出来了）。

```
有效 ⇔  去空格后非空
      ∧ 大写形式不在保留值名单
      ∧ 去掉非字母数字字符后长度 ≥ 4
```

### 3.2 保留值名单（大小写不敏感）

| 级别 | 取值 | 处理 |
|------|------|------|
| L1 硬拦 | `NA`、`N/A`、`NULL`、`UNDEFINED`、`NONE`、`UNKNOWN`、`UNKNOW`、`NIL`、`-`、`--`、`NaN` | 直接拦截 + 引导加群 |
| L2 观察 | `0`、`0000`、`TEST`、`EMPTY`、`DEFAULT`、`FALSE` | 拦截但记录独立 reason，观察 24h 误伤率后再决定是否保留 |

> L2 单独分级的原因：理论上设备指纹后 4 位可能出现 `0000`。上线首日只统计不阻断（配置开关），确认 0 误伤后再硬拦。

### 3.3 判定用例

| 输入 | 归一化结果 | 期望 |
|------|-----------|------|
| `NA` | `00NA` | ❌ 拦截（L1） |
| `na` / `N/a` | `00NA` | ❌ 拦截（L1） |
| `null` / `undefined` | `0000` | ❌ 拦截（L1） |
| `-` / `--` | `0000` | ❌ 拦截（L1） |
| ``（空） | `0000` | ❌ 拦截（走"请从手环扫码打开"分支） |
| `0` | `0000` | ⚠️ L2 观察 |
| `a1b2` | `A1B2` | ✅ 放行 |
| `550e8400-e29b-41d4-a716-446655440000` | `40000`…（取后 4 位 `0000`） | ✅ 放行（原始值合法，不因后 4 位是 0000 拦截） |

> 注意最后一行：**校验的是原始值，不是后 4 位**。否则 UUID 尾部为 `0000` 的用户会被误伤。

---

## 4. 前端改造（`activate.html`）

### 4.1 新增判定函数

紧跟 `getDeviceIdFromUrl()` 之后加入（保持 `var` 风格、无箭头函数）：

```js
    // 设备ID 保留值黑名单：手环取不到 ID 时常见回落值
    var INVALID_DEVICE_TOKENS = {
      'NA': 1, 'N/A': 1, 'NULL': 1, 'UNDEFINED': 1, 'NONE': 1,
      'UNKNOWN': 1, 'UNKNOW': 1, 'NIL': 1, 'NAN': 1, '-': 1, '--': 1,
      '0': 1, '0000': 1, 'TEST': 1, 'EMPTY': 1, 'DEFAULT': 1, 'FALSE': 1
    };

    function isValidDeviceId(raw) {
      var s = String(raw || '').trim();
      if (!s) return false;
      if (INVALID_DEVICE_TOKENS[s.toUpperCase()]) return false;
      var alnum = s.replace(/[^0-9A-Za-z]/g, '');
      return alnum.length >= 4;
    }
```

### 4.2 初始化分支改造

替换 `activate.html:309-323` 现有逻辑：

```js
    var urlDeviceId = getDeviceIdFromUrl();
    var deviceId = urlDeviceId;
    var deviceIdInvalid = false;

    if (_isL2OnlyNoBlock) { /* 见 4.5 灰度开关，默认 false */ }

    if (!deviceId) {
      // 空值：沿用本地兜底（用户直接浏览器打开的场景）
      deviceId = localStorage.getItem('deviceId') || '';
      if (!deviceId) {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        deviceId = '';
        for (var i = 0; i < 4; i++) {
          deviceId += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        localStorage.setItem('deviceId', deviceId);
      }
    } else if (!isValidDeviceId(deviceId)) {
      // 无效值：绝不落库、绝不发码，直接走引导
      deviceIdInvalid = true;
    }

    document.getElementById('deviceId').value = deviceId || '未获取到';
    document.getElementById('deviceInfo').textContent = '设备ID来源: ' + (urlDeviceId ? 'URL参数' : '本地生成');
```

并在 4.3 的卡片渲染中调用 `showInvalidDeviceCard(rawDeviceId)`。

> ⚠️ **实测踩坑（已修）**：页面底部的 `xhrFetch(Request('/api/admin/health?section=version'))` 在 `onload` 里会调 `setLoading(false)`，它会把 `#activateBtn` 重新点亮、文案改回「立即激活」，**覆盖掉无效状态的禁用**。因此 `setLoading()` 开头必须短路：
> ```js
>     function setLoading(loading) {
>       var btn = document.getElementById('activateBtn');
>       if (deviceIdInvalid) {          // 无效设备ID：按钮恒锁死，不被 xhrFetch 收尾复位
>         btn.disabled = true;
>         btn.textContent = '设备信息异常，暂不可激活';
>         return;
>       }
>       ...
> ```

### 4.3 无效值提示卡片（友好 · 带加群）

在 `<div class="card">` 内、`.steps` 之前插入隐藏容器：

```html
    <div id="invalidCard" class="invalid-card" style="display:none">
      <div class="invalid-icon">⚠️</div>
      <div class="invalid-title">未能读取到您的设备信息</div>
      <div class="invalid-desc">
        检测到设备返回的标识为「<b id="invalidRaw">NA</b>」，这是一个无效值，<b>不是您的操作问题</b>。
        继续激活会导致激活码无效，请先按下方方式联系我们处理。
      </div>
      <div class="invalid-steps">
        ① 请先<b>重启手环</b>，从手环端重新打开激活二维码再扫一次；<br>
        ② 若仍显示相同提示，请携带下方信息到<b>页面底部</b>的交流群反馈。
      </div>
      <!-- 群号刻意不写在这里：加群入口统一由页面底部提供（见 4.7） -->
      <a class="jump-btn" href="#qq-group">前往底部加群 →</a>
      <button class="ghost-btn" id="copyDiagBtn" onclick="copyDiagInfo()">复制设备信息（反馈给作者）</button>
      <div class="diag-tip" id="diagTip"></div>
    </div>
```

配套 CSS（追加到 `<style>` 末尾，复用现有色系）：

```css
    .invalid-card {
      background: #fff8e1;
      border: 1px solid #ffe082;
      border-left: 4px solid #f59e0b;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 20px;
      text-align: center;
    }
    .invalid-card .invalid-icon { font-size: 28px; margin-bottom: 6px; }
    .invalid-card .invalid-title { font-size: 0.95rem; font-weight: 700; color: #92400e; margin-bottom: 8px; }
    .invalid-card .invalid-desc { font-size: 0.78rem; color: #7c5a17; line-height: 1.7; text-align: left; }
    .invalid-card .invalid-steps { font-size: 0.75rem; color: #7c5a17; line-height: 1.9; text-align: left; margin-top: 10px; }
    .jump-btn {
      display: inline-block;
      margin-top: 14px;
      padding: 8px 18px;
      background: #12b7f5;
      color: #fff;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
      text-decoration: none;
    }
    /* 页面底部：全站唯一写群号的地方（见 4.7） */
    .page-footer {
      margin-top: 22px;
      padding-top: 16px;
      border-top: 1px dashed #e5e7eb;
      text-align: center;
      font-size: 0.75rem;
      color: #6b7280;
      line-height: 1.9;
    }
    .page-footer .qq-box { color: #6b7280; }
    .page-footer .qq-num { color: #1a1a2e; font-weight: 700; letter-spacing: 0.5px; }
    .page-footer .qq-btn {
      display: inline-block;
      margin-left: 6px;
      padding: 4px 12px;
      background: #12b7f5;
      color: #fff;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      text-decoration: none;
    }
    .ghost-btn {
      margin-top: 12px;
      width: 100%;
      padding: 10px;
      background: #fff;
      border: 1px solid #e0c98a;
      border-radius: 10px;
      color: #8a6d1f;
      font-size: 0.78rem;
      cursor: pointer;
    }
    .diag-tip { font-size: 0.7rem; color: #2e7d32; margin-top: 6px; height: 14px; }
```

### 4.4 渲染与提交拦截

```js
    function showInvalidDeviceCard(raw) {
      document.getElementById('invalidCard').style.display = 'block';
      document.getElementById('invalidRaw').textContent = String(raw || '').slice(0, 40);
      // 隐藏兑换码表单，避免用户白输一遍
      var form = document.getElementById('activateForm');
      if (form) form.style.display = 'none';
      var btn = document.getElementById('activateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '设备信息异常，暂不可激活'; }
    }

    // 诊断信息：一次性打包，用户粘贴即可
    function buildDiagText() {
      var lines = [];
      lines.push('[EV激活异常] 设备ID无效');
      lines.push('deviceId=' + (getDeviceIdFromUrl() || '(空)'));
      lines.push('型号=' + (deviceInfo.model || '-') + ' / 产品=' + (deviceInfo.product || '-'));
      lines.push('设备类型=' + (deviceInfo.deviceType || '-') + ' 屏幕=' + (deviceInfo.screenWidth || '-') + 'x' + (deviceInfo.screenHeight || '-') + ' ' + (deviceInfo.screenShape || '-'));
      lines.push('ROM=' + (deviceInfo.romVersion || '-') + ' 平台版本=' + (deviceInfo.platformVersionCode || '-') + ' 渠道=' + (deviceInfo.source || '-'));
      lines.push('UA=' + (navigator.userAgent || '').slice(0, 200));
      lines.push('URL=' + window.location.href);
      lines.push('时间=' + new Date().toString());
      return lines.join('\n');
    }

    function copyDiagInfo() {
      var text = buildDiagText();
      var tip = function (ok) {
        var el = document.getElementById('diagTip');
        if (el) el.textContent = ok ? '已复制，粘贴到群里发给作者即可' : '复制失败，请手动截图本页';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { tip(true); })
          .catch(function () { tip(fallbackCopyText(text)); });
      } else {
        tip(fallbackCopyText(text));
      }
    }

    function fallbackCopyText(text) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) { return false; }
    }
```

`activate()` 开头加硬拦截（防控制台绕过、防按钮被误启用）：

```js
    function activate() {
      if (deviceIdInvalid) {
        showResult('error', '设备信息异常，请按页面提示加群反馈后重试');
        return;
      }
      ...
```

### 4.5 灰度开关（可选）

若担心 L2 名单（`0` / `0000` / `TEST`）误伤，用一个常量分级：

```js
    // false = L2 只上报不拦截；观察 24h 后台 failure 统计后再改 true
    var BLOCK_L2 = false;
```

`isValidDeviceId()` 内对 L2 命中时返回 `true` 但仍调用一次 `/api/activate?section=visitor-track` 上报 `l2Hit`，用于统计。

### 4.6 顺带清理

`populateDevicePanel()`（原 `activate.html:289`）依赖 `#devicePanel` / `#dModel` 等节点，但当前 HTML 中不存在这些元素，属**死代码**。本次改造**直接删除**（设备信息已在 `buildDiagText()` 里以文本形式提供给用户复制，不需要额外面板）。

### 4.7 群号唯一来源：页面底部（**不写进代码**）

**约定：`activate.html` 里只允许在底部这一处出现群号与加群链接，JS、接口、后端文案一律不出现。** 群满换群时只改这段 HTML，逻辑零改动。

在 `.version-footer` 之后（卡片内最底部）加入：

```html
    <!-- ⬇️ 交流群：全站唯一群号来源，群满换群只改这一段 -->
    <div class="page-footer" id="qq-group">
      遇到问题？加入用户交流 QQ 群：<span class="qq-num">936886288</span>
      <a class="qq-btn" href="https://qm.qq.com/q/6lmyuev7VY" target="_blank" rel="noopener">一键加群</a><br>
      问题反馈、版本更新通知、用户交流都在群里
    </div>
```

要点：
- `id="qq-group"` 就是 4.3 卡片里 `href="#qq-group"` 的跳转锚点，**纯 HTML 锚点，不依赖 JS**（老 WebView 无兼容风险）；
- 群号/链接只此一处，改群号 = 改两处文本（数字 + 链接），不碰任何 `.js` / `api/*` / `lib/*`；
- 与 `ev-timetable.html:379`、`user-guide.html` 的群号口径保持一致；将来若统一由一处维护，建议抽出 `/api/site-config` 之类的小接口，但**本次不引入**，避免为改个群号增加运行时依赖；
- 底部区域在卡片内、始终可见（不随 `invalidCard` 显隐变化），即使用户没触发拦截也能找到群入口。

> ❌ 反面写法（不要）：`showResult('error', '设备ID无效，请加QQ群 936886288')` —— 群号进了 JS，换群必须发版；`lib/validate.js` 里拼群号同理，属于服务端文案，改起来要走部署。

---

## 5. 后端兜底（防绕过）

前端拦截可被绕过（手改 URL、直接打接口），后端必须独立判定。

### 5.1 `lib/validate.js`

```js
var INVALID_DEVICE_TOKENS = {
  NA: 1, "N/A": 1, NULL: 1, UNDEFINED: 1, NONE: 1, UNKNOWN: 1, UNKNOW: 1,
  NIL: 1, NAN: 1, "-": 1, "--": 1, "0": 1, "0000": 1, TEST: 1, EMPTY: 1, DEFAULT: 1, FALSE: 1,
};

function isValidDeviceId(rawDeviceId) {
  var s = String(rawDeviceId == null ? "" : rawDeviceId).trim();
  if (!s) return false;
  if (INVALID_DEVICE_TOKENS[s.toUpperCase()]) return false;
  var alnum = s.replace(/[^0-9A-Za-z]/g, "");
  return alnum.length >= 4;
}

function validateDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
    return { valid: false, code: "DEVICE_ID_EMPTY", error: "设备ID不能为空" };
  }
  if (!isValidDeviceId(deviceId)) {
    // 原文里带上原始值（截断），方便后台一眼看出是 NA / null 还是别的
    var raw = deviceId.trim().slice(0, 12);
    return {
      valid: false,
      code: "DEVICE_ID_INVALID",
      // ⚠️ 服务端文案不写群号：群号只在 activate.html 底部维护（见 4.7），
      //    否则换个群就要改代码 + 重新部署。前端按 code 自行拼引导文案。
      error: '设备ID无效（当前值："' + raw + '"），请重启后重试，或联系作者处理',
      raw: raw,
    };
  }
  return { valid: true, value: normalizeDeviceId(deviceId) };
}
```

同步导出 `isValidDeviceId`、并保留 `normalizeDeviceId`（`lib/crypto.js` 内部实现不改，行为不变）。

> **旧调用方兼容（重要）**：`api/admin/redeem-codes.js:180`（后台「直开激活码」）也调 `validateDeviceId()`。为避免误伤后台——管理员可能需要**给设备取不到 ID 的用户手工开码**，或用自己的短 ID 联调——`validateDeviceId` 增加第二参数：
> ```js
> function validateDeviceId(deviceId, options) {
>   var strict = !options || options.strict !== false;   // 默认严格
>   ...
>   if (strict && !isValidDeviceId(deviceId)) { ... }
> ```
> 后台那处改为 `validateDeviceId(deviceId, { strict: false })`（仍拦空值，但放行 `NA` / 短 ID）。用户自助激活走默认严格模式。

### 5.2 `api/activate.js`

`deviceCheck` 分支（当前 `api/activate.js:347-374`）改动最小：

```js
    var deviceCheck = validateDeviceId(deviceId);
    var device = deviceCheck.value;
    if (!deviceCheck.valid) {
      // 失败原因区分开，后台漏斗能看到「设备ID无效」独立一档
      var failReason = deviceCheck.code === "DEVICE_ID_INVALID"
        ? "设备ID无效(" + (deviceCheck.raw || "") + ")"
        : deviceCheck.error;
      saveFailureRecord(failReason, deviceId, redeemCode, "", "", visitorInfo, deviceInfo);
      ...
      return res.status(400).json({
        success: false,
        code: deviceCheck.code,          // ← 新增，前端据此渲染加群卡片
        error: deviceCheck.error,
        debug: { visitor: visitorInfo, notification: buildNotificationStatus(deviceNotifyResult), reason: failReason },
      });
    }
```

要点：
- 返回体新增 `code` 字段（`DEVICE_ID_EMPTY` / `DEVICE_ID_INVALID`），前端按 code 分支，不靠文案匹配；
- `saveFailureRecord` 与 `pushNotification("activation_failure")` 走原有链路，作者侧可实时收到 `NA` 告警；
- 因无效值被拦截的请求**不占用限流配额**（当前顺序：`checkIpRateLimit` → 设备校验；如需进一步节省配额可把设备校验提到限流之前，但会牺牲防刷，建议保持现状）。

### 5.3 前端兜底渲染

`activate()` 的响应处理里加：

```js
          } else {
            if (data.code === 'DEVICE_ID_INVALID' || data.code === 'DEVICE_ID_EMPTY') {
              showInvalidDeviceCard(getDeviceIdFromUrl() || '(空)');
              showResult('error', '设备信息异常，请前往页面底部加群反馈');
            } else {
              showResult('error', data.error || '激活失败，请重试');
            }
          }
```

---

## 6. 文案（可直接用）

| 场景 | 文案 | 所在位置（是否含群号） |
|------|------|----------------------|
| 卡片标题 | 未能读取到您的设备信息 | 卡片 HTML，无群号 |
| 卡片正文 | 检测到设备返回的标识为「NA」，这是一个无效值，不是您的操作问题。继续激活会导致激活码无效，请先按下方方式联系我们处理。 | 卡片 HTML，无群号 |
| 处理步骤 | ① 请先重启手环，从手环端重新打开激活二维码再扫一次；② 若仍显示相同提示，请携带下方信息到页面底部的交流群反馈。 | 卡片 HTML，**只提"页面底部"，不写数字** |
| 跳转按钮 | 前往底部加群 → | 卡片 HTML，`href="#qq-group"` 锚点 |
| 加群区 | 遇到问题？加入用户交流 QQ 群：936886288　[一键加群] | **页面底部 `#qq-group`（全站唯一写群号处）** |
| 复制按钮 | 复制设备信息（反馈给作者） | 卡片 HTML |
| 复制成功 | 已复制，粘贴到群里发给作者即可 | 卡片 HTML |
| 提交拦截 | 设备信息异常，请按页面提示加群反馈后重试 | JS（`activate()`），无群号 |
| 接口错误 | 设备ID无效（当前值："NA"），请重启后重试，或联系作者处理 | `lib/validate.js`，**无群号** |

> 文案原则：**先归因于设备/程序，不归因于用户**；给出「先重启再反馈」的可执行动作；不出现"非法""错误"等指责性词汇。
> 维护原则：**群号只在页面底部出现一次**，JS 与后端文案只描述"去哪反馈"，不承载具体号码——群满换群时零逻辑改动（详见 4.7）。

---

## 7. 观测与统计

### 7.1 后台看板

`saveFailureRecord` 写入统一事件流（`lib/tracking.js`，`kind=failure`），设备无效会以独立 reason 出现：

- `设备ID无效(NA)`
- `设备ID无效(null)`
- `设备ID无效(-)`
- `设备ID为空`

建议在后台「失败原因」分布里单独加一档卡片：**设备信息异常用户数 / 占比**，用来回答「这是普遍问题还是个别机型」。

### 7.2 上线首日观察点

| 指标 | 关注什么 |
|------|---------|
| `设备ID无效(*)` 日总量 | 判断影响面（若 > 总激活 3%，需推动手环端修） |
| 按机型 / ROM 版本分布（`deviceInfo.model` + `r`） | 定位是哪一代固件读不到 ID |
| 拦截后 24h 内加群反馈人数 | 验证引导文案是否有效 |
| L2 名单命中量 | 决定是否把 `0` / `0000` / `TEST` 升级为硬拦 |

### 7.3 现有记录查询

失败记录同时落在 Postgres（`device_id_full = NA`），可直接 SQL 抽样：

```sql
SELECT reason, model, COUNT(*) AS n
FROM (
  SELECT payload->>'reason' AS reason, payload->>'model' AS model
  FROM kv_lists WHERE key LIKE 'tracking:%'
) t
WHERE reason LIKE '设备ID无效%'
GROUP BY 1, 2 ORDER BY n DESC;
```

> 注：`kv_lists` 无 TTL，历史数据可长期回溯（见项目数据库备忘）。

---

## 8. 测试用例

| # | 场景 | 输入 | 预期 |
|---|------|------|------|
| 1 | NA 拦截 | `?deviceId=NA&m=ap&p=Xiaomi%20Smart%20Band%209&...` | 页面直接显示加群卡片，兑换码表单隐藏，接口返回 `code=DEVICE_ID_INVALID` |
| 2 | 大小写 | `?deviceId=na` | 同上 |
| 3 | 空值旧链路 | 无 `deviceId` 参数 | 保持现状：本地随机 + 提示"本地生成"（不改行为） |
| 4 | 后端绕过 | `curl -X POST /api/activate -d '{"deviceId":"NA","redeemCode":"AB12"}'` | HTTP 400 + `code=DEVICE_ID_INVALID`，无激活码下发，有失败记录 |
| 5 | 正常 UUID | `?deviceId=550e8400-e29b-41d4-a716-446655440000` | 正常激活 |
| 6 | 尾部 0000 的 UUID | `?deviceId=xxx...0000` | 正常激活（校验原始值，不误伤） |
| 7 | 前往底部加群 | 卡片内点击「前往底部加群 →」 | 锚点跳到 `#qq-group`，底部群号区可见 |
| 8 | 复制诊断信息 | 点击复制按钮 | 剪贴板含 deviceId / 机型 / ROM / UA / URL，**不含群号** |
| 9 | 老 WebView | 仅 `var` / `XMLHttpRequest` | 无 `const` / `fetch` / 箭头函数 / 模板字符串 |
| 10 | 过期码 + 无效设备 | 两者都错 | 优先返回设备无效（设备校验在前） |
| 11 | **群号不入代码** | 全仓搜索 `936886288` | 仅命中 `activate.html` 底部 1 处（+ 其它静态说明页）；`api/*`、`lib/*`、`activate.html` 的 `<script>` 内 **0 命中** |
| 12 | 换群演练 | 只改底部数字 + 链接 | 页面正常，无需动任何 JS/接口 |

---

## 9. 实施步骤

| 阶段 | 内容 | 预估 |
|------|------|------|
| P0 后端 | `lib/validate.js` 判定 + `api/activate.js` 返回 `code`、独立 reason | 0.5h |
| P0 前端 | `activate.html` 判定函数、卡片、复制诊断、提交硬拦截 | 1h |
| P1 观测 | 后台失败原因增加「设备信息异常」分档 | 0.5h |
| P1 验证 | 用例 1–10（含真机：小米手环 9 + 表盘二维码扫码实测） | 1h |
| P2 上游 | 推动手环端修 `deviceId` 取值（见第 10 节） | 待排期 |

发布流程遵循项目约定：`./scripts/bump-version.sh` → `git add <改动文件>`（含 `version.json`，**禁止 `git add -A`**）→ `git commit -m "fix: block invalid deviceId (NA) and guide users to QQ group"` → `git push`（Vercel 自动构建，约 60–90s 生效）。

### 回滚

改动集中在 3 个文件（`activate.html`、`lib/validate.js`、`api/activate.js`），无数据结构变更、无迁移。紧急回滚只需 `git revert` 对应 commit 后 push；旧的 `NA` 激活记录保持可查。

---

## 10. 上游根治建议（手环端 / 快应用）

拦截只是止血，真正的修复应在取值侧。建议按优先级取值并保证**永不返回 `NA`**：

1. 首选：系统提供的设备唯一标识 API；
2. 次选：蓝牙 MAC / 序列号后 4 位（数字字母）；
3. 兜底：手环端生成随机 4 位并**持久化到本地存储**，重复读取返回同一值；
4. 三者皆失败：在 URL 上显式标记 `deviceId=` 空 + 新增 `ds=none`（deviceIdSource）参数，让激活页能区分"没读到"与"读到了但值异常"，并给出更精准的引导文案。

同时建议在 URL 增加 `ds=`（来源）参数，取值如 `sys` / `mac` / `random` / `none`，便于后台统计各机型取值成功率——插件侧目前已有 `m` / `p` / `r` 等参数，加一个 `ds` 成本极低。

---

## 11. 附：改动清单

| 文件 | 改动 | 是否含群号 |
|------|------|-----------|
| `docs/设备ID为NA无效值拦截与反馈引导方案.md` | 本文档 | — |
| `lib/validate.js` | 新增 `INVALID_DEVICE_TOKENS` / `isValidDeviceId()` 并导出；`validateDeviceId(deviceId, {strict})` 返回 `code` / `raw`，错误文案**不含群号** | ❌ 无 |
| `api/activate.js` | 失败 reason 细分（`设备ID无效(NA)`）；响应体新增 `code` | ❌ 无 |
| `api/admin/redeem-codes.js` | 直开激活码改 `validateDeviceId(deviceId, { strict: false })`，保持后台可用（Admin 可能要为 NA 设备手工开码） | ❌ 无 |
| `activate.html` | 无效值判定、提示卡片（含「前往底部加群」锚点）、**页面底部交流群区（唯一群号来源）**、复制诊断信息、`activate()` 硬拦截、清理 `populateDevicePanel` 死代码 | ✅ 仅底部 1 处 |
| `admin_Dx23.html`（可选） | 失败原因增加「设备信息异常」分档 | ❌ 无 |

**群号维护铁律**：`936886288` / `https://qm.qq.com/q/6lmyuev7VY` 只允许出现在 `activate.html` 底部的 `#qq-group` 那段静态 HTML 里；任何 `.js`、`api/*`、`lib/*`、后端文案都不得出现群号。换群时改那两处文本即可发布（或只改 HTML 单独发一次），不涉及逻辑回归。
