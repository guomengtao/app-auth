use serde::Serialize;
use std::collections::HashMap;
use crate::models::{
    UnifiedCourse, UnifiedSchedule, UnifiedExport,
    color_hex_to_index,
};

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

pub fn export_as_evschedule(
    schedule: &UnifiedSchedule,
) -> String {
    let export = UnifiedExport::new(
        "EV Schedule Sync",
        vec![schedule.clone()],
    );

    serde_json::to_string_pretty(&export).unwrap_or_else(|_| "{}".to_string())
}

pub fn export_as_sgschedule(
    courses: &[UnifiedCourse],
    semester_start_date: &str,
    total_weeks: u32,
) -> String {
    let mut seen_slots: HashMap<(String, String), u32> = HashMap::new();
    let mut slot_number: u32 = 1;

    for course in courses {
        let key = (course.start_time.clone(), course.end_time.clone());
        if !seen_slots.contains_key(&key) {
            seen_slots.insert(key, slot_number);
            slot_number += 1;
        }
    }

    let mut time_slots: Vec<SgExportTimeSlot> = seen_slots
        .iter()
        .map(|((start, end), num)| SgExportTimeSlot {
            number: *num,
            start_time: start.clone(),
            end_time: end.clone(),
        })
        .collect();
    time_slots.sort_by_key(|s| s.number);

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
            let color_idx = c.color.as_deref()
                .map(|hex| color_hex_to_index(hex))
                .unwrap_or(0);

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

    let config = SgExportConfig {
        semester_start_date: semester_start_date.to_string(),
        semester_total_weeks: total_weeks,
        default_class_duration: 95,
        default_break_duration: 30,
    };

    let export = SgExport {
        courses: export_courses,
        time_slots,
        config,
    };

    serde_json::to_string_pretty(&export).unwrap_or_else(|_| "{}".to_string())
}