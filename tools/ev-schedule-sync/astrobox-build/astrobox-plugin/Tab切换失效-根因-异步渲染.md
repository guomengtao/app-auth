# 「只加了一点东西，Tab 切换就失效」—— 根因分析

> 日期：2026-09-22
> 分析对象：`tab-experiment/`（v1.0.0 能切 → v1.1.0 不能切）
> 包路径：`tab-experiment/dist/TabExperiment-v1.1.0.abp`
> 结论先行：**你加的不是「一点东西」。真正杀死切换的，是 `on_ui_event` 从「同步渲染」被改成了「异步 `spawn` 渲染」——状态变更和 `ui::render()` 被挪进了 spawned task，延后到事件回调返回之后才执行。**

---

## 一、现象与对照实验

同一个 demo，只隔了一个版本，行为却完全相反：

| 版本 | `on_ui_event` 写法 | 结果 |
|------|-------------------|------|
| **v1.0.0** | **同步**（状态变更 + `render` 直接在回调里） | ✅ 你说「切换生效了」 |
| **v1.1.0** | **异步 `future_new` + `spawn`**（加了 EV 连接检测后改的） | ❌ 「tab 切换立即失效」 |

这是一次非常干净的 A/B：**同一个插件，唯一影响「切换」这条链路的改动，就是事件处理模型的同步 → 异步。**

---

## 二、你说的「一点东西」其实改了三处

### 2.1 表面改动（无害）

- 加了 `EvConnectionStatus` 枚举 + `ev_status` 状态字段
- 加了 `build_ev_status()` / `build_check_button()` 两个静态 UI 元素
- 加了 `check_ev_connection()`，内部要 `.await` 宿主 API：
  `device::get_connected_device_list()`、`thirdpartyapp::get_thirdparty_app_list(&addr)`
- 新增 `use crate::astrobox::psys_host::{device, thirdpartyapp};`

这些**本身都不影响 tab 切换**——它们都是静态渲染，跟 `page` 状态无关。

### 2.2 致命改动（真正的元凶）

为了让上面的 `check_ev_connection()` 能 `.await`，你把 `on_ui_event` 从**同步内联**改成了**异步 spawn**：

```93:113:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/tab-experiment/src/lib.rs
    fn on_ui_event(
        event_id: String,
        event: event::Event,
        event_payload: String,
    ) -> FutureReader<String> {
        let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };

        spawn(async move {
            let needs_render = handle_ui_event_inner(&event_id, &event, &event_payload).await;
            if needs_render {
                let target = STATE.lock().unwrap().render_target.clone();
                if !target.is_empty() {
                    ui::render_main_ui(&target);
                }
            }
            let _ = writer.write(String::new()).await;
        });

        reader
    }
```

注意：**`STATE.lock()...page = TabB` 和 `ui::render_main_ui(...)` 现在全都在 `spawn(async move { ... })` 里面**。
这就是切换失效的开关。

对比 v1.0.0 的写法（能切）：

```rust
// v1.0.0 —— 同步：状态变更 + render 都在回调调用栈内完成
fn on_ui_event(event_id, event, _payload) -> FutureReader<String> {
    let needs_render = match event {
        UiEvent::Click => match event_id.as_str() {
            "btn-tab-a" => { STATE.lock().unwrap().page = Page::TabA; true }
            "btn-tab-b" => { STATE.lock().unwrap().page = Page::TabB; true }
            _ => false,
        },
        _ => false,
    };
    if needs_render {
        let target = STATE.lock().unwrap().render_target.clone();
        if !target.is_empty() { ui::render_main_ui(&target); }
    }
    make_empty_string_future()   // ← 只用来填一个空 future，不承载渲染
}
```

**两版的核心区别不在「有没有用 spawn」，而在「渲染发生在什么时候」**：
- v1.0.0：渲染发生在 `on_ui_event` **返回之前**（同步调用栈内）。
- v1.1.0：渲染发生在 `on_ui_event` **返回之后**（spawn 出来的 task 里，延后执行）。

---

## 三、根因：渲染被挪出了事件的同步执行流

### 3.1 机制

宿主处理 UI 事件时，时序是这样的：

