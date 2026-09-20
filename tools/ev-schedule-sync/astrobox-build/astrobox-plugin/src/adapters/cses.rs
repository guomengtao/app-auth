use anyhow::Result;
use serde::Deserialize;
use crate::models::{UnifiedCourse, WeekType};

#[derive(Deserialize)]
struct CsesDocument {
    #[serde(rename = "cses_version")]
    cses_version: String,
    #[serde(rename = "export_time")]
    export_time: Option<String>,
    #[serde(rename = "source_app")]
    source_app: Option<String>,
    schedules: Vec<CsesSchedule>,
}

#[derive(Deserialize)]
struct CsesSchedule {
    #[serde(rename = "schedule_id")]
    schedule_id: Option<String>,
    #[serde(rename = "schedule_name")]
    schedule_name: Option<String>,
    courses: Vec<CsesCourse>,
}

#[derive(Deserialize)]
struct CsesCourse {
    #[serde(rename = "course_id")]
    course_id: Option<String>,
    name: String,
    #[serde(rename = "day_of_week")]
    day_of_week: u8,
    #[serde(rename = "start_time")]
    start_time: String,
    #[serde(rename = "end_time")]
    end_time: String,
    location: String,
    teacher: String,
    weeks: Vec<u32>,
    #[serde(rename = "week_type")]
    week_type: Option<String>,
    credits: Option<f32>,
    color: Option<String>,
    #[serde(rename = "extensions")]
    extensions: Option<serde_json::Value>,
}

pub fn detect(raw_json: &str) -> bool {
    raw_json.contains("\"cses_version\"") && raw_json.contains("\"day_of_week\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let doc: CsesDocument = serde_json::from_str(raw_json)?;

    let courses: Vec<UnifiedCourse> = doc.schedules
        .into_iter()
        .flat_map(|s| s.courses.into_iter().map(move |c| (c, s.schedule_id.clone())))
        .map(|(c, _schedule_id)| {
            let week_type = match c.week_type.as_deref() {
                Some("odd") => WeekType::Odd,
                Some("even") => WeekType::Even,
                _ => WeekType::All,
            };

            UnifiedCourse {
                id: c.course_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                name: c.name,
                teacher: c.teacher,
                location: c.location,
                day: c.day_of_week,
                start_time: c.start_time,
                end_time: c.end_time,
                weeks: c.weeks,
                week_type,
                color: c.color,
                credit: c.credits,
                remark: c.extensions
                    .and_then(|v| v.get("remark").cloned())
                    .and_then(|v| v.as_str().map(String::from)),
            }
        })
        .collect();

    Ok(courses)
}