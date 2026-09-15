# 屏幕位置指定功能 设计方案

## 一、概述

### 1.1 背景

当前的 Auto Clicker 支持坐标点击和按钮文字检测，但缺乏可视化的区域管理能力。用户无法直观地看到哪些区域正在被监控或自动操作。

本方案设计一个**屏幕位置指定功能**，让用户可以在屏幕上用线框标记出多个矩形区域，每个区域可独立配置处理逻辑。

### 1.2 核心需求

| 编号 | 需求 | 详细说明 |
|------|------|----------|
| R1 | 屏幕截取位置 | 运行后在屏幕上拖拽框选出一个矩形区域 |
| R2 | 移动位置 | 线框可被拖拽移动到屏幕任意位置 |
| R3 | 调整大小 | 通过拖拽边缘或右下角手柄缩放线框尺寸 |
| R4 | 线框样式 | 半透明彩色边框 + 编号标签，现代简洁风格 |
| R5 | 添加多个 | 支持同时创建和管理多个线框区域 |
| R6 | 编号标识 | 每个线框左上角显示唯一编号和自定义标签 |
| R7 | 取消/删除 | 每个线框可单独关闭或删除 |
| R8 | 持久显示 | 线框始终悬浮在所有窗口之上，除非手动隐藏 |
| R9 | 独立处理逻辑 | 每个区域可绑定不同的自动操作（点击、OCR、滚动等） |

---

## 二、线框外观设计

### 2.1 视觉效果

```
┌──────────────────────────────────────────────┐
│  #1 全部采纳                    ┌────┐       │
│                                 │ 拖 │       │  ← 标题栏区域（可拖拽）
│                                 └────┘       │
│                                              │
│              +                               │
│              │                               │  ← 十字参考线
│         ─────┼─────                          │
│              │                               │
│              +                               │
│                                              │
│                                       ┌───┐  │
│                                       │ ◥◤ │  │  ← 缩放手柄（右下角）
│                                       └───┘  │
└──────────────────────────────────────────────┘
```

### 2.2 样式规格

| 属性 | 默认值 | 说明 |
|------|--------|------|
| 边框宽度 | 2px | 线框轮廓线宽度 |
| 边框颜色 | `#FF4444`（红色） | 可自定义，每个区域独立颜色 |
| 边框透明度 | 85% | 半透明，不刺眼 |
| 标题栏高度 | 24px | 顶部标签栏，白色文字 + 彩色背景 |
| 标题栏字体 | Helvetica 10px Bold | 编号 + 标签名 |
| 十字线颜色 | 同边框颜色，30%透明度 | 对角线交叉线 |
| 缩放手柄大小 | 16×16 px | 右下角蓝色方块 |
| 最小宽度 | 30px | 防止缩到看不见 |
| 最小高度 | 20px | 防止缩到看不见 |
| 中间区域 | 完全透明 | 不遮挡下方窗口内容 |
| 层级 | 始终置顶 (topmost) | 不被任何窗口遮挡 |

### 2.3 颜色方案

预置6种颜色供选择，每个区域独立配色：

| 颜色名称 | 色值 | 用途建议 |
|----------|------|----------|
| 红色 | `#FF4444` | 默认，高优先级按钮 |
| 蓝色 | `#4488FF` | 确认/提交按钮 |
| 绿色 | `#44CC44` | 状态监控区域 |
| 橙色 | `#FF8800` | 警告相关区域 |
| 紫色 | `#AA44FF` | 辅助操作区域 |
| 灰色 | `#888888` | 已禁用的区域 |

---

## 三、数据结构

### 3.1 区域配置 JSON

配置文件路径：`~/.auto_clicker_regions.json`

