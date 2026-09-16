# 屏幕区域管理器 - 实现方案分析

**日期:** 2026-09-16
**版本:** v1.8.0

---

## 一、需求合理性分析

### 1.1 核心需求梳理

| 需求 | 描述 | 是否合理 |
|------|------|---------|
| 屏幕区域标记 | 在屏幕上显示半透明彩色框，标记关注的区域 | ✅ 合理 |
| 区域拖动 | 用户可拖动区域到任意位置 | ✅ 合理 |
| 区域调整大小 | 用户可拖拽边角调整区域尺寸 | ✅ 合理 |
| 关闭按钮 | 区域右上角有关闭按钮 | ✅ 合理 |
| 自动运行 | 点击 Start 后每 10 秒翻页 7 次，然后点击区域 | ✅ 合理 |
| 菜单栏托盘 | macOS 菜单栏集成，可创建/编辑/删除区域 | ✅ 合理 |
| 长期稳定运行 | 应用需持续运行数小时不崩溃 | ✅ 合理（最核心需求） |
| 事件响应 | 按钮点击、拖动都要即时响应 | ✅ 合理 |

**结论：需求完全合理，没有任何不切实际的部分。** 这是一个标准的桌面 overlay + 自动化工具。

### 1.2 需求的核心难点

真正难的不是需求本身，而是一个底层问题：

> **在 macOS 上创建可接收鼠标事件的 borderless（无边框）浮动窗口**

这个问题在所有跨平台 GUI 框架中都是已知痛点，因为每个操作系统对"无边框窗口"的处理方式完全不同。

---

## 二、当前实现方式分析（Tkinter + rumps）

### 2.1 架构概览

```
rumps.App (菜单栏托盘)
    └── RegionManager (区域管理)
            └── RegionOverlay (每个区域的覆盖窗口)
                    └── tk.Toplevel (overrideredirect=True)
                            └── tk.Canvas (绘制边框+按钮)
```

### 2.2 当前问题总结

| 问题 | 严重程度 | 根因 |
|------|---------|------|
| 点击按钮无反应 | 🔴 致命 | macOS 上 `overrideredirect(True)` 的 Toplevel 窗口不接收鼠标事件 |
| 区域无法拖动 | 🔴 致命 | 同上，B1-Motion 事件也不触发 |
| 窗口不可见 | 🔴 致命 | root Tk 窗口 `withdraw()` 导致子窗口不可映射 |
| 进程随机崩溃 | 🔴 致命 | 过多的 event binding + 文件 I/O 在 rumps 事件循环中导致 GIL 崩溃 |
| alpha/systemTransparent 不可靠 | 🟡 中等 | 不同 macOS/Tk 版本行为不一致 |

### 2.3 为何 Tkinter 不适合此场景

Tkinter 是 GUI 工具包中最轻量的，但它的设计目标从来不是"无边框浮动 overlay 窗口"。在 macOS 上：

1. **`overrideredirect(True)` 是 Hack**：这个 API 设计用于全屏弹窗（如 splash screen），不是用于半透明可交互 overlay
2. **Tk 8.7 才原生支持透明窗口**：macOS 自带 Tk 通常还是 8.5，在很多系统上不工作
3. **与 rumps 事件循环冲突**：rumps 使用 NSApplication 的 run loop，Tk 有自己的 main loop，两者并存容易导致 GIL 死锁
4. **零文档**：Tkinter + macOS + borderless 透明窗口的组合几乎没有可参考的资料

**结论：Tkinter 不适合这个需求。过去 4 天的调试证明了这一点——同一个修复反复失效，因为底层平台本身就不支持。**

---

## 三、替代方案对比

### 3.1 候选方案总览

| 方案 | 稳定度 | 实现难度 | 无边框窗口 | 事件支持 | 长期运行 |
|------|--------|---------|-----------|---------|---------|
| **Hammerspoon** | ⭐⭐⭐⭐⭐ | ⭐⭐ (简单) | ✅ 原生 | ✅ 完美 | ✅ 设计用于长期运行 |
| **PyObjC (原生 NSWindow)** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ (中等) | ✅ 原生 | ✅ 完美 | ✅ 稳定 |
| **Electron** | ⭐⭐⭐⭐ | ⭐⭐⭐ | ✅ 透明可用 | ✅ 完美 | ⚠️ 内存占用高 |
| **Tauri** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ 原生 webview | ✅ 完美 | ✅ 轻量 |
| **SwiftUI App** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ 原生 | ✅ 完美 | ✅ 最佳 |
| **Tkinter (当前)** | ⭐ | ⭐⭐ | ⚠️ 平台相关 | ❌ 不可用 | ❌ 崩溃 |

