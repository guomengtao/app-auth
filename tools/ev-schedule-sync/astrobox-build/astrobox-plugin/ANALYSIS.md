# EV 课程表同步器 代码分析报告

> 版本：v1.0.23 | WASM 大小：672KB | ABP 包大小：398KB
> 分析日期：2026-09-22

---

## 一、项目概览

EV 课程表同步器是一个运行在 **AstroBox 宿主环境**中的 WASM 插件（Rust 编写），主要功能是在手表/手环之间导入和导出课程表数据。支持 7 种格式：Demo JSON、sgschedule、WakeUp、StarLink、CSES、EV Schedule（导出格式）、EV Schedule（原生格式）。

### 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | Rust（编译到 wasm32-wasip2） |
| UI 框架 | AstroBox psys-host UI（声明式 Element 树） |
| 序列化 | serde / serde_json |
| 构建 | Cargo → wasm + zip → .abp |

---

## 二、文件结构

```
astrobox-build/astrobox-plugin/
├── manifest.json          # 插件元信息（名称、版本、入口 wasm、权限）
├── Cargo.toml             # Rust 项目配置
├── icon.png               # 插件图标
├── src/
│   ├── lib.rs             # ⭐ 入口：Page 状态机、事件路由、守卫检查
│   ├── ui.rs              # ⭐ UI 渲染：所有页面的 Element 树构建
│   ├── models.rs          # 数据模型：UnifiedCourse、UnifiedSchedule 等
│   ├── import_engine.rs   # 导入引擎：JSON → UnifiedCourse
│   ├── export_engine.rs   # 导出引擎：UnifiedCourse → JSON（EV/SG 格式）
│   ├── device.rs          # 设备检测：配对设备列表 + EV 安装状态检测
│   ├── demo_template.rs   # Demo JSON 模板 + 支持格式说明
│   ├── resources.rs       # 静态资源（base64 图片）
│   ├── logger.rs          # 日志（空实现）
│   └── adapters/
│       ├── mod.rs         # 格式自动检测 + 分发解析
│       ├── demo.rs        # Demo JSON 解析器
│       ├── sgschedule.rs  # sgschedule 解析器
│       ├── wakeup.rs      # WakeUp 解析器
│       ├── starlink.rs    # StarLink 解析器
│       ├── cses.rs        # CSES 解析器
│       ├── evschedule.rs  # EV Schedule（导出格式）解析器
│       └── evschedule_actual.rs  # EV Schedule（原生格式）解析器
├── scripts/
│   ├── build_abp.sh       # Shell 构建脚本
│   └── build_dist.py      # Python 构建脚本（更通用）
├── dist/                  # 构建输出目录
│   ├── manifest.json
│   ├── ev-schedule-sync.wasm
│   ├── icon.png
│   └── EV-Schedule-Sync-v1.0.23.abp  ← 当前发布包
└── DESIGN.md              # 设计方案文档
```

---

## 三、核心架构分析

### 3.1 状态管理

```rust
// lib.rs
pub enum Page {
    Import,        // 导入页
    Export,        // 导出页
    SelectDevice,  // 设备选择页（覆盖式）
}

struct PluginState {
    page: Page,                    // 当前页面
    previous_tab: Page,            // 进入设备选择页之前的页面
    imported_json: String,         // 导入 JSON 输入
    schedule_name: String,         // 课程表名称
    courses: Vec<UnifiedCourse>,   // 当前课程数据
    devices: Vec<DeviceEntry>,     // 设备列表
    selected_device_addr: Option<String>,  // 已选设备地址
    // ... 其他 UI 状态
}
```

**关键设计：**
- 全局状态通过 `static STATE: Mutex<PluginState>` 管理
- 不可重入 Mutex → 各 build 函数内部短作用域持锁，**禁止嵌套调用持锁函数**
- 页面切换通过修改 `state.page` 实现

### 3.2 事件驱动流程

```
on_ui_render(element_id)
    → ui::render_main_ui(&element_id)     // 首次渲染

on_ui_event(event_id, event, payload)
    → handle_ui_event_inner()              // 处理点击/输入
        → 更新 STATE
        → 返回 true（需要重渲染）
    → ui::render_main_ui(&target)          // 重新渲染
```

### 3.3 当前页面结构（双 Tab 模式）

```
┌──────────────────────────────────┐
│  EV 课程表同步器                  │
│  目标设备：[切换设备]             │
│  ── 导入 Tab ──/── 导出 Tab ──   │  ← 纵向通栏按钮切换
│  ┌────────────────────────────┐  │
│  │ 粘贴课程表 JSON            │  │
│  │ [文本输入框]               │  │
│  │ 目标课程表名称              │  │
│  │ [文本输入框]               │  │
│  │ [导入] [AI生成] [格式说明]  │  │
│  └────────────────────────────┘  │
│  [→ 前往导出]                    │  ← 跳转按钮
│  版本 v1.0.23                    │
└──────────────────────────────────┘
```

**问题：** 导入和导出在同一个页面通过 Tab 切换，不够直观。用户需要：
- 一个**独立的主页**，清楚区分"导入"和"导出"两个入口
- 导入页是完整的独立页面
- 导出页是完整的独立页面
- 各自有"返回主页"按钮

### 3.4 导入引擎（import_engine.rs）

```
import_from_json(raw_json, schedule_name)
  → adapters::auto_parse(raw_json)
      → detect_format() 逐个尝试 detect()
      → parse_by_format() 分发到具体解析器
  → 返回 ImportResult { format, courses, ... }
```

