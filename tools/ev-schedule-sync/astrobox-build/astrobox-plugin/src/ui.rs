// UI 渲染 —— DESIGN.md §1.2 / §3.2 / §4
//
// 页面按 STATE.page 切换；Demo 对话框用 absolute overlay 叠在当前页面上
// （WIT ui 没有原生 modal，只能用绝对定位 + z-index 模拟）。

use crate::astrobox::psys_host::{self, ui};
use crate::demo_template;
use crate::{Page, STATE};

pub fn render_main_ui(element_id: &str) {
    // 先取快照再释放锁：build_*_page() 内部会自己 STATE.lock()，
    // std::sync::Mutex 不可重入，这里若继续持有锁会直接死锁。
    let (page, show_demo_dialog) = {
        let state = STATE.lock().unwrap();
        (state.page.clone(), state.show_demo_dialog)
    };

    let container = match page {
        Page::SelectDevice => build_select_device_page(),
        Page::Main => build_main_page(),
    };

    if show_demo_dialog {
        psys_host::ui::render(element_id, container.child(build_demo_overlay()));
    } else {
        psys_host::ui::render(element_id, container);
    }
}

// ────────────────────────── 主页（导入 / 导出）──────────────────────────

fn build_main_page() -> ui::Element {
    let state = STATE.lock().unwrap();

    let mut container = ui::Element::new(ui::ElementType::Div, None)
        .padding(16)
        .bg("#1e1e1e");

    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("EV 课程表同步器"))
            .size(22)
            .text_color("#ffffff")
            .margin(8),
    );

    // 版本号常驻：安装后第一眼就能核对设备上到底是哪一版
    let version_text = format!("版本 v{}", crate::PLUGIN_VERSION);
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some(&version_text))
            .size(12)
            .text_color("#888888")
            .margin(2),
    );

    // ── 目标设备横幅（DESIGN.md §4.2 / §4.3）──
    let (banner_text, banner_color) = match &state.selected_device_name {
        Some(name) => (format!("目标设备：{}", name), "#4CAF50"),
        None => ("未选择目标设备".to_string(), "#FF9800"),
    };
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some(&banner_text))
            .size(14)
            .text_color(banner_color)
            .padding(8)
            .margin(8)
            .radius(6)
            .bg("#242424"),
    );
    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("切换 / 选择设备"))
            .width(300)
            .size(14)
            .text_color("#ffffff")
            .bg("#2196F3")
            .radius(8)
            .padding(10)
            .margin(8)
            .on(ui::Event::Click, "btn-goto-select-device"),
    );

    // ── 守卫错误横幅（§2.2）──
    if !state.guard_error.is_empty() {
        container = container.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.guard_error))
                .size(13)
                .text_color("#ffffff")
                .padding(10)
                .margin(8)
                .radius(6)
                .bg("#B71C1C"),
        );
    }

    // ── 导入区 ──
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("导入课程表"))
            .size(18)
            .text_color("#aaaaaa")
            .margin(8),
    );

    container = container.child(
        ui::Element::new(ui::ElementType::Input, None)
            .width(300)
            .height(140)
            .size(13)
            .text_color("#ffffff")
            .bg("#2a2a2a")
            .radius(8)
            .padding(8)
            .margin(8)
            .on(ui::Event::Change, "import-json-input"),
    );

    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("目标课程表名称："))
            .size(13)
            .text_color("#aaaaaa")
            .margin(4),
    );
    container = container.child(
        ui::Element::new(ui::ElementType::Input, None)
            .width(300)
            .size(14)
            .text_color("#ffffff")
            .bg("#2a2a2a")
            .radius(8)
            .padding(8)
            .margin(8)
            .on(ui::Event::Change, "import-name-input"),
    );

    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("导入"))
            .width(300)
            .size(16)
            .text_color("#ffffff")
            .bg("#4CAF50")
            .radius(8)
            .padding(12)
            .margin(8)
            .on(ui::Event::Click, "import-btn"),
    );

    // ── §3：Demo JSON 快捷导入入口 ──
    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("用 AI 生成课表（Demo JSON）"))
            .width(300)
            .size(15)
            .text_color("#ffffff")
            .bg("#9C27B0")
            .radius(8)
            .padding(12)
            .margin(8)
            .on(ui::Event::Click, "btn-show-demo"),
    );

    if !state.status_message.is_empty() {
        container = container.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.status_message))
                .size(13)
                .text_color("#cccccc")
                .margin(8),
        );
    }

    // ── 导出区 ──
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("导出"))
            .size(18)
            .text_color("#aaaaaa")
            .margin(8),
    );

    let course_count = format!("已加载 {} 门课程", state.courses.len());
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some(&course_count))
            .size(13)
            .text_color("#888888")
            .margin(8),
    );

    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("导出为 EV 课程表"))
            .width(300)
            .size(16)
            .text_color("#ffffff")
            .bg("#2196F3")
            .radius(8)
            .padding(12)
            .margin(8)
            .on(ui::Event::Click, "export-ev-btn"),
    );
    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("导出为 sgschedule"))
            .width(300)
            .size(16)
            .text_color("#ffffff")
            .bg("#FF9800")
            .radius(8)
            .padding(12)
            .margin(8)
            .on(ui::Event::Click, "export-sg-btn"),
    );

    if !state.export_result.is_empty() {
        container = container.child(
            ui::Element::new(ui::ElementType::Span, Some("导出结果："))
                .size(13)
                .text_color("#aaaaaa")
                .margin(4),
        );
        container = container.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.export_result))
                .size(11)
                .text_color("#cccccc")
                .bg("#1a1a1a")
                .padding(8)
                .radius(4)
                .margin(4),
        );
    }

    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("清空"))
            .width(300)
            .size(14)
            .text_color("#ffffff")
            .bg("#555555")
            .radius(8)
            .padding(8)
            .margin(8)
            .on(ui::Event::Click, "clear-btn"),
    );

    container
}

