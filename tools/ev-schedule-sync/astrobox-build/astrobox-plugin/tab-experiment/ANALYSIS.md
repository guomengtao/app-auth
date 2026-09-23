# Tab 切换失效原因分析

> 包：`dist/TabExperiment-v1.1.0.abp`
> 问题：在 v1.0.0（正常工作）基础上仅增加 EV 连接检测功能，Tab 切换立即失效

---

## 一、v1.0.0 与 v1.1.0 的代码差异

### 1.1 结构差异

| 方面 | v1.0.0（正常） | v1.1.0（失效） |
|------|---------------|---------------|
| 源文件 | `lib.rs` + `ui.rs` | `lib.rs` + `ui.rs`（相同） |
| `PluginState` 字段 | `page`, `render_target` | 新增 `ev_status: EvConnectionStatus` |
| 依赖 | `wit-bindgen` | `wit-bindgen`（相同） |
| 导入模块 | `event`, `lifecycle` | 新增 `EventType`, `UiEvent`, `device`, `thirdpartyapp` |
| 包大小 | 236KB | 252KB |

### 1.2 `on_ui_event` 的关键差异

**v1.0.0（推测，正常工作）：**

```rust
fn on_ui_event(event_id: String, event: event::Event, ...) -> FutureReader<String> {
    let vtable = ...;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };

    // ⭐ 事件处理在主线程同步执行
    let needs_render = handle_ui_event_inner(&event_id, &event, ...);  // 非 async
    if needs_render {
        ui::render_main_ui(&target);
    }

    spawn(async move {
        let _ = writer.write(String::new()).await;
    });
    reader
}
```

**v1.1.0（当前代码，Tab 切换失效）：**

```rust
fn on_ui_event(event_id: String, event: event::Event, ...) -> FutureReader<String> {
    let vtable = ...;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };

    // ❌ 全部事件处理塞进 spawn，异步延迟执行
    spawn(async move {
        let needs_render = handle_ui_event_inner(&event_id, &event, ...).await;
        if needs_render {
            ui::render_main_ui(&target);
        }
        let _ = writer.write(String::new()).await;
    });
    reader
}
```

---

## 二、根因分析

### 2.1 核心问题：`spawn` 延迟执行导致事件丢失

`spawn(async move { ... })` 将事件处理逻辑提交到 WASM 的任务队列中**异步执行**。关键问题在于：

1. **事件处理与 Future 响应是两条独立的路径**：`spawn` 不阻塞 `on_ui_event` 的返回，函数立即返回 `reader`。
2. **如果 WASM 任务队列没有被及时轮询**（poll），spawn 中的 `state.page = Page::TabB` 和 `ui::render_main_ui(&target)` 永远不会执行。
3. **即使被轮询**，如果轮询发生在 host 已经处理完本轮事件之后，UI 重渲染的时机已经错过。

### 2.2 v1.0.0 为什么正常？

v1.0.0 中 Tab 切换的处理**不在 `spawn` 内部**：
- `handle_ui_event_inner` 是同步函数（没有 `.await`）
- 状态更新和 `ui::render_main_ui` 在 `on_ui_event` 返回前就已经完成
- `spawn` 只负责写入 Future 响应（`writer.write`）
- UI 更新是即时生效的

### 2.3 v1.1.0 为什么失效？

v1.1.0 为了支持 `check_ev_connection().await`（需要异步查询设备和应用列表），将 `handle_ui_event_inner` 改为 `async fn`，并将**所有事件处理**都塞进了 `spawn`：

```rust
spawn(async move {
    let needs_render = handle_ui_event_inner(...).await;
    // ↑ 这是 async fn，因为 check_ev_connection 需要 .await
    // 但 Tab 切换分支根本不需要 .await！
    ...
});
```

虽然 `handle_ui_event_inner` 内部的 Tab 切换分支不实际执行任何 `.await`，但由于整个函数是 `async`，调用者必须 `.await` 它。这迫使所有事件处理（包括同步的 Tab 切换）都进入 spawn 延迟执行。

### 2.4 为什么主插件用同样模式却正常？

主插件（`ev-schedule-sync`）也使用 `spawn(async move { handle_ui_event_inner(...).await })` 模式。它能正常工作的可能原因：

- 主插件加载时有更多初始化逻辑（`logger::init()` 等），可能在加载期间触发了 WASM 任务轮询机制
- 主插件包体更大（~900KB），加载时间更长，给了任务队列更多被轮询的机会
- 具体 WASM runtime 的调度行为可能因插件大小/复杂度而不同

无论如何，**依赖 spawn 的执行时机来处理用户交互是不稳定的设计**：WASM 任务调度时机由 host 控制，插件无法保证。

