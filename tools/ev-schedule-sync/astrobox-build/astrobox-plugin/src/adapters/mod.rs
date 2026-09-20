use anyhow::Result;
use crate::models::UnifiedCourse;

pub mod sgschedule;
pub mod wakeup;
pub mod starlink;
pub mod cses;
pub mod evschedule;

#[derive(Debug, Clone, PartialEq)]
pub enum FormatType {
    SgSchedule,
    WakeUp,
    Starlink,
    Cses,
    EvSchedule,
}

impl FormatType {
    pub fn display_name(&self) -> &str {
        match self {
            FormatType::SgSchedule => "sgschedule (ShiGuang Schedule)",
            FormatType::WakeUp => "WakeUp Schedule",
            FormatType::Starlink => "StarLink Schedule",
            FormatType::Cses => "CSES Standard",
            FormatType::EvSchedule => "EV Schedule",
        }
    }
}

pub fn detect_format(raw_json: &str) -> Option<FormatType> {
    if sgschedule::detect(raw_json) {
        return Some(FormatType::SgSchedule);
    }
    if wakeup::detect(raw_json) {
        return Some(FormatType::WakeUp);
    }
    if starlink::detect(raw_json) {
        return Some(FormatType::Starlink);
    }
    if cses::detect(raw_json) {
        return Some(FormatType::Cses);
    }
    if evschedule::detect(raw_json) {
        return Some(FormatType::EvSchedule);
    }
    None
}

pub fn parse_by_format(raw_json: &str, format: &FormatType) -> Result<Vec<UnifiedCourse>> {
    match format {
        FormatType::SgSchedule => sgschedule::parse(raw_json),
        FormatType::WakeUp => wakeup::parse(raw_json),
        FormatType::Starlink => starlink::parse(raw_json),
        FormatType::Cses => cses::parse(raw_json),
        FormatType::EvSchedule => evschedule::parse(raw_json),
    }
}

pub fn auto_parse(raw_json: &str) -> Result<(FormatType, Vec<UnifiedCourse>)> {
    let format = detect_format(raw_json)
        .ok_or_else(|| anyhow::anyhow!("Unsupported schedule format. Unable to auto-detect."))?;
    let courses = parse_by_format(raw_json, &format)?;
    Ok((format, courses))
}