// ────────────────────────── 选择设备页（§1.2 / §4.1）──────────────────────────

fn build_select_device_page() -> ui::Element {
    let state = STATE.lock().unwrap();

    let mut container = ui::Element::new(ui::ElementType::Div, None)
        .padding(16)
        .bg("#1e1e1e");

    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("选择目标设备"))
            .size(22)
            .text_color("#ffffff")
            .margin(8),
    );
    let sub_title = format!("请选择要同步到的设备 · v{}", crate::PLUGIN_VERSION);
    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some(&sub_title))
            .size(13)
            .text_color("#888888")
            .margin(4),
    );

    if state.devices.is_empty() {
        // §8：完全无设备
        container = container.child(
            ui::Element::new(
                ui::ElementType::Span,
                Some("未发现设备，请通过蓝牙配对设备后重试"),
            )
            .size(14)
            .text_color("#FF9800")
            .padding(12)
            .radius(6)
            .bg("#242424")
            .margin(8),
        );
    } else {
        for device in state.devices.iter() {
            container = container.child(build_device_card(device));
        }
    }

    if !state.guard_error.is_empty() {
        container = container.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.guard_error))
                .size(13)
                .text_color("#ffffff")
                .padding(10)
                .radius(6)
                .bg("#B71C1C")
                .margin(8),
        );
    }

    container = container.child(
        ui::Element::new(ui::ElementType::Span, Some("没有找到设备？"))
            .size(13)
            .text_color("#888888")
            .margin(8),
    );
    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("刷新列表"))
            .width(300)
            .size(15)
            .text_color("#ffffff")
            .bg("#2196F3")
            .radius(8)
            .padding(12)
            .margin(8)
            .on(ui::Event::Click, "btn-refresh-devices"),
    );
    container = container.child(
        ui::Element::new(ui::ElementType::Button, Some("返回主页"))
            .width(300)
            .size(14)
            .text_color("#ffffff")
            .bg("#555555")
            .radius(8)
            .padding(10)
            .margin(8)
            .on(ui::Event::Click, "btn-back-main"),
    );

    container
}

