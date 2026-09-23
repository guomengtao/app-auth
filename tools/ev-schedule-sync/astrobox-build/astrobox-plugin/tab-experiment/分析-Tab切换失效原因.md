# Tab 切换失效原因分析

> 包路径：`dist/TabExperiment-v1.1.0.abp`
> 
> 对比对象：v1.0.0（工作正常） vs v1.1.0（Tab 切换失效）

---

## 一、v1.1.0 相比 v1.0.0 加入了什么

| 新增内容 | 涉及文件 | 说明 |
|---------|---------|------|
| EV 连接状态检测 | `lib.rs` + `ui.rs` | 新增 `check_ev_connection()`、`build_ev_status()`、`build_check_button()` |
| 状态字段 `ev_status` | `lib.rs` | 新增枚举 `EvConnectionStatus`（4 个状态） |
| 引入 `device` 接口 | `main.wit` + `lib.rs` | 调用 `device::get_connected_device_list()` |
| 引入 `thirdpartyapp` 接口 | `main.wit` + `lib.rs` | 调用 `thirdpartyapp::get_thirdparty_app_list()` |
| "检测 EV 连接" 按钮 | `ui.rs` | UI 上新增一个按钮，绑定 `btn-check-ev` 事件 |

---

## 二、v1.0.0 → v1.1.0 之间的结构性变更

这些变更是**被动发生**的，并非刻意修改：

### 2.1 `main.wit` 世界定义被完全替换

**v1.0.0（设计文档中的最小版本）：**

```wit
package astrobox:main;

use astrobox:psys-host/ui;
use astrobox:psys-plugin/lifecycle;
use astrobox:psys-plugin/event as plugin-event;

world psys-world {
  import ui;
  export lifecycle;
  export plugin-event;
}
```

**v1.1.0（实际文件，与主插件一致）：**

```wit
package astrobox:main;

use astrobox:psys-host/os;
use astrobox:psys-host/transport;
use astrobox:psys-host/ui;
use astrobox:psys-host/ui-v3;
use astrobox:psys-host/clipboard;
use astrobox:psys-host/dialog;
use astrobox:psys-host/device;
use astrobox:psys-host/register;
use astrobox:psys-host/event;
use astrobox:psys-host/provider-callback;
use astrobox:psys-host/queue;
use astrobox:psys-host/timer;
use astrobox:psys-host/interconnect;
use astrobox:psys-host/thirdpartyapp;
use astrobox:psys-host/watchface;
use astrobox:psys-host/i18n;

use astrobox:psys-plugin/lifecycle;
use astrobox:psys-plugin/event as plugin-event;
use astrobox:psys-plugin/event-v3 as plugin-event-v3;

world psys-world {
  import os;
  import transport;
  import ui;
  import ui-v3;
  import clipboard;
  import dialog;
  import device;
  import register;
  import event;
  import provider-callback;
  import queue;
  import timer;
  import interconnect;
  import thirdpartyapp;
  import watchface;
  import i18n;

  export lifecycle;
  export plugin-event;
}
```

**影响：** `wit-bindgen::generate!` 基于 WIT world 生成全部的 Rust 绑定。world 定义变了 → 生成的 trait 名、函数签名全部跟着变。

### 2.2 Trait 名称变更

| 接口 | v1.0.0 Trait | v1.1.0 Trait |
|------|:-----------:|:-----------:|
| lifecycle | `lifecycle::Lifecycle` | `lifecycle::Guest` |
| event | `event::Event` | `event::Guest` |

**影响：** 如果 WIT 世界的微小编排变化导致 wit-bindgen 改变了 trait 命名规则，宿主运行时可能找不到正确的导出函数入口，Tab 点击事件不会被分发到插件。

### 2.3 方法签名变更

**v1.0.0（设计文档，`async fn` + `&self`）：**

```rust
impl event::Event for Event {
    async fn on_ui_event(
        &self,
        event_id: String,
        event: astrobox::psys_host::ui::Event,
        _event_payload: String,
    ) -> String { ... }
}
```

**v1.1.0（实际代码，`fn` → `FutureReader<T>`，无 `&self`）：**

```rust
impl event::Guest for TabExperiment {
    fn on_ui_event(
        event_id: String,
        event: event::Event,
        event_payload: String,
    ) -> FutureReader<String> { ... }
}
```

**影响：** 这两个接口的 WASM 导出函数签名不同。如果宿主期望 v1.0.0 的签名而实际得到 v1.1.0 的签名，`on_ui_event` 不会被正确调用。

> **注意：** 设计文档中的 v1.0.0 代码可能从未实际编译通过（`impl lifecycle::Lifecycle for Lifecycle` 这种写法可疑），但至少说明当时期望的接口形态与现在不同。

### 2.4 状态结构变更

| | v1.0.0 | v1.1.0 |
|---|--------|--------|
| 类型 | `Mutex<Option<PluginState>>` | `Mutex<PluginState>` |
| 初始化 | `on_load()` 中 `.set()` | `const fn new()` 编译期初始化 |
| 访问 | `state.as_mut().unwrap()` | 直接 `state.page` |

**影响：** 如果 `on_load()` 从未被调用（或调用时机晚于首次 `on_ui_render`），v1.0.0 会 panic（`unwrap` 失败），而 v1.1.0 静默成功。这本身不是 bug，但说明两条代码路径的初始化时序可能不同。

---

## 三、根因分析：为什么加入 EV 检测后 Tab 切换立即失效

### 根本原因：`main.wit` 被替换为主插件的完整世界定义