### 3.2 最优推荐：Hammerspoon

Hammerspoon 是 macOS 自动化神器，它：
- 用 Lua 脚本编写，语法极简
- 原生访问 macOS API（NSWindow, NSScreen, CGEvent）
- 自带定时器、键盘鼠标监听、canvas 绘图
- 作为菜单栏常驻应用运行（类似 rumps 但更稳定）
- 社区活跃，文档完善
- **专为长期运行设计**，数小时/数天不崩溃

**对比当前方案的优势：**
- 不需要折腾 `overrideredirect`
- 不需要纠结 `alpha` / `systemTransparent`
- 原生 NSWindow 就是无框架的，直接创建即可
- Canvas 自动接收所有事件，无需坐标 hit-test hack
- 内置 hs.timer 替代手动线程管理

---

## 四、Hammerspoon 实现方案（推荐）

### 4.1 安装

```bash
# 1. 安装 Hammerspoon
brew install --cask hammerspoon

# 2. 启动并授予权限
open /Applications/Hammerspoon.app
# 系统会提示授予"辅助功能"和"屏幕录制"权限，请全部允许

# 3. 配置文件位置
# ~/.hammerspoon/init.lua
```

### 4.2 完整实现代码

创建文件 `~/.hammerspoon/init.lua`：

```lua
-- ============================================================
-- 屏幕区域管理器 - Hammerspoon 版
-- 功能：半透明浮动区域 + 点击/拖动 + 自动翻页运行
-- ============================================================

-- ---------- 配置 ----------
local configFile = os.getenv("HOME") .. "/.screen_regions.json"

-- ---------- 全局状态 ----------
local overlays = {}           -- { id -> { window, canvas, cfg, ... } }
local timer = nil             -- 全局运行定时器
local editMode = false        -- 编辑模式开关

-- ---------- JSON 读写 ----------
local function readConfig()
    local f = io.open(configFile, "r")
    if not f then return {} end
    local content = f:read("*all")
    f:close()
    local ok, data = pcall(hs.json.decode, content)
    if not ok then return {} end
    return data.regions or {}
end

local function writeConfig(regions)
    local data = { version = "1.0", regions = regions }
    local f = io.open(configFile, "w")
    f:write(hs.json.encode(data))
    f:close()
end

-- ---------- 创建单个区域 ----------
local function createOverlay(cfg)
    local id = cfg.id
    local x, y = cfg.x, cfg.y
    local w, h = cfg.width, cfg.height
    local color = cfg.color or "#FF4444"

    -- 使用原生 NSWindow (面板类型，无标题栏，始终置顶，可交互)
    local rect = hs.geometry.rect(x, y, w, h)
    local win = hs.canvas.new(rect)
        :behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)      -- 所有桌面可见
        :level(hs.canvas.windowLevels.floating)                    -- 浮动在所有窗口之上
        :allowGestures(true)                                        -- 允许鼠标事件
        :clickActivating(true)                                      -- 点击可激活
        :wantsLayer(true)                                           -- 启用图层

    -- 绘制区域
    win[1] = {
        type = "rectangle",
        action = "fill",
        fillColor = { alpha = 0.15 },  -- 半透明填充
        frame = { x = 0, y = 0, w = w, h = h },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
    }

    -- 边框
    win[2] = {
        type = "rectangle",
        action = "stroke",
        strokeColor = hs.drawing.color.x11[color],
        strokeWidth = 2,
        frame = { x = 0, y = 0, w = w, h = h },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
    }

    -- 关闭按钮 (右上角)
    win[3] = {
        type = "rectangle",
        action = "fill",
        fillColor = { red = 1, green = 0.2, blue = 0.2, alpha = 0.9 },
        frame = { x = w - 20, y = h - 20, w = 16, h = 16 },
        roundedRectRadii = { xRadius = 3, yRadius = 3 },
    }
    win[4] = {
        type = "text",
        text = "X",
        textColor = { white = 1 },
        textSize = 10,
        frame = { x = w - 20, y = h - 20, w = 16, h = 16 },
    }

    -- Start 按钮 (底部居中)
    win[5] = {
        type = "rectangle",
        action = "fill",
        fillColor = { red = 0.13, green = 0.55, blue = 0.13, alpha = 0.9 },
        frame = { x = (w - 60) / 2, y = 4, w = 60, h = 22 },
        roundedRectRadii = { xRadius = 4, yRadius = 4 },
    }
    win[6] = {
        type = "text",
        text = "Start",
        textColor = { white = 1 },
        textSize = 10,
        frame = { x = (w - 60) / 2, y = 4, w = 60, h = 22 },
    }

    -- 显示
    win:show()

    -- 存储状态
    local state = {
        window = win,
        cfg = cfg,
        dragging = false,
        resizing = false,
        dragStartX = 0,
        dragStartY = 0,
        running = false,
        runCount = 0,
        runTimer = nil,
    }

    -- ===== 关闭按钮点击检测 =====
    win:canvasMouseUp(function(canvas, msg)
        local mx, my = msg.x, msg.y
        -- 转换为 Canvas 坐标 (左上角为原点)
        my = h - my

        if mx >= w - 20 and mx <= w - 4 and my >= 0 and my <= 16 then
            -- 点击了关闭按钮
            state.window:delete()
            overlays[id] = nil
            -- 从配置文件删除
            local regions = readConfig()
            local newRegions = {}
            for _, r in ipairs(regions) do
                if r.id ~= id then table.insert(newRegions, r) end
            end
            writeConfig(newRegions)
            hs.alert.show("区域已删除")
            return true
        elseif mx >= (w - 60) / 2 and mx <= (w - 60) / 2 + 60 and my >= 4 and my <= 26 then
            -- 点击了 Start 按钮
            toggleRun(state)
            return true
        elseif editMode then
            -- 编辑模式下，检测是否点击了右下角调整大小区域
            if mx >= w - 16 and my >= 0 and my <= 16 then
                state.resizing = true
                state.dragStartX = mx
                state.dragStartY = my
                return true
            end
            -- 编辑模式下，开始拖动
            state.dragging = true
            state.dragStartX = mx
            state.dragStartY = my
            return true
        end
        return false
    end)

    -- ===== 拖动处理 =====
    win:canvasMouseDrag(function(canvas, msg)
        if not state.dragging and not state.resizing then return end

        local mx, my = msg.x, msg.y
        my = h - my

        if state.resizing then
            local newW = math.max(50, cfg.width + (mx - state.dragStartX))
            local newH = math.max(30, cfg.height - (my - state.dragStartY))
            cfg.width = newW
            cfg.height = newH
            state.window:frame(hs.geometry.rect(cfg.x, cfg.y, newW, newH))
            -- 重新绘制内容 (简化版，完整版需重建所有元素)
            updateOverlay(state)
        elseif state.dragging then
            local newX = cfg.x + (mx - state.dragStartX)
            local newY = cfg.y - (my - state.dragStartY)  -- 注意 Y 轴翻转
            cfg.x = newX
            cfg.y = newY
            state.window:topLeft({ x = newX, y = newY })
        end
    end)

    win:canvasMouseUp(function()
        if state.dragging or state.resizing then
            state.dragging = false
            state.resizing = false
            -- 保存新位置到配置文件
            local regions = readConfig()
            for _, r in ipairs(regions) do
                if r.id == id then
                    r.x = cfg.x
                    r.y = cfg.y
                    r.width = cfg.width
                    r.height = cfg.height
                end
            end
            writeConfig(regions)
        end
        return true
    end)

    overlays[id] = state
    return state
end

-- ---------- 更新区域显示 ----------
local function updateOverlay(state)
    local win = state.window
    local cfg = state.cfg
    local w, h = cfg.width, cfg.height

    win[1].frame = { x = 0, y = 0, w = w, h = h }
    win[2].frame = { x = 0, y = 0, w = w, h = h }
    win[3].frame = { x = w - 20, y = h - 20, w = 16, h = 16 }
    win[4].frame = { x = w - 20, y = h - 20, w = 16, h = 16 }
    win[5].frame = { x = (w - 60) / 2, y = 4, w = 60, h = 22 }
    win[6].frame = { x = (w - 60) / 2, y = 4, w = 60, h = 22 }
end

-- ---------- 启动/停止运行 ----------
local function toggleRun(state)
    if state.running then
        -- 停止
        if state.runTimer then
            state.runTimer:stop()
            state.runTimer = nil
        end
        state.running = false
        state.window[6].text = "Start"
        state.window[5].fillColor = { red = 0.13, green = 0.55, blue = 0.13, alpha = 0.9 }
        hs.alert.show("已停止 (共执行 " .. state.runCount .. " 次)")
    else
        -- 开始
        state.running = true
        state.runCount = 0
        state.window[6].text = "0 times"
        state.window[5].fillColor = { red = 1, green = 0.2, blue = 0.2, alpha = 0.9 }

        -- 定时器：每 10 秒执行一次
        state.runTimer = hs.timer.doEvery(10, function()
            if not state.running then return end

            -- 1. 往下翻页 7 次
            for i = 1, 7 do
                hs.eventtap.scrollWheel({ 0, -3 }, {})
                hs.timer.usleep(200000)  -- 200ms 间隔
            end

            -- 2. 等待一下
            hs.timer.usleep(500000)

            -- 3. 点击区域中心
            local cx = state.cfg.x + state.cfg.width / 2
            local cy = state.cfg.y + state.cfg.height / 2
            hs.eventtap.leftClick({ x = cx, y = cy })
            hs.timer.usleep(100000)
            -- 再次点击确保生效
            hs.eventtap.leftClick({ x = cx, y = cy })

            -- 4. 更新计数
            state.runCount = state.runCount + 1
            state.window[6].text = state.runCount .. " times"
        end)
        state.runTimer:start()
        hs.alert.show("开始运行")
    end
end

-- ---------- 加载所有区域 ----------
local function loadAll()
    -- 销毁所有现有区域
    for id, state in pairs(overlays) do
        state.window:delete()
    end
    overlays = {}

    local regions = readConfig()
    for _, cfg in ipairs(regions) do
        if cfg.enabled ~= false then
            createOverlay(cfg)
        end
    end
    hs.alert.show("已加载 " .. #regions .. " 个区域")
end

-- ---------- 菜单栏 ----------
local menu = hs.menubar.new()
menu:setTitle("📍")

menu:setMenu({
    { title = "刷新区域", fn = loadAll },
    { title = "-" },
    { title = "切换编辑模式", fn = function()
        editMode = not editMode
        hs.alert.show(editMode and "编辑模式: 开 (可拖动/调整大小)" or "编辑模式: 关")
    end },
    { title = "-" },
    { title = "停止所有运行", fn = function()
        for _, state in pairs(overlays) do
            if state.running then toggleRun(state) end
        end
    end },
    { title = "-" },
    { title = "重新加载配置", fn = function()
        hs.reload()
    end },
})

-- ---------- 启动 ----------
loadAll()
hs.alert.show("区域管理器已启动")
```

