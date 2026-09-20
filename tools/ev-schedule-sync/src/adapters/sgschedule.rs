use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;
use crate::models::{UnifiedCourse, WeekType, color_index_to_hex};

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

pub fn detect(raw_json: &str) -> bool {
    raw_json.contains("\"timeSlots\"") && raw_json.contains("\"startSection\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let sg: SgSchedule = serde_json::from_str(raw_json)?;

    let slot_map: HashMap<u32, (String, String)> = sg.time_slots
        .iter()
        .map(|s| (s.number, (s.start_time.clone(), s.end_time.clone())))
        .collect();

    let courses: Vec<UnifiedCourse> = sg.courses
        .into_iter()
        .map(|c| {
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

            let color = color_index_to_hex(c.color);

            UnifiedCourse {
                id: c.id,
                name: c.name,
                teacher: c.teacher,
                location: c.position,
                day: c.day,
                start_time,
                end_time,
                weeks: c.weeks,
                week_type: WeekType::All,
                color,
                credit: None,
                remark: None,
            }
        })
        .collect();

    Ok(courses)
}