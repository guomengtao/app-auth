# 屏幕区域管理器 设计方案

## 概述

开发一个可以在用户屏幕上创建**可移动、可调整大小、持久显示的线框区域**的工具。支持多个区域，每个区域绑定独立的处理逻辑（点击、OCR识别、滚动、截图等）。

## 目标

- 用户可以在屏幕上绘制矩形框，框选特定区域
- 线框样式（边框+编号标签），始终悬浮显示在所有窗口之上
- 支持移动（拖拽）和调整大小（拖拽角或边）
- 可创建多个区域，每个区域有编号，可独立启用/禁用
- 每个区域可配置不同的自动处理逻辑
- 区域配置持久化，重启后恢复

## 使用场景

| 场景 | 区域用途 | 处理逻辑 |
|------|---------|---------|
| AIoT IDE "全部采纳"按钮 | 框住按钮区域 | 每3秒坐标点击 |
| VSCode 底部对话框"继续" | 框住底部确认区域 | 出现文字时点击 |
| 某个监控面板 | 框住状态区域 | OCR识别文字变化并通知 |
| 列表页面 | 框住列表区域 | 每10秒向下滚动一次 |

## 技术方案

### 方案对比

| 方案 | 实现方式 | 优点 | 缺点 |
|------|---------|------|------|
| A: Tkinter 透明窗口 | N个透明Tk窗口叠加 | 跨平台，实现简单 | Mac下topmost可能不稳 |
| B: Quartz CGWindow | 绘制到屏幕层 | Mac原生，性能好 | API复杂，需定时刷新 |
| C: rumps + 全局hover | 菜单栏应用+悬浮层 | 轻量，与现有架构一致 | 多个窗口管理复杂 |

**推荐方案 A（Tkinter 透明窗口）**，原因：
- macOS 上 `attributes('-topmost', True)` 可保持置顶
- `overrideredirect(True)` 去掉标题栏实现纯线框
- 每个区域一个独立窗口，天然支持多区域
- 拖拽和缩放事件 Tk 原生支持
- 已有 Tkinter 使用经验（状态窗口）

### 架构设计

```
┌─────────────────────────────────────────┐
│           ScreenRegionManager           │
│  (管理所有区域窗口的生命周期)              │
├─────────────────────────────────────────┤
│  regions: List[RegionConfig]            │
│  windows: Dict[str, RegionWindow]       │
│  + add_region()                         │
│  + remove_region()                      │
│  + toggle_region()                      │
│  + restore_from_config()                │
└──────────────┬──────────────────────────┘
               │
     ┌─────────┼─────────┐
     │         │         │
     ▼         ▼         ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Region #1│ │Region #2│ │Region #3│
│ (Tk窗口) │ │ (Tk窗口) │ │ (Tk窗口) │
│ 线框+标签 │ │ 线框+标签 │ │ 线框+标签 │
├─────────┤ ├─────────┤ ├─────────┤
│ 配置:    │ │ 配置:    │ │ 配置:    │
│ 位置     │ │ 位置     │ │ 位置     │
│ 大小     │ │ 大小     │ │ 大小     │
│ 处理逻辑 │ │ 处理逻辑 │ │ 处理逻辑 │
│ 颜色     │ │ 颜色     │ │ 颜色     │
└─────────┘ └─────────┘ └─────────┘
```

### 每个区域窗口的结构

```
┌──────────────────────────────────┐
│ ● #1 全部采纳            [×]    │  ← 标题栏（可拖拽移动）
│                                  │
│                                  │
│         透明区域                  │  ← 中间透明，让下方内容可见
│                                  │
│                                  │
│                            ◥◤    │  ← 右下角缩放手柄
└──────────────────────────────────┘
```

### 区域配置数据结构

