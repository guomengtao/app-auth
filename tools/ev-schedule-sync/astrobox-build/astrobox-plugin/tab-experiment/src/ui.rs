use crate::astrobox::psys_host::{self, ui};
use crate::{Page, STATE, EvConnectionStatus};

const BG_ROOT: &str = "#191919";
const BG_CARD: &str = "#242424";
const FG_PRIMARY: &str = "#ffffff";
const FG_SECONDARY: &str = "#aaaaaa";
const FG_MUTED: &str = "#6f6f6f";
const GREEN: &str = "#4CAF50";
const RED: &str = "#C62828";
const BLUE: &str = "#2196F3";
const YELLOW: &str = "#FFC107";

pub fn render_main_ui(element_id: &str) {
    let state = STATE.lock().unwrap();
    let page = state.page.clone();
    let ev_status = state.ev_status.clone();
    drop(state);

    let mut root = ui::Element::new(ui::ElementType::Div, None)
        .padding(10)
        .bg(BG_ROOT);

    let title = format!("Tab 实验 v{}", crate::PLUGIN_VERSION);
    root = root.child(
        ui::Element::new(ui::ElementType::Span, Some(&title))
            .size(21)
            .text_color(FG_PRIMARY)
            .margin(6),
    );

    root = root.child(build_tab_bar(&page));

    root = root.child(build_ev_status(&ev_status));

    root = root.child(build_check_button());

    root = match page {
        Page::TabA => root.child(build_tab_a_content()),
        Page::TabB => root.child(build_tab_b_content()),
    };

    psys_host::ui::render(element_id, root);
}

fn build_tab_bar(current: &Page) -> ui::Element {
    let is_a = matches!(current, &Page::TabA);

    ui::Element::new(ui::ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Row)
        .padding(6)
        .margin(4)
        .child(tab_button("Tab A", is_a, GREEN, "btn-tab-a"))
        .child(tab_button("Tab B", !is_a, BLUE, "btn-tab-b"))
}

fn tab_button(label: &str, active: bool, accent: &str, id: &str) -> ui::Element {
    ui::Element::new(ui::ElementType::Button, Some(label))
        .size(if active { 16 } else { 13 })
        .text_color(if active { FG_PRIMARY } else { FG_SECONDARY })
        .bg(if active { accent } else { BG_CARD })
        .radius(10)
        .padding(10)
        .margin(2)
        .on(ui::Event::Click, id)
}

fn build_ev_status(status: &EvConnectionStatus) -> ui::Element {
    let (text, color) = match status {
        EvConnectionStatus::Idle => ("未检测".to_string(), FG_MUTED),
        EvConnectionStatus::Checking => ("检测中...".to_string(), YELLOW),
        EvConnectionStatus::Connected(name) => (format!("已连接: {}", name), GREEN),
        EvConnectionStatus::NotConnected => ("未连接".to_string(), RED),
    };

    ui::Element::new(ui::ElementType::Span, Some(&text))
        .size(14)
        .text_color(color)
        .margin(8)
}

fn build_check_button() -> ui::Element {
    ui::Element::new(ui::ElementType::Button, Some("检测 EV 连接"))
        .size(14)
        .text_color(FG_PRIMARY)
        .bg("#444444")
        .radius(10)
        .padding(10)
        .margin(8)
        .on(ui::Event::Click, "btn-check-ev")
}

fn build_tab_a_content() -> ui::Element {
    ui::Element::new(ui::ElementType::Span, Some("dod"))
        .size(18)
        .text_color(GREEN)
        .margin(20)
}

fn build_tab_b_content() -> ui::Element {
    ui::Element::new(ui::ElementType::Span, Some("fox"))
        .size(18)
        .text_color(BLUE)
        .margin(20)
}