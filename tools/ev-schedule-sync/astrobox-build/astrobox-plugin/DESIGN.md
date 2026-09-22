# EV 同步插件 - 导入导出功能增强方案

## 概述

对 EV 课程表同步插件界面进行以下增强：
1. **设备目标菜单** —— 导入/导出前选择目标设备
2. **设备连接状态检查** —— 未连接设备或未安装 EV 课程表时阻止操作
3. **Demo JSON 对话框** —— 展示带详细注释的 demo JSON，用户可复制给 AI 编辑后粘贴回来快速导入

---

## 1. 设备目标菜单

### 1.1 设计思路

在任意导入或导出操作之前，用户必须先选择一个**目标设备**。插件通过 AstroBox 宿主 API 列出已连接设备，并检查每台设备上是否安装了 EV 课程表应用。

### 1.2 界面布局

```
┌─────────────────────────────────────────┐
│  选择目标设备                             │
│  请选择要同步到的设备                      │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ 📱 我的手表          ● 已连接  │    │
│  │     EV 课程表: ✅ 已安装        │    │
│  │         [选择此设备]            │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ 📱 我的手环          ○ 离线    │    │
│  │     EV 课程表: ⚠️ 未知         │    │
│  │         [不可用]                │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ 📱 另一台设备        ● 已连接  │    │
│  │     EV 课程表: ❌ 未安装        │    │
│  │         [请先安装]              │    │
│  └─────────────────────────────────┘    │
│                                         │
│  没有找到设备？                          │
│  [刷新列表]  [返回主页]                  │
└─────────────────────────────────────────┘
```

### 1.3 设备状态说明

| 状态 | 图标 | 含义 | 可执行操作 |
|------|------|------|-----------|
| 已连接 + EV 已安装 | ✅ 绿色 | 可以同步 | **选择此设备** 按钮可用 |
| 已连接 + EV 未安装 | ❌ 红色 | 需要先安装 EV 课程表 | **请先安装**（可跳转安装引导） |
| 离线 | ⚠️ 灰色 | 设备未连接 | **不可用**（按钮置灰） |
| 检测中 | ⏳ 黄色 | 正在检测状态 | 显示加载动画，自动重试 |

### 1.4 后端检测逻辑（使用的 WIT 接口）

```rust
// 使用 AstroBox 宿主 API
use astrobox::psys_host::device;       // 列出已连接设备
use astrobox::psys_host::thirdpartyapp; // 检查 EV 课程表是否已安装
```

**检测流程：**

1. 调用 `device::get_device_list()` → 全部已配对设备 `Vec<DeviceInfo>{ name, addr }`；
   再调用 `device::get_connected_device_list()` → 当前在线设备。两者求交集得出每台设备的「在线 / 离线」
2. 对每台**在线**设备，调用 `thirdpartyapp::get_thirdparty_app_list(addr)`
   → 返回 `Result<Vec<AppInfo>, ()>`，在列表里匹配
   `package_name == "com.application.watch.classschedule"` 判断是否已安装
3. 根据两项结果渲染设备卡片

> ⚠️ 2026-09-22 校正：WIT 里**不存在** `thirdpartyapp::is_installed()` 这种直接查询函数，
> 只能拉应用列表自行匹配；EV 课程表真实包名也不是本文原写的 `com.ev.schedule`。
4. 用户点击"选择此设备" → 将 `selected_device_id` 存入状态 → 跳转到导入/导出页面

### 1.5 新增页面状态

```rust
enum Page {
    Main,           // 主页
    SelectDevice,   // 新增：选择目标设备
    Import,         // 导入
    Export,         // 导出
    Result,         // 结果
    Error,          // 错误
}
```

操作流程：`主页 → 选择设备 → 导入/导出`

---

## 2. 操作前守卫检查

### 2.1 检查条件

在执行任意导入/导出操作前，必须通过以下三项检查：

```
selected_device_id 不为空
    AND 设备在线（device_is_connected）
    AND EV 课程表已安装（ev_schedule_is_installed）
```

任一项不满足 → 显示明确错误提示 + 解决方案按钮。

### 2.2 错误提示文案

