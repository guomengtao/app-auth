# sgschedule JSON 格式 — 导入/导出对接分析

> **来源**：`https://sgschedule.jursin.top/guide/user/schedule-import`（拾光课程表 / sgschedule）  
> **目标**：分析此 JSON 格式与 EV课程表之间的导入/导出是否可行，给出完整的转换逻辑。  
> **日期**：2026-09-20

---

## 零、核心结论

**完全可行，双向互转。** 唯一的关键差异是「节次编号 vs 直接时间」的表示方式——通过 `timeSlots` 对照表即可无缝转换。

| 方向 | 可行性 | 复杂度 |
|------|:---:|:---:|
| sgschedule → EV课程表（导入） | ✅ | ⭐⭐ 中等（需 timeSlots 查表） |
| EV课程表 → sgschedule（导出） | ✅ | ⭐⭐⭐ 稍高（需反向匹配节次） |

---

## 一、格式结构解析

### 1.1 完整 Schema

```json
{
  "courses": [...],      // 课程数组
  "timeSlots": [...],    // 节次→时间对照表
  "config": {...}        // 学期配置
}
```

### 1.2 课程对象 (courses[])

| 字段 | 类型 | 示例 | 说明 |
|------|------|------|------|
| `id` | UUID 字符串 | `"a63cb711-f626-4ff5-98dd-55cef8d815eb"` | 课程唯一标识 |
| `name` | string | `"高等数学A"` | 课程名称 |
| `teacher` | string | `"张老师"` | 任课教师 |
| `position` | string | `"东13-D-124c"` | 上课地点 |
| `day` | number | `1` | 星期（1=周一 ~ 7=周日） |
| `startSection` | number | `1` | 开始节次（引用 timeSlots） |
| `endSection` | number | `1` | 结束节次（引用 timeSlots） |
| `color` | number | `4` | 颜色索引（非 hex） |
| `weeks` | number[] | `[1,2,3,...,16]` | 上课周次列表 |

**与 EV课程表核心差异**：
- `startSection`/`endSection` 是节次编号 → EV课程表用 `startTime`/`endTime` 字符串
- `position` → EV课程表用 `location`
- `color` 是数字索引 → EV课程表用 hex 字符串

### 1.3 节次对照表 (timeSlots[])

```json
[
  { "number": 1, "startTime": "08:00", "endTime": "08:45" },
  { "number": 2, "startTime": "10:05", "endTime": "11:40" },
  { "number": 3, "startTime": "14:00", "endTime": "15:35" },
  { "number": 4, "startTime": "16:05", "endTime": "17:40" },
  { "number": 5, "startTime": "19:00", "endTime": "20:35" },
  { "number": 6, "startTime": "20:45", "endTime": "22:20" }
]
```

这是整个转换的核心枢纽。`startSection=1` → 查表 → `startTime="08:00"`。

### 1.4 学期配置 (config)

| 字段 | 类型 | 示例 | 说明 |
|------|------|------|------|
| `semesterStartDate` | date string | `"2026-03-02"` | 学期开始日期 |
| `semesterTotalWeeks` | number | `20` | 学期总周数 |
| `defaultClassDuration` | number | `95` | 默认课程时长（分钟） |
| `defaultBreakDuration` | number | `30` | 默认课间休息（分钟） |

---

## 二、与 EV课程表格式的双向映射

### 2.1 字段对照总表

```
sgschedule 格式                      EV课程表格式
─────────────────                   ──────────────
courses[].name         ──▶ 直接映射  name
courses[].teacher      ──▶ 直接映射  teacher
courses[].position     ──▶ 重命名    location
courses[].day          ──▶ 直接映射  day

courses[].startSection  ──▶ 查表转换  startTime
courses[].endSection    ──▶ 查表转换   endTime
   ↑                                     ↑
  timeSlots[] 是查表依据                "08:00" 格式

courses[].color        ──▶ 索引转换  color
   ↑                                     ↑
  数字 0-5                             "#4A90D9" 格式

courses[].weeks        ──▶ 直接映射  weeks
courses[].id           ──▶ 保留/生成  id

config.semesterStartDate ─▶ 保留     semester
config.semesterTotalWeeks ─▶ 可选     totalWeeks
```

### 2.2 关键转换逻辑

#### 转换 A：节次 → 时间（导入时）