自动检测优先级：Demo > sgschedule > WakeUp > StarLink > CSES > EVScheduleActual > EVSchedule

### 3.5 导出引擎（export_engine.rs）

- `export_as_evschedule()` → EV 课程表自身备份格式（UnifiedExport）
- `export_as_evschedule_actual()` → EV 课程表原生格式（按天分组）
- `export_as_sgschedule()` → sgschedule 格式（含 timeSlots 节次表）

### 3.6 设备守卫（DESIGN.md §2）

每次导入/导出操作前检查：
1. `selected_device_addr` 不为空
2. 设备在线（connected）
3. EV 课程表已安装（ev_status == Installed）

任一不满足 → 显示明确错误横幅。

---

## 四、当前代码的关键流程

### 4.1 页面渲染（ui.rs）

```rust
pub fn render_main_ui(element_id: &str) {
    let (page, show_demo_dialog, show_format_dialog) = { STATE... };

    let container = if page == Page::SelectDevice {
        build_select_device_page()
    } else {
        build_tabbed_page(page)   // ← Import 或 Export
    };

    // 对话框用 absolute overlay 叠加
    if show_format_dialog {
        render(container.child(build_format_overlay()));
    } else if show_demo_dialog {
        render(container.child(build_demo_overlay()));
    } else {
        render(container);
    }
}
```

### 4.2 build_tabbed_page 结构

```
build_tabbed_page(page)
  ├── 标题 "EV 课程表同步器"
  ├── build_device_card_banner()        // 目标设备
  ├── guard_error 横幅（条件渲染）
  ├── build_import_tab() / build_export_tab()  // Tab 内容
  ├── build_nav_button(&page)           // "→ 前往导出" / "← 返回导入"
  └── build_footer()                    // 版本号
```

### 4.3 Tab 切换按钮（build_nav_button）

```rust
fn build_nav_button(current: &Page) -> ui::Element {
    let (label, target) = match current {
        Page::Export => ("← 返回导入", "btn-tab-import"),
        _ => ("→ 前往导出", "btn-tab-export"),
    };
    // 纵向通栏按钮（flex Row 在宿主版本下不可靠）
}
```

---

## 五、分离导入和导出的方案

### 5.1 目标

将当前的「双 Tab 模式」改为「三页模式」：

```
主页（新）─→ 导入页（独立页面）
  │
  └───────→ 导出页（独立页面）
```

### 5.2 改动方案

#### Step 1：lib.rs —— 新增 Page::Main

```rust
pub enum Page {
    Main,          // 新增：主页（入口）
    Import,        // 导入页（独立）
    Export,        // 导出页（独立）
    SelectDevice,  // 设备选择页
}
```

默认页面改为 `Page::Main`。

#### Step 2：lib.rs —— 新增点击事件处理

- `"btn-goto-import"` → `page = Page::Import`
- `"btn-goto-export"` → `page = Page::Export`
- `"btn-back-main"` → `page = Page::Main`

#### Step 3：ui.rs —— 新增 build_main_page()

主页包含两个大按钮：
- "📥 导入课程表" → `btn-goto-import`
- "📤 导出课程表" → `btn-goto-export`

以及设备状态横幅和版本号。

#### Step 4：ui.rs —— 修改 build_import_tab / build_export_tab

每个独立页面底部添加"← 返回主页"按钮（`btn-back-main`）。

#### Step 5：ui.rs —— 删除 build_nav_button()

不再需要 tab 间切换按钮。

#### Step 6：ui.rs —— 修改 render_main_ui()

```rust
let container = match page {
    Page::Main => build_main_page(),
    Page::SelectDevice => build_select_device_page(),
    _ => build_standalone_page(page),  // Import / Export
};
```

### 5.3 影响范围总结

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `lib.rs` | ~10 行 | 新增 Page::Main，新增 3 个点击事件 |
| `ui.rs` | ~60 行 | 新增 build_main_page()，修改独立页面，删除 nav 按钮 |
| `manifest.json` | 1 行 | 版本号 bump 到 1.0.24 |

### 5.4 不改动的部分

- ✅ 设备选择页（SelectDevice）保持不变
- ✅ Demo JSON 对话框保持不变
- ✅ 格式说明对话框保持不变
- ✅ 导入引擎、导出引擎、适配器完全不变
- ✅ 守卫检查逻辑不变
- ✅ 设备检测逻辑不变
- ✅ 安装流程不变

---

## 六、包大小分析

| 文件 | 大小 |
|------|------|
| ev-schedule-sync.wasm | ~672KB |
| manifest.json | ~0.5KB |
| icon.png | ~5KB |
| **ABP 包总计** | **~398KB**（zip 压缩） |

WASM 体积主要来自：
- serde / serde_json（大量序列化代码）
- wit-bindgen 生成的宿主绑定代码
- 7 个格式适配器的解析逻辑

ABP 包通过 zip 压缩减小了约 40% 的体积。

---

## 七、构建流程

```bash
# 1. 编译 WASM
cargo build --target wasm32-wasip2 --release

# 2. 打包 ABP
# 方式 A：Shell 脚本
scripts/build_abp.sh

# 方式 B：Python 脚本
python3 scripts/build_dist.py --release --package

# 输出：dist/EV-Schedule-Sync-v{version}.abp
```

---

## 八、总结

当前 v1.0.23 的代码结构清晰，模块职责明确。将导入和导出从「双 Tab」改为「三页面（主页+导入+导出）」的改动量很小（约 70 行），不影响任何核心逻辑，且安装流程保持完全不变。