```
宿主调用 on_ui_event ──┬─ 返回 FutureReader ── 宿主 await 这个 future
                       │
                       └─ 若内部 spawn 了 task，task 在「回调返回之后」才被调度执行
```

- **同步版**：状态变更和 `ui::render()` 都发生在宿主的 `on_ui_event` 调用**内部**。宿主在事件处理的上下文里收到了这次 render，界面立即刷新。→ ✅ 能看到 dod/fox 切换。
- **异步版**：`on_ui_event` 立刻返回，真正的状态变更 + `ui::render()` 被推迟到 spawned task 中执行。**这次 render 发生在事件回调的上下文之外**，宿主不再把它当作「本次事件引起的重绘」来处理（该 task 的调度/宿主对 render 的接纳与该上下文强绑定），结果就是界面不刷新、tab 点了没反应。→ ❌

一句话：**`ui::render()` 必须在 `on_ui_event` 的同步调用栈里调用，不能挪进 `spawn` 的 task。**

### 3.2 为什么 `make_empty_string_future()` 也用 spawn 却没事？

因为它的 spawn **只负责写一个空字符串去完成 future**，渲染早已在同步路径里做完了。
所以「用了 spawn」本身不是罪，**「把渲染放进 spawn」才是罪**。这个区分很关键，别一看到 spawn 就以为矛盾。

---

## 四、证据链（三条独立线索指向同一结论）

### 证据 1：同 demo 的 A/B（最强）
v1.0.0 同步 → 能切；v1.1.0 异步 → 不能切。唯一变量就是事件模型。

### 证据 2：主插件从来就没能切过，因为它一直异步
主插件（含 git 里已提交的 v1.0.20）的 `on_ui_event` 一直是 spawn 异步写法：

```
$ git show 15c7260:.../src/lib.rs | sed -n '/fn on_ui_event/,/^    }/p'
    ) -> FutureReader<String> {
        let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
        spawn(async move {
            let needs_render = handle_ui_event_inner(...).await;
            if needs_render {
                ... ui::render_main_ui(&target);     ← 渲染在 spawn 里
            }
            ...
```

这解释了 v1.0.21 ~ v1.0.28 一路「切页无效」的顽疾——**它从第一版起就踩在同一个坑里，从来没「好过」过**。

### 证据 3：本项目早期文档已经怀疑过 async 兼容性
`HELLOWORLD-分析.md` 的「原因 3」早就写了：

> `wit-bindgen 0.57` 的 `async` 特性需要宿主侧也使用对应的 async 支持。如果 AstroBox 宿主使用的 `wit-bindgen` 版本较旧，或宿主侧的 future 实现不兼容，会导致组件无法正常加载。

当时没深挖，现在这条线索和 A/B 结果对上了。

---

## 五、复盘：之前所有的"修复"都修错了地方

| 曾经的诊断 | 实际 |
|-----------|------|
| v1.0.22：写死像素宽度溢出 | ❌ 替罪羊 |
| v1.0.23：flex(Row) 横向布局不可用 | ❌ 替罪羊（布局确实可能有问题，但不是"切换失效"的原因）|
| v1.0.28：overlay 状态没清理 / scroll-area 够不着 | ❌ 替罪羊 |

**问题从来不在"布局"，而在"时序"。** 因为主插件一路都是异步写法，所以无论怎么改宽度、flex、位置，切换都不会好——改的是无关变量。直到 demo v1.0.0 第一次用了同步写法，才拿到「能切」的对照样本。

---

## 六、对主插件 v1.0.29 的影响（重要）

我上一轮给主插件加的「导入/导出 双 Tab 栏」（v1.0.29）**沿用了主插件原有的异步 spawn 模式**，
所以按本分析，**v1.0.29 大概率同样是「能装、能看、但点不动」**。

好消息是：**真正的原因找到了，而且改动很小**——只要把渲染路径改回同步即可，不需要动 flex / ui-v3 / 布局。

---

## 七、修复方案

### 核心原则
> **状态变更 + `ui::render()` 必须在 `on_ui_event` 的同步调用栈内完成。**
> `spawn` 只允许用来做「不立刻影响 UI 的后台工作」或「填一个 future」。

### 7.1 Tab 切换（纯状态操作）—— 直接移回同步