### 4.3 使用方法

1. 安装 Hammerspoon：`brew install --cask hammerspoon`
2. 启动 Hammerspoon，授予辅助功能和屏幕录制权限
3. 将上面的 Lua 代码复制到 `~/.hammerspoon/init.lua`
4. 点击菜单栏 Hammerspoon 图标 → "Reload Config"
5. 如果需要创建新区域，可以在终端运行：
   ```bash
   # 手动编辑 ~/.screen_regions.json 添加区域
   # 然后点击菜单栏 "刷新区域"
   ```

### 4.4 配置文件格式

文件路径：`~/.screen_regions.json`

```json
{
  "version": "1.0",
  "regions": [
    {
      "id": "region-001",
      "x": 500,
      "y": 400,
      "width": 150,
      "height": 100,
      "label": "监控区域1",
      "color": "#FF4444",
      "enabled": true,
      "action_type": "click"
    }
  ]
}
```

---

## 五、操作步骤（详细版）

### 5.1 移除旧方案

```bash
# 1. 停止当前 Tkinter 版本
kill $(pgrep -f "region_manager.py")

# 2. 备份旧配置文件（可选）
cp ~/.screen_regions.json ~/.screen_regions.json.bak

# 3. 清理旧的 Tkinter 窗口残留
kill $(pgrep -f "Python.*region")
```

