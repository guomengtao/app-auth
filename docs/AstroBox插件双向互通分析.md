# AstroBox V2 插件双向互通分析

> **核心结论**：AstroBox V2 插件系统基于 WASI Preview2 + WIT Component Model，**Host ↔ Plugin 是双向 RPC**，插件完全可以向外导出数据。
> **日期**：2026-09-20

---

## 零、最关键的认知纠正

### 误区

很多人（包括之前的分析）看到插件是被动触发的（没有 `main` 函数，入口全是宿主回调），就认为「插件只能被动接收宿主数据，不能向外输出」。

### 事实

插件不只能被动接收，**可以主动调用宿主 API 向外输出数据**。WIT 里的 `import` 和 `export` 含义和日常直觉正好相反：

| WIT 关键字 | 谁调用谁 | 数据流向 | 通俗理解 |
|:---:|------|------|------|
| **`import`** | Plugin → Host | **插件把数据传给宿主** | 👈 插件「导出」数据给宿主 |
| **`export`** | Host → Plugin | **宿主把数据传给插件** | 👉 宿主「导入」数据到插件 |

```
WIT world 定义：

import psys-host: dialog;     ← 插件 import 宿主能力
                               插件可以调用 dialog::show_dialog()
                               把弹窗数据传给宿主

export psys-plugin: lifecycle; ← 插件 export 接口给宿主
                                宿主可以调用 lifecycle::on_load()
                                把控制权交给插件
```

---

## 一、双向数据流详解

### 1.1 宿主 → 插件（Host 调用 Plugin export）

宿主在特定时机主动调用插件的 export 函数，把事件数据**传入**插件：

```
宿主                                  Plugin (WASM)
 │                                        │
 │  on_load()                             │
 ├──────────────────────────────────────▶ │  插件启动，初始化
 │                                        │
 │  on_ui_event("btn-click", "{...}")     │
 ├──────────────────────────────────────▶ │  用户点击按钮
 │                                        │
 │  on_device_event(...)                  │
 ├──────────────────────────────────────▶ │  设备连接/断开
 │                                        │
```

入口函数：
- `lifecycle::on_load()` — 插件加载
- `event::on_event(...)` — 设备事件
- `event::on_ui_event(...)` — UI 交互事件

### 1.2 插件 → 宿主（Plugin 调用 Host import）

插件在任意时机（`on_load` 内、事件回调内）主动调用宿主 API，把数据**传出**给宿主：

```
Plugin (WASM)                          宿主
 │                                        │
 │  ui::render(element)                   │
 ├──────────────────────────────────────▶ │  把 UI 结构数据提交宿主渲染
 │                                        │
 │  dialog::show_dialog(title, content)   │
 ├──────────────────────────────────────▶ │  把弹窗数据传给宿主弹出
 │                                        │
 │  transport::fetch(url, options)        │
 ├──────────────────────────────────────▶ │  把 HTTP 请求数据交给宿主发送
 │  ◀───────────────────────────────────┤ │  宿主返回响应数据
 │                                        │
 │  interconnect::send_to_device(...)      │
 ├──────────────────────────────────────▶ │  把业务数据推送到手环
 │                                        │
 │  os::write_file(path, data)            │
 ├──────────────────────────────────────▶ │  把数据交给宿主持久化存储
 │                                        │
 │  FutureReader::write(result)           │
 ├──────────────────────────────────────▶ │  把异步计算结果回传给宿主
 │                                        │
```

插件可调用的 Host API（都是插件向外输出数据的通道）：

| Host API | 插件传出的数据 | 
|------|------|
| **UI** | 声明式 UI 元素树（按钮、文本、列表等） |
| **Dialog** | 弹窗标题、内容、按钮配置 |
| **Transport** | HTTP 请求（URL、Header、Body） |
| **Interconnect** | 推送到手环的业务数据 |
| **Queue** | 自定义消息写入宿主队列 |
| **OS** | 文件读写、配置存储 |
| **Timer** | 定时任务配置 |
| **ThirdpartyApp** | 第三方应用交互数据 |