```json
{
  "version": "1.0",
  "updated_at": "2026-09-15T10:30:00Z",
  "regions": [
    {
      "id": "region_1726410000",
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
        "click_offset_y": 0,
        "double_click": false
      }
    },
    {
      "id": "region_1726410001",
      "label": "继续按钮",
      "x": 850,
      "y": 730,
      "width": 100,
      "height": 35,
      "color": "#4488FF",
      "enabled": true,
      "action_type": "click",
      "action_config": {
        "interval_seconds": 5,
        "click_mode": "center",
        "click_offset_x": 0,
        "click_offset_y": 0,
        "double_click": false
      }
    },
    {
      "id": "region_1726410002",
      "label": "状态监控区",
      "x": 100,
      "y": 200,
      "width": 300,
      "height": 120,
      "color": "#44CC44",
      "enabled": false,
      "action_type": "ocr",
      "action_config": {
        "interval_seconds": 5,
        "watch_text": "error",
        "language": "chi_sim+eng",
        "notify_on_match": true
      }
    }
  ]
}
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | string | 是 | 自动生成 | 唯一标识，格式 `region_{timestamp}` |
| `label` | string | 是 | "New Region" | 显示标签，用户可自定义 |
| `x` | int | 是 | 鼠标位置 | 左上角 X 坐标（屏幕绝对坐标） |
| `y` | int | 是 | 鼠标位置 | 左上角 Y 坐标（屏幕绝对坐标） |
| `width` | int | 是 | 120 | 宽度（最小 30px） |
| `height` | int | 是 | 40 | 高度（最小 20px） |
| `color` | string | 是 | `#FF4444` | 线框颜色，十六进制格式 |
| `enabled` | bool | 是 | `true` | 启用状态（关闭时线框隐藏） |
| `action_type` | string | 是 | `"none"` | 处理逻辑类型 |
| `action_config` | object | 否 | `{}` | 处理逻辑的详细参数 |

---

## 四、处理逻辑类型

### 4.1 支持的操作类型

| action_type | 名称 | 描述 | 适用场景 |
|-------------|------|------|----------|
| `click` | 定时点击 | 按间隔自动点击区域几何中心 | 按钮自动确认 |
| `ocr` | 文字识别 | 截图后 OCR 识别区域内文字 | 状态变化监控 |
| `scroll` | 自动滚动 | 在区域内定时向下/向上滚动 | 长列表翻页 |
| `screenshot` | 定时截图 | 截取区域并保存为文件 | 证据留存、变化对比 |
| `none` | 仅标记 | 纯视觉标注，无自动操作 | 标记关注区域 |

### 4.2 各类型的 action_config 参数

#### click（定时点击）

