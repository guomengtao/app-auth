# 同步器「多页面 / Tab 切换」到底卡在哪 —— 根因分析

> 日期：2026-09-22
> 当前版本：v1.0.28（`manifest.json` / `src/lib.rs` 两处一致）
> 结论先行：**「切页」从来没坏过，坏的只是「两个按钮并排」这个视觉布局；而「为什么别人能做 tab」的答案是——别人用的是 `ui-v3` 原生 TABS，而且这个接口我们其实已经 import 进来了，只是一直没人去试。**

---

## 一、一句话结论

| 你的疑问 | 真相 |
|---------|------|
| 多页面支持吗？ | **不支持，也不该追求**。插件不是网页，没有 URL 路由、没有多个 HTML 页 |
| tab 切换实现过吗？ | **实现过，且切换逻辑一直是好的**。坏的是「并排 tab 按钮」这个**视觉布局** |
| 测试失败在哪？ | 失败的是**横向 flex 并排**——按钮被挤出 ~194px 的窄屏，点不到 |
| 别人插件为什么可以？ | 别人用 **api_level 3 + `ui-v3` 原生 TABS**；我们困在 api_level 2 的旧 `ui` |
| 到底哪里错了？ | ① 把「布局问题」误诊成「切换逻辑问题」② 写死像素宽度 ③ 以为 `flex(Row)` 一定生效 ④ 误判「必须升 api_level 3 才能用 tabs」 |

---

## 二、先厘清三个被混为一谈的概念（混乱的总根源）

「多页面」这个词同时指了三件不同的事，把它们混在一起，才导致反复折腾：

### 1. 多页面（multi-page）—— 不存在

AstroBox 插件 UI 的宿主模型是**单容器**：

```
on_ui_render(element_id)  ← 宿主只给你一个容器 id，就一个
ui::render(element_id, tree)  ← 每次调用都「全量替换」这整棵树
```

- 没有 URL 路由，没有「打开另一个页面文件」。
- 没有 DOM 增量更新，没有多页面栈。
- 心智模型是 **React `setState` 条件渲染**，不是浏览器多页导航。

> 官方文档：`https://abox.run/docs/plugin-dev/host-api/ui`（见排错手册 §8.1）。

### 2. 页面切换（state-machine 切页）—— 支持，且我们已实现、一直正常

`src/lib.rs` 里的状态机就是「切页」：

```42:46:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/lib.rs
pub enum Page {
    Import,
    Export,
    SelectDevice,
}
```

点按钮 → 改 `state.page` → `ui.rs` 按 `page` 重建整棵树：

```37:40:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/ui.rs
    let container = match page {
        Page::SelectDevice => build_select_device_page(),
        Page::Import | Page::Export => build_tabbed_page(page),
    };
```

**这就是「多页面切换」在这个平台上的唯一正确形态，它已经实现而且没坏。**
证据：页脚会实时显示 `当前:导入 / 导出 / 选设备`（`build_footer()`），只要这个字会变，就说明状态机、事件路由、整树重建**全链路都是通的**。

### 3. Tab 栏（visual tab bar）—— 这才是反复失败的元凶

「页面上方放一排 导入/导出 两个并排按钮」这个**视觉组件**，才是所有失败发生的地方。

---

## 三、真相：切页逻辑没坏，坏的是「并排按钮」

### 3.1 曾经实现过，而且实现过不止一次

`src/ui.rs` 里现在还留着那段被删掉的横向 tab 的墓志铭：

```83:86:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/ui.rs
    // ⚠️ 这里曾是「横向 tab 栏」（flex(Row) + 两个并排按钮）。
    // 实测在本宿主版本下 flex Row 不生效，元素被挤出屏幕导致点不到，已移除。
    // 页面切换统一走上方 build_nav_button() 的纵向按钮。详见排错手册 §8.3。
```

`TABS-问题分析.md`（v1.0.25）也记录了那一版的全过程。

### 3.2 两次失败，两个不同的根因