---

## 二、为什么会产生「只能导入」的错觉？

### 2.1 插件入口全是被动的

插件没有 `main()` 函数，所有入口都是宿主回调：

```rust
// 插件代码里没有这个：
// fn main() { ... }

// 只有这些被宿主调用的入口：
impl lifecycle::Guest for MyPlugin {
    fn on_load() { ... }           // 宿主调用
}

impl event::Guest for MyPlugin {
    fn on_event(...) -> FutureReader<String> { ... }  // 宿主调用
    fn on_ui_event(...) -> FutureReader<String> { ... } // 宿主调用
}
```

**第一眼看过去**：插件的起点永远是宿主调用它，像「只有宿主往插件灌数据」。

**实际情况**：插件在这些回调里，可以自由调用宿主 API 把数据传出去。

### 2.2 WASM 内存隔离

Host 和 Plugin **不共享内存**。所有数据传递都通过 WIT 自动序列化，不能裸指针传数据。

这给人一种「封闭」的感觉，但这不是「不能输出」，而是「所有输出都必须经过 WIT 契约规范」——这是一种安全机制，不是功能限制。

### 2.3 异步模型看起来像单向

```rust
fn on_event(...) -> FutureReader<String> {
    let (writer, reader) = wit_future::new::<String>(|| "".to_string());
    wit_bindgen::spawn(async move {
        // 在异步任务里调用宿主 API → 持续把数据发给宿主
        let result = psys_host::transport::fetch("https://...", None).await;
        writer.write(result).await.unwrap();  // ← 数据回传给宿主
    });
    reader  // 立即返回，宿主稍后拿到数据
}
```

`on_event` 返回 `FutureReader`，看起来只是「返回一个结果」。实际上 `FutureReader` 是插件**把异步计算结果回传给宿主**的完整机制——插件在里面可以做任意复杂的数据处理，最终把结果交出。

---

## 三、插件向外导出数据的典型场景

### 3.1 提交 UI 渲染（每个插件都在做）

```rust
let btn = ui::element::new(ElementType::BUTTON, Some("导入".into()))
    .on(Event::CLICK, "import-click");
ui::render(btn);  // ← 插件把 UI 元素结构体传给宿主
```

### 3.2 弹出对话框

```rust
dialog::show_dialog(
    DialogType::Alert,
    DialogStyle::System,
    &DialogInfo {
        title: "导入完成".into(),
        content: "12 门课程已导入到手环".into(),
        buttons: vec![DialogButton {
            id: "ok".into(),
            primary: true,
            content: "确定".into(),
        }],
    },
).await;  // ← 插件把弹窗数据传给宿主
```

### 3.3 发送网络请求

```rust
let html = transport::fetch(
    "https://教务系统/课表",
    Some(&FetchOptions {
        method: "POST",
        headers: &[("Content-Type", "application/x-www-form-urlencoded")],
        body: &form_data,
    }),
).await;  // ← 插件把请求发给宿主 → 宿主执行 → 结果返回插件
```

### 3.4 推送数据到手环

```rust
let json = serde_json::to_string(&courses).unwrap();
interconnect::send_to_device("com.ev.schedule", &json).await;
// ← 插件把课程数据传给宿主 → 宿主通过蓝牙推送到手环
```

### 3.5 持久化存储

```rust
// 把插件配置数据交给宿主持久化
os::write_file("/data/plugin_config.json", &config_data).await;
```

### 3.6 on_event 返回结果

```rust
fn on_event(...) -> FutureReader<String> {
    let (writer, reader) = wit_future::new::<String>(|| "".to_string());
    wit_bindgen::spawn(async move {
        // 复杂业务处理...
        writer.write("处理完成，导入了 12 门课程".to_string()).await.unwrap();
    });
    reader  // ← 插件最终把 String 结果回传给宿主
}
```

