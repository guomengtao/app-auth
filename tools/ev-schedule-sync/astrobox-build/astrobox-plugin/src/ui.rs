use crate::astrobox::psys_host::{self, ui};

pub fn handle_ui_event(_event_id: &str) {
}

pub fn render_main_ui(element_id: &str) {
    let hello = ui::Element::new(ui::ElementType::Span, Some("hello world"))
        .size(32)
        .text_color("#ffffff");
    psys_host::ui::render(element_id, hello);
}