| 版本 | 做法 | 失败现象 | 根因 |
|------|------|---------|------|
| v1.0.21→22 | 两个按钮写死 `width(135)` | 第二个按钮「导出」被挤出屏幕，点不到 | **写死像素宽度**：`135×2=270px` > 屏幕 ~194px（排错手册 §8.3） |
| v1.0.25→28 | `flex(Row)` + `width_half()` | 依然被挤出屏幕，点不到 | **该宿主版本下 `flex(Row)` 横向布局本身不生效** |

关键：第二次失败**不是**宽度问题了（已经换成相对宽度 `width_half()`），而是 `flex(Row)` 在这个宿主版本 + api_level 2 下**横向排列压根不起作用**——两个子元素仍然按块级垂直堆叠 / 或溢出。

### 3.3 最终有效方案：纵向导航按钮

现在的 `build_nav_button()` 放弃了横向并排，退化成**一次只显示一个功能区的纵向通栏按钮**：

```104:124:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/ui.rs
fn build_nav_button(current: &Page) -> ui::Element {
    let (label, target) = match current {
        Page::Export => ("← 返回「导入」", "btn-tab-import"),
        _ => ("→ 前往「导出」", "btn-tab-export"),
    };
    ...
}
```

这不是「不能切页」，是**「并排 tab 栏」这个视觉形态在此平台做不出来**，只能退而求其次。

---

## 四、为什么「别人的插件可以」？—— 关键发现

### 4.1 别人用的是原生 TABS 组件（`ui-v3`）

`ui-v3` 里有一整套原生 Tabs，切换动画、高亮、内容区都是宿主自动处理的：

```192:237:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/wit/deps/astrobox-psys-host.wit
interface ui-v3 {
    enum element-type {
        BUTTON,
        INPUT,
        ...
        TABS-ROOT,      // Tab 容器
        TABS-LIST,      // Tab 按钮列表
        TABS-TRIGGER,   // 单个 Tab 按钮
        TABS-CONTENT,   // Tab 内容区
        ...
```

别人（api_level 3 的插件）就是直接渲染 `TABS-ROOT/TABS-LIST/TABS-TRIGGER/TABS-CONTENT`，宿主自己处理并排和切换，**根本不用手搓 `flex(Row)`**。所以它们不会踩我们这个坑。

### 4.2 ⭐ 反直觉发现：`ui-v3` 在 api_level 2 下其实也已经 import 了

这是本次分析最重要的收获。我们一直以为「要原生 tabs 必须升 api_level 3」，但看 `wit/main.wit`：

```26:46:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/wit/main.wit
world psys-world {
  import os;
  import transport;
  import ui;
  import ui-v3;      // ← api_level 2 的 world 同样 import 了 ui-v3！
  ...
  export lifecycle;
  export plugin-event;
}
```

排错手册 §1.1 的表格也明确写着：

| WIT world | 导入的 host API | 配哪个 api_level |
|-----------|:--------------:|:---------------:|
| `psys-world` | **`ui` + `ui-v3`** | **2** |

**也就是说：我们当前 `api_level: 2` + `psys-world` 的组合下，`crate::astrobox::psys_host::ui_v3` 这个模块极可能是已经生成的、可以用的**，`TABS-ROOT` 等元素也许不用升 api_level 就能渲染。

### 4.3 唯一需要留意的风险点：事件类型可能不匹配

`psys-world` 导出的是 v1 的 `plugin-event`，它的 `on_ui_event` 用的是**旧 `ui` 的 event 枚举**：

```7:24:tools/ev-schedule-sync/astrobox-build/astrobox-plugin/wit/deps/astrobox-psys-plugin.wit
interface event {
    ...
    use astrobox:psys-host/ui.{event};
    on-ui-event: func(event-id: string, event: event, event-payload: string) -> future<string>;
    ...
}
```

而 `ui-v3` 的 event 枚举多了 `KEY-DOWN/KEY-UP/LONG-PRESS` 等变体（`psys-host.wit` L341-356）。如果用 `ui-v3` 元素渲染，点击事件回传时的枚举类型和导出接口可能有出入。

但注意：`CLICK / CHANGE / INPUT / FOCUS / BLUR / HOVER` 是两套枚举**共有的变体**，点按钮这种基本交互大概率能对上。**结论：值得做一个 10 分钟的最小验证**，而不是直接否定。

---

## 五、真正的错误清单（逐条复盘）

