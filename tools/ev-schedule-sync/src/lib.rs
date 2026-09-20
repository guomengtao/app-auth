mod logger;
pub mod models;
pub mod adapters;
pub mod import_engine;
pub mod export_engine;
pub mod ui;

use crate::adapters::{FormatType, detect_format, auto_parse};
use crate::import_engine::{ImportResult, import_from_json, merge_courses};
use crate::export_engine::{export_as_evschedule, export_as_sgschedule};
use crate::models::{UnifiedCourse, UnifiedSchedule};
use crate::ui::{
    build_main_page, build_import_page, build_import_result_page,
    build_error_page,
};

pub struct EvScheduleSync {
    current_page: String,
    pending_courses: Vec<UnifiedCourse>,
    detected_format: Option<FormatType>,
    import_result: Option<ImportResult>,
}

impl EvScheduleSync {
    pub fn new() -> Self {
        Self {
            current_page: "main".to_string(),
            pending_courses: Vec::new(),
            detected_format: None,
            import_result: None,
        }
    }

    pub fn on_load(&mut self) -> String {
        logger::init();
        log::info!("EV Schedule Sync plugin loaded");
        self.current_page = "main".to_string();
        build_main_page()
    }

    pub fn handle_file_selected(&mut self, raw_json: &str) -> String {
        match detect_format(raw_json) {
            Some(format) => {
                log::info!("Detected format: {:?}", format);
                self.detected_format = Some(format.clone());

                match auto_parse(raw_json) {
                    Ok((_, courses)) => {
                        self.pending_courses = courses;
                        log::info!("Parsed {} courses", self.pending_courses.len());
                        self.current_page = "import".to_string();
                        build_import_page(Some(&format))
                    }
                    Err(e) => {
                        log::error!("Parse error: {}", e);
                        build_error_page(&format!("Failed to parse: {}", e))
                    }
                }
            }
            None => {
                log::error!("Unrecognized format");
                build_error_page(
                    "Unsupported schedule format. Please ensure the file is a valid course schedule JSON.\n\n\
                     Supported formats: EV Schedule, sgschedule (ShiGuang), WakeUp, StarLink, CSES"
                )
            }
        }
    }

    pub fn handle_import(&mut self, schedule_name: &str, merge_existing: Option<&[UnifiedCourse]>) -> String {
        if self.pending_courses.is_empty() {
            return build_error_page("No courses loaded. Please select a file first.");
        }

        let final_courses = if let Some(existing) = merge_existing {
            merge_courses(existing, &self.pending_courses)
        } else {
            self.pending_courses.clone()
        };

        let format = self.detected_format.clone().unwrap_or(FormatType::EvSchedule);
        let result = ImportResult {
            format,
            schedule_name: schedule_name.to_string(),
            courses: final_courses,
            total_count: self.pending_courses.len(),
        };

        log::info!(
            "Import complete: {} courses into '{}'",
            result.total_count,
            result.schedule_name
        );

        self.import_result = Some(result.clone());
        self.current_page = "result".to_string();
        build_import_result_page(&result)
    }

    pub fn handle_export(
        &self,
        courses: &[UnifiedCourse],
        format: &str,
        semester_start: &str,
        total_weeks: u32,
    ) -> String {
        match format {
            "sgschedule" => {
                log::info!("Exporting as sgschedule format ({} courses)", courses.len());
                export_as_sgschedule(courses, semester_start, total_weeks)
            }
            _ => {
                let schedule = UnifiedSchedule {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "Exported Schedule".to_string(),
                    courses: courses.to_vec(),
                };
                log::info!("Exporting as EV Schedule format ({} courses)", courses.len());
                export_as_evschedule(&schedule)
            }
        }
    }

    pub fn get_import_result(&self) -> Option<&ImportResult> {
        self.import_result.as_ref()
    }

    pub fn get_pending_courses(&self) -> &[UnifiedCourse] {
        &self.pending_courses
    }

    pub fn go_to_main(&mut self) -> String {
        self.current_page = "main".to_string();
        self.pending_courses.clear();
        self.detected_format = None;
        self.import_result = None;
        build_main_page()
    }
}

