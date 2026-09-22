use crate::astrobox::psys_host::{self, ui};

pub fn render_main_ui(element_id: &str) {
    let hello = ui::Element::new(ui::ElementType::Span, Some("hello world"))
        .size(32)
        .text_color("#ffffff")
        .margin(16);

    let again = ui::Element::new(ui::ElementType::Span, Some("again edit"))
        .size(20)
        .text_color("#aaaaaa")
        .margin(8);

    let container = ui::Element::new(ui::ElementType::Div, None)
        .child(hello)
        .child(again);

    psys_host::ui::render(element_id, container);
}