fn build_device_card(device: &crate::device::DeviceEntry) -> ui::Element {
    let conn_text = if device.connected {
        "● 已连接"
    } else {
        "○ 离线"
    };
    let conn_color = if device.connected {
        "#4CAF50"
    } else {
        "#888888"
    };

    let ev_text = format!("EV 课程表：{}", device.ev_status.icon());
    let ev_color = device.ev_status.color();

    let mut card = ui::Element::new(ui::ElementType::Div, None)
        .border(1, "#333333")
        .radius(8)
        .padding(12)
        .margin(8);

    let title = format!("{}  {}", device.name, conn_text);
    card = card.child(
        ui::Element::new(ui::ElementType::Span, Some(&title))
            .size(16)
            .text_color(conn_color)
            .margin(2),
    );
    card = card.child(
        ui::Element::new(ui::ElementType::Span, Some(&ev_text))
            .size(13)
            .text_color(ev_color)
            .margin(2),
    );

    let mut action = ui::Element::new(ui::ElementType::Button, Some(device.action_label()))
        .width(260)
        .size(14)
        .text_color("#ffffff")
        .bg(if device.is_ready() {
            "#4CAF50"
        } else {
            "#555555"
        })
        .radius(8)
        .padding(10)
        .margin(4)
        .on(ui::Event::Click, &format!("btn-pick-device-{}", device.addr));

    if !device.is_ready() {
        action = action.disabled();
    }

    card.child(action)
}

// ────────────────────────── Demo JSON 对话框（§3.2）──────────────────────────

fn build_demo_overlay() -> ui::Element {
    let state = STATE.lock().unwrap();

    let mut box_el = ui::Element::new(ui::ElementType::Div, None)
        .bg("#2a2a2a")
        .radius(12)
        .padding(16)
        .margin(12);

    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Span, Some("快捷导入 Demo"))
            .size(18)
            .text_color("#ffffff")
            .margin(4),
    );
    box_el = box_el.child(
        ui::Element::new(
            ui::ElementType::Span,
            Some("复制下方 JSON 发给 AI 助手，让 AI 按你的课程表改好内容，再粘贴回来导入："),
        )
        .size(12)
        .text_color("#cccccc")
        .margin(4),
    );

    // Demo 全文（带注释，给 AI 读的版本）
    box_el = box_el.child(
        ui::Element::new(
            ui::ElementType::Span,
            Some(demo_template::DEMO_JSON_WITH_NOTES),
        )
        .size(9)
        .text_color("#9E9E9E")
        .bg("#1a1a1a")
        .padding(8)
        .radius(6)
        .margin(6),
    );

    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Button, Some("复制 Demo JSON"))
            .width(260)
            .size(14)
            .text_color("#ffffff")
            .bg("#9C27B0")
            .radius(8)
            .padding(10)
            .margin(6)
            .on(ui::Event::Click, "btn-copy-demo"),
    );

    if !state.demo_hint.is_empty() {
        box_el = box_el.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.demo_hint))
                .size(12)
                .text_color("#4CAF50")
                .margin(4),
        );
    }

    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Span, Some("── 把 AI 返回的 JSON 粘贴到下方 ──"))
            .size(12)
            .text_color("#888888")
            .margin(8),
    );
    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Input, None)
            .width(280)
            .height(120)
            .size(12)
            .text_color("#ffffff")
            .bg("#1a1a1a")
            .radius(8)
            .padding(8)
            .margin(6)
            .on(ui::Event::Change, "demo-paste-input"),
    );

    if !state.demo_error.is_empty() {
        box_el = box_el.child(
            ui::Element::new(ui::ElementType::Span, Some(&state.demo_error))
                .size(12)
                .text_color("#ffffff")
                .padding(8)
                .radius(6)
                .bg("#B71C1C")
                .margin(4),
        );
    }

    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Button, Some("导入已粘贴的 JSON"))
            .width(260)
            .size(15)
            .text_color("#ffffff")
            .bg("#4CAF50")
            .radius(8)
            .padding(12)
            .margin(6)
            .on(ui::Event::Click, "btn-paste-import"),
    );
    box_el = box_el.child(
        ui::Element::new(ui::ElementType::Button, Some("关闭"))
            .width(260)
            .size(14)
            .text_color("#ffffff")
            .bg("#555555")
            .radius(8)
            .padding(10)
            .margin(6)
            .on(ui::Event::Click, "btn-close-demo"),
    );

    ui::Element::new(ui::ElementType::Div, None)
        .absolute()
        .top(0)
        .left(0)
        .width_full()
        .height_full()
        .bg("#000000")
        .opacity(0.92)
        .z_index(99)
        .child(box_el)
}
