use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedCourse {
    pub id: String,
    pub name: String,
    pub teacher: String,
    pub location: String,
    pub day: u8,
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: String,
    pub weeks: Vec<u32>,
    #[serde(rename = "weekType")]
    pub week_type: WeekType,
    pub color: Option<String>,
    pub credit: Option<f32>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WeekType {
    All,
    Odd,
    Even,
}

impl Default for WeekType {
    fn default() -> Self {
        WeekType::All
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedSchedule {
    pub id: String,
    pub name: String,
    pub courses: Vec<UnifiedCourse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedExport {
    pub version: String,
    #[serde(rename = "exportTime")]
    pub export_time: u64,
    #[serde(rename = "appName")]
    pub app_name: String,
    pub schedules: Vec<UnifiedSchedule>,
}

impl UnifiedExport {
    pub fn new(app_name: &str, schedules: Vec<UnifiedSchedule>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        Self {
            version: "2.0".to_string(),
            export_time: now,
            app_name: app_name.to_string(),
            schedules,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "loginUrl")]
    pub login_url: String,
    #[serde(rename = "scheduleUrl")]
    pub schedule_url: String,
    #[serde(rename = "usernameField")]
    pub username_field: String,
    #[serde(rename = "passwordField")]
    pub password_field: String,
    #[serde(rename = "scheduleTableSelector")]
    pub schedule_table_selector: String,
    #[serde(rename = "cellFieldOrder")]
    pub cell_field_order: Vec<String>,
    #[serde(rename = "hiddenFields")]
    pub hidden_fields: Vec<String>,
    #[serde(rename = "extraFields")]
    pub extra_fields: Option<Vec<(String, String)>>,
}

pub const SG_COLOR_MAP: [&str; 10] = [
    "#F44336", "#E91E63", "#9C27B0", "#673AB7", "#3F51B5",
    "#2196F3", "#00BCD4", "#4CAF50", "#FF9800", "#FF5722",
];

pub fn color_index_to_hex(index: u8) -> Option<String> {
    SG_COLOR_MAP.get(index as usize).map(|&s| s.to_string())
}

pub fn color_hex_to_index(hex: &str) -> u8 {
    SG_COLOR_MAP
        .iter()
        .position(|&s| s.eq_ignore_ascii_case(hex))
        .map(|i| i as u8)
        .unwrap_or(0)
}

pub fn weeks_from_range(start: u32, end: u32) -> Vec<u32> {
    (start..=end).collect()
}

pub fn parse_week_range(range_str: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = range_str.split('-').collect();
    if parts.len() == 2 {
        let start = parts[0].trim().parse().ok()?;
        let end = parts[1].trim().parse().ok()?;
        Some((start, end))
    } else {
        None
    }
}