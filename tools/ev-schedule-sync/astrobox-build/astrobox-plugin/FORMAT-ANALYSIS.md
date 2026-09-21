# EV 课程表数据格式分析 —— 同步器对接评估

> 对比 EV 课程表实际存储格式与同步器当前设计的 JSON 格式，分析差异原因并提出方案建议。

---

## 一、两套格式一览

### 1.1 EV 课程表实际存储格式（EV 格式）

```json
[
  {
    "day": "星期一",
    "classes": [
      {
        "id": "1",
        "name": "数学",
        "time": "08:00 - 08:45",
        "teacher": "王老师",
        "location": "301教室",
        "notes": "第五章：三角函数"
      }
    ]
  },
  {
    "day": "星期二",
    "classes": []
  }
]
```

关键特征：
- 顶层是按 `day` 分组的数组 `[{day, classes[]}]`
- 时间字段 `time` 是合并字符串 `"HH:MM - HH:MM"`
- `day` 用中文字符串 `"星期一"` ~ `"星期日"`
- 每个课程有 `id`（数字字符串），用于 CRUD
- 课程表名称单独存在 `scheduleNames` 键中
- 无 weeks、无 weekType、无 color、无 credit

### 1.2 同步器当前设计格式（同步器格式）

```json
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
      "remark": "备注内容"
    }
  ]
}
```

关键特征：
- 顶层平铺 `{scheduleName, courses[]}`
- 时间拆分为 `startTime` + `endTime`
- `day` 用数字 `1`~`7`
- 没有 `id` 字段
- 有 weeks、weekType、color、credit 等 EV 不需要的字段
- 用 `remark` 而非 `notes`

---

## 二、逐字段差异对照

| 维度 | EV 格式 | 同步器格式 | 差异程度 |
|------|:--:|:--:|:--:|
| 顶层结构 | 按天分组 `[{day, classes[]}]` | 平铺 `{scheduleName, courses[]}` | 完全不同 |
| scheduleName | 另存于 `scheduleNames` 键 | 内联在 JSON 中 | 存储位置不同 |
| id | `string`，CRUD 必需 | 无 | EV 依赖此字段 |
| 时间 | `time: "08:00 - 08:45"` 合并 | `startTime` + `endTime` 拆分 | 结构不同 |
| day | `"星期一"` 字符串 | `1` 数字 | 类型和值都不同 |
| notes/remark | `notes` | `remark` | 字段名不同 |
| weeks | 无 | 有 | EV 不需要 |
| weekType | 无 | 有 | EV 不需要 |
| color | 无 | 有 | EV 不需要 |
| credit | 无 | 有 | EV 不需要 |

---

## 三、核心问题：EV 数据库结构是否不规范？

**结论：不是不规范，是设计取舍不同。**

### EV 格式这样设计的原因

**（1）time 合并为 `"08:00 - 08:45"`**

来自 HarmonyOS `@system.storage` 扁平 key-value 存储的限制。前端渲染课程表直接展示时间段文本，合在一起最直接。冲突检测在代码层面拆解，开销可忽略。

**（2）day 用中文 `"星期一"`**

前端 UI 直接读取 day 值渲染表头，省去数字到中文的映射。鸿蒙低性能设备的渲染优化。

**（3）顶层按天分组 `[{day, classes[]}]`**

鸿蒙前端渲染课程表格天然按天遍历，读取数据后直接 forEach 渲染，无需客户端 groupBy。"存储即视图"的设计，对低性能穿戴设备合理。

**（4）用 id 做 CRUD**

updateCourse / deleteCourse 都依赖 id，标准做法。

**（5）没有 weeks / weekType / color / credit**

当前 EV 课程表功能范围不需要——不区分单双周、不支持课程颜色、不管理学分。正确的设计：不存用不到的数据。

### 同步器格式为什么不同

同步器以 WakeUp、sgschedule、StarLink、CSES 为参考，设计了一个"最大公约数"的中间格式（包含所有第三方字段的超集）。它没有深入了解 EV 课程表的实际存储格式，导致字段不匹配。

**本质是"中间格式过宽"的问题，不是 EV 数据库不规范。**

---

## 四、方案建议：不改数据库，做转换层

| 因素 | 分析 |
|------|------|
| 成熟度 | EV 课程表已上线运行，数据库稳定 |
| 风险 | 改数据库 = 改前端渲染、冲突检测、备份恢复、全部 CRUD → 高风险 |
| 收益 | startTime+endTime 代替 time 字符串，收益极小 |
| 正确做法 | 同步器侧加一层格式转换，EV 数据库完全不动 |

### 转换映射（同步器中间格式 → EV 实际格式）

