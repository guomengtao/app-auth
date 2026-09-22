use anyhow::Result;
use crate::models::UnifiedCourse;

pub mod sgschedule;
pub mod wakeup;
pub mod starlink;
pub mod cses;
pub mod evschedule;
pub mod evschedule_actual;
pub mod demo;

#[derive(Debug, Clone, PartialEq)]
pub enum FormatType {
    SgSchedule,
    WakeUp,
    Starlink,
    Cses,
    EvSchedule,
    EvScheduleActual,
    DemoSchedule,
}

impl FormatType {
    pub fn display_name(&self) -> &str {
        match self {
            FormatType::SgSchedule => "sgschedule (ShiGuang Schedule)",
            FormatType::WakeUp => "WakeUp Schedule",
            FormatType::Starlink => "StarLink Schedule",
            FormatType::Cses => "CSES Standard",
            FormatType::EvSchedule => "EV Schedule (export format)",
            FormatType::EvScheduleActual => "EV Schedule (native)",
            FormatType::DemoSchedule => "Demo JSON (AI 生成)",
        }
    }
}

pub fn detect_format(raw_json: &str) -> Option<FormatType> {
    // Demo JSON 特征最明显（scheduleName + courses），必须最先匹配，
    // 否则可能被后续更宽松的 detect 抢走。
    if demo::detect(raw_json) {
        return Some(FormatType::DemoSchedule);
    }
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
    if evschedule_actual::detect(raw_json) {
        return Some(FormatType::EvScheduleActual);
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
        FormatType::EvScheduleActual => evschedule_actual::parse(raw_json),
        FormatType::DemoSchedule => demo::parse(raw_json),
    }
}

pub fn auto_parse(raw_json: &str) -> Result<(FormatType, Vec<UnifiedCourse>)> {
    let format = detect_format(raw_json)
        .ok_or_else(|| anyhow::anyhow!("Unsupported schedule format. Unable to auto-detect."))?;
    let courses = parse_by_format(raw_json, &format)?;
    Ok((format, courses))
}