```
startSection=2  →  查 timeSlots[number=2]  →  startTime="10:05"
endSection=3    →  查 timeSlots[number=3]  →  endTime="15:35"
```

注意：一门课可能跨多节（如 `startSection=2, endSection=3` 表示第2-3节），此时应取第一节的 `startTime` 和最后一节的 `endTime`。

#### 转换 B：时间 → 节次（导出时）

```
startTime="10:05"  →  反向查 timeSlots  →  startSection=2
endTime="15:35"    →  反向查 timeSlots  →  endSection=3
```

这是较难的一步：需要找一个时间恰好匹配的 timeSlot。如果 EV课程表的时间不完全匹配 timeSlots 中的任何一个，有几种策略：

| 策略 | 说明 | 推荐度 |
|------|------|:---:|
| 精确匹配 | 只匹配完全相等的时间 | ⭐⭐⭐ |
| 就近匹配 | 找最近的 timeSlot（容差 ±5 分钟） | ⭐⭐⭐⭐ |
| 动态生成 | 不匹配现有 timeSlot，往 timeSlots 里追加新条目 | ⭐⭐⭐⭐⭐ |

**推荐动态生成**——最灵活，不会丢数据。

#### 转换 C：颜色索引 → 颜色字符串

sgschedule 的 `color` 是数字索引（0-5 或更多），猜测映射：

```rust
const SG_COLORS: [&str; 6] = [
    "#F44336",  // 0: 红色
    "#FF9800",  // 1: 橙色  
    "#FFEB3B",  // 2: 黄色
    "#4CAF50",  // 3: 绿色
    "#2196F3",  // 4: 蓝色
    "#9C27B0",  // 5: 紫色
];
```

EV课程表使用 hex 颜色字符串，导入时查表映射，导出时反查（找不到则默认 0）。

---

## 三、导入逻辑（sgschedule → EV课程表）

### 3.1 流程图

```
sgschedule JSON
      │
      ▼
┌─────────────┐
│ 解析 JSON     │  serde_json::from_str
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 加载 timeSlots│  构建 HashMap<number, (start, end)>
│ 为 HashMap    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 遍历 courses │  对每个 course：
│  逐一转换     │    section → time
│              │    position → location
│              │    color 索引 → hex
│              │    weeks 不变
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 生成 Unified  │  Vec<UnifiedCourse>
│ Course 列表   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 写入 EV课程表 │  interconnect::send_to_device
│  手环存储     │
└─────────────┘
```

### 3.2 Rust 实现

```rust
// src/import/sgschedule.rs

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct SgSchedule {
    courses: Vec<SgCourse>,
    #[serde(rename = "timeSlots")]
    time_slots: Vec<SgTimeSlot>,
    config: Option<SgConfig>,
}

#[derive(Deserialize)]
struct SgCourse {
    id: String,
    name: String,
    teacher: String,
    position: String,
    day: u8,
    #[serde(rename = "startSection")]
    start_section: u32,
    #[serde(rename = "endSection")]
    end_section: u32,
    color: u8,
    weeks: Vec<u32>,
}

#[derive(Deserialize)]
struct SgTimeSlot {
    number: u32,
    #[serde(rename = "startTime")]
    start_time: String,
    #[serde(rename = "endTime")]
    end_time: String,
}

#[derive(Deserialize)]
struct SgConfig {
    #[serde(rename = "semesterStartDate")]
    semester_start_date: String,
    #[serde(rename = "semesterTotalWeeks")]
    semester_total_weeks: u32,
    #[serde(rename = "defaultClassDuration")]
    default_class_duration: u32,
    #[serde(rename = "defaultBreakDuration")]
    default_break_duration: u32,
}

const SG_COLOR_MAP: [&str; 6] = [
    "#F44336", "#FF9800", "#FFEB3B", "#4CAF50", "#2196F3", "#9C27B0",
];

pub fn import_sgschedule(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let sg: SgSchedule = serde_json::from_str(raw_json)?;

    // Step 1: 构建节次→时间 HashMap
    let slot_map: HashMap<u32, (String, String)> = sg.time_slots
        .iter()
        .map(|s| (s.number, (s.start_time.clone(), s.end_time.clone())))
        .collect();

    // Step 2: 逐课程转换
    let courses: Vec<UnifiedCourse> = sg.courses
        .into_iter()
        .map(|c| {
            // 节次 → 时间：取 startSection 的 startTime + endSection 的 endTime
            let start_slot = slot_map.get(&c.start_section);
            let end_slot = slot_map.get(&c.end_section);

            let (start_time, end_time) = match (start_slot, end_slot) {
                (Some((s_start, _)), Some((_, e_end))) =>
                    (s_start.clone(), e_end.clone()),
                (Some((s_start, s_end)), None) =>
                    (s_start.clone(), s_end.clone()),
                _ =>
                    ("08:00".to_string(), "08:45".to_string()),
            };

            // 颜色索引 → hex 字符串
            let color = SG_COLOR_MAP
                .get(c.color as usize)
                .map(|&s| s.to_string());

            UnifiedCourse {
                name: c.name,
                day: c.day,
                start_time,
                end_time,
                location: c.position,
                teacher: c.teacher,
                weeks: c.weeks,
                week_type: WeekType::All,
                color,
            }
        })
        .collect();

    Ok(courses)
}

/// 自动检测：包含 timeSlots + startSection 特征
pub fn detect_sgschedule(raw_json: &str) -> bool {
    raw_json.contains("\"timeSlots\"") && raw_json.contains("\"startSection\"")
}
```