| 情况 | 提示文案 | 操作按钮 |
|------|---------|---------|
| 未选择设备 | "请先选择目标设备" | "选择设备" → 跳转回选择设备页 |
| 设备已断开 | "设备'我的手表'已断开连接，请重新连接" | "刷新设备列表" |
| EV 未安装 | "设备'我的手表'上未安装 EV 课程表，请先安装" | "如何安装" → 显示安装引导 |

### 2.3 集成位置

- **导入页面**：进入时检查守卫，不通过则顶部显示错误横幅
- **导出页面**：进入时检查守卫，不通过则顶部显示错误横幅
- **执行导入/导出按钮点击时**：再次检查守卫，不通过则中止操作

---

## 3. Demo JSON 对话框（快捷导入）

### 3.1 设计目的

用户通常不清楚 JSON 的正确格式。我们提供一个**Demo JSON 对话框**，其中：
- 展示一份真实有效的示例 JSON，包含所有必填字段
- 附带**详细注释**，说明每个字段的含义、类型和约束条件
- 用户可以**复制** demo → 发给 AI 助手 → AI 编辑好 JSON → **粘贴回来** → 一键导入

### 3.2 界面布局

```
┌──────────────────────────────────────────────────┐
│  快捷导入 Demo                           [✕ 关闭]│
├──────────────────────────────────────────────────┤
│                                                  │
│  复制下方 JSON，发给 AI 助手，让 AI 按照你的     │
│  课程表编辑好内容，然后粘贴回来即可导入：         │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ {                                        │    │
│  │   "scheduleName": "2026 春季学期",       │    │
│  │   "courses": [                           │    │
│  │     {                                    │    │
│  │       "name": "高等数学",                │    │
│  │       "teacher": "张教授",               │    │
│  │       "location": "A楼101教室",          │    │
│  │       "day": 1,                          │    │
│  │       "startTime": "08:00",              │    │
│  │       "endTime": "09:40",                │    │
│  │       "weeks": [1,2,3,4,5,6,7,8],       │    │
│  │       "weekType": "all",                 │    │
│  │       "color": "#F44336",                │    │
│  │       "credit": 3.0,                     │    │
│  │       "remark": "可选备注"               │    │
│  │     }                                    │    │
│  │   ]                                      │    │
│  │ }                                        │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  [复制 Demo JSON]                                │
│                                                  │
│  ── 将 AI 编辑好的 JSON 粘贴到下方 ──            │
│  ┌──────────────────────────────────────────┐    │
│  │ (在此粘贴你的 JSON...)                   │    │
│  │                                          │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  [导入已粘贴的 JSON]   [取消]                    │
└──────────────────────────────────────────────────┘
```

### 3.3 复制给 AI 的 Demo JSON（带注释版）

当用户点击"复制 Demo JSON"按钮时，复制的内容包含详细注释，AI 可以直接读懂：

```json
/*
 * EV 课程表导入 JSON 格式说明
 * ==========================================
 * 复制下面整段内容发给 AI，让 AI 按照你的课程表编辑好内容后粘贴回来即可导入。
 * AI 会读取这些注释并生成合法的 JSON。
 *
 * ── 必填字段 ──
 * scheduleName  : 字符串，课程表名称，最长 50 个字符
 * courses[]     : 课程数组，至少包含 1 门课程
 *
 *   每门课程的必填字段：
 *   name          : 字符串，课程名称，最长 50 个字符，例如 "高等数学"
 *   teacher       : 字符串，授课教师，最长 30 个字符，例如 "张教授"
 *   location      : 字符串，上课地点，最长 50 个字符，例如 "A楼101"
 *   day           : 整数，星期几，1-7（1=周一，7=周日）
 *   startTime     : 字符串，上课时间，"HH:MM" 24小时制，例如 "08:00"
 *   endTime       : 字符串，下课时间，"HH:MM" 24小时制，必须大于 startTime
 *   weeks         : 整数数组，上课周次，例如 [1,2,3,4,5,6,7,8]
 *   weekType      : 字符串，周类型，三选一："all"（每周）| "odd"（单周）| "even"（双周）
 *
 *   每门课程的可选字段：
 *   color         : 字符串，颜色值，#RRGGBB 格式，例如 "#F44336"
 *   credit        : 数字，学分，例如 3.0
 *   remark        : 字符串，备注，最长 200 个字符
 *
 * ── 注意事项 ──
 * - 只返回合法的 JSON，不要用 markdown 代码块包裹，不要添加额外文字
 * - startTime 和 endTime 必须是有效时间，且 startTime < endTime
 * - day 必须是 1-7 的整数
 * - weeks 必须是包含整数的非空数组
 */
{
  "scheduleName": "2026 春季学期",
  "courses": [
    {
      "name": "高等数学",
      "teacher": "张教授",
      "location": "A楼101教室",
      "day": 1,
      "startTime": "08:00",
      "endTime": "09:40",
      "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      "weekType": "all",
      "color": "#F44336",
      "credit": 3.0,
      "remark": "这是可选备注"
    },
    {
      "name": "大学英语",
      "teacher": "李教授",
      "location": "教学楼B205",
      "day": 3,
      "startTime": "10:05",
      "endTime": "11:40",
      "weeks": [1,3,5,7,9,11,13,15],
      "weekType": "odd",
      "color": "#2196F3"
    }
  ]
}
```

