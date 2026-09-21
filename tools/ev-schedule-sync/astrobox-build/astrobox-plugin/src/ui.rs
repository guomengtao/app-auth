use crate::astrobox::psys_host::{self, ui};
use crate::STATE;

pub fn handle_ui_event(_event_id: &str) {
}

pub fn render_main_ui(element_id: &str) {
    let state = STATE.lock().unwrap();

    let title = ui::Element::new(ui::ElementType::Span, Some("EV Schedule Sync"))
        .size(24)
        .text_color("#ffffff")
        .margin(16);

    let import_heading = ui::Element::new(ui::ElementType::Span, Some("Import Schedule Data"))
        .size(18)
        .text_color("#aaaaaa")
        .margin(8);

    let json_input = ui::Element::new(ui::ElementType::Input, None)
        .width(300)
        .height(160)
        .size(14)
        .text_color("#ffffff")
        .bg("#2a2a2a")
        .radius(8)
        .padding(8)
        .margin(8)
        .on(ui::Event::Change, "import-json-input");

    let name_label = ui::Element::new(ui::ElementType::Span, Some("Schedule Name:"))
        .size(14)
        .text_color("#aaaaaa")
        .margin(4);

    let name_input = ui::Element::new(ui::ElementType::Input, None)
        .width(300)
        .size(14)
        .text_color("#ffffff")
        .bg("#2a2a2a")
        .radius(8)
        .padding(8)
        .margin(8)
        .on(ui::Event::Change, "import-name-input");

    let import_btn = ui::Element::new(ui::ElementType::Button, Some("Import"))
        .width(300)
        .size(16)
        .text_color("#ffffff")
        .bg("#4CAF50")
        .radius(8)
        .padding(12)
        .margin(8)
        .on(ui::Event::Click, "import-btn");

    let status_text = ui::Element::new(
        ui::ElementType::Span,
        Some(&state.status_message),
    )
        .size(13)
        .text_color("#cccccc")
        .margin(8);

    let export_heading = ui::Element::new(ui::ElementType::Span, Some("Export"))
        .size(18)
        .text_color("#aaaaaa")
        .margin(8);

    let course_count = format!("{} courses loaded", state.courses.len());
    let count_text = ui::Element::new(ui::ElementType::Span, Some(&course_count))
        .size(13)
        .text_color("#888888")
        .margin(8);

    let export_ev_btn = ui::Element::new(ui::ElementType::Button, Some("Export EV Schedule"))
        .width(300)
        .size(16)
        .text_color("#ffffff")
        .bg("#2196F3")
        .radius(8)
        .padding(12)
        .margin(8)
        .on(ui::Event::Click, "export-ev-btn");

    let export_sg_btn = ui::Element::new(ui::ElementType::Button, Some("Export sgschedule"))
        .width(300)
        .size(16)
        .text_color("#ffffff")
        .bg("#FF9800")
        .radius(8)
        .padding(12)
        .margin(8)
        .on(ui::Event::Click, "export-sg-btn");

    let clear_btn = ui::Element::new(ui::ElementType::Button, Some("Clear"))
        .width(300)
        .size(14)
        .text_color("#ffffff")
        .bg("#555555")
        .radius(8)
        .padding(8)
        .margin(8)
        .on(ui::Event::Click, "clear-btn");

    let export_result_label = ui::Element::new(ui::ElementType::Span, Some("Export Result:"))
        .size(13)
        .text_color("#aaaaaa")
        .margin(4);

    let export_result_text = ui::Element::new(
        ui::ElementType::Span,
        Some(&state.export_result),
    )
        .size(12)
        .text_color("#cccccc")
        .bg("#1a1a1a")
        .padding(8)
        .radius(4);

    let container = ui::Element::new(ui::ElementType::Div, None)
        .child(title)
        .child(import_heading)
        .child(json_input)
        .child(name_label)
        .child(name_input)
        .child(import_btn)
        .child(status_text)
        .child(export_heading)
        .child(count_text)
        .child(export_ev_btn)
        .child(export_sg_btn)
        .child(clear_btn)
        .child(export_result_label)
        .child(export_result_text)
        .padding(16)
        .bg("#1e1e1e");

    psys_host::ui::render(element_id, container);
}