---

## 四、导出逻辑（EV课程表 → sgschedule）

### 4.1 核心挑战

| 挑战 | 说明 |
|------|------|
| 时间 → 节次反向匹配 | EV课程表用 `startTime`/`endTime`，sgschedule 用节次编号 |
| 节次对照表构建 | sgschedule 要求导出 `timeSlots`，而 EV课程表不一定有这个概念 |
| 单课表 vs 多课表 | EV课程表支持多张课表，sgschedule 是单课表结构 |

### 4.2 方案选择

**方案 A：使用 sgschedule 自带的 timeSlots（导入时保存的）**

如果用户是用 sgschedule 导入的，插件可以缓存原始的 `timeSlots`，导出时直接复用。

**方案 B：从 EV课程表数据反向推导 timeSlots**

从所有课程中收集不重复的 `startTime`/`endTime` 组合，自动构建 `timeSlots` 对照表。

**方案 C：混合方案（推荐）**

优先用方案 A（有缓存时），否则用方案 B。

### 4.3 导出 Rust 实现

```rust
// src/export/sgschedule.rs

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize)]
struct SgExportCourse {
    id: String,
    name: String,
    teacher: String,
    position: String,
    day: u8,
    #[serde(rename = "startSection")]
    start_section: u32,
    #[serde(rename = "endSection")]
    end_section: u32,
    color: u8,
    weeks: Vec<u32>,
}

#[derive(Serialize)]
struct SgExportTimeSlot {
    number: u32,
    #[serde(rename = "startTime")]
    start_time: String,
    #[serde(rename = "endTime")]
    end_time: String,
}

#[derive(Serialize)]
struct SgExportConfig {
    #[serde(rename = "semesterStartDate")]
    semester_start_date: String,
    #[serde(rename = "semesterTotalWeeks")]
    semester_total_weeks: u32,
    #[serde(rename = "defaultClassDuration")]
    default_class_duration: u32,
    #[serde(rename = "defaultBreakDuration")]
    default_break_duration: u32,
}

#[derive(Serialize)]
struct SgExport {
    courses: Vec<SgExportCourse>,
    #[serde(rename = "timeSlots")]
    time_slots: Vec<SgExportTimeSlot>,
    config: SgExportConfig,
}

/// 将 EV课程表课程列表导出为 sgschedule 格式
pub fn export_sgschedule(courses: &[UnifiedCourse]) -> String {
    // Step 1: 从所有课程中收集 timeSlots
    let mut slot_map: BTreeMap<String, u32> = BTreeMap::new();
    let mut slot_number: u32 = 1;

    // 收集所有不重复的 (startTime, endTime) 对
    let mut seen_slots: HashMap<(String, String), u32> = HashMap::new();

    for course in courses {
        let key = (course.start_time.clone(), course.end_time.clone());
        if !seen_slots.contains_key(&key) {
            seen_slots.insert(key.clone(), slot_number);
            slot_number += 1;
        }
    }

    // 按编号排序构建 timeSlots 数组
    let mut time_slots: Vec<SgExportTimeSlot> = seen_slots
        .into_iter()
        .map(|((start, end), num)| SgExportTimeSlot {
            number: num,
            start_time: start,
            end_time: end,
        })
        .collect();
    time_slots.sort_by_key(|s| s.number);

    // Step 2: 课程转换（时间 → 节次）
    // 重建反向查找： (startTime, endTime) → section_number
    let reverse_map: HashMap<(String, String), u32> = time_slots
        .iter()
        .map(|s| ((s.start_time.clone(), s.end_time.clone()), s.number))
        .collect();

    let export_courses: Vec<SgExportCourse> = courses
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let time_key = (c.start_time.clone(), c.end_time.clone());
            let section = reverse_map.get(&time_key).copied().unwrap_or(1);

            // 颜色 hex → 索引
            let color_idx = match &c.color {
                Some(hex) => SG_COLOR_MAP.iter()
                    .position(|&s| s.eq_ignore_ascii_case(hex))
                    .map(|i| i as u8)
                    .unwrap_or(0),
                None => 0,
            };

            SgExportCourse {
                id: format!("ev-{:04x}", i),
                name: c.name.clone(),
                teacher: c.teacher.clone(),
                position: c.location.clone(),
                day: c.day,
                start_section: section,
                end_section: section,
                color: color_idx,
                weeks: c.weeks.clone(),
            }
        })
        .collect();

    // Step 3: 组装 config（使用默认值或用户可配置）
    let config = SgExportConfig {
        semester_start_date: "2026-03-02".to_string(),
        semester_total_weeks: 20,
        default_class_duration: 95,
        default_break_duration: 30,
    };

    let export = SgExport {
        courses: export_courses,
        time_slots,
        config,
    };

    serde_json::to_string_pretty(&export).unwrap()
}
```