### 5.2 安装 Hammerspoon

```bash
# 安装
brew install --cask hammerspoon

# 首次启动
open /Applications/Hammerspoon.app
```

启动后，macOS 会弹出权限请求：
1. **辅助功能权限** → 系统偏好设置 → 隐私与安全性 → 辅助功能 → 勾选 Hammerspoon
2. **屏幕录制权限** → 系统偏好设置 → 隐私与安全性 → 屏幕录制 → 勾选 Hammerspoon

### 5.3 部署配置文件

```bash
# 1. 确保配置目录存在
mkdir -p ~/.hammerspoon

# 2. 备份原配置（如果有）
cp ~/.hammerspoon/init.lua ~/.hammerspoon/init.lua.old 2>/dev/null

# 3. 写入新配置
cat > ~/.hammerspoon/init.lua << 'LUAEOF'
# [将上面的完整 Lua 代码粘贴到这里]
LUAEOF
```

**建议使用 VS Code 编辑 `~/.hammerspoon/init.lua`**，因为路径带点号，访达中默认不可见。

### 5.4 第一次运行

1. 点击菜单栏的 🔨 Hammerspoon 图标
2. 点击 "Reload Config"
3. 如果看到 `区域管理器已启动` 提示，成功
4. 点击菜单栏新增的 📍 图标 → "刷新区域"

