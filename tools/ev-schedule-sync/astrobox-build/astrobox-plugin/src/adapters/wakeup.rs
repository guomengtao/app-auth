use anyhow::Result;
use serde::Deserialize;
use crate::models::{UnifiedCourse, WeekType};

#[derive(Deserialize)]
struct WakeUpSchedule {
    #[serde(rename = "scheduleName")]
    schedule_name: Option<String>,
    #[serde(rename = "courseList")]
    course_list: Vec<WakeUpCourse>,
}

#[derive(Deserialize)]
struct WakeUpCourse {
    name: String,
    day: u8,
    start: String,
    end: String,
    room: String,
    teacher: String,
    weeks: Vec<u32>,
    #[serde(rename = "type")]
    course_type: Option<String>,
    color: Option<String>,
}

pub fn detect(raw_json: &str) -> bool {
    raw_json.contains("\"courseList\"") && raw_json.contains("\"scheduleName\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let schedule: WakeUpSchedule = serde_json::from_str(raw_json)?;

    let courses: Vec<UnifiedCourse> = schedule.course_list
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let week_type = match c.course_type.as_deref() {
                Some("every") | None => WeekType::All,
                Some("odd") => WeekType::Odd,
                Some("even") => WeekType::Even,
                Some(other) => match other {
                    "all" => WeekType::All,
                    _ => WeekType::All,
                },
            };

            UnifiedCourse {
                id: format!("wu-{:04x}", i),
                name: c.name,
                teacher: c.teacher,
                location: c.room,
                day: c.day,
                start_time: c.start,
                end_time: c.end,
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