# 独立虚拟鼠标方案分析

## 问题描述

当前使用 Hammerspoon 模拟鼠标点击时，会抢占用户真实的鼠标光标和窗口焦点，导致打字时频繁丢失焦点，电脑几乎无法同时做其他操作。

虽然已经实现了"保存光标→点击→恢复光标→恢复焦点"的方案，但仍有短暂的闪烁和焦点切换，体验不佳。

## 核心问题

macOS 内核设计上**没有真正独立的"第二鼠标"概念**。所有 CGEvent（Core Graphics 事件）都走同一个系统事件队列，鼠标事件和窗口焦点是强绑定的。要彻底隔离，需要绕过系统事件队列。

---

## 方案对比

### 方案 A：CGEvent（当前方案）

| 项目 | 说明 |
|------|------|
| 原理 | 往系统事件队列注入鼠标按下/抬起事件 |
| 光标 | 必然移动（可事后恢复，但会闪烁） |
| 焦点 | 必然切换（可事后 `activate()` 恢复，但打字被打断） |
| 可用性 | ⭐ 电脑几乎不能同时使用 |
| 结论 | **不可接受** |

### 方案 B：Accessibility API（AXPress）

| 项目 | 说明 |
|------|------|
| 原理 | `hs.axuielement:elementAtPosition(x,y)` 找到 UI 元素，调用 `performAction("AXPress")` 直接触发元素的点击动作 |
| 光标 | ✅ 完全不动 |
| 焦点 | ✅ 不切换（如果元素支持 AX，点击在其应用内部处理） |
| 限制 | ❌ 并非所有 UI 元素都支持 AXPress（Web 页面内元素、Canvas、图片等通常不支持） |
| 滚动 | ❌ AX API 对滚动支持有限（没有 AXScroll 这种通用动作） |
| 适用 | 原生 macOS 按钮、菜单、列表等标准控件 |

**实测结果：**
```lua
-- 测试：AXPress 不会移动光标
local elem = hs.axuielement.systemWideElement()
local target = elem:elementAtPosition({x=500, y=400})
target:performAction("AXPress")
-- 光标位置不变！✅
```

**不适用场景：**
- 网页内的任意位置点击（浏览器将整个网页渲染为一个 AXWebArea，不暴露内部元素坐标）
- 图片、Canvas 区域
- 自定义渲染的 UI

### 方案 C：CGEventPostToPSN（定向投递）

| 项目 | 说明 |
|------|------|
| 原理 | 将鼠标事件直接投递到目标进程的私有事件队列，不经过系统全局事件流 |
| 光标 | ✅ 不动（事件只发给目标进程） |
| 焦点 | ✅ 不切换（系统不知道有鼠标事件发生） |
| 限制 | ❌ Hammerspoon 未暴露此 API，需要写 Objective-C 扩展 |
| 实现 | 需要 Xcode + 编译 `.m` 文件 + 签名 |

**这是 macOS 层面最接近"独立虚拟鼠标"的方案**，但开发成本高。

### 方案 D：浏览器 DevTools Protocol（CDP）

如果目标区域是**浏览器中的网页**，这是最完美的方案：

| 项目 | 说明 |
|------|------|
| 原理 | 通过 Chrome DevTools Protocol 的 `Input.dispatchMouseEvent` 在页面内部模拟点击和滚动，完全不经过系统事件 |
| 光标 | ✅ 完全不动 |
| 焦点 | ✅ 不切换 |
| 滚动 | ✅ 完美支持（`Input.dispatchMouseEvent` + `type: "mouseWheel"`） |
| 点击 | ✅ 完美支持（`Input.dispatchMouseEvent` + `type: "mousePressed"` / `"mouseReleased"`） |
| 精确度 | ✅ 像素级精确，可指定页面内坐标 |
| 限制 | ⚠️ 仅适用于 Chrome/Edge 等支持 CDP 的浏览器 |
| 成熟度 | ⭐⭐⭐⭐⭐ 工业级方案（Puppeteer、Playwright 底层都用它） |

**CDP 命令示例：**
```json
{
  "method": "Input.dispatchMouseEvent",
  "params": {
    "type": "mousePressed",
    "x": 300,
    "y": 200,
    "button": "left",
    "clickCount": 1
  }
}
```

光标完全不动，点击只在浏览器页面内部生效。

### 方案 E：Playwright / Puppeteer 进程分离