```json
{
  "regions": [
    {
      "id": "region_1",
      "label": "全部采纳",
      "x": 298,
      "y": 659,
      "width": 120,
      "height": 40,
      "color": "#FF4444",
      "enabled": true,
      "action_type": "click",
      "action_config": {
        "interval_seconds": 3,
        "click_mode": "center",
        "click_offset_x": 0,
        "click_offset_y": 0
      }
    },
    {
      "id": "region_2",
      "label": "继续按钮",
      "x": 450,
      "y": 800,
      "width": 100,
      "height": 35,
      "color": "#44AAFF",
      "enabled": true,
      "action_type": "click",
      "action_config": {
        "interval_seconds": 3,
        "click_mode": "center"
      }
    },
    {
      "id": "region_3",
      "label": "状态监控",
      "x": 100,
      "y": 200,
      "width": 300,
      "height": 100,
      "color": "#44FF44",
      "enabled": false,
      "action_type": "ocr",
      "action_config": {
        "interval_seconds": 5,
        "watch_text": "error",
        "language": "chi_sim+eng"
      }
    }
  ]
}
```

### 处理逻辑类型（action_type）

| 类型 | 说明 | 参数 |
|------|------|------|
| `click` | 定时点击区域中心 | interval_seconds, click_mode(center/scan) |
| `ocr` | OCR识别区域文字 | interval_seconds, watch_text, language |
| `scroll` | 在区域内滚动 | interval_seconds, scroll_distance, direction(up/down) |
| `screenshot` | 定时截图保存 | interval_seconds, save_path |
| `none` | 仅标记，无自动操作 | - |

## 交互设计

### 创建区域

1. 右键菜单栏图标 → "新建区域"
2. 鼠标变为十字准星样式
3. 用户在屏幕上拖拽画出矩形
4. 松开鼠标后弹出命名对话框
5. 确认后区域窗口创建并显示

### 操作区域

| 操作 | 方式 |
|------|------|
| 移动 | 拖拽标题栏 |
| 调整大小 | 拖拽右下角手柄 |
| 删除 | 点击区域标签上的 [×] 按钮 |
| 启用/禁用 | 菜单中切换勾选 |
| 修改颜色 | 菜单中选颜色 |
| 修改处理逻辑 | 菜单中选 action type |

### 区域窗口特性

```
- always on top（始终在最上层）
- 不可被其他窗口遮挡
- 鼠标事件可穿透（点击穿透到下层窗口）
- 标题栏和手柄区域不穿透（可交互）
- 刷新时窗口位置保持不变
```

### 右键菜单新增项

```
菜单栏
├── 新建区域
├── 区域列表 ────────
│   ├── [√] #1 全部采纳  ────────
│   │   ├── 处理逻辑  ──
│   │   │   ├── [√] 定时点击
│   │   │   ├── [ ] OCR识别
│   │   │   ├── [ ] 滚动
│   │   │   ├── [ ] 截图
│   │   │   └── [ ] 无操作
│   │   ├── 点击模式  ──
│   │   │   ├── [√] 中心点点击
│   │   │   └── [ ] 逐像素扫描
│   │   ├── 间隔时间 → 3s / 5s / 10s / 自定义
│   │   ├── 改变颜色
│   │   ├── 重命名
│   │   └── 删除
│   ├── [√] #2 继续按钮
│   └── [ ] #3 状态监控
├── 显示/隐藏所有区域
├── 保存区域配置
└── 加载区域配置
```

## 窗口技术细节

### Tkinter 透明线框实现

