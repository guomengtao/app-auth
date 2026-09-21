use anyhow::Result;
use serde::Deserialize;
use crate::models::{UnifiedCourse, WeekType};

#[derive(Deserialize)]
struct EvScheduleExport {
    version: Option<String>,
    #[serde(rename = "exportTime")]
    export_time: Option<u64>,
    #[serde(rename = "appName")]
    app_name: Option<String>,
    schedules: Vec<EvSchedule>,
}

#[derive(Deserialize)]
struct EvSchedule {
    id: Option<String>,
    name: Option<String>,
    courses: Vec<EvCourse>,
}

#[derive(Deserialize)]
struct EvCourse {
    id: Option<String>,
    name: String,
    day: u8,
    #[serde(rename = "startTime")]
    start_time: String,
    #[serde(rename = "endTime")]
    end_time: String,
    location: String,
    teacher: String,
    weeks: Vec<u32>,
    #[serde(rename = "weekType")]
    week_type: Option<String>,
    color: Option<String>,
}

pub fn detect(raw_json: &str) -> bool {
    let lower = raw_json.to_lowercase();
    raw_json.contains("\"appName\"")
        && lower.contains("ev")
        && raw_json.contains("\"schedules\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let export: EvScheduleExport = serde_json::from_str(raw_json)?;

    let courses: Vec<UnifiedCourse> = export.schedules
        .into_iter()
        .flat_map(|s| s.courses.into_iter())
        .map(|c| {
            let week_type = match c.week_type.as_deref() {
                Some("odd") => WeekType::Odd,
                Some("even") => WeekType::Even,
                _ => WeekType::All,
            };

            UnifiedCourse {
                id: c.id.unwrap_or_else(|| crate::models::generate_id()),
                name: c.name,
                teacher: c.teacher,
                location: c.location,
                day: c.day,
                start_time: c.start_time,
                end_time: c.end_time,
                weeks: c.weeks,
                week_type,
                color: c.color,
                credit: None,
                remark: None,
            }
        })
        .collect();

    Ok(courses)
}