---

## 三、修复方案

### 3.1 分离同步与异步事件

核心思路：**同步事件（Tab 切换）在 `on_ui_event` 中直接执行，只有异步事件（EV 检测）使用 `spawn`**。

```rust
fn on_ui_event(event_id: String, event: event::Event, ...) -> FutureReader<String> {
    let vtable = ...;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };

    match &event {
        UiEvent::Click => match event_id.as_str() {
            // ⭐ 同步事件：直接处理，立即重渲染
            "btn-tab-a" => {
                STATE.lock().unwrap().page = Page::TabA;
                let target = STATE.lock().unwrap().render_target.clone();
                if !target.is_empty() {
                    ui::render_main_ui(&target);
                }
            }
            "btn-tab-b" => {
                STATE.lock().unwrap().page = Page::TabB;
                let target = STATE.lock().unwrap().render_target.clone();
                if !target.is_empty() {
                    ui::render_main_ui(&target);
                }
            }
            // ⭐ 异步事件：仍需 spawn
            "btn-check-ev" => {
                STATE.lock().unwrap().ev_status = EvConnectionStatus::Checking;
                let target = STATE.lock().unwrap().render_target.clone();
                if !target.is_empty() {
                    ui::render_main_ui(&target);
                }

                spawn(async move {
                    let status = check_ev_connection().await;
                    STATE.lock().unwrap().ev_status = status;
                    let t = STATE.lock().unwrap().render_target.clone();
                    if !t.is_empty() {
                        ui::render_main_ui(&t);
                    }
                });
            }
            _ => {}
        },
        _ => {}
    }

    spawn(async move {
        let _ = writer.write(String::new()).await;
    });
    reader
}
```

### 3.2 更优雅的方式：保留 `handle_ui_event_inner` 但分层

```rust
// 同步处理器（Tab 切换等不需要 .await 的操作）
fn handle_sync_events(event_id: &str, event: &UiEvent) -> Option<()> {
    match event {
        UiEvent::Click => match event_id {
            "btn-tab-a" => { STATE.lock().unwrap().page = Page::TabA; Some(()) }
            "btn-tab-b" => { STATE.lock().unwrap().page = Page::TabB; Some(()) }
            _ => None,
        },
        _ => None,
    }
}

// 异步处理器（EV 检测等需要 .await 的操作）
async fn handle_async_events(event_id: &str, event: &UiEvent) -> bool {
    match event {
        UiEvent::Click if event_id == "btn-check-ev" => {
            STATE.lock().unwrap().ev_status = EvConnectionStatus::Checking;
            let status = check_ev_connection().await;
            STATE.lock().unwrap().ev_status = status;
            true
        }
        _ => false,
    }
}
```

然后在 `on_ui_event` 中先调用同步处理器，再根据需要 spawn 异步处理器。

### 3.3 简化修复（推荐用于本次迭代）

直接将 `handle_ui_event_inner` 中 Tab 切换的逻辑**提出来**，在 `spawn` 外部执行：

```rust
fn on_ui_event(...) -> FutureReader<String> {
    // 1. 同步处理 Tab 切换
    let needs_render = handle_tab_switch(&event_id, &event);
    if needs_render {
        let target = STATE.lock().unwrap().render_target.clone();
        if !target.is_empty() {
            ui::render_main_ui(&target);
        }
    }

    // 2. 如果需要 EV 检测，spawn 异步任务
    if matches!(event, UiEvent::Click) && event_id == "btn-check-ev" {
        spawn(async move {
            STATE.lock().unwrap().ev_status = EvConnectionStatus::Checking;
            let status = check_ev_connection().await;
            STATE.lock().unwrap().ev_status = status;
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        });
    }

    // 3. 返回 Future
    let vtable = ...;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
    spawn(async move { let _ = writer.write(String::new()).await; });
    reader
}
```

---

## 四、教训

| 规则 | 说明 |
|------|------|
| **同步操作用同步路径** | Tab 切换、UI 状态更新等不需要 I/O 的操作，不应塞进 `spawn` |
| **异步操作才用 spawn** | 只有需要 `.await` 的操作（网络请求、设备查询等）才放入 `spawn` |
| **不要为了一致性牺牲可靠性** | 虽然所有事件处理塞进一个 `handle_ui_event_inner` 看起来更"整洁"，但在 WASM 环境中，`spawn` 的执行时机不受插件控制，结果不可靠 |
| **最小化改动范围** | 加一个异步功能时，不应改变已有同步功能的执行路径 |

根本原因一句话：**为了 EV 检测的异步需求，错误地把 Tab 切换从同步执行改成了 spawn 异步延迟执行，导致 Tab 切换失效。**