```
scheduleName                       → scheduleNames[index]
courses[] 按 day 分组              → [{day: "星期一", classes: [...]}]
day: 1~7                           → "星期一"~"星期日"
startTime + endTime                → time: "startTime - endTime" (合并)
remark                             → notes
weekType                           → 丢弃
weeks                              → 丢弃
color                              → 丢弃
credit                             → 丢弃
—                                  → 生成 id (递增字符串)
```

### 反向转换（EV 格式 → 同步器中间格式）

```
scheduleNames[index]               → scheduleName
[{day, classes[]}]                 → courses[] 平铺
"星期一"~"星期日"                   → day: 1~7
time: "startTime - endTime"        → startTime + endTime (拆分)
notes                              → remark
id                                 → 保留
```

---

## 五、修正后的导入/导出 Demo JSON

### 完整 Demo JSON

```json
/*
 * EV 课程表导入 JSON 格式说明
 * ==========================================
 * 复制下面整段内容发给 AI，编辑后粘贴回来即可导入。
 *
 * 顶层：数组，每个元素代表一天
 * day        : 必须为 "星期一"~"星期日"
 * classes[]  : 当天课程，可为空 []
 *
 * 必填：
 * id          : 字符串，唯一标识，建议递增 "1" "2" ...
 * name        : 字符串，课程名，最长50字符
 * time        : 字符串，"HH:MM - HH:MM"，24小时制，如 "08:00 - 09:40"
 *
 * 可选：
 * teacher     : 教师，最长30字符
 * location    : 地点，最长50字符
 * notes       : 备注，最长200字符
 *
 * 注意：只返回合法JSON，不用markdown代码块包裹；time开始<结束；id唯一
 */
[
  {
    "day": "星期一",
    "classes": [
      {
        "id": "1",
        "name": "高等数学",
        "time": "08:00 - 09:40",
        "teacher": "张教授",
        "location": "A楼101教室",
        "notes": ""
      },
      {
        "id": "2",
        "name": "大学英语",
        "time": "10:00 - 11:40",
        "teacher": "李教授",
        "location": "教学楼B205",
        "notes": ""
      }
    ]
  },
  { "day": "星期二", "classes": [] },
  { "day": "星期三", "classes": [] },
  { "day": "星期四", "classes": [] },
  { "day": "星期五", "classes": [] },
  { "day": "星期六", "classes": [] },
  { "day": "星期日", "classes": [] }
]
```

### 字段约束

| 层级 | 字段 | 类型 | 必填 | 约束 |
|------|------|------|:--:|------|
| 根 | *(数组)* | array | 是 | 7个元素，每天一个 |
| 天 | day | string | 是 | `"星期一"`~`"星期日"` |
| 天 | classes | array | 是 | 可为空 `[]` |
| 课 | id | string | 是 | 唯一，递增数字 |
| 课 | name | string | 是 | ≤50字符 |
| 课 | time | string | 是 | `"HH:MM - HH:MM"`，开始<结束 |
| 课 | teacher | string | 否 | ≤30字符 |
| 课 | location | string | 否 | ≤50字符 |
| 课 | notes | string | 否 | ≤200字符 |

---

## 六、同步器代码改动清单

### 6.1 adapters/ 下新增 evschedule_actual.rs

处理 EV 课程表实际格式（非之前的中间格式）：

- `parse()`: `[{day, classes[]}]` → `Vec<UnifiedCourse>`
- `export()`: `Vec<UnifiedCourse>` → `[{day, classes[]}]`
- `detect()`: 检测顶层是否为数组 + 元素含 `day` 和 `classes` 字段

### 6.2 mod.rs 新增 FormatType::EvScheduleActual

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum FormatType {
    SgSchedule,
    WakeUp,
    Starlink,
    Cses,
    EvSchedule,
    EvScheduleActual,  // 新增
}
```

### 6.3 import_engine.rs / export_engine.rs

新增对应的导入/导出路径，导出时提供"导出为 EV 课程表 JSON"选项。

### 6.4 UI 页面

- Demo JSON 按钮展示修正后的实际格式
- 导入页支持粘贴直接导入 EV 原生 JSON

---

## 七、总结

| 问题 | 结论 |
|------|------|
| EV 数据库是否不规范？ | **否。** 符合鸿蒙平台限制和前端渲染需求，设计取舍合理。 |
| 是否修改 EV 数据库？ | **不建议。** 高风险、低收益。 |
| 同步器如何对接？ | 新增 `EvScheduleActual` 适配器，做双向格式转换。 |
| 中间格式怎么办？ | **不变。** 中间格式是最大公约数，EV 格式只是多一条转换路径。 |
| Demo JSON 改不改？ | **要改。** 必须修正为 EV 实际格式，否则导入失败。 |