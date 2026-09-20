use anyhow::Result;
use serde::Deserialize;
use crate::models::{UnifiedCourse, WeekType, weeks_from_range, parse_week_range};

#[derive(Deserialize)]
struct StarlinkSchedule {
    semester: Option<String>,
    subjects: Vec<StarlinkSubject>,
}

#[derive(Deserialize)]
struct StarlinkSubject {
    #[serde(rename = "subjectName")]
    subject_name: String,
    weekday: u8,
    #[serde(rename = "beginTime")]
    begin_time: String,
    #[serde(rename = "finishTime")]
    finish_time: String,
    place: String,
    instructor: String,
    #[serde(rename = "weekRange")]
    week_range: String,
    #[serde(rename = "oddEven")]
    odd_even: Option<u8>,
    color: Option<String>,
    #[serde(alias = "credit")]
    credit: Option<f32>,
}

pub fn detect(raw_json: &str) -> bool {
    raw_json.contains("\"subjectName\"") && raw_json.contains("\"weekRange\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let schedule: StarlinkSchedule = serde_json::from_str(raw_json)?;

    let courses: Vec<UnifiedCourse> = schedule.subjects
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let weeks = parse_week_range(&c.week_range)
                .map(|(start, end)| weeks_from_range(start, end))
                .unwrap_or_default();

            let week_type = match c.odd_even.unwrap_or(0) {
                1 => WeekType::Odd,
                2 => WeekType::Even,
                _ => WeekType::All,
            };

            UnifiedCourse {
                id: format!("sl-{:04x}", i),
                name: c.subject_name,
                teacher: c.instructor,
                location: c.place,
                day: c.weekday,
                start_time: c.begin_time,
                end_time: c.finish_time,
                weeks,
                week_type,
                color: c.color,
                credit: c.credit,
                remark: None,
            }
        })
        .collect();

    Ok(courses)
}