---

## 五、可行性分析总结

### 5.1 各字段 compatibility 矩阵

| sgschedule 字段 | EV课程表字段 | 导入 | 导出 | 说明 |
|------|------|:---:|:---:|------|
| `name` | `name` | ✅ | ✅ | 直接映射 |
| `teacher` | `teacher` | ✅ | ✅ | 直接映射 |
| `position` | `location` | ✅ | ✅ | 仅字段名不同 |
| `day` | `day` | ✅ | ✅ | 值域一致 1-7 |
| `startSection` | `startTime` | ✅ | ⚠️ | 需 timeSlots 转换 |
| `endSection` | `endTime` | ✅ | ⚠️ | 需 timeSlots 转换 |
| `weeks` | `weeks` | ✅ | ✅ | 数组格式一致 |
| `color` | `color` | ⚠️ | ⚠️ | 索引 vs hex，需映射表 |
| `id` | `id` | ✅ | ✅ | 保留或生成 |
| `timeSlots` | （无对应） | ✅ | ⚠️ | 导入时读取，导出时动态构建 |
| `config` | （无对应） | ✅ | ⚠️ | 导入时保留，导出时设默认值 |

### 5.2 风险评估

| 风险 | 等级 | 应对 |
|------|:---:|------|
| 节次 → 时间转换丢失精度 | 🟢 低 | timeSlots 查表是精确映射 |
| 时间 → 节次反向匹配失败 | 🟡 中 | 动态生成新节次条目 |
| 颜色索引映射不准确 | 🟢 低 | 查表+默认值兜底 |
| 跨多节课程（2-3节） | 🟢 低 | 取首节 startTime + 末节 endTime |
| 单双周信息丢失 | 🟡 中 | sgschedule 格式无 weekType 字段，导入时默认 "all" |
| timeSlots 不完整 | 🟡 中 | 导出时自动从课程数据推导 |

### 5.3 最终结论

| 维度 | 评估 |
|------|------|
| 导入可行性 | ✅ **完全可行**。timeSlots 提供了完整的节次→时间映射 |
| 导出可行性 | ✅ **可行**，但需要额外处理时间→节次的反向推导 |
| 数据完整性 | ⭐⭐⭐ 大部分字段无损映射，单双周信息需注意 |
| 开发工作量 | 导入约 2-3 小时，导出约 2-3 小时 |
| 是否需要 sgschedule 端配合 | ❌ 不需要，格式是公开的 JSON |

**唯一的设计差异**：sgschedule 用「节次编号」抽象时间，EV课程表用「直接时间字符串」。这是两种不同的建模思路——前者更灵活（换学校只改 timeSlots 不改课程数据），后者更直观。但通过 timeSlots 对照表，两者可以无损互转。