use anyhow::Result;
use crate::adapters::{self, FormatType};
use crate::models::{UnifiedCourse, SchoolConfig};

#[derive(Debug, Clone)]
pub struct ImportResult {
    pub format: FormatType,
    pub schedule_name: String,
    pub courses: Vec<UnifiedCourse>,
    pub total_count: usize,
}

pub fn import_from_json(raw_json: &str, schedule_name: &str) -> Result<ImportResult> {
    let (format, courses) = adapters::auto_parse(raw_json)?;

    let total_count = courses.len();

    if total_count == 0 {
        anyhow::bail!("No courses found in the imported data.");
    }

    Ok(ImportResult {
        format,
        schedule_name: schedule_name.to_string(),
        courses,
        total_count,
    })
}

pub fn import_with_format(
    raw_json: &str,
    format: &FormatType,
    schedule_name: &str,
) -> Result<ImportResult> {
    let courses = adapters::parse_by_format(raw_json, format)?;
    let total_count = courses.len();

    if total_count == 0 {
        anyhow::bail!("No courses found in the imported data.");
    }

    Ok(ImportResult {
        format: format.clone(),
        schedule_name: schedule_name.to_string(),
        courses,
        total_count,
    })
}

pub fn merge_courses(
    existing: &[UnifiedCourse],
    imported: &[UnifiedCourse],
) -> Vec<UnifiedCourse> {
    let mut merged = existing.to_vec();

    for course in imported {
        let is_duplicate = merged.iter().any(|existing_course| {
            existing_course.name == course.name
                && existing_course.day == course.day
                && existing_course.start_time == course.start_time
                && existing_course.end_time == course.end_time
        });

        if !is_duplicate {
            merged.push(course.clone());
        }
    }

    merged
}

pub fn import_from_academic_system(
    _config: &SchoolConfig,
    _username: &str,
    _password: &str,
) -> Result<Vec<UnifiedCourse>> {
    anyhow::bail!(
        "Academic system import requires the AstroBox Host Transport API. \
         This feature is available when running inside the AstroBox runtime."
    )
}

#[cfg(feature = "astrobox-host")]
pub mod host_import {
    use super::*;

    pub async fn import_from_academic_system_host(
        config: &SchoolConfig,
        username: &str,
        password: &str,
    ) -> Result<Vec<UnifiedCourse>> {
        todo!("Implement when psys-host::transport bindings are available")
    }
}