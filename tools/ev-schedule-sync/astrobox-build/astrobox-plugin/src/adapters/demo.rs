// Demo JSON 适配器 —— 解析 AI 生成的「便捷导入」格式
//
// 对应 DESIGN.md §3：用户复制带注释的 Demo JSON → 发给 AI 编辑 → 粘贴回来导入。
// 与 evschedule.rs（导出格式）不同，本格式面向「手写/AI 生成」，因此校验更严格，
// 错误信息要能精确定位到字段，方便用户（或 AI）修正后重贴。

use anyhow::{Context, Result};
use serde::Deserialize;
use crate::models::{generate_id, UnifiedCourse, WeekType};

#[derive(Debug, Deserialize)]
struct DemoRoot {
    #[serde(rename = "scheduleName")]
    schedule_name: Option<String>,
    courses: Option<Vec<DemoCourse>>,
}

#[derive(Debug, Deserialize)]
struct DemoCourse {
    name: Option<String>,
    teacher: Option<String>,
    location: Option<String>,
    day: Option<serde_json::Value>,
    #[serde(rename = "startTime")]
    start_time: Option<String>,
    #[serde(rename = "endTime")]
    end_time: Option<String>,
    weeks: Option<Vec<serde_json::Value>>,
    #[serde(rename = "weekType")]
    week_type: Option<String>,
    color: Option<String>,
    credit: Option<serde_json::Value>,
    remark: Option<String>,
}

/// 必须的键名是否存在（用于 detect，容忍任意额外字段）
pub fn detect(raw_json: &str) -> bool {
    let trimmed = raw_json.trim();
    trimmed.starts_with('{')
        && trimmed.contains("scheduleName")
        && trimmed.contains("courses")
}

/// 取出 Demo JSON 里声明的课程表名称（导入页用它回填「目标课程表名称」）
pub fn extract_schedule_name(raw_json: &str) -> Option<String> {
    let root: DemoRoot = serde_json::from_str(raw_json).ok()?;
    root.schedule_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 按 DESIGN.md §3.5 逐条校验，任一失败返回带字段名的中文错误
pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let root: DemoRoot = serde_json::from_str(raw_json)
        .context("JSON 格式错误，无法解析（请检查是否误加markdown代码块或多余文字）")?;

    let schedule_name = root.schedule_name.clone().unwrap_or_default();
    if schedule_name.trim().is_empty() {
        anyhow::bail!("缺少字段 scheduleName：课程表名称不能为空");
    }
    if schedule_name.chars().count() > 50 {
        anyhow::bail!("scheduleName 超过 50 个字符（当前 {} 个）", schedule_name.chars().count());
    }

    let demo_courses = root
        .courses
        .ok_or_else(|| anyhow::anyhow!("缺少字段 courses：课程数组不能为空"))?;

    if demo_courses.is_empty() {
        anyhow::bail!("courses 数组为空：至少需要 1 门课程");
    }

    let mut courses = Vec::with_capacity(demo_courses.len());

    for (i, c) in demo_courses.into_iter().enumerate() {
        let idx = i + 1;
        let label = c
            .name
            .clone()
            .unwrap_or_else(|| format!("第 {} 门课", idx));

        // ── 必填字符串字段 ──
        let name = require_text(c.name, "name", &label, 50)?;
        let teacher = require_text(c.teacher, "teacher", &label, 30)?;
        let location = require_text(c.location, "location", &label, 50)?;

        // ── startTime / endTime：HH:MM 且 start < end ──
        let start_time = c
            .start_time
            .ok_or_else(|| anyhow::anyhow!("课程「{}」缺少字段 startTime", label))?;
        let end_time = c
            .end_time
            .ok_or_else(|| anyhow::anyhow!("课程「{}」缺少字段 endTime", label))?;
        check_time_format(&start_time)
            .with_context(|| format!("课程「{}」的 startTime 格式错误", label))?;
        check_time_format(&end_time)
            .with_context(|| format!("课程「{}」的 endTime 格式错误", label))?;
        if time_to_minutes(&start_time) >= time_to_minutes(&end_time) {
            anyhow::bail!(
                "课程「{}」的时间无效：startTime({}) 必须早于 endTime({})",
                label,
                start_time,
                end_time
            );
        }

        // ── day：1-7 ──
        let day = parse_day(c.day).with_context(|| format!("课程「{}」的 day 取值错误", label))?;

        // ── weeks：非空整数数组 ──
        let weeks = parse_weeks(c.weeks)
            .with_context(|| format!("课程「{}」的 weeks 取值错误", label))?;

        // ── weekType：all / odd / even ──
        let week_type = match c.week_type.as_deref().unwrap_or("all") {
            "all" => WeekType::All,
            "odd" => WeekType::Odd,
            "even" => WeekType::Even,
            other => anyhow::bail!(
                "课程「{}」的 weekType 无效：{}（只能是 all / odd / even）",
                label,
                other
            ),
        };

        // ── 可选字段 ──
        if let Some(ref color) = c.color {
            check_hex_color(color)
                .with_context(|| format!("课程「{}」的 color 格式错误", label))?;
        }
        let credit = match c.credit {
            None => None,
            Some(v) => Some(v.as_f64().ok_or_else(|| {
                anyhow::anyhow!("课程「{}」的 credit 必须是数字", label)
            })? as f32),
        };
        if let Some(ref remark) = c.remark {
            if remark.chars().count() > 200 {
                anyhow::bail!("课程「{}」的 remark 超过 200 个字符", label);
            }
        }

        courses.push(UnifiedCourse {
            id: generate_id(),
            name,
            teacher,
            location,
            day,
            start_time,
            end_time,
            weeks,
            week_type,
            color: c.color,
            credit,
            remark: c.remark,
        });
    }

    Ok(courses)
}