```json
{
  "interval_seconds": 3,
  "click_mode": "center",
  "click_offset_x": 0,
  "click_offset_y": 0,
  "double_click": false
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `interval_seconds` | float | 3.0 | 点击间隔（秒） |
| `click_mode` | string | `"center"` | `center` 中心点击 / `scan` 逐像素扫描 |
| `click_offset_x` | int | 0 | 相对于中心的 X 偏移 |
| `click_offset_y` | int | 0 | 相对于中心的 Y 偏移 |
| `double_click` | bool | false | 是否双击 |

**点击坐标计算：**
```
click_x = x + width/2 + click_offset_x
click_y = y + height/2 + click_offset_y
```

#### ocr（文字识别）

```json
{
  "interval_seconds": 5,
  "watch_text": "error",
  "language": "chi_sim+eng",
  "notify_on_match": true,
  "notify_on_change": false
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `interval_seconds` | float | 5.0 | 识别间隔（秒） |
| `watch_text` | string | `""` | 监控的关键词（空则返回所有文字） |
| `language` | string | `"chi_sim+eng"` | OCR 语言 |
| `notify_on_match` | bool | true | 匹配关键词时发送通知 |
| `notify_on_change` | bool | false | 文字变化时发送通知 |

#### scroll（自动滚动）

```json
{
  "interval_seconds": 10,
  "scroll_distance": 300,
  "direction": "down"
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `interval_seconds` | float | 10.0 | 滚动间隔（秒） |
| `scroll_distance` | int | 300 | 每次滚动距离（像素） |
| `direction` | string | `"down"` | `down` 向下 / `up` 向上 |

#### screenshot（定时截图）

```json
{
  "interval_seconds": 60,
  "save_path": "~/Desktop/screenshots/",
  "filename_prefix": "region",
  "max_files": 100
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `interval_seconds` | float | 60.0 | 截图间隔（秒） |
| `save_path` | string | `"~/Desktop/"` | 保存目录 |
| `filename_prefix` | string | `"region"` | 文件名前缀 |
| `max_files` | int | 100 | 最多保留文件数（超出删旧） |

---

## 五、交互设计

### 5.1 创建区域

**方式一：菜单创建（默认）**

1. 点击菜单栏图标 → 选择 **"+ 新建区域"**
2. 弹出对话框输入标签名称（如"全部采纳"）
3. 区域立即在鼠标当前位置创建（默认 120×40 px）
4. 线框显示在屏幕上，处于编辑模式

**方式二：拖拽创建**

1. 菜单栏 → **"拖拽创建区域"**
2. 鼠标光标变为十字准星 `+`
3. 在屏幕上按住左键拖拽出矩形
4. 松开鼠标，弹出命名对话框
5. 确认后线框固定在拖拽区域

### 5.2 编辑模式 vs 显示模式

| 模式 | 线框状态 | 鼠标行为 | 如何进入 |
|------|---------|---------|---------|
| 显示模式 | 纯线框+编号，无法交互 | 鼠标穿透到下层窗口 | 默认模式 |
| 编辑模式 | 线框可拖拽、可缩放、显示手柄 | 鼠标可操作线框 | 菜单 → "编辑模式: ON" |

**显示模式下的穿透效果：**
- 线框之外的区域：鼠标事件完全穿透到下层窗口
- 线框边框部分：仅宽 2px 的边框可被感知，由于很窄几乎不影响操作
- 线框内透明区域：完全穿透

**编辑模式下的交互：**
- 拖拽线框任意位置 → 移动整个区域
- 拖拽右下角蓝色手柄 → 调整大小
- 双击线框 → 弹出配置对话框

### 5.3 操作方式汇总

| 操作 | 方式 | 前置条件 |
|------|------|----------|
| 创建区域 | 菜单 → "+ 新建区域" | 无 |
| 移动位置 | 编辑模式 → 拖拽线框 | 编辑模式开启 |
| 调整大小 | 编辑模式 → 拖拽右下角手柄 | 编辑模式开启 |
| 修改标签 | 菜单 → 点击区域名 → "重命名" | 无 |
| 修改颜色 | 菜单 → 点击区域名 → "颜色" → 选择 | 无 |
| 修改处理逻辑 | 菜单 → 点击区域名 → "处理逻辑" → 选择 | 无 |
| 启用/禁用 | 菜单 → 区域名前 [✓] 切换 | 无 |
| 删除单个 | 编辑模式 → 右键线框 → "删除" | 编辑模式开启 |
| 删除全部 | 菜单 → "删除所有区域" | 无 |
| 隐藏全部 | 菜单 → "隐藏所有区域" | 无 |
| 显示全部 | 菜单 → "显示所有区域" | 无 |

### 5.4 菜单栏结构

```
EvNotifier 菜单栏
├── 状态：运行中 🟢
├── 当前区域数：3
├── ─────────────────────
├── + 新建区域
├── 拖拽创建区域
├── ─────────────────────
├── [✓] #1 全部采纳          ← 点击展开子菜单
│   ├── 处理逻辑 ▸
│   │   ├── [✓] 定时点击
│   │   ├── [ ] OCR 识别
│   │   ├── [ ] 自动滚动
│   │   ├── [ ] 定时截图
│   │   └── [ ] 仅标记
│   ├── 颜色 ▸               ← 颜色选择器
│   │   ├── [✓] 红色
│   │   ├── [ ] 蓝色
│   │   ├── [ ] 绿色
│   │   ├── [ ] 橙色
│   │   ├── [ ] 紫色
│   │   └── [ ] 灰色
│   ├── 重命名...
│   ├── 点击间隔 ▸
│   │   ├── [ ] 1 秒
│   │   ├── [✓] 3 秒
│   │   ├── [ ] 5 秒
│   │   └── [ ] 自定义...
│   └── 删除
├── [✓] #2 继续按钮
├── [ ] #3 状态监控区         ← 已禁用，灰色
├── ─────────────────────
├── 编辑模式：[OFF]           ← 切换编辑/显示模式
├── 隐藏所有区域
├── 显示所有区域
├── 删除所有区域
├── ─────────────────────
├── 导出配置...
├── 导入配置...
└── 退出
```

---

## 六、技术实现

### 6.1 技术选型

| 组件 | 技术方案 | 原因 |
|------|---------|------|
| 线框窗口 | Tkinter `Toplevel` | Python 标准库，零额外依赖 |
| 窗口置顶 | `attributes("-topmost", True)` | macOS 原生支持 |
| 透明背景 | `attributes("-transparent")` | macOS 系统级透明 |
| 无边框 | `overrideredirect(True)` | 纯线框效果，无标题栏 |
| 点击穿透 | 显示模式设置 `ignoresMouseEvents` | 通过 PyObjC 或 osascript |
| 截图 | `Quartz CGWindowListCreateImage` | 已在使用，区域截图 |
| 配置存储 | JSON 文件 | 简单可靠，人类可读 |

### 6.2 架构设计

```
RegionManager（区域总管）
├── 负责所有区域的生命周期管理
├── 读取/写入 JSON 配置文件
├── 创建/销毁 Tkinter 窗口
├── 调度定时任务（点击/OCR/滚动/截图）
│
├── regions: List[RegionConfig]      ← 所有区域配置
├── windows: Dict[str, RegionWindow] ← id → 窗口实例映射
│
├── add_region(label, x, y)          ← 创建新区域
├── remove_region(region_id)         ← 删除区域
├── toggle_region(region_id)         ← 启用/禁用切换
├── update_region(region_id, config) ← 更新区域配置
├── save_to_file()                   ← 持久化到 JSON
├── load_from_file()                 ← 从 JSON 恢复
├── enter_edit_mode()                ← 进入编辑模式
├── exit_edit_mode()                 ← 退出编辑模式
└── start_action_loops()             ← 启动所有处理逻辑循环
```

### 6.3 单个区域窗口结构

```
RegionWindow（单个线框窗口）
├── Tkinter Toplevel 窗口
├── Canvas 画布
│   ├── 线框矩形（border rectangle）
│   ├── 标题栏背景（label background）
│   ├── 编号标签文字（label text）
│   ├── 十字参考线（crosshair lines）
│   └── 缩放手柄（resize handle）
│
├── 事件绑定
│   ├── <Button-1>           → 开始拖拽
│   ├── <B1-Motion>          → 执行拖拽
│   ├── 手柄 <Button-1>      → 开始缩放
│   ├── 手柄 <B1-Motion>     → 执行缩放
│   └── <Double-Button-1>    → 打开配置
│
└── 状态
    ├── editing: bool         ← 是否编辑模式
    ├── enabled: bool         ← 是否启用
    └── config: RegionConfig  ← 配置引用
```

### 6.4 核心代码结构（伪代码）

```python
class RegionManager:
    def __init__(self):
        self.regions = []
        self.windows = {}
        self.edit_mode = False
        self.config_path = os.path.expanduser("~/.auto_clicker_regions.json")
        self.action_threads = {}

    def add_region(self, label, x=None, y=None):
        """创建新区域"""
        if x is None or y is None:
            x, y = get_mouse_position()

        region = RegionConfig(
            id=f"region_{int(time.time())}",
            label=label,
            x=x, y=y,
            width=120, height=40,
            color="#FF4444",
            enabled=True,
            action_type="none"
        )
        self.regions.append(region)
        self._create_window(region)
        self.save_to_file()
        return region

    def _create_window(self, region):
        """为区域创建 Tkinter 线框窗口"""
        window = RegionWindow(region, self)
        self.windows[region.id] = window

    def remove_region(self, region_id):
        """删除指定区域"""
        if region_id in self.windows:
            self.windows[region_id].destroy()
            del self.windows[region_id]
        self.regions = [r for r in self.regions if r.id != region_id]
        self.save_to_file()

    def toggle_region(self, region_id):
        """切换区域启用/禁用状态"""
        region = next((r for r in self.regions if r.id == region_id), None)
        if region:
            region.enabled = not region.enabled
            if region.enabled:
                self._create_window(region)
            else:
                self.windows[region_id].destroy()
                del self.windows[region_id]
            self.save_to_file()

    def enter_edit_mode(self):
        """进入编辑模式：所有线框可交互"""
        self.edit_mode = True
        for window in self.windows.values():
            window.set_edit_mode(True)

    def exit_edit_mode(self):
        """退出编辑模式：所有线框显示模式，鼠标穿透"""
        self.edit_mode = False
        for window in self.windows.values():
            window.set_edit_mode(False)

    def save_to_file(self):
        """持久化所有区域到 JSON"""
        data = {
            "version": "1.0",
            "updated_at": datetime.now().isoformat(),
            "regions": [r.to_dict() for r in self.regions]
        }
        with open(self.config_path, "w") as f:
            json.dump(data, f, indent=2)

    def load_from_file(self):
        """从 JSON 恢复所有区域"""
        if os.path.exists(self.config_path):
            with open(self.config_path) as f:
                data = json.load(f)
            for r_data in data.get("regions", []):
                region = RegionConfig.from_dict(r_data)
                self.regions.append(region)
                if region.enabled:
                    self._create_window(region)
```

### 6.5 点击穿透实现

在 macOS 上使 Tkinter 窗口鼠标穿透：

```python
# 方案：通过 osascript 设置窗口 ignoresMouseEvents
def set_window_click_through(window, enabled=True):
    """设置窗口鼠标事件穿透"""
    try:
        # 获取 Tk 窗口的 NSWindow ID
        # 或者使用 PyObjC
        from Cocoa import NSApp, NSWindow
        # ... 设置 ignoresMouseEvents
    except ImportError:
        # 降级方案：不做穿透，编辑模式/显示模式切换
        pass
```

**降级方案**（无需额外依赖）：
- 显示模式下：边框宽度仅 2px，内部完全透明，实际对下层窗口操作影响极小
- 编辑模式下：正常响应鼠标事件
- 用户通过菜单栏切换模式

### 6.6 性能考虑

| 指标 | 预估值 | 说明 |
|------|--------|------|
| 单窗口内存 | ~5 MB | 每个 Tkinter 区域窗口 |
| 10 个区域内存 | ~50 MB | 可接受范围 |
| CPU 空闲 | < 1% | 无操作时几乎不消耗 |
| 定时任务 CPU | 2-5% | 取决于 OCR 频率 |
| 窗口刷新率 | 按需刷新 | 仅在移动/缩放时重绘 |

### 6.7 多显示器支持

- 记录区域所在的屏幕编号
- 区域坐标使用全局屏幕坐标系
- 切换显示器时自动调整位置（如果目标屏幕不存在则停用区域）

---

## 七、使用场景示例

### 7.1 AIoT IDE 自动确认

```
场景：AIoT IDE 频繁弹出"全部采纳"对话框需要确认

区域配置：
┌─────────────────────────────────────────┐
│ #1 全部采纳                                │
│ 位置：(298, 659)  大小：120×40            │
│ 颜色：#FF4444（红色）                       │
│ 处理逻辑：click，间隔 3 秒                  │
│ 状态：启用                                  │
└─────────────────────────────────────────┘

效果：每 3 秒自动点击"全部采纳"按钮中心位置
```

### 7.2 VSCode 对话框自动确认

```
场景：VSCode 底部弹出"继续"对话框

区域配置：
┌─────────────────────────────────────────┐
│ #2 继续按钮                                │
│ 位置：(850, 730)  大小：100×35            │
│ 颜色：#4488FF（蓝色）                       │
│ 处理逻辑：click，间隔 5 秒                  │
│ 状态：启用                                  │
└─────────────────────────────────────────┘
```

### 7.3 监控面板状态变化

```
场景：监控运维面板上的错误状态

区域配置：
┌─────────────────────────────────────────┐
│ #3 状态监控区                              │
│ 位置：(100, 200)  大小：300×120           │
│ 颜色：#44CC44（绿色）                       │
│ 处理逻辑：ocr，监控 "error" 关键词          │
│ 状态：启用                                  │
└─────────────────────────────────────────┘

效果：每 5 秒 OCR 识别区域内文字，
      发现 "error" 时发送系统通知
```

### 7.4 多个区域同时运行

```
屏幕上的实际效果：

┌──────────────────────────────────────────────────────────┐
│                                                          │
│  ┌──────────┐                                            │
│  │ #1 全部采纳 │   ← 红色线框，3秒点击                        │
│  └──────────┘                                            │
│                                                          │
│           ┌──────────────────────┐                       │
│           │ #3 状态监控区            │  ← 绿色线框，5秒OCR     │
│           └──────────────────────┘                       │
│                                                          │
│                                    ┌────────┐            │
│                                    │ #2 继续  │  ← 蓝框  │
│                                    └────────┘            │
│                                                          │
│  ┌────────────────────────┐                              │
│  │ #4 列表区域                │  ← 紫色线框，10秒滚动        │
│  │                          │                              │
│  └────────────────────────┘                              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 八、CLI 命令扩展

| 命令 | 作用 | 示例 |
|------|------|------|
| `--region-new` | 在鼠标位置创建新区域 | `--region-new --label "全部采纳"` |
| `--region-new-drag` | 拖拽模式创建区域 | `--region-new-drag` |
| `--region-list` | 列出所有区域配置 | `--region-list` |
| `--region-delete` | 删除指定编号的区域 | `--region-delete 1` |
| `--region-clear` | 删除所有区域 | `--region-clear` |
| `--region-toggle` | 启用/禁用区域 | `--region-toggle 1` |
| `--region-edit` | 进入编辑模式 | `--region-edit on/off` |
| `--region-export` | 导出配置到文件 | `--region-export config.json` |
| `--region-import` | 从文件导入配置 | `--region-import config.json` |
| `--region-test` | 测试所有区域的点击位置 | `--region-test` |
| `--region-info` | 显示区域详细信息 | `--region-info 1` |

---

## 九、配置文件管理

### 9.1 文件位置

```
~/.auto_clicker_regions.json    ← 区域配置主文件
~/.auto_clicker_regions.bak     ← 自动备份（每次保存时）
```

### 9.2 自动备份策略

- 每次写入新配置前，自动备份旧配置为 `.bak`
- 如果新配置写入失败，回滚到备份
- 保留最近 5 个备份版本

### 9.3 导入/导出

```
导出：将当前所有区域配置导出为 JSON 文件
导入：从 JSON 文件加载区域配置（合并或替换现有配置）

用途：
- 在不同机器间迁移配置
- 分享给其他用户
- 版本控制管理配置
```

---

## 十、错误处理与边界情况

| 场景 | 处理方式 |
|------|----------|
| 区域超出屏幕范围 | 拖拽时限制不超出屏幕边界 |
| 区域尺寸过小 | 设置最小 30×20 px 限制 |
| 区域被其他 topmost 窗口遮挡 | 定期检查并重新置顶 |
| 系统睡眠/唤醒 | 唤醒后检测窗口是否存在，不存在则重建 |
| 配置文件损坏 | 读取失败时使用空配置，备份损坏文件 |
| 多个区域重叠 | 允许重叠，按创建顺序绘制（后创建在上层） |
| 切换桌面/空间 | macOS 上窗口绑定到所有空间 (canJoinAllSpaces) |

---

## 十一、开发路线图

### 11.1 版本规划

| 版本 | 功能 | 预计工作量 |
|------|------|-----------|
| v1.0 | 单区域：创建线框、移动、缩放、持久化 | 1 天 |
| v1.1 | 多区域：编号、启用/禁用、删除、菜单管理 | 1 天 |
| v1.2 | 处理逻辑：click 定时点击、编辑/显示模式切换 | 1 天 |
| v1.3 | 扩展逻辑：OCR 识别、滚动、截图 | 2 天 |
| v1.4 | 优化：颜色自定义、拖拽创建、导入导出 | 1 天 |
| v1.5 | 稳定：多显示器、睡眠恢复、性能优化 | 1 天 |

### 11.2 实现优先级

```
P0（必须）: 创建线框 + 移动 + 缩放 + 持久化
P1（重要）: 多区域管理 + click 处理逻辑
P2（增强）: OCR + 滚动 + 截图
P3（优化）: 颜色自定义 + 拖拽创建 + 导入导出
```

---

## 十二、风险与注意事项

| 风险项 | 影响 | 缓解措施 |
|--------|------|----------|
| Tkinter topmost 在 macOS 全屏应用下失效 | 线框被遮挡 | 检测全屏状态，提示用户 |
| 多个 Tkinter 窗口内存占用 | 10 个区域约 50MB | 不启用时不创建窗口 |
| OCR 识别耗时阻塞 UI | 界面卡顿 | 在独立线程执行 |
| 配置文件并发写入 | 数据丢失 | 加文件锁 |
| 系统睡眠后窗口丢失 | 线框消失 | 监听睡眠通知，自动重建 |

---

## 十三、总结

本方案设计了一个完整的屏幕位置指定功能，核心特点：

1. **可视化**：线框悬浮显示，直观看到所有监控区域
2. **多区域**：同时管理多个区域，每个有独立编号
3. **可交互**：编辑模式下拖拽移动、缩放调整
4. **持久化**：配置自动保存，重启恢复
5. **可扩展**：每种区域绑定独立的处理逻辑（点击/OCR/滚动/截图）
6. **低依赖**：基于 Tkinter（Python 标准库），无需安装额外包
7. **非侵入**：显示模式下鼠标穿透，不影响正常操作

该功能是对当前坐标点击功能的重大升级，从"盲点"变为"可视化管理"，大幅提升用户体验和自动化效率。