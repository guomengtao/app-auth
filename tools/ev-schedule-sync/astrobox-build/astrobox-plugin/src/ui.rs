use crate::astrobox::psys_host::{self, ui};
use std::sync::{Mutex, OnceLock};

use crate::export_engine::{export_as_evschedule, export_as_evschedule_actual, export_as_sgschedule};
use crate::import_engine::{import_from_json, ImportResult};
use crate::models::UnifiedSchedule;

const BTN_IMPORT_FILE: &str = "btn_import_file";
const BTN_IMPORT_JWXT: &str = "btn_import_jwxt";
const BTN_EXPORT: &str = "btn_export";
const BTN_BACK: &str = "btn_back";
const BTN_DO_IMPORT: &str = "btn_do_import";
const BTN_DO_EXPORT: &str = "btn_do_export";
const BTN_RETRY: &str = "btn_retry";

#[derive(Clone, Copy, PartialEq)]
enum Page {
    Main,
    Import,
    Export,
    Result,
    Error,
}

struct UiState {
    page: Page,
    root_element_id: Option<String>,
    last_result: Option<ImportResult>,
    last_error: Option<String>,
    last_export: Option<String>,
    export_format: usize,
}

static UI_STATE: OnceLock<Mutex<UiState>> = OnceLock::new();

fn state() -> &'static Mutex<UiState> {
    UI_STATE.get_or_init(|| {
        Mutex::new(UiState {
            page: Page::Main,
            root_element_id: None,
            last_result: None,
            last_error: None,
            last_export: None,
            export_format: 0,
        })
    })
}

fn rerender() {
    let root = state().lock().unwrap_or_else(|p| p.into_inner()).root_element_id.clone();
    if let Some(id) = root {
        let page = state().lock().unwrap_or_else(|p| p.into_inner()).page;
        psys_host::ui::render(&id, build_page(page));
    }
}

fn el_text(text: &str, size: u32, color: &str) -> ui::Element {
    ui::Element::new(ui::ElementType::Span, Some(text))
        .size(size)
        .text_color(color)
}

fn el_p(text: &str, size: u32, color: &str) -> ui::Element {
    ui::Element::new(ui::ElementType::P, Some(text))
        .size(size)
        .text_color(color)
}

fn el_header(title: &str, subtitle: &str) -> ui::Element {
    let title_el = el_text(title, 22, "#FFFFFF");
    let sub_el = el_text(subtitle, 13, "#888888");

    ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .padding(16)
        .child(title_el)
        .child(sub_el)
}

fn el_menu_card(id: &str, icon: &str, title: &str, desc: &str, color: &str) -> ui::Element {
    let icon_el = ui::Element::new(ui::ElementType::Span, Some(icon))
        .size(22)
        .width(44)
        .height(44)
        .bg(color)
        .radius(10)
        .flex()
        .justify_center()
        .align_center();

    let title_el = el_p(title, 15, "#FFFFFF");
    let desc_el = el_p(desc, 12, "#666666");

    let col = ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .child(title_el)
        .child(desc_el);

    ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Row)
        .padding(14)
        .margin(8)
        .align_center()
        .bg("#14141F")
        .radius(12)
        .on(ui::Event::Click, id)
        .child(icon_el)
        .child(col)
}

fn el_button(id: &str, label: &str, primary: bool) -> ui::Element {
    let bg = if primary { "#2196F3" } else { "#2A2A3A" };
    let fg = if primary { "#FFFFFF" } else { "#AAAAAA" };
    ui::Element::new(ui::ElementType::Button, Some(label))
        .bg(bg)
        .text_color(fg)
        .radius(12)
        .padding(14)
        .margin(8)
        .on(ui::Event::Click, id)
}

fn el_result_card(result: &ImportResult) -> ui::Element {
    let check = el_text("OK", 24, "#4CAF50");
    let summary = el_p(
        &format!("Successfully imported {} courses from {}", result.total_count, result.format.display_name()),
        15,
        "#FFFFFF",
    );
    let info = el_p(
        &format!("Format: {} | Count: {}", result.format.display_name(), result.total_count),
        13,
        "#888888",
    );

    ui::Element::new(ui::ElementType::Div, None)
        .bg("#1A2A1A")
        .radius(12)
        .padding(16)
        .margin(12)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .child(check)
        .child(summary)
        .child(info)
}