// ────────────────────────── 内部工具 ──────────────────────────

/// 必填文本：必须存在、trim 后非空、不超过 max_len
fn require_text(
    value: Option<String>,
    field: &str,
    label: &str,
    max_len: usize,
) -> Result<String> {
    let text = value
        .ok_or_else(|| anyhow::anyhow!("课程「{}」缺少字段 {}", label, field))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        anyhow::bail!("课程「{}」的 {} 不能为空", label, field);
    }
    if trimmed.chars().count() > max_len {
        anyhow::bail!(
            "课程「{}」的 {} 超过 {} 个字符（当前 {} 个）",
            label,
            field,
            max_len,
            trimmed.chars().count()
        );
    }
    Ok(trimmed.to_string())
}

/// 严格校验 HH:MM（24 小时制）
fn check_time_format(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        anyhow::bail!("时间 \"{}\" 格式错误，必须为 HH:MM（例如 08:00）", value);
    }
    let hh: u32 = value[0..2]
        .parse()
        .map_err(|_| anyhow::anyhow!("时间 \"{}\" 的小时无效", value))?;
    let mm: u32 = value[3..5]
        .parse()
        .map_err(|_| anyhow::anyhow!("时间 \"{}\" 的分钟无效", value))?;
    if hh > 23 || mm > 59 {
        anyhow::bail!("时间 \"{}\" 超出有效范围（00:00-23:59）", value);
    }
    Ok(())
}

fn time_to_minutes(value: &str) -> u32 {
    let hh: u32 = value[0..2].parse().unwrap_or(0);
    let mm: u32 = value[3..5].parse().unwrap_or(0);
    hh * 60 + mm
}

/// day 可能是 JSON 数字（1-7），也容忍 AI 误写字符串 "1"
fn parse_day(value: Option<serde_json::Value>) -> Result<u8> {
    let raw = value.ok_or_else(|| anyhow::anyhow!("缺少字段 day"))?;
    let day = match raw {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("day 必须是整数"))?,
        serde_json::Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("day \"{}\" 不是整数", s))?,
        other => anyhow::bail!("day 的类型无效：{}", other),
    };
    if !(1..=7).contains(&day) {
        anyhow::bail!("day 必须为 1-7（1=周一，7=周日），当前值为 {}", day);
    }
    Ok(day as u8)
}

fn parse_weeks(value: Option<Vec<serde_json::Value>>) -> Result<Vec<u32>> {
    let raw = value.ok_or_else(|| anyhow::anyhow!("缺少字段 weeks"))?;
    if raw.is_empty() {
        anyhow::bail!("weeks 不能为空数组，至少要有 1 个周次");
    }
    let mut weeks = Vec::with_capacity(raw.len());
    for w in raw {
        match w {
            serde_json::Value::Number(n) => {
                let week = n
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("weeks 里的 {} 不是正整数", n))?;
                if week == 0 {
                    anyhow::bail!("weeks 里的周次必须大于 0");
                }
                weeks.push(week as u32);
            }
            serde_json::Value::String(s) => {
                let week: u32 = s
                    .trim()
                    .parse()
                    .map_err(|_| anyhow::anyhow!("weeks 里的 \"{}\" 不是正整数", s))?;
                if week == 0 {
                    anyhow::bail!("weeks 里的周次必须大于 0");
                }
                weeks.push(week);
            }
            other => anyhow::bail!("weeks 里的元素类型无效：{}", other),
        }
    }
    weeks.sort_unstable();
    weeks.dedup();
    Ok(weeks)
}

fn check_hex_color(value: &str) -> Result<()> {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("颜色 \"{}\" 格式错误，应为 #RRGGBB", value);
    }
    Ok(())
}
