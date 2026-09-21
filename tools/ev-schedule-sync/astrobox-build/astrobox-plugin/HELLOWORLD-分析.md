# HelloWorld 包安装后不显示 — 原因分析

> 分析对象：`tools/ev-schedule-sync/astrobox-build/astrobox-plugin/`
> 问题描述：helloworld 版本编译出的 `.abp` 包安装到 AstroBox 后，插件列表里不显示，或显示了但没有界面。

---

## 一、当前 HelloWorld 代码现状

当前 `src/lib.rs` 就是 HelloWorld 版本，核心逻辑极其简单：

- `on_load()` → 初始化空日志
- `on_card_render()` → 渲染一行 "hello world" 文本卡片
- `on_ui_render()` → 渲染一个 `Span` 组件，内容 "hello world"，字号 32，白色
- 所有 `future<T>` 返回值都是异步空数据

`src/ui.rs` 也是极简版：

```rust
pub fn render_main_ui(element_id: &str) {
    let hello = ui::Element::new(ui::ElementType::Span, Some("hello world"))
        .size(32)
        .text_color("#ffffff");
    psys_host::ui::render(element_id, hello);
}
```

---

## 二、可能的原因分析

### 原因 1（⭐ 最可能）：`api_level` 与 WIT world 不匹配

**问题描述**：

| 配置项 | 值 | 所在文件 | 含义 |
|--------|:--:|------|------|
| `api_level` | `3` | `manifest.json` | 告诉 AstroBox 宿主使用 v3 API |
| WIT world | `psys-world` | `lib.rs` 宏 | 插件导出 v1/v2 的事件接口 |

这两个值存在**严重不匹配**。

**详细分析**：

查看 `wit/main.wit`，项目定义了三个 world：

| World | 导入的 host API | 导出的 plugin 接口 |
|-------|:--------------:|:-----------------:|
| `psys-world` | `ui` **+** `ui-v3` | `plugin-event` (v1/v2) |
| `psys-world-v2` | `ui` **+** `ui-v3` | `plugin-event` (v1/v2) |
| `psys-world-v3` | **仅** `ui-v3` | `plugin-event-v3` |

当 `api_level: 3` 时，AstroBox 宿主**只会**提供 `ui-v3` 的 API，而不会提供旧版 `ui` API。

但是当前 `lib.rs` 编译时连接的是 `psys-world`，它：
- 导出了 `plugin-event`（旧版事件接口，不是 `plugin-event-v3`）
- 生成的主机 API 代码会同时引用 `ui` 和 `ui-v3`
- `src/ui.rs` 里用的是 `psys_host::ui::render()`（旧版 UI 接口）

**后果**：
- 如果宿主严格按 `api_level: 3` 只挂载 v3 API，插件在 WASM 组件实例化阶段就会失败
- 即使实例化成功，调用旧版 `ui::render()` 时宿主没有注册这个接口，直接崩溃或静默失败
- 插件列表中可能根本不会出现该插件，或者出现但无法渲染任何 UI

**验证方法**：
1. 将 `manifest.json` 中的 `api_level` 改为 `2`，重新打包测试
2. 或将 `lib.rs` 中的 WIT world 改为 `psys-world-v3`，同时把所有 `ui` 调用改为 `ui-v3`

---

### 原因 2（可能）：Rust `edition = "2024"` 不稳定

**问题描述**：

`Cargo.toml` 第 4 行：

```toml
edition = "2024"
```

Rust 2024 edition 在 2025 年 2 月（Rust 1.85）才稳定下来。`wasm32-wasip2` 目标对该 edition 的支持可能不完整。

**可能的影响**：
- `wit-bindgen 0.57` 的 proc-macro 在 2024 edition 下可能生成不兼容的代码
- WASM 组件模型的某些 ABI 细节可能与 2024 edition 冲突

**建议**：改回 `edition = "2021"`，这是 AstroBox 官方模板使用的版本。

---

### 原因 3（可能）：`wit-bindgen` 版本相关

**问题描述**：

```toml
wit-bindgen = { version = "0.57", features = ["async", "async-spawn"] }
```

第 1-2 行使用了较新的 `async_support` 模块：

```rust
use wit_bindgen::rt::async_support::{FutureReader, future_new};
use wit_bindgen::spawn;
```

`wit-bindgen 0.57` 的 `async` 特性需要宿主侧也使用对应的 async 支持。如果 AstroBox 宿主使用的 `wit-bindgen` 版本较旧，或宿主侧的 future 实现不兼容，会导致组件无法正常加载。

**验证方法**：检查 AstroBox 官方插件模板使用的 `wit-bindgen` 版本，对齐版本号。

---