---

## 四、真正的限制（不是不能导出，是有边界约束）

| 限制 | 说明 | 不是「不能导出」 |
|------|------|:---:|
| 不能直接 syscall | 所有 IO 必须通过 Host API 中转 | ✅ 但 Host API 覆盖了所有常用 IO |
| 不能裸指针传数据 | 必须通过 WIT 序列化 | ✅ 正常的数据交换方式 |
| 不能脱离 FutureReader 创建后台任务 | `wit_bindgen::spawn` 受限 | ✅ 不影响正常业务逻辑 |
| 不能直接访问 Android 文件系统 | 通过 OS API | ✅ OS API 提供了文件读写能力 |
| 内存隔离 | Host/Plugin 独立内存空间 | ✅ 安全保障，不影响数据流通 |

**一句话**：不是不能导出数据，是**不能绕过宿主直接操作系统资源**。所有对外输出都要走 Host 接口——但这和「不能导出」是两码事。

---

## 五、对 EV课程表导入器的意义

### 5.1 之前分析的误区

之前认为「插件只能导入数据（手机 → 手环），不能导出（手环 → 手机）」。

### 5.2 纠正后的理解

| 操作 | 可行性 | 实现方式 |
|------|:---:|------|
| 从教务系统拉取课表 | ✅ | Transport API（HTTP 请求） |
| 推送课表到手环 | ✅ | Interconnect API |
| 把课表数据保存到手机 | ✅ | OS API 写文件 |
| 导出课表 JSON 给其他 App | ✅ | ThirdpartyApp API / OS 写文件 |
| 弹出导入结果通知 | ✅ | Dialog API |
| 展示导入进度 UI | ✅ | UI API |
| **从手环读取 EV课程表现有数据** | ⚠️ | 取决于 Interconnect API 是否支持双向 |

### 5.3 关键区分

```
✅ 插件 → 宿主（手机）：完全可以，通过所有 Host API
   ├─ Transport: 发 HTTP 请求
   ├─ UI: 提交界面
   ├─ Dialog: 弹窗
   ├─ OS: 写文件/存配置
   └─ Queue: 写消息队列

⚠️ 手环 → 插件：取决于 Interconnect API
   如果 Interconnect 只支持 send_to_device（单向推送），
   那插件确实无法主动从手环拉取数据。
   
   但如果 Interconnect 支持接收回调（比如 on_device_data），
   插件就可以接收手环发回的数据。
```

---

## 六、总结

| 误解 | 事实 |
|------|------|
| 插件只能被动接收数据 | ✅ 插件入口是被动的，但**可以在回调里主动调用 Host API 输出数据** |
| 插件不能向外输出 | ❌ 错误。import = Plugin → Host，插件调用 Host API 就是输出数据 |
| WIT import 是导入数据 | ❌ 反了。WIT import = 插件导入宿主能力 = 插件把数据传给宿主 |
| Host ↔ Plugin 是单向的 | ❌ 双向 RPC，两个方向都有完整的数据通道 |

**核心公式**：

```
插件 export 函数 = 宿主 → 插件（宿主把数据/事件传入插件）
插件 import API  = 插件 → 宿主（插件把业务数据传给宿主）
```

**EV课程表导入器可以做的远不止「导入」**：
- ✅ 从教务系统拉取课表（Transport）
- ✅ 推送课表到手环（Interconnect）
- ✅ 保存导入记录到手机（OS）
- ✅ 导出课表 JSON 分享给他人（OS 写文件 + ThirdpartyApp）
- ✅ 展示丰富的导入 UI（UI）
- ✅ 弹窗通知导入结果（Dialog）

「导入器」这个名字是准确的——因为它的核心任务是「把教务系统课表导入到手环」。但这不意味着插件架构只能做导入方向的数据流。