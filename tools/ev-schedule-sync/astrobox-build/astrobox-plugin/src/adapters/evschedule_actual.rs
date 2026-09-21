use anyhow::Result;
use serde::Deserialize;
use crate::models::{UnifiedCourse, WeekType};

#[derive(Deserialize)]
struct EvDayEntry {
    day: String,
    classes: Vec<EvClassEntry>,
}

#[derive(Deserialize)]
struct EvClassEntry {
    id: Option<String>,
    name: String,
    time: String,
    teacher: Option<String>,
    location: Option<String>,
    notes: Option<String>,
}

fn day_name_to_number(day: &str) -> u8 {
    match day {
        "星期一" => 1,
        "星期二" => 2,
        "星期三" => 3,
        "星期四" => 4,
        "星期五" => 5,
        "星期六" => 6,
        "星期日" => 7,
        _ => 1,
    }
}

fn split_time_range(time: &str) -> Result<(String, String)> {
    let parts: Vec<&str> = time.split(" - ").collect();
    anyhow::ensure!(
        parts.len() == 2,
        "Invalid time format: '{}'. Expected 'HH:MM - HH:MM'",
        time
    );
    Ok((parts[0].trim().to_string(), parts[1].trim().to_string()))
}

pub fn detect(raw_json: &str) -> bool {
    let trimmed = raw_json.trim();
    if !trimmed.starts_with('[') {
        return false;
    }
    trimmed.contains("\"day\"") && trimmed.contains("\"classes\"")
}

pub fn parse(raw_json: &str) -> Result<Vec<UnifiedCourse>> {
    let entries: Vec<EvDayEntry> = serde_json::from_str(raw_json)?;

    let mut courses = Vec::new();
    for day_entry in entries {
        let day_num = day_name_to_number(&day_entry.day);
        for class in day_entry.classes {
            let (start_time, end_time) = split_time_range(&class.time)?;
            courses.push(UnifiedCourse {
                id: class.id.unwrap_or_else(|| "0".to_string()),
                name: class.name,
                teacher: class.teacher.unwrap_or_default(),
                location: class.location.unwrap_or_default(),
                day: day_num,
                start_time,
                end_time,
                weeks: Vec::new(),
                week_type: WeekType::All,
                color: None,
                credit: None,
                remark: class.notes,
            });
        }
    }

    Ok(courses)
}