```python
def create_region_window(region_id, x, y, width, height, color, label):
    import tkinter as tk

    root = tk.Tk()
    root.overrideredirect(True)           # 无标题栏
    root.attributes("-topmost", True)      # 永远置顶
    root.attributes("-alpha", 0.85)        # 半透明边框
    root.geometry(f"{width}x{height}+{x}+{y}")

    # macOS 特定：让窗口悬浮在所有空间
    root.attributes("-transparent", "systemTransparent")

    # 边框画布
    canvas = tk.Canvas(root, width=width, height=height,
                       bg="systemTransparent", highlightthickness=0)
    canvas.pack()

    # 绘制线框
    canvas.create_rectangle(0, 0, width-1, height-1,
                            outline=color, width=2)

    # 编号标签（左上角）
    canvas.create_text(30, 12, text=f"#{label}",
                       fill=color, font=("Helvetica", 10, "bold"))

    # 拖动移动
    def start_drag(event):
        root._drag_x = event.x
        root._drag_y = event.y

    def do_drag(event):
        x = root.winfo_x() + event.x - root._drag_x
        y = root.winfo_y() + event.y - root._drag_y
        root.geometry(f"+{x}+{y}")

    canvas.bind("<Button-1>", start_drag)
    canvas.bind("<B1-Motion>", do_drag)

    # 缩放手柄（右下角）
    resize_handle = canvas.create_rectangle(
        width-20, height-20, width, height,
        fill=color, outline=""
    )

    def start_resize(event):
        root._resize_x = event.x
        root._resize_y = event.y

    def do_resize(event):
        new_w = max(30, width + event.x - root._resize_x)
        new_h = max(20, height + event.y - root._resize_y)
        root.geometry(f"{new_w}x{new_h}")

    canvas.tag_bind(resize_handle, "<Button-1>", start_resize)
    canvas.tag_bind(resize_handle, "<B1-Motion>", do_resize)

    return root
```

### 点击穿透实现

在 macOS 上，使用 `NSTrackingArea` 或设置窗口 `ignoresMouseEvents`：

```python
# 方案1：使用 PyObjC（需要安装 pyobjc）
from AppKit import NSApp, NSWindoow
# ...设置窗口 ignoresMouseEvents

# 方案2：使用 osascript（更简单）
def set_click_through(window_id, enabled=True):
    """设置窗口点击穿透"""
    # 需要先获取Tk窗口的NSWindow ID
    # 然后设置 ignoresMouseEvents
    pass
```

**简化方案**：如果 Tkinter 点击穿透复杂，可考虑：
- 整个窗口忽略鼠标事件（完全穿透）
- 操作通过菜单栏完成，不依赖窗口上的按钮
- 使用独立的"编辑模式"和"显示模式"切换

### 编辑模式 vs 显示模式

| 模式 | 窗口行为 | 如何进入 |
|------|---------|---------|
| 显示模式 | 线框+标签，鼠标穿透 | 默认 |
| 编辑模式 | 线框可拖拽、可缩放、显示手柄 | 菜单"编辑所有区域" |

这样避免复杂的点击穿透问题：显示模式下窗口完全透明穿透，编辑时才可交互。

## 实现计划

### 版本规划

| 版本 | 功能 |
|------|------|
| v1.2.0 | 基础区域：创建线框、移动、缩放、持久化 |
| v1.2.1 | 多区域管理：编号、启用/禁用、删除 |
| v1.2.2 | 处理逻辑绑定：定时点击、OCR、滚动 |
| v1.2.3 | 编辑/显示模式切换，颜色自定义 |
| v1.3.0 | 优化：CPU/内存优化，减少闪烁 |

### 文件结构

```
tools/ev-notifier/
├── auto_clicker_v1.1.2.py          ← 当前版本（坐标点击）
├── auto_clicker_v1.2.0.py          ← 区域管理器（新）
├── screen_region_config.json       ← 区域配置文件
└── screen-region-manager.md        ← 本文档
```

## 与现有功能的整合

`auto_clicker` 作为主进程运行，区域管理器作为可选模块：
- 用户可选择：纯坐标模式 or 区域管理模式
- 区域管理模式自动包含坐标点击功能（区域中心点）
- 统一的状态窗口、日志记录

## 风险与注意事项

1. **性能**：每个区域一个Tk窗口，10个区域约占用 50MB 内存，可接受
2. **闪烁**：持续重绘可能导致视觉闪烁，可用 `update_idletasks()` 优化
3. **多显示器**：记录屏幕编号，区域绑定到具体屏幕
4. **全屏应用**：全屏模式下 topmost 窗口可能被遮挡
5. **睡眠恢复**：系统睡眠后窗口可能丢失，需重绘检测

## 总结

该方案利用 Tkinter（Python标准库，零额外依赖）实现屏幕区域管理，通过透明置顶窗口创建可移动的线框区域，每个区域绑定独立的自动处理逻辑（点击/OCR/滚动/截图），完美补充当前坐标点击功能，实现更灵活、更可视化的屏幕自动化。