| # | 我们做错/误判了什么 | 正确的认知 |
|:-:|--------------------|-----------|
| 1 | 用「写网页」的思路想「多页面」 | 插件只有单容器，「切页」= 状态变量 + 全树重建 |
| 2 | 把「并排按钮点不到」当成「切页逻辑坏了」去反复改切换代码 | 切换逻辑一直是对的，坏的是**布局** |
| 3 | 写死像素宽度 `width(135)` | 手表 ~194px，必须 `width_full()` / `width_half()` |
| 4 | 以为 `flex(Row)` 一定能横向并排 | 该宿主版本 api_level 2 下实测**不生效**，要横向 tab 就别指望它 |
| 5 | 以为「要原生 tabs 必须升 api_level 3」 | **可能不必要**：`psys-world` 已 import `ui-v3`（见 §4.2） |
| 6 | 把「tab 栏」和「tab 切换」绑定在一起 | 两者可解耦：切换用状态机（已好），并排栏可以用原生 TABS 或干脆用纵向按钮 |

---

## 六、三条可走的路

### 路 A（当前已生效，能用但丑）：纵向导航按钮
`build_nav_button()` + `Page` 状态机。**已稳定运行**，但一次只看一个功能区，多一步点击。

### 路 B（推荐下一步验证，改动小）：api_level 2 下直接用 `ui-v3` 原生 TABS
既然 `psys-world` 已经 import `ui-v3`，可以试：
1. 保持 `manifest.json` `api_level: 2` 不动；
2. 在 `ui.rs` 用 `crate::astrobox::psys_host::ui_v3` 构造 `TABS-ROOT/TABS-LIST/TABS-TRIGGER/TABS-CONTENT`；
3. 渲染一棵最小 TABS 树，看能否并排显示、能否点击切换。

> 若成功：原生 tab 并排 + 切换动画全有了，且不用推翻 §0 那套「api_level 2 + edition 2021 + psys-world」已验证能装上的配方。
> 若失败（渲染空白 / 事件不回传）：再退回路 A，或走路 C。

### 路 C（兜底，成本最高）：升 api_level 3 + `psys-world-v3`
全量迁移到 `ui-v3` + `plugin-event-v3`，会推翻排错手册 §1.1 的整套匹配规则（`export!` 宏、`on_ui_event_v3`、事件枚举都要改），风险大，**除非路 B 证实不可行，否则别动**。

---

## 七、验证路 B 的最小实验清单

```bash
cd tools/ev-schedule-sync/astrobox-build/astrobox-plugin
# 先确认生成的绑定里到底有没有 ui_v3 模块
grep -rn "ui_v3" target/wasm32-wasip2/release/ 2>/dev/null | head
# 或编译一个临时函数，故意类型不匹配让编译器打印 ui_v3 真实路径
```

在 `src/ui.rs` 里加一个最小实验函数（不影响现有代码）：

```rust
// 临时验证：api_level 2 下 ui_v3 是否可用
fn probe_ui_v3() {
    use crate::astrobox::psys_host::ui_v3;
    let root = ui_v3::Element::new(ui_v3::ElementType::TabsRoot, None);
    // 若这一行能编译通过，说明 ui_v3 绑定已生成，路 B 可行
    let _ = root;
}
```

只要 `cargo build` 能过这行，就说明「必须升 api_level 3」是误判，后续可以放心把 tab 栏换成原生 TABS。

---

## 八、总结

1. **「多页面」在 AstroBox 插件里不存在**，只有「单容器 + 全量重建」。我们追求错了目标。
2. **我们的「切页」从 v1.0.20 起就是好的**（`Page` 状态机 + 事件路由 + 整树重建），别再改它。
3. **反复失败的只有「并排 tab 按钮」这个视觉布局**：先死于写死像素宽度，后死于 `flex(Row)` 在本宿主失效。
4. **别人能做 tab，是因为用 `ui-v3` 原生 TABS**，而 `ui-v3` 在我们的 `psys-world`（api_level 2）里**其实已经 import 进来了**——这是最有价值的突破口，值得用 §7 的最小实验验证，而不是一上来就升 api_level 3 推翻已验证的安装配方。