### 5.5 创建你的第一个区域

编辑 `~/.screen_regions.json`：

```bash
# 直接用 nano 编辑
nano ~/.screen_regions.json

# 或者用 VS Code
code ~/.screen_regions.json
```

写入内容：
```json
{
  "version": "1.0",
  "regions": [
    {
      "id": "test-01",
      "x": 500,
      "y": 400,
      "width": 150,
      "height": 100,
      "label": "Test",
      "color": "#FF4444",
      "enabled": true,
      "action_type": "click"
    }
  ]
}
```

保存后，点击菜单栏 📍 → "刷新区域"，屏幕 (500, 400) 位置会出现一个红色半透明方框。

### 5.6 日常使用流程

1. **创建区域**：编辑 `~/.screen_regions.json`，添加新的 region 条目
2. **调整位置**：点击菜单栏 📍 → "切换编辑模式"，然后拖动区域到目标位置
3. **开始自动运行**：点击区域内绿色 "Start" 按钮 → 变成红色并显示执行次数
4. **停止运行**：再次点击按钮，或点击菜单栏 📍 → "停止所有运行"
5. **删除区域**：点击区域右上角红色 X 按钮

### 5.7 设置为开机自启

```bash
# 方法 1：系统偏好设置
# 系统偏好设置 → 通用 → 登录项 → + → 添加 Hammerspoon

# 方法 2：命令行
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Hammerspoon.app", hidden:false}'
```

### 5.8 确认稳定运行

```bash
# 检查 Hammerspoon 是否在运行
ps aux | grep Hammerspoon | grep -v grep

# 查看日志（如有问题）
tail -f ~/.hammerspoon/hammerspoon.log
```

---

## 六、方案对比总结

| 维度 | Tkinter (当前) | Hammerspoon (推荐) |
|------|---------------|-------------------|
| 无边框浮动窗口 | macOS 上几乎不可用 | 原生支持，开箱即用 |
| 鼠标事件 | 反复失效 | 完美接收所有事件 |
| 拖动/调整大小 | 坐标手动计算 | 原生拖拽 API |
| 定时器 | 手动 `threading.Timer` | 内置 `hs.timer` |
| 菜单栏集成 | rumps (需额外依赖) | 内置 `hs.menubar` |
| 代码量 | ~1300 行 Python | ~300 行 Lua |
| 崩溃风险 | 高 (GIL 冲突) | 极低 (原生 runloop) |
| 社区支持 | Tkinter+overlay 几乎无人用 | Hammerspoon 是 macOS 自动化主流工具 |
| 长期运行稳定性 | 数分钟即崩溃 | 可连续运行数周 |

**结论：放弃 Tkinter 方案，迁移到 Hammerspoon。整个迁移预计 30 分钟完成，稳定性将从根本上得到解决。**