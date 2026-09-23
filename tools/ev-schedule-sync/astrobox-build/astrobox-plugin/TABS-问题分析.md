# 导出 Tab 点不开 — 根因分析与官方方案对比

> 日期：2026-09-22
> 版本：v1.0.25
> 关联文档：[AstroBox UI v3 官方文档](https://abox.run/docs/plugin-dev/host-api/ui-v3)

---

## 一、现象

插件主界面有 `[导入课程表]` `[导出课程表]` 两个按钮，但**导出按钮点不到**——不是点了没反应，而是**按钮在屏幕上根本看不到**，被导入区域的内容挤出视口了。

---

## 二、当前实现方式（有问题）

### 2.1 代码位置

[ui.rs L80-L104](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/ui.rs#L80-L104)

```rust
// 两个 Tab 按钮放在一个 Div 里
let tab_import = ui::Element::new(ui::ElementType::Button, Some("导入课程表"))
    .size(15)
    .bg(GREEN)
    .on(ui::Event::Click, "btn-tab-import");

let tab_export = ui::Element::new(ui::ElementType::Button, Some("导出课程表"))
    .size(13)
    .bg(BG_CARD)
    .on(ui::Event::Click, "btn-tab-export");

root = root.child(
    ui::Element::new(ui::ElementType::Div, None)  // ← 没有 flex()
        .padding(6)
        .child(tab_import)      // 第一个孩子
        .child(tab_export),     // 第二个孩子
);
```

### 2.2 问题根因

| 层级 | 发生了什么 |
|------|-----------|
| **Div 容器** | 没有调用 `.flex()`，默认为**块级布局（block）** |
| **导入按钮** | 块级元素，占满整行宽度 |
| **导出按钮** | 块级元素，被挤到导入按钮**下方**第二行 |
| **导入 Tab 内容** | JSON 输入框（120px 高）+ 导入按钮 + AI 生成按钮 + 格式按钮 ≈ 占据大量垂直空间 |
| **手表屏幕** | 分辨率很低（约 240×280 级别），垂直空间极其有限 |
| **结果** | 导出按钮在导入内容区下方，用户根本**滚动不到**或**看不见**它 |

### 2.3 布局示意（实际渲染）

```
┌───────────────────┐  ← 手表屏幕可视区域上边界
│ EV 课程表同步器    │
│ 目标设备：xxx      │
│ [切换设备]         │
│ ┌────────────────┐ │
│ │  导入课程表      │ │  ← 第一个 Tab 按钮（可见）
│ └────────────────┘ │
│ ┌────────────────┐ │
│ │  导出课程表      │ │  ← 第二个 Tab 按钮（可能可见，但...）
│ └────────────────┘ │
│ 粘贴课程表 JSON    │
│ ┌────────────────┐ │
│ │                │ │  ← JSON 输入框 120px
│ │                │ │
│ └────────────────┘ │
│ [导入]              │
│ [用 AI 生成课表]    │
│ [支持哪些格式？]    │  ← ← 所有导入内容把导出按钮往下挤
├───────────────────┤  ← 手表屏幕可视区域下边界
│ 版本 v1.0.25      │  ← 页脚（滚动到底才能看到）
└───────────────────┘
```

---

## 三、官方支持的方式

### 3.1 方式 A：Flex 布局（当前 API Level 2 即可用）

旧版 `ui` 模块**本身就支持 flex**。查看 WIT 定义：

[astrobox-psys-host.wit L118-L119](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/wit/deps/astrobox-psys-host.wit#L118-L119)

```wit
interface ui {
    resource element {
        flex: func() -> element;
        flex-direction: func(direction: flex-direction) -> element;
        // ...
    }
    enum flex-direction {
        ROW,
        COLUMN,
        ROW-REVERSE,
        COLUMN-REVERSE,
    }
}
```

**我们一直没用到它。** 让两个 Tab 按钮并排只需加两行：

```rust
// ✅ 修复方案（不需要改 api_level）
root = root.child(
    ui::Element::new(ui::ElementType::Div, None)
        .flex()                              // ← 开启 flex 布局
        .flex_direction(ui::FlexDirection::Row)  // ← 水平排列
        .padding(6)
        .child(tab_import)
        .child(tab_export),
);
```

修复后渲染效果：

```
┌──────────────────────┐
│ EV 课程表同步器       │
│ 目标设备：xxx         │
│ [切换设备]            │
│ ┌────────┬──────────┐│
│ │导入课程表│导出课程表││  ← 两个并排，都可见
│ └────────┴──────────┘│
│ 粘贴课程表 JSON       │
│ ┌────────────────────┐│
│ │                    ││
│ └────────────────────┘│
│ [导入]                │
│ ...                   │
└──────────────────────┘
```

**优点**：改动 2 行代码，不涉及 API 升级，零风险。
**缺点**：两个按钮平分宽度，在窄屏上每个约 30 个汉字宽度，够用但不是最优雅。

---

### 3.2 方式 B：ui-v3 原生 Tabs 组件（需要 API Level 3）

官方 ui-v3 提供了**真正的 Tab 组件**：

[astrobox-psys-host.wit L213-L216](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/wit/deps/astrobox-psys-host.wit#L213-L216)

```wit
interface ui-v3 {
    enum element-type {
        // ... 基础元素 ...
        TABS-ROOT,      // Tab 容器
        TABS-LIST,      // Tab 按钮列表
        TABS-TRIGGER,   // 单个 Tab 按钮
        TABS-CONTENT,   // Tab 内容区
        // ...
    }
}
```

ui-v3 的 Tabs 组件**自动处理切换逻辑**，不需要手动写 `btn-tab-import`/`btn-tab-export` 事件：

```
┌──────────────────────┐
│ EV 课程表同步器       │
│ ┌────────┬──────────┐│
│ │ ★导入   │   导出   ││  ← TABS-LIST（自动高亮当前项）
│ └────────┴──────────┘│
│ ┌────────────────────┐│
│ │  TABS-CONTENT      ││  ← 自动切换内容，无需手动管理 Page 状态
│ │  (导入或导出内容)   ││
│ └────────────────────┘│
└──────────────────────┘
```

**优点**：原生组件，切换动画、焦点管理、无障碍都自动处理。
**缺点**：需要**完整迁移到 ui-v3**，改动量大：

| 改动项 | 说明 |
|--------|------|
| `manifest.json` | `api_level: 2` → `3` |
| `lib.rs` WIT world | `psys-world` → `psys-world-v3` |
| `lib.rs` 事件处理 | `EventType` 接口从 v1 升级到 v3 |
| `ui.rs` 全部元素 | `psys_host::ui` → `psys_host::ui_v3` |
| `ui.rs` 方法链 | `size()` `bg()` 等方法签名一致，但需要逐处替换导入路径 |
| Tab 切换逻辑 | 删除手动 `Page` 状态机，由 TABS-ROOT 组件自动管理 |

这不是一个小改动，属于 **API 大版本迁移**。

---

### 3.3 方式 C：单页面滚动（原始设计，无 Tab）

v1.0.23 及之前的做法：只有一个 "→ 前往导出" 按钮，点击后**整个页面替换**为导出内容。

这其实是**单页面状态切换**，没有"同时显示两个 Tab"的需求，所以从来不存在"导出点不到"的问题。

**优点**：永远不可能"点不到"，每次只渲染一个功能区的全部内容。
**缺点**：用户需要多点一次才能切换，体验不够直观。

---

## 四、三种方案对比

| 维度 | A: Flex 布局 | B: ui-v3 Tabs | C: 单页面切换 |
|------|:-----------:|:------------:|:-----------:|
| **改动量** | 2 行代码 | 全项目重写 | 恢复旧代码 |
| **api_level** | 保持 2 | 升到 3 | 保持 2 |
| **Tab 可见性** | ✅ 两个都可见 | ✅ 原生 Tab 栏 | ❌ 一次只看一个 |
| **切换体验** | 点 Tab 按钮 | 原生 Tab 切换 | 点导航按钮 |
| **风险** | 极低 | 高（API 迁移） | 无 |
| **长期维护** | 一般 | 最优 | 一般 |
| **官方推荐** | 可接受 | ✅ 推荐 | 临时方案 |

---

## 五、推荐方案

### 短期（立即修复）：方案 A — 加 flex

**改动量**：在 [ui.rs L99](file:///Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/src/ui.rs#L99) 的 Div 上加 `.flex()` 和 `.flex_direction(FlexDirection::Row)`。

```rust
root = root.child(
    ui::Element::new(ui::ElementType::Div, None)
        .flex()                                // ← 新增
        .flex_direction(ui::FlexDirection::Row) // ← 新增
        .padding(6)
        .child(tab_import)
        .child(tab_export),
);
```

这样两个 Tab 按钮水平并排，始终可见。不需要改任何其他代码。

### 长期（下次大版本）：方案 B — 迁移到 ui-v3 + Tabs

当需要升级 `api_level: 3` 时，顺带用上原生 `TABS-ROOT`/`TABS-LIST`/`TABS-TRIGGER`/`TABS-CONTENT`，彻底告别手动状态管理。

---

## 六、总结

**导出点不开不是因为"Tab 切换逻辑写错了"，而是因为两个按钮作为块级元素垂直堆叠，导入内容把导出按钮挤出了手表屏幕的可视区域。**

解决方案很简单：让两个按钮并排显示。当前 API Level 2 的旧版 `ui` 模块本身就支持 `flex()` + `flex-direction(ROW)`，代码里只是从来没用过。