### 原因 4（可能）：ABP 打包文件不正确

**问题描述**：

当前 `dist/` 目录下有三类 `.abp` 文件：

| 文件 | 可能的问题 |
|------|-----------|
| `EV 课程表同步器.abp` | 全功能版本，可能包含不同的 lib.rs |
| `hello.apilevel3.abp` | HelloWorld + api_level 3 |
| `EV-Schedule-Sync-HelloWorld.apilevel3.abp` | 同上，命名不同 |

这些 ABP 本质上是一个 ZIP 文件，里面应该包含：
- `manifest.json`
- `icon.png`
- `ev-schedule-sync.wasm`

如果打包时用了旧的 `ev-schedule-sync.wasm`（编译时用了不同的代码版本），或者缺少 `icon.png`，宿主可能无法正确识别插件。

**验证方法**：解压各个 ABP，对比其中 wasm 文件的 sha256 是否一致。

---

### 原因 5（可能）：`manifest.json` 中的 `entry` 字段与实际文件名不匹配

**问题描述**：

`manifest.json` 中指定：

```json
"entry": "ev-schedule-sync.wasm"
```

这意味着 ABP 包内必须包含名为 `ev-schedule-sync.wasm` 的文件。如果打包脚本把 wasm 文件命名成别的名字（如 `hello.wasm`），宿主找不到入口文件。

---

### 原因 6（可能）：`on_ui_render` 没有实际渲染可见内容

**问题描述**：

当前 `render_main_ui` 渲染的是：

```rust
let hello = ui::Element::new(ui::ElementType::Span, Some("hello world"))
    .size(32)
    .text_color("#ffffff");
```

如果一个 `<Span>` 元素（内联文本元素）作为顶层组件渲染，没有设置宽度、高度或父容器，在 AstroBox 的 UI 布局引擎中可能**不可见**。

**更严重的是**：如果用 `api_level: 3`，旧版 `ui::render()` 根本不存在，渲染调用会直接失败，导致宿主认为插件渲染异常，整个插件被跳过。

**建议**：使用 `ui-v3` 的列（Column）容器包裹内容，或至少用 `Block` 元素。

---

## 三、根本原因判断

按概率排序：

| 排序 | 原因 | 概率 | 严重程度 |
|:----:|------|:----:|:------:|
| **1** | `api_level: 3` 但 WIT world 用 `psys-world` 不匹配 | ⭐⭐⭐⭐⭐ 极高 | 🔴 致命 |
| 2 | Rust `edition = "2024"` 不稳定 | ⭐⭐⭐ 中等 | 🟡 可能 |
| 3 | `wit-bindgen 0.57` 版本不兼容 | ⭐⭐ 低 | 🟡 可能 |
| 4 | 打包缺少文件或文件名不对 | ⭐⭐ 低 | 🟡 可能 |
| 5 | UI 组件本身不可见 | ⭐ 很低 | 🟢 一般 |

---

## 四、解决方案

### 方案 A（最快验证）：将 `api_level` 改为 2

修改 `manifest.json`：

```json
"api_level": 2
```

重新打包后安装测试。如果问题消失，证明就是 api_level / WIT world 不匹配。

### 方案 B（正确修复）：对齐 api_level 和 WIT world

**选项 B1**：保持 `api_level: 3`，改用 `psys-world-v3`

1. 修改 `lib.rs`：
   ```rust
   wit_bindgen::generate!({
       path: "wit",
       world: "psys-world-v3",
       generate_all,
   });

   use exports::astrobox::psys_plugin::event_v3::{self, EventType};
   ```

2. 修改 `src/ui.rs`，将 `psys_host::ui` 改为 `psys_host::ui_v3`

3. 修改 `on_card_render`，使用 v3 的卡片渲染 API

**选项 B2**：改用 `api_level: 2`，保持 `psys-world`

1. 修改 `manifest.json`：`"api_level": 2`
2. 代码不变

### 方案 C：其他修复

1. 改 `Cargo.toml` 中 `edition = "2021"`
2. 给 `Span` 加一个父容器或改成 `Block` 元素
3. 确保 ABP 打包用的脚本正确复制了所有文件

---

## 五、给后续开发的建议

1. **不要混用 api_level**：`api_level: 2` 对应 `psys-world`/`psys-world-v2`，`api_level: 3` 对应 `psys-world-v3`
2. **参考官方模板**：始终从 `AstroBox-NG-Plugin-Template-Rust` 获取最新 WIT 文件和 `Cargo.toml` 配置
3. **Rust edition 保持 2021**：非必要不升级
4. **打包后验证**：解压 ABP 检查是否包含正确的 wasm、manifest.json、icon.png