```rust
fn on_ui_event(event_id: String, event: event::Event, _payload: String) -> FutureReader<String> {
    let needs_render = match event {
        UiEvent::Click => match event_id.as_str() {
            "btn-tab-a" => { STATE.lock().unwrap().page = Page::TabA; true }
            "btn-tab-b" => { STATE.lock().unwrap().page = Page::TabB; true }
            _ => false,
        },
        _ => false,
    };
    if needs_render {
        let target = STATE.lock().unwrap().render_target.clone();
        if !target.is_empty() { ui::render_main_ui(&target); }
    }
    make_empty_string_future()
}
```

### 7.2 需要 await 的宿主 IO（EV 连接检测）—— 两种做法

**做法 A（推荐先试）：`wit_bindgen::block_on`，同步等结果再 render**

```rust
"btn-check-ev" => {
    // 先同步把状态设成"检测中"并立刻 render（这一步一定是同步的）
    STATE.lock().unwrap().ev_status = EvConnectionStatus::Checking;
    let target = STATE.lock().unwrap().render_target.clone();
    if !target.is_empty() { ui::render_main_ui(&target); }

    // 同步阻塞等待宿主 IO 完成，再改状态
    let status = wit_bindgen::block_on(check_ev_connection());
    STATE.lock().unwrap().ev_status = status;
    true   // 回到同步路径统一 render
}
```
> ⚠️ `block_on` 是否能在 UI 事件回调里安全使用需实测（本项目文档提到过它，但未在 UI 事件中验证过）。
> 若 `block_on` 不可用，退做法 B。

**做法 B（稳妥）：把「检测」改成两步**
- 第一步（同步）：点按钮 → 状态置 `Checking` → 同步 render（用户看到"检测中..."）。
- 第二步：用 `on_event`（非 UI 事件）或定时器在后台拉数据，拿到结果后**再**触发一次同步路径更新状态。
- 关键是：**任何要反映到界面上的状态变更，最终都必须由一次「同步 render」收尾**，不能在 spawn 里直接 render。

### 7.3 一句话总结改法
把 v1.1.0 的 `on_ui_event` **整体退回 v1.0.0 的同步形态**；EV 检测这条需要 await 的分支单独用 `block_on`（或拆成两步），**绝不在 `spawn` 里调用 `ui::render_main_ui`**。

---

## 八、如何用最小 A/B 确认（10 分钟）

保留 v1.1.0 的**所有**新增功能（状态字段、检测按钮、`check_ev_connection`），**只把 `on_ui_event` 改回同步内联**，重新打包：

- **切换恢复** → 本结论成立（异步 spawn 渲染就是根因）。
- **切换依旧失效** → 才需要回头查「device/thirdpartyapp 导入是否触发权限/实例化问题」（目前看可能性很低，因为插件能加载能首屏渲染，且点 tab 根本不碰设备代码）。

这个实验把「异步时序」和「设备功能」两个变量彻底分开，一次定性。

---

## 九、一个需要你确认的事实点（用于排除残留不确定性）

有个事实我无法从代码判断，需要你回忆一下：

> **在主插件里，你有没有成功进到过「选择目标设备」页（看到设备列表）？**

- 如果**成功过** → 说明主插件那条异步路径**曾经能渲染**，那问题就不是"异步全盘失效"，而是更精细的时序/挂起差异，需要我们再缩小范围（比如某些 await 会让整个事件链挂起）。
- 如果**从未成功过 / 没试过** → 与本结论完全一致：异步渲染就是不通，同步才通。

你先确认这一点，能帮我们把最后一点不确定性关掉。

---

## 十、结论

1. 「加了一点东西就失效」是误解。**加的东西本身无害，坏在你顺手把 `on_ui_event` 从同步改成了 `spawn` 异步。**
2. 根因：**`ui::render()` 被挪进了 spawned task，发生在事件回调返回之后，宿主不认这次重绘。**
3. 主插件 v1.0.21~v1.0.29 的「切页/切 tab 无效」**同一个根因**——它一直用的就是异步 spawn 写法，所以从来没好过；过去所有「改宽度 / 改 flex / 改位置」都是在修无关变量。
4. 修复很小：**把渲染路径退回同步**；需要 await 的宿主 IO 用 `block_on` 或拆两步，**禁止在 spawn 里 render**。