impl Default for EvScheduleSync {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SG_SAMPLE: &str = r#"{
  "courses": [
    {
      "id": "a63cb711-f626-4ff5-98dd-55cef8d815eb",
      "name": "Advanced Mathematics",
      "teacher": "Prof. Zhang",
      "position": "Building A-101",
      "day": 1,
      "startSection": 1,
      "endSection": 1,
      "color": 5,
      "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]
    }
  ],
  "timeSlots": [
    {"number": 1, "startTime": "08:00", "endTime": "08:45"},
    {"number": 2, "startTime": "10:05", "endTime": "11:40"}
  ],
  "config": {
    "semesterStartDate": "2026-03-02",
    "semesterTotalWeeks": 20,
    "defaultClassDuration": 95,
    "defaultBreakDuration": 30
  }
}"#;

    const WAKEUP_SAMPLE: &str = r#"{
  "scheduleName": "Spring 2026",
  "courseList": [
    {
      "name": "College English",
      "day": 2,
      "start": "10:00",
      "end": "11:40",
      "room": "Teaching Bldg B-205",
      "teacher": "Prof. Li",
      "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      "type": "every"
    }
  ]
}"#;

    #[test]
    fn test_detect_sgschedule() {
        assert_eq!(detect_format(SG_SAMPLE), Some(FormatType::SgSchedule));
    }

    #[test]
    fn test_detect_wakeup() {
        assert_eq!(detect_format(WAKEUP_SAMPLE), Some(FormatType::WakeUp));
    }

    #[test]
    fn test_parse_sgschedule() {
        let (format, courses) = auto_parse(SG_SAMPLE).unwrap();
        assert_eq!(format, FormatType::SgSchedule);
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].name, "Advanced Mathematics");
        assert_eq!(courses[0].start_time, "08:00");
        assert_eq!(courses[0].end_time, "08:45");
    }

    #[test]
    fn test_parse_wakeup() {
        let (format, courses) = auto_parse(WAKEUP_SAMPLE).unwrap();
        assert_eq!(format, FormatType::WakeUp);
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].name, "College English");
        assert_eq!(courses[0].start_time, "10:00");
        assert_eq!(courses[0].end_time, "11:40");
    }

    #[test]
    fn test_import_from_json() {
        let result = import_from_json(SG_SAMPLE, "Test Schedule").unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.format, FormatType::SgSchedule);
    }

    #[test]
    fn test_merge_courses_no_duplicate() {
        let existing = vec![UnifiedCourse {
            id: "1".into(),
            name: "Physics".into(),
            teacher: "Prof. Wang".into(),
            location: "Lab-301".into(),
            day: 3,
            start_time: "14:00".into(),
            end_time: "15:40".into(),
            weeks: vec![1, 2, 3],
            week_type: crate::models::WeekType::All,
            color: None,
            credit: None,
            remark: None,
        }];

        let new = vec![UnifiedCourse {
            id: "2".into(),
            name: "Chemistry".into(),
            teacher: "Prof. Zhao".into(),
            location: "Lab-302".into(),
            day: 4,
            start_time: "08:00".into(),
            end_time: "09:40".into(),
            weeks: vec![1, 2, 3],
            week_type: crate::models::WeekType::All,
            color: None,
            credit: None,
            remark: None,
        }];

        let merged = merge_courses(&existing, &new);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn test_merge_courses_duplicate() {
        let course = UnifiedCourse {
            id: "1".into(),
            name: "Physics".into(),
            teacher: "Prof. Wang".into(),
            location: "Lab-301".into(),
            day: 3,
            start_time: "14:00".into(),
            end_time: "15:40".into(),
            weeks: vec![1, 2, 3],
            week_type: crate::models::WeekType::All,
            color: None,
            credit: None,
            remark: None,
        };

        let existing = vec![course.clone()];
        let new = vec![course.clone()];
        let merged = merge_courses(&existing, &new);
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn test_export_evschedule() {
        let schedule = UnifiedSchedule {
            id: "test-1".into(),
            name: "Test".into(),
            courses: vec![],
        };
        let json = export_as_evschedule(&schedule);
        assert!(json.contains("\"version\""));
        assert!(json.contains("\"schedules\""));
    }

    #[test]
    fn test_export_sgschedule() {
        let courses = vec![UnifiedCourse {
            id: "1".into(),
            name: "Math".into(),
            teacher: "Prof. X".into(),
            location: "A-101".into(),
            day: 1,
            start_time: "08:00".into(),
            end_time: "08:45".into(),
            weeks: vec![1, 2, 3],
            week_type: crate::models::WeekType::All,
            color: Some("#2196F3".into()),
            credit: None,
            remark: None,
        }];
        let json = export_as_sgschedule(&courses, "2026-03-02", 20);
        assert!(json.contains("\"timeSlots\""));
        assert!(json.contains("\"courses\""));
    }

    #[test]
    fn test_evschedule_roundtrip() {
        let original = vec![UnifiedCourse {
            id: "1".into(),
            name: "Math".into(),
            teacher: "Prof. X".into(),
            location: "A-101".into(),
            day: 1,
            start_time: "08:00".into(),
            end_time: "08:45".into(),
            weeks: vec![1, 2, 3],
            week_type: crate::models::WeekType::All,
            color: Some("#2196F3".into()),
            credit: None,
            remark: None,
        }];

        let schedule = UnifiedSchedule {
            id: "test-1".into(),
            name: "Test".into(),
            courses: original.clone(),
        };

        let exported = export_as_evschedule(&schedule);
        let (_, imported) = auto_parse(&exported).unwrap();

        assert_eq!(imported.len(), original.len());
        assert_eq!(imported[0].name, original[0].name);
        assert_eq!(imported[0].start_time, original[0].start_time);
    }

    #[test]
    fn test_unknown_format() {
        assert_eq!(detect_format(r#"{"foo": "bar"}"#), None);
    }

    #[test]
    fn test_empty_courses_import() {
        let empty_sg = r#"{"courses": [], "timeSlots": [{"number":1,"startTime":"08:00","endTime":"08:45"}], "config": {"semesterStartDate":"2026-03-02","semesterTotalWeeks":20,"defaultClassDuration":95,"defaultBreakDuration":30}}"#;
        let result = import_from_json(empty_sg, "Empty");
        assert!(result.is_err());
    }
}