### 3.4 字段约束汇总

| 字段 | 是否必填 | 类型 | 约束条件 |
|------|---------|------|---------|
| `scheduleName` | ✅ 必填 | string | 最长 50 个字符 |
| `courses` | ✅ 必填 | array | 至少包含 1 门课程 |
| `courses[].name` | ✅ 必填 | string | 最长 50 个字符 |
| `courses[].teacher` | ✅ 必填 | string | 最长 30 个字符 |
| `courses[].location` | ✅ 必填 | string | 最长 50 个字符 |
| `courses[].day` | ✅ 必填 | integer | 1-7（周一到周日） |
| `courses[].startTime` | ✅ 必填 | string | 格式 `HH:MM`，24 小时制，如 `"08:00"` |
| `courses[].endTime` | ✅ 必填 | string | 格式 `HH:MM`，必须大于 startTime |
| `courses[].weeks` | ✅ 必填 | array | 非空整数数组，如 `[1,2,3]` |
| `courses[].weekType` | ✅ 必填 | string | 三选一：`"all"` / `"odd"` / `"even"` |
| `courses[].color` | ❌ 可选 | string | 十六进制颜色 `#RRGGBB` |
| `courses[].credit` | ❌ 可选 | number | 如 `3.0` |
| `courses[].remark` | ❌ 可选 | string | 最长 200 个字符 |

### 3.5 粘贴后校验逻辑

用户点击"导入已粘贴的 JSON"时：

1. 解析文本框中的 JSON
2. 校验 `scheduleName` 是否存在且为字符串
3. 校验 `courses` 是否为非空数组
4. 对每门课程逐一校验：
   - 所有必填字段是否都存在
   - `day` 是否在 1-7 范围内
   - `startTime` / `endTime` 是否匹配 `HH:MM` 正则
   - `startTime` 是否小于 `endTime`
   - `weekType` 是否为 `all` / `odd` / `even` 之一
   - `weeks` 是否为非空整数数组
5. 任一校验失败 → 显示具体错误信息，指出问题字段
6. 全部通过 → 调用 `import_from_json()` → 跳转到结果页面

### 3.6 实现注意事项

- Demo JSON 作为**代码常量**存储在插件中（含注释）
- "复制 Demo JSON"按钮使用 `clipboard` WIT 接口（`astrobox::psys_host::clipboard::write_text(text: &str)`）
- 粘贴区域为标准文本输入框
- 校验逻辑在插件 WASM 内部完成，然后再调用导入引擎

---

## 4. 修改后的界面流程

```
┌──────┐    ┌──────────────┐    ┌────────┐    ┌────────┐
│ 主页 │───>│  选择设备    │───>│ 导入页 │───>│ 结果页 │
│      │    │  （新增）    │    │        │    │        │
└──────┘    └──────────────┘    └────────┘    └────────┘
     │              │                 │              │
     │              │                 ├── Demo JSON ─┤
     │              │                 │   对话框      │
     │              │                 │  （新增）     │
     │              │                 │               │
     │              └────────>│ 导出页 │──────>│ 结果页 │
     │                        │        │       │        │
     │                        └────────┘       └────────┘
     │
     └──────────────────────────────────────────────>│ 错误页 │
                                                     │        │
```

### 4.1 新增页面：选择设备

- 通过 `device::get_device_list()` 列出所有设备，并用 `device::get_connected_device_list()` 判定在线状态
- 每台设备显示连接状态 + EV 课程表安装状态
- 只有"已连接 + EV 已安装"的设备可以选中
- 提供"刷新列表"按钮重新扫描
- 选中后，设备 ID 存入 `UiState.selected_device_id`

