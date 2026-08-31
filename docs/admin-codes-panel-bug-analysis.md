# 兑换码管理页面打不开问题分析

## 问题描述

后台管理页面中，点击左侧菜单"兑换码管理"后，内容区域无法显示兑换码面板，页面内容区域为空。

## 根因分析

### 1. switchTab 函数缺少空值保护（致命Bug）

```javascript
// admin.html 第 620 行
document.getElementById('panel-' + tab).classList.add('active');
```

当 `document.getElementById('panel-' + tab)` 返回 `null` 时（例如元素 ID 拼写错误、DOM 未完全加载等边缘情况），调用 `.classList` 会抛出 `TypeError: Cannot read properties of null`。

**关键问题**：此错误发生在 `classList.remove('active')` 已经执行之后。此时所有 `.panel` 的 `active` 类已被移除，但新的 `active` 类未能添加成功，导致**所有面板都处于隐藏状态**，用户看到空白内容区域。

前面的 sidebar link 查询有 `if (activeLink)` 保护：
```javascript
var activeLink = document.querySelector('.sidebar-menu li a[data-tab="' + tab + '"]');
if (activeLink) activeLink.classList.add('active'); // 有 null 保护
```

但 panel 的查询没有 null 保护，直接调用 `.classList.add('active')`。

### 2. loadCodes 静默吞掉所有错误

```javascript
// admin.html 第 695 行
async function loadCodes() {
  try {
    // ... API 调用和 DOM 操作
  } catch (e) {}  // 空 catch 块，任何错误都被静默忽略
}
```

当 API 返回非预期状态码（如 500 Server Error）或网络异常时：
- `api()` 函数中 `res.json()` 可能解析失败抛出异常
- 异常被空 catch 块捕获，无任何提示
- 用户看到空表格，但不知道发生了什么

### 3. 页面初始化时无意义调用 loadCodes()

```javascript
// admin.html 第 936 行
loadStats();
loadProducts();
loadCodes();  // 此时 panel-codes 是隐藏状态，加载数据无意义
```

页面加载时 `panel-codes` 处于 `display: none` 状态，此时调用 `loadCodes()` 加载数据白白消耗 API 请求，且如果此请求失败（如 401 未认证），会触发重定向到登录页。

### 4. sidebar `<a>` 标签缺少 href 属性

```html
<li><a onclick="switchTab('codes')" data-tab="codes">...</a></li>
```

虽然现代浏览器中 `<a>` 无 `href` 不会导航，但某些环境（如移动端 WebView、旧浏览器）可能行为不一致。缺少 `href` 也导致链接不可通过键盘 Tab 访问，影响无障碍体验。

## 修复方案

### 修复 1：switchTab 添加空值保护

```javascript
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.sidebar-menu li a').forEach(function(a) { a.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  var activeLink = document.querySelector('.sidebar-menu li a[data-tab="' + tab + '"]');
  if (activeLink) activeLink.classList.add('active');
  var panel = document.getElementById('panel-' + tab);
  if (panel) {
    panel.classList.add('active');
  } else {
    console.error('Panel not found: panel-' + tab);
  }
  // ...
}
```

### 修复 2：loadCodes 添加错误处理和用户提示

```javascript
async function loadCodes() {
  try {
    // ... 原有逻辑
  } catch (e) {
    console.error('loadCodes failed:', e);
    showToast('加载兑换码失败', 'error');
  }
}
```

### 修复 3：移除初始化时的 loadCodes() 调用

页面初始化时 `panel-codes` 是隐藏的，无需加载数据。首次点击"兑换码管理"时 `switchTab` 会自动调用 `loadCodes()`。

### 修复 4：sidebar 链接添加 href="javascript:void(0)"

```html
<li><a href="javascript:void(0)" onclick="switchTab('codes')" data-tab="codes">...</a></li>
```

## 影响范围

- 兑换码管理面板：修复后正常显示
- 激活记录面板：同样受益于 switchTab 空值保护
- 解密验证面板：同样受益
- 所有 load 函数：统一错误处理，用户可见错误提示