为了调用 `device::get_connected_device_list()` 和 `thirdpartyapp::get_thirdparty_app_list()`，必须在 WIT world 中 `import device;` 和 `import thirdpartyapp;`。

而 tab-experiment 的 `wit/main.wit` 被直接**替换成了主插件的 `main.wit`**（对比两个文件内容完全一致），引入全部 15 个 import。

这个变更导致以下连锁反应：

#### 连锁 1：wit-bindgen 重新生成所有绑定

`generate_all` 宏展开后，trait 名称和函数签名可能全部变化。宿主（AstroBox 运行时）根据 `api_level: 2` 期望固定的导出函数名。如果生成的导出名与预期不符，事件分发直接断路。

#### 连锁 2：`ui-v3` 被引入导致类型冲突风险

`main.wit` 中同时 `import ui;` 和 `import ui-v3;`。`psys-plugin/event` 接口的 `on-ui-event` 使用 `astrobox:psys-host/ui.{event}`，但 `event-v3` 使用 `astrobox:psys-host/ui-v3.{event}`。在同一个 world 中同时存在两个 ui 模块，wit-bindgen 生成的类型别名可能指向错误版本的 `Event` 类型。

具体来说，`lib.rs` 中：
```rust
use crate::astrobox::psys_host::ui::Event as UiEvent;
```

然后在 `handle_ui_event_inner` 中：
```rust
match event {          // event 类型是 event::Event（来自 psys-plugin/event 的别名）
    UiEvent::Click =>  // UiEvent 是 astrobox::psys_host::ui::Event
```

虽然编译通过了（说明当前它们被解析为同一类型），但在 `ui-v3` 同时存在时，这个别名解析是不稳定的。

#### 连锁 3：`import device;` 要求宿主提供 device 接口

`api_level: 2` 的宿主可能不提供 `device` 和 `thirdpartyapp` 接口。如果 WIT world 声明了 `import device;`，宿主在实例化插件时可能因为找不到该接口而**拒绝加载整个插件**。即使宿主降级处理（忽略未知 import），`device::get_connected_device_list()` 在不支持的运行时上调用也会导致 panick 或静默失败。

### 直接触发场景

1. 用户在 AstroBox 中安装 `TabExperiment-v1.1.0.abp`
2. 宿主尝试加载 wasm，解析其 imports
3. 宿主发现 wasm 要求 `device`、`thirdpartyapp` 等接口
4. 如果这些接口在 `api_level: 2` 下不可用，**插件加载失败 → 所有功能包括 Tab 切换均不工作**
5. 即使插件加载成功，WIT 世界变更导致导出函数签名与宿主预期不匹配 → **点击事件无法路由到 `on_ui_event`**

---

## 四、证据收集

### 4.1 设计文档的历史记录

[设计文档.md](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/tab-experiment/设计文档.md) 明确记录了 v1.0.0 的 `main.wit` 应该是**最小版本**：

> **注意**：只引入 `ui`（不用 `ui-v3`），因为我们用 `api_level: 2` 的旧版接口做实验。

实际 v1.1.0 的 `main.wit` 违背了这个设计原则。

### 4.2 main.wit 对比

```
主插件  wit/main.wit  ←→  tab-experiment/wit/main.wit
       完全一致（含15+ import）      完全一致
```

tab-experiment 的 `main.wit` 实际上是主插件的副本，而非最小实验版本。

### 4.3 插件描述变更

```
v1.0.0 manifest: "Tab 切换最小实验 - Tab A 显示 dod，Tab B 显示 fox"
v1.1.0 manifest: "Tab 切换实验 + EV 连接检测"
```

v1.1.0 的描述明确增加了 "EV 连接检测"，验证了 v1.1.0 引入了 EV 检测代码。

---

## 五、修复方案

### 方案 A：创建独立的 EV 连接检测插件（推荐）

不要往最小实验中加功能。保持 tab-experiment 的 `main.wit` 为最小版本，创建一个新的实验插件（如 `ev-checker`）专门做 EV 连接检测。

| 插件 | WIT imports | 用途 |
|------|------------|------|
| `tab-experiment` | 仅 `ui` | 验证 Tab 切换 |
| `ev-checker` | `ui` + `device` + `thirdpartyapp` | 验证 EV 连接检测 |

两者互不干扰。

### 方案 B：如果必须合并，精确控制 WIT world

如果确实需要在一个插件中同时验证 Tab 切换和 EV 连接检测，则只添加必要的 import，不要复制整个主插件的 `main.wit`：

```wit
package astrobox:main;

use astrobox:psys-host/ui;
use astrobox:psys-host/device;
use astrobox:psys-host/thirdpartyapp;
use astrobox:psys-plugin/lifecycle;
use astrobox:psys-plugin/event as plugin-event;

world psys-world {
  import ui;
  import device;
  import thirdpartyapp;
  export lifecycle;
  export plugin-event;
}
```

**注意：** `ui-v3`、`clipboard`、`dialog`、`os`、`transport` 等无关接口一律不要引入。

---

## 六、教训总结

1. **不要复制整个 `main.wit`** —— tab-experiment 的 WIT world 应只包含本实验实际需要的接口，而非主插件的全部声明。
2. **每次加新功能前先确认 WIT world 是否需要扩展** —— 需要新 host 函数（如 `device::get_connected_device_list`）时，只需加对应的 `import` 声明，不要替换整个文件。
3. **设计文档中明确写了"只引入 ui"**——但实际执行时违背了这个约束。
4. **WASM 组件模型中，import 声明不只是"声明"，而是契约**——宿主必须提供所有声明的 import 接口，否则实例化失败。