| 项目 | 说明 |
|------|------|
| 原理 | 启动独立的 Node.js 进程，通过 WebSocket 连接浏览器 CDP，使用 Playwright/Puppeteer 控制页面 |
| 优点 | 代码简单、生态成熟、支持复杂交互 |
| 缺点 | 需要独立进程、需要 node 环境、需要浏览器开启调试端口 |
| 光标 | ✅ 完全不动 |
| 焦点 | ✅ 不切换 |

### 方案 F：用 cliclick / AppleScript 在后台窗口操作

| 项目 | 说明 |
|------|------|
| 原理 | cliclick 是命令行工具，底层仍是 CGEvent，会移动光标 |
| 结论 | ❌ 与方案 A 同问题 |

---

## 总结对比表

| 方案 | 光标不动 | 焦点不抢 | 任意坐标点击 | 滚动支持 | 实现难度 |
|------|:---:|:---:|:---:|:---:|:---:|
| A: CGEvent | ❌ | ❌ | ✅ | ✅ | 已实现 |
| B: AXPress | ✅ | ✅ | ❌ | ❌ | 低 |
| C: CGEventPostToPSN | ✅ | ✅ | ✅ | ✅ | 高（需 ObjC 扩展） |
| **D: CDP 浏览器控制** | ✅ | ✅ | ✅ | ✅ | **中（推荐）** |
| E: Playwright 独立进程 | ✅ | ✅ | ✅ | ✅ | 中 |
| F: cliclick/AppleScript | ❌ | ❌ | ✅ | ✅ | 低 |

---

## 推荐方案：D 或 E（CDP 浏览器控制）

### 为什么推荐 CDP 方案

1. **完全隔离**：CDP 在浏览器渲染进程内部操作，与系统鼠标零耦合
2. **你的使用场景匹配**：区域管理器大概率是用来自动操作**浏览器中的网页**
3. **成熟稳定**：Playwright/Puppeteer 是 Google/Microsoft 维护的工业级工具
4. **可长期运行**：Node.js 守护进程，不会崩溃

### 实现步骤（方案 E: Playwright）

#### 1. 安装 Node.js（如没有）
```bash
brew install node
```

#### 2. 创建项目
```bash
mkdir -p ~/region-automation
cd ~/region-automation
npm init -y
npm install playwright
npx playwright install chromium
```

#### 3. 编写自动化脚本 `auto-worker.js`
```javascript
const { chromium } = require('playwright');

const REGIONS = [
  { name: 'region-1', x: 300, y: 200, width: 100, height: 80 },
  // ... more regions from .screen_regions.json
];

async function runRegion(browser, page, region) {
  let count = 0;
  const loop = async () => {
    // 1. 滚动 7 页（每次滚动一定距离）
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 300); // 向下滚 300px
      await page.waitForTimeout(300);
    }
    // 2. 在区域中心点击
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    await page.mouse.click(cx, cy);
    count++;
    console.log(`[${region.name}] click #${count}`);
    // 3. 等 10 秒再循环
    setTimeout(loop, 10000);
  };
  loop();
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  // 连接到已有的浏览器窗口，或打开新页面
  const page = await browser.newPage();
  await page.goto('https://your-target-url.com');
  
  for (const region of REGIONS) {
    runRegion(browser, page, region);
  }
}

main();
```

#### 4. 让 Hammerspoon 管理 Playwright 进程
在 `~/.hammerspoon/init.lua` 中用 `hs.task` 启动/停止 Node 进程：
```lua
local task = nil
function startWorker()
    task = hs.task.new("/usr/local/bin/node", function(_, stdout)
        print(stdout)
    end, {
        os.getenv("HOME") .. "/region-automation/auto-worker.js"
    })
    task:start()
end
```

---

## 如果目标不是浏览器

如果区域内的内容不是浏览器网页（比如是 macOS 原生应用），那么：

1. **第一选择**：尝试 AXPress（方案 B），先检测目标元素是否支持
2. **第二选择**：写一个小型 Objective-C Hammerspoon 扩展暴露 CGEventPostToPSN（方案 C）
3. **放弃方案**：CGEvent 恢复光标/焦点方案只能是权宜之计，不适合长期使用

---

## 结论

- **不存在** macOS 系统级的"完全独立虚拟鼠标"API
- **如果目标是浏览器页面**：强烈推荐 CDP（方案 D/E），光标和焦点零干扰
- **如果目标是原生应用**：方案 B（AXPress）可部分解决，但有元素类型限制；方案 C（CGEventPostToPSN）是最彻底的但需要 ObjC 开发
- **当前 CGEvent 方案**：不适合需要同时使用电脑的场景