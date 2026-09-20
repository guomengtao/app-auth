use crate::adapters::FormatType;
use crate::import_engine::ImportResult;

pub fn build_main_page() -> String {
    r#"{
  "type": "page",
  "title": "EV 课程表同步器",
  "sections": [
    {
      "type": "header",
      "title": "EV 课程表同步器",
      "subtitle": "导入 / 导出课程表"
    },
    {
      "type": "actions",
      "items": [
        {
          "id": "import-from-file",
          "label": "从文件导入",
          "description": "JSON / WakeUp / sgschedule / StarLink / CSES",
          "icon": "file-import"
        },
        {
          "id": "import-from-jwxt",
          "label": "从教务系统导入",
          "description": "自动从学校教务系统获取课程表",
          "icon": "cloud-download"
        },
        {
          "id": "export-schedule",
          "label": "导出课程表",
          "description": "导出为 EV 课程表 / sgschedule 格式",
          "icon": "file-export"
        }
      ]
    }
  ]
}"#.to_string()
}

pub fn build_import_page(detected_format: Option<&FormatType>) -> String {
    let format_label = detected_format
        .map(|f| f.display_name())
        .unwrap_or("未知格式");

    serde_json::json!({
        "type": "page",
        "title": "导入课程表",
        "sections": [
            {
                "type": "header",
                "title": "导入课程表",
                "subtitle": format!("检测到的格式：{}", format_label)
            },
            {
                "type": "form",
                "fields": [
                    {
                        "id": "schedule-name",
                        "label": "目标课程表名称",
                        "type": "text",
                        "placeholder": "例如：2026年春季学期",
                        "required": true
                    },
                    {
                        "id": "import-mode",
                        "label": "导入模式",
                        "type": "select",
                        "options": [
                            { "value": "new", "label": "创建新课程表" },
                            { "value": "merge", "label": "合并到已有课程表" }
                        ],
                        "default": "new"
                    }
                ]
            },
            {
                "type": "preview",
                "id": "course-preview",
                "title": "待导入课程",
                "emptyText": "尚未加载课程"
            },
            {
                "type": "actions",
                "items": [
                    {
                        "id": "confirm-import",
                        "label": "导入到 Band",
                        "style": "primary"
                    },
                    {
                        "id": "cancel-import",
                        "label": "取消",
                        "style": "secondary"
                    }
                ]
            }
        ]
    }).to_string()
}

pub fn build_import_result_page(result: &ImportResult) -> String {
    let course_list: Vec<serde_json::Value> = result.courses.iter().map(|c| {
        serde_json::json!({
            "name": c.name,
            "teacher": c.teacher,
            "location": c.location,
            "time": format!("周{} {} - {}", c.day, c.start_time, c.end_time),
            "weeks": c.weeks.len(),
            "weekType": format!("{:?}", c.week_type)
        })
    }).collect();

    serde_json::json!({
        "type": "page",
        "title": "导入结果",
        "sections": [
            {
                "type": "header",
                "title": "导入成功",
                "subtitle": format!("从 {} 导入了 {} 门课程", result.format.display_name(), result.total_count)
            },
            {
                "type": "list",
                "id": "course-list",
                "title": "已导入课程",
                "items": course_list
            },
            {
                "type": "actions",
                "items": [
                    {
                        "id": "push-to-band",
                        "label": "推送到 Band",
                        "style": "primary"
                    },
                    {
                        "id": "back-to-main",
                        "label": "返回主页",
                        "style": "secondary"
                    }
                ]
            }
        ]
    }).to_string()
}

pub fn build_export_page() -> String {
    serde_json::json!({
        "type": "page",
        "title": "导出课程表",
        "sections": [
            {
                "type": "header",
                "title": "导出课程表",
                "subtitle": "选择导出格式和选项"
            },
            {
                "type": "form",
                "fields": [
                    {
                        "id": "export-format",
                        "label": "导出格式",
                        "type": "select",
                        "options": [
                            { "value": "evschedule", "label": "EV 课程表 (.json)" },
                            { "value": "sgschedule", "label": "sgschedule / 时光 (.json)" }
                        ],
                        "default": "evschedule"
                    },
                    {
                        "id": "semester-start",
                        "label": "学期开始日期",
                        "type": "date",
                        "placeholder": "2026-03-02"
                    },
                    {
                        "id": "total-weeks",
                        "label": "总周数",
                        "type": "number",
                        "placeholder": "20",
                        "default": "20"
                    }
                ]
            },
            {
                "type": "actions",
                "items": [
                    {
                        "id": "confirm-export",
                        "label": "导出",
                        "style": "primary"
                    },
                    {
                        "id": "cancel-export",
                        "label": "取消",
                        "style": "secondary"
                    }
                ]
            }
        ]
    }).to_string()
}

pub fn build_error_page(message: &str) -> String {
    serde_json::json!({
        "type": "page",
        "title": "导入失败",
        "sections": [
            {
                "type": "header",
                "title": "导入失败",
                "subtitle": message
            },
            {
                "type": "actions",
                "items": [
                    {
                        "id": "retry-import",
                        "label": "重试",
                        "style": "primary"
                    },
                    {
                        "id": "back-to-main",
                        "label": "返回主页",
                        "style": "secondary"
                    }
                ]
            }
        ]
    }).to_string()
}