### 4.2 修改页面：导入

- 进入时：如果 `selected_device_id` 为空，自动跳转到选择设备页
- 顶部横幅显示已选设备：`目标设备: 📱 我的手表`
- 新增"Demo JSON"按钮 → 打开 Demo 对话框
- 保留原有的"从文件导入"和"从教务系统导入"

### 4.3 修改页面：导出

- 进入时：如果 `selected_device_id` 为空，自动跳转到选择设备页
- 顶部横幅显示已选设备名称
- 执行导出前完成守卫检查

---

## 5. 新增状态字段

```rust
struct UiState {
    page: Page,
    root_element_id: Option<String>,
    selected_device_id: Option<String>,        // 新增：选中的设备 ID
    selected_device_name: Option<String>,       // 新增：选中的设备名称
    devices: Vec<DeviceInfo>,                   // 新增：设备列表
    last_result: Option<ImportResult>,
    last_error: Option<String>,
    last_export: Option<String>,
    export_format: usize,
    show_demo_dialog: bool,                     // 新增：Demo 对话框是否显示
    demo_pasted_json: Option<String>,           // 新增：用户粘贴的 JSON
}
```

---

## 6. 新增按钮 ID

```rust
const BTN_SELECT_DEVICE: &str = "btn_select_device";   // 选择设备
const BTN_REFRESH_DEVICES: &str = "btn_refresh_devices"; // 刷新设备列表
const BTN_SHOW_DEMO: &str = "btn_show_demo";           // 打开 Demo 对话框
const BTN_COPY_DEMO: &str = "btn_copy_demo";           // 复制 Demo JSON
const BTN_PASTE_IMPORT: &str = "btn_paste_import";     // 从粘贴内容导入
const BTN_CLOSE_DEMO: &str = "btn_close_demo";         // 关闭 Demo 对话框
```

---

## 7. 依赖的 AstroBox 宿主 API

| API（真实签名，见 `wit/deps/astrobox-psys-host.wit`） | 用途 |
|-----|------|
| `device::get_device_list() -> Vec<DeviceInfo>` | 列出全部已配对设备 |
| `device::get_connected_device_list() -> Vec<DeviceInfo>` | 列出当前在线设备 |
| `thirdpartyapp::get_thirdparty_app_list(addr: &str) -> Result<Vec<AppInfo>, ()>` | 拉设备应用列表，再按包名匹配 EV 课程表 |
| `clipboard::write_text(text: &str) -> Result<(), ()>` | 复制 Demo JSON 到剪贴板 |

> ⚠️ 2026-09-22 校正：原文写的 `device::list()` / `device::get_info(id)` /
> `thirdpartyapp::is_installed(...)` / `clipboard::write(...)` 在 WIT 里**均不存在**，
> 属于伪代码。且所有宿主函数参数是 `&str` 而非 `String`。
> EV 课程表真实包名：`com.application.watch.classschedule`（来源 `github.com/guomengtao/class-schedule`）。
> 平台没有 `dialog::show` 这类原生弹窗，错误提示与对话框均需用
> `ui::Element` 的 `absolute()` + `z_index()` 自行模拟。

---

## 8. 异常处理

- **完全无设备**：显示"未发现设备，请通过蓝牙连接设备后重试" + 刷新按钮
- **操作中途设备断连**：显示横幅"设备已断开连接，请重新连接" + 返回选择设备按钮
- **粘贴 JSON 解析失败**：文本框下方显示错误"第 X 行 JSON 格式错误：..."
- **字段校验失败**：显示具体字段错误，如"day 必须为 1-7，当前值为 8"
- **导入引擎报错**：跳转到错误页面，显示详细错误信息

---

## 9. 实现顺序

1. 新增 `SelectDevice` 页面 + 设备列表逻辑
2. 在状态中增加 `selected_device_id`，在导入/导出页面增加守卫检查
3. 新增 Demo JSON 对话框，含复制 + 粘贴 + 校验完整流程
4. 对接剪贴板 API 实现复制按钮
5. 实现粘贴 JSON 的校验逻辑
6. 使用模拟设备数据进行测试
7. 在真实 AstroBox 运行环境中集成测试