fn el_course_item(name: &str, day: u8, start: &str, end: &str, location: &str, teacher: &str) -> ui::Element {
    let name_el = el_p(name, 14, "#FFFFFF");
    let meta = el_p(
        &format!("Week {} {} - {} | {} | {}", day, start, end, location, teacher),
        12,
        "#777777",
    );
    ui::Element::new(ui::ElementType::Div, None)
        .bg("#1A1A2A")
        .radius(10)
        .padding(12)
        .margin(8)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .child(name_el)
        .child(meta)
}

fn build_page(page: Page) -> ui::Element {
    match page {
        Page::Main => build_main(),
        Page::Import => build_import(),
        Page::Export => build_export(),
        Page::Result => build_result(),
        Page::Error => build_error(),
    }
}

fn build_main() -> ui::Element {
    let subtitle = format!("v{} | 导入 / 导出 课程表", env!("CARGO_PKG_VERSION"));
    let header = el_header("EV 课程表同步器", &subtitle);

    let c1 = el_menu_card(BTN_IMPORT_FILE, "📥", "从文件导入",
        "JSON / WakeUp / sgschedule / StarLink / CSES", "rgba(33,150,243,0.15)");
    let c2 = el_menu_card(BTN_IMPORT_JWXT, "🏫", "从教务系统导入",
        "自动从学校教务系统获取课程表", "rgba(76,175,80,0.15)");
    let c3 = el_menu_card(BTN_EXPORT, "📤", "导出课程表",
        "导出为 EV 课程表 / sgschedule 格式", "rgba(255,152,0,0.15)");

    ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .child(header)
        .child(c1)
        .child(c2)
        .child(c3)
}

fn build_import() -> ui::Element {
    let header = el_header("导入课程表", "选择文件或从教务系统导入");

    let info = el_p("支持格式：sgschedule、WakeUp、StarLink、CSES、EV 课程表", 13, "#888888")
        .padding(12);

    let mut container = ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .child(header)
        .child(info);

    let show_result = state().lock().unwrap_or_else(|p| p.into_inner()).last_result.clone();
    if let Some(ref result) = show_result {
        container = container.child(el_p(
            &format!("Parsed {} courses:", result.total_count), 14, "#4CAF50",
        ).padding(12));
        for c in &result.courses {
            container = container.child(el_course_item(&c.name, c.day, &c.start_time, &c.end_time, &c.location, &c.teacher));
        }
    }

    container = container
        .child(el_button(BTN_DO_IMPORT, "执行导入（演示）", true))
        .child(el_button(BTN_BACK, "返回主页", false));
    container
}

fn build_export() -> ui::Element {
    let header = el_header("导出课程表", "选择导出格式");

    let label = el_p("导出格式", 13, "#999999").padding(12);

    let option1 = ui::Element::new(ui::ElementType::Option, Some("EV 课程表 (.json)"));
    let option2 = ui::Element::new(ui::ElementType::Option, Some("sgschedule / 时光 (.json)"));
    let select = ui::Element::new(ui::ElementType::Select, None)
        .margin(12)
        .child(option1)
        .child(option2);

    let mut container = ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .child(header)
        .child(label)
        .child(select);

    let show_export = state().lock().unwrap_or_else(|p| p.into_inner()).last_export.clone();
    if let Some(ref exported) = show_export {
        container = container.child(
            el_p(exported, 11, "#888888")
                .padding(12)
                .bg("#1A1A2A")
                .radius(8)
                .margin(12)
        );
    }

    container = container
        .child(el_button(BTN_DO_EXPORT, "导出", true))
        .child(el_button(BTN_BACK, "返回主页", false));
    container
}

fn build_result() -> ui::Element {
    let header = el_header("导入成功", "");

    let mut container = ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .child(header);

    let show = state().lock().unwrap_or_else(|p| p.into_inner()).last_result.clone();
    if let Some(ref result) = show {
        container = container.child(el_result_card(result));
        for c in &result.courses {
            container = container.child(el_course_item(&c.name, c.day, &c.start_time, &c.end_time, &c.location, &c.teacher));
        }
    }

    container = container.child(el_button(BTN_BACK, "返回主页", false));
    container
}

fn build_error() -> ui::Element {
    let header = el_text("导入失败", 18, "#F44336");
    let error = state().lock().unwrap_or_else(|p| p.into_inner()).last_error.clone().unwrap_or_default();
    let msg = el_p(&error, 14, "#AAAAAA").padding(12);

    ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .padding(16)
        .child(header)
        .child(msg)
        .child(el_button(BTN_RETRY, "重试", true))
        .child(el_button(BTN_BACK, "返回主页", false))
}

fn do_import_demo() {
    let json = r#"[
  {
    "day": "星期一",
    "classes": [
      {
        "id": "1",
        "name": "高等数学",
        "time": "08:00 - 09:40",
        "teacher": "张教授",
        "location": "A楼101教室",
        "notes": ""
      },
      {
        "id": "2",
        "name": "大学英语",
        "time": "10:00 - 11:40",
        "teacher": "李教授",
        "location": "教学楼B205",
        "notes": ""
      }
    ]
  },
  {
    "day": "星期二",
    "classes": [
      {
        "id": "3",
        "name": "线性代数",
        "time": "08:00 - 09:40",
        "teacher": "王教授",
        "location": "数学楼301",
        "notes": ""
      }
    ]
  },
  { "day": "星期三", "classes": [] },
  { "day": "星期四", "classes": [] },
  { "day": "星期五", "classes": [] },
  { "day": "星期六", "classes": [] },
  { "day": "星期日", "classes": [] }
]"#;

    match import_from_json(json, "示例课程表") {
        Ok(result) => {
            state().lock().unwrap_or_else(|p| p.into_inner()).last_result = Some(result);
            state().lock().unwrap_or_else(|p| p.into_inner()).last_error = None;
            state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Result;
        }
        Err(e) => {
            state().lock().unwrap_or_else(|p| p.into_inner()).last_error = Some(format!("Import failed: {}", e));
            state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Error;
        }
    }
    rerender();
}

fn do_export_demo() {
    let json = r#"[
  {
    "day": "星期一",
    "classes": [
      {
        "id": "1",
        "name": "高等数学",
        "time": "08:00 - 09:40",
        "teacher": "张教授",
        "location": "A楼101教室",
        "notes": ""
      }
    ]
  },
  { "day": "星期二", "classes": [] },
  { "day": "星期三", "classes": [] },
  { "day": "星期四", "classes": [] },
  { "day": "星期五", "classes": [] },
  { "day": "星期六", "classes": [] },
  { "day": "星期日", "classes": [] }
]"#;

    if let Ok(result) = import_from_json(json, "示例") {
        let schedule = UnifiedSchedule {
            id: "demo".to_string(),
            name: "示例课程表".to_string(),
            courses: result.courses,
        };
        let fmt = state().lock().unwrap_or_else(|p| p.into_inner()).export_format;
        let exported = if fmt == 0 {
            export_as_evschedule_actual(&schedule)
        } else {
            export_as_sgschedule(&schedule.courses, "2025-02-24", 20)
        };
        let truncated = if exported.len() > 400 { format!("{}... ({} chars)", &exported[..400], exported.len()) } else { exported };
        state().lock().unwrap_or_else(|p| p.into_inner()).last_export = Some(truncated);
    }
    rerender();
}

pub fn handle_ui_event(event_id: &str) {
    match event_id {
        BTN_IMPORT_FILE => { state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Import; rerender(); }
        BTN_IMPORT_JWXT => do_import_demo(),
        BTN_EXPORT => { state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Export; rerender(); }
        BTN_BACK => { state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Main; rerender(); }
        BTN_DO_IMPORT => do_import_demo(),
        BTN_DO_EXPORT => do_export_demo(),
        BTN_RETRY => { state().lock().unwrap_or_else(|p| p.into_inner()).page = Page::Import; rerender(); }
        _ => {}
    }
}

pub fn render_main_ui(element_id: &str) {
    state().lock().unwrap_or_else(|p| p.into_inner()).root_element_id = Some(element_id.to_string());
    let page = state().lock().unwrap_or_else(|p| p.into_inner()).page;
    psys_host::ui::render(element_id, build_page(page));
}