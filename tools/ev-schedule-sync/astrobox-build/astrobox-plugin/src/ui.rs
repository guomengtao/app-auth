// UI 渲染 —— 导入 / 导出 双标签页 + 覆盖式设备选择页 + Demo 对话框
//
// 布局约定（手表屏幕窄，节奏要克制）：
//   标题 → 设备卡片 → 错误横幅 → Tab 栏 → Tab 内容 → 版本号（固定在最下方）
// 每个 build_* 函数内部各自短作用域 STATE.lock()，彼此之间**不允许**嵌套调用持锁函数，
// 否则 std::sync::Mutex 不可重入会死锁。

use crate::astrobox::psys_host::{self, ui, ui_v3};
use crate::demo_template;
use crate::device::{DeviceEntry, EvInstallStatus};
use crate::models::UnifiedCourse;
use crate::{Page, STATE};

// ── 统一配色 / 尺寸常量 ──
const BG_ROOT: &str = "#191919";
const BG_CARD: &str = "#242424";
const BG_INPUT: &str = "#2b2b2b";
const FG_PRIMARY: &str = "#ffffff";
const FG_SECONDARY: &str = "#aaaaaa";
const FG_MUTED: &str = "#6f6f6f";
const ACCENT_BLUE: &str = "#2196F3";
const GREEN: &str = "#4CAF50";
const PURPLE: &str = "#9C27B0";
const ORANGE: &str = "#FF9800";
const RED: &str = "#C62828";
const GREY_BTN: &str = "#444444";

pub fn render_main_ui(element_id: &str) {
    let (page, show_demo_dialog, show_format_dialog) = {
        let state = STATE.lock().unwrap();
        (
            state.page.clone(),
            state.show_demo_dialog,
            state.show_format_dialog,
        )
    };

    let container = match page {
        Page::SelectDevice => build_select_device_page(),
        Page::EditCourse => build_edit_course_page(),
        Page::Import | Page::Export | Page::Settings => build_tabbed_page(page),
        Page::Log => build_log_page(),
    };

    if show_format_dialog {
        psys_host::ui_v3::render(element_id, container.child(build_format_overlay()));
    } else if show_demo_dialog {
        psys_host::ui_v3::render(element_id, container.child(build_demo_overlay()));
    } else {
        psys_host::ui_v3::render(element_id, container);
    }
}

// ══════════════════════════ 双标签页主界面 ═══════════════════════════

fn build_tabbed_page(page: Page) -> ui_v3::Element {
    let guard_error = {
        let state = STATE.lock().unwrap();
        state.guard_error.clone()
    };

    let mut root = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(10)
        .bg(BG_ROOT);

    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("EV 课程表同步器"))
            .size(21)
            .text_color(FG_PRIMARY)
            .margin(6),
    );

    // Tab 栏放在**标题下方**——v2 没有 scroll-area，放页面底部会滚不到、看不见
    root = root.child(build_tab_bar(&page));

    // 目标设备卡片
    root = root.child(build_device_card_banner());

    // 守卫错误
    if !guard_error.is_empty() {
        root = root.child(build_alert(&guard_error, RED));
    }

    // ── Tab 内容 ──
    root = match page {
        Page::Import => root.child(build_import_tab()),
        Page::Export => root.child(build_export_tab()),
        Page::Settings => root.child(build_settings_tab()),
        // 以下两个不会走到这里（它们有各自独立的整页），仅占位以满足穷尽匹配
        Page::SelectDevice | Page::EditCourse | Page::Log => root,
    };

    // ── 版本号固定在底部 ──
    root.child(build_footer())
}

/// 导入 ⇄ 导出 双 Tab 栏：两个按钮始终可见，当前 tab 高亮。
///
/// 采用 tab-experiment 验证过的「状态机切换」：点按钮 → 改 `state.page` → 整棵树重建。
/// 按钮用 flex(Row) 并排；若宿主版本下 flex Row 不生效（按钮竖排），切换依旧正常。
fn build_tab_bar(current: &Page) -> ui_v3::Element {
    let is_import = matches!(current, &Page::Import);
    let is_export = matches!(current, &Page::Export);
    let is_settings = matches!(current, &Page::Settings);

    ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .flex()
        .flex_direction(ui_v3::FlexDirection::Row)
        .padding(6)
        .margin(4)
        .child(tab_button("导入", is_import, GREEN, "btn-tab-import"))
        .child(tab_button("导出", is_export, ACCENT_BLUE, "btn-tab-export"))
        .child(tab_button("设置", is_settings, PURPLE, "btn-tab-settings"))
}

/// 单个 tab 按钮：激活态亮色大字，未激活态深底灰字。
///
/// 三个 tab 并排时把字号/内边距压小，避免 flex Row 在手表窄屏下溢出被挤出点不到。
fn tab_button(label: &str, active: bool, accent: &str, id: &str) -> ui_v3::Element {
    ui_v3::Element::new(ui_v3::ElementType::Button, Some(label))
        .size(if active { 14 } else { 12 })
        .text_color(if active { FG_PRIMARY } else { FG_SECONDARY })
        .bg(if active { accent } else { BG_CARD })
        .radius(10)
        .padding(8)
        .margin(1)
        .on(ui_v3::Event::Click, id)
}

fn build_import_tab() -> ui_v3::Element {
    let state = STATE.lock().unwrap();

    let mut tab = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(6)
        .bg(BG_ROOT);

    tab = tab.child(section_title("粘贴课程表 JSON"));
    // content 必须回填 state 里的值，否则「填入示例数据」后界面上仍是空白框
    // 用 v3 TEXTAREA 才能多行显示/编辑 JSON（v2 的 INPUT 是单行）
    tab = tab.child(
        ui_v3::Element::new(ui_v3::ElementType::Textarea, Some(&state.imported_json))
            .width_full()
            .height(160)
            .size(11)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "import-json-input"),
    );

    tab = tab.child(section_title("目标课程表名称"));
    tab = tab.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, Some(&state.schedule_name))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "import-name-input"),
    );

    // 一键填入最小可用示例：无需 AI 修改即可直接导入，便于验证整条导入链路
    tab = tab.child(primary_button(
        "填入示例数据",
        ORANGE,
        14,
        "btn-fill-demo",
    ));
    tab = tab.child(primary_button("导入", GREEN, 15, "import-btn"));
    tab = tab.child(primary_button(
        "用 AI 生成课表（Demo JSON）",
        PURPLE,
        14,
        "btn-show-demo",
    ));
    tab = tab.child(primary_button(
        "支持哪些格式？查看样板",
        GREY_BTN,
        13,
        "btn-show-format",
    ));

    if !state.status_message.is_empty() {
        tab = tab.child(build_alert(&state.status_message, "#2E4A33"));
    }

    tab
}

fn build_export_tab() -> ui_v3::Element {
    let state = STATE.lock().unwrap();

    let mut tab = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(6)
        .bg(BG_ROOT);

    tab = tab.child(section_title("当前课程"));

    let summary = format!("共 {} 门课程", state.courses.len());
    tab = tab.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&summary))
            .size(15)
            .text_color(if state.courses.is_empty() {
                FG_MUTED
            } else {
                FG_PRIMARY
            })
            .margin(4),
    );

    if !state.schedule_name.is_empty() {
        let name_line = format!("课程表：{}", state.schedule_name);
        tab = tab.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&name_line))
                .size(13)
                .text_color(FG_SECONDARY)
                .margin(2),
        );
    }

    // ── 逐条列出已导入的课程（v2 无 scroll-area，最多列 8 条，其余折叠成一行）──
    const MAX_LIST: usize = 8;
    if !state.courses.is_empty() {
        tab = tab.child(section_title("课程明细"));
        for (i, c) in state.courses.iter().take(MAX_LIST).enumerate() {
            tab = tab.child(build_course_row(i, c));
        }
        if state.courses.len() > MAX_LIST {
            let rest = format!(
                "… 还有 {} 门未列出（导出时全部包含）",
                state.courses.len() - MAX_LIST
            );
            tab = tab.child(
                ui_v3::Element::new(ui_v3::ElementType::Span, Some(&rest))
                    .size(11)
                    .text_color(FG_MUTED)
                    .margin(2),
            );
        }
    }

    // ── 读取并展示当前导出设置（sgschedule 用的学期参数）──
    let start_text = if state.semester_start.is_empty() {
        "2026-09-01（默认）"
    } else {
        &state.semester_start
    };
    let weeks = if state.semester_weeks == 0 {
        20
    } else {
        state.semester_weeks
    };
    let settings_text = format!("导出设置：起始 {} · {} 周", start_text, weeks);
    tab = tab.child(section_title("当前设置"));
    tab = tab.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&settings_text))
            .size(12)
            .text_color(FG_SECONDARY)
            .margin(2),
    );
    tab = tab.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("可在「设置」页修改"))
            .size(11)
            .text_color(FG_MUTED)
            .margin(2),
    );

    tab = tab.child(section_title("与手环同步"));
    tab = tab.child(primary_button(
        "从手环读取",
        ACCENT_BLUE,
        14,
        "btn-read-from-device",
    ));
    tab = tab.child(primary_button(
        "同步到手环（覆盖）",
        GREEN,
        15,
        "export-ev-btn",
    ));
    tab = tab.child(primary_button(
        "导出为 sgschedule",
        ORANGE,
        15,
        "export-sg-btn",
    ));

    // 最近一次手环回包原文：联调时一眼看清手环到底回了什么
    if !state.last_response.is_empty() {
        tab = tab.child(section_title("手环回包"));
        tab = tab.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&state.last_response))
                .size(10)
                .text_color(FG_SECONDARY)
                .bg("#141414")
                .radius(8)
                .padding(8)
                .margin(4),
        );
    }

    if !state.export_result.is_empty() {
        tab = tab.child(section_title("导出结果"));
        tab = tab.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&state.export_result))
                .size(11)
                .text_color(FG_SECONDARY)
                .bg("#141414")
                .radius(8)
                .padding(8)
                .margin(4),
        );
    }

    tab = tab.child(primary_button("清空", GREY_BTN, 13, "clear-btn"));

    tab
}

/// 课程明细里的一行：课程名 + 「周X 时间 教师 地点」+ 编辑入口
///
/// `idx` 是 `state.courses` 的 0-based 下标，按钮 id 直接带它，
/// 与设备列表用 `btn-pick-device-{addr}` 是同一套路数。
fn build_course_row(idx: usize, c: &UnifiedCourse) -> ui_v3::Element {
    let title = format!("{}. {}", idx + 1, c.name);

    let mut detail = format!("{} {}-{}", weekday_name(c.day), c.start_time, c.end_time);
    if !c.teacher.is_empty() {
        detail.push(' ');
        detail.push_str(&c.teacher);
    }
    if !c.location.is_empty() {
        detail.push(' ');
        detail.push_str(&c.location);
    }

    let mut row = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg(BG_CARD)
        .radius(8)
        .padding(7)
        .margin(3);

    row = row.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&title))
            .size(13)
            .text_color(FG_PRIMARY)
            .margin(1),
    );
    row = row.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&detail))
            .size(11)
            .text_color(FG_SECONDARY)
            .margin(1),
    );

    row = row.child(
        ui_v3::Element::new(ui_v3::ElementType::Button, Some("编辑"))
            .width_full()
            .size(12)
            .text_color(FG_PRIMARY)
            .bg(ACCENT_BLUE)
            .radius(6)
            .padding(6)
            .margin(1)
            .on(ui_v3::Event::Click, &format!("btn-edit-course-{}", idx)),
    );

    row
}

fn weekday_name(day: u8) -> &'static str {
    match day {
        1 => "周一",
        2 => "周二",
        3 => "周三",
        4 => "周四",
        5 => "周五",
        6 => "周六",
        7 => "周日",
        _ => "?",
    }
}

// ══════════════════════════ 目标设备 ══════════════════════════

fn build_device_card_banner() -> ui_v3::Element {
    // 取选中设备：名字 + EV 安装状态 + 是否已连接（从 state.devices 里按 addr 查）
    let (name, ev_status, connected) = {
        let state = STATE.lock().unwrap();
        let addr = state.selected_device_addr.clone();
        match &addr {
            Some(a) => state
                .devices
                .iter()
                .find(|d| d.addr == *a)
                .map(|d| (d.name.clone(), d.ev_status.clone(), d.connected))
                .unwrap_or_else(|| {
                    (
                        state.selected_device_name.clone().unwrap_or_default(),
                        EvInstallStatus::Unknown,
                        false,
                    )
                }),
            None => (String::new(), EvInstallStatus::Unknown, false),
        }
    };

    let has_device = !name.is_empty();

    // 容器：已选设备时用偏绿高亮背景，让这张卡在页面里「跳」出来；未选时普通卡色
    let mut card = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg(if has_device { "#1f3326" } else { BG_CARD })
        .radius(12)
        .padding(12)
        .margin(6);

    // 小标签
    card = card.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("目标设备"))
            .size(11)
            .text_color(FG_MUTED)
            .margin(2),
    );

    if has_device {
        // 设备名：大号、醒目白字
        card = card.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&name))
                .size(18)
                .text_color(FG_PRIMARY)
                .margin(2),
        );

        // EV 课程表 连接状态：彩色大字号，一眼看清
        let (ev_label, ev_color) = match ev_status {
            EvInstallStatus::Installed => ("EV 课程表：已连接", GREEN),
            EvInstallStatus::NotInstalled => ("EV 课程表：未安装", RED),
            EvInstallStatus::Unknown => ("EV 课程表：状态未知", ORANGE),
            EvInstallStatus::Checking => ("EV 课程表：检测中…", ORANGE),
        };
        card = card.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(ev_label))
                .size(15)
                .text_color(ev_color)
                .margin(4),
        );

        // 设备连接状态（与 EV 区分开，小字）
        let conn_text = if connected { "设备已连接" } else { "设备离线" };
        let conn_color = if connected { GREEN } else { FG_MUTED };
        card = card.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(conn_text))
                .size(11)
                .text_color(conn_color)
                .margin(2),
        );
    } else {
        card = card.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some("未选择目标设备"))
                .size(16)
                .text_color(ORANGE)
                .margin(2),
        );
    }

    card = card.child(
        ui_v3::Element::new(ui_v3::ElementType::Button, Some("切换设备"))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(ACCENT_BLUE)
            .radius(8)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Click, "btn-goto-select-device"),
    );

    card
}

fn build_select_device_page() -> ui_v3::Element {
    let (devices, guard_error) = {
        let state = STATE.lock().unwrap();
        (state.devices.clone(), state.guard_error.clone())
    };

    let mut root = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(10)
        .bg(BG_ROOT);

    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("选择目标设备"))
            .size(21)
            .text_color(FG_PRIMARY)
            .margin(6),
    );

    let sub = format!("请选择要同步到的设备 · v{}", crate::PLUGIN_VERSION);
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&sub))
            .size(12)
            .text_color(FG_MUTED)
            .margin(2),
    );

    if devices.is_empty() {
        root = root.child(build_alert(
            "未发现设备，请通过蓝牙配对设备后重试",
            ORANGE,
        ));
    } else {
        for d in devices.iter() {
            root = root.child(build_device_row(d));
        }
    }

    if !guard_error.is_empty() {
        root = root.child(build_alert(&guard_error, RED));
    }

    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("没有找到设备？"))
            .size(12)
            .text_color(FG_MUTED)
            .margin(6),
    );
    root = root.child(primary_button("刷新列表", ACCENT_BLUE, 14, "btn-refresh-devices"));
    root = root.child(primary_button("返回", GREY_BTN, 13, "btn-back-main"));

    root.child(build_footer())
}

// ══════════════════════════ 设置页 ══════════════════════════

/// 设置 Tab 的内容（与 导入 / 导出 共享同一套 tab 栏 + 页脚）。
///
/// 第一个区块就是「手环昵称」读测试：点「读昵称」通过 `{action:"export"}` 取回，
/// 手环白名单里 `profile(nickname)` 默认开放（read:"always"），应能直接读到；
/// 读到的昵称与原始回包都显示出来，一眼确认互通有没有打通。
/// 连接状态按钮：显示当前 EV 课程表的连接状态与版本号，按钮样式。
/// 点击触发 ping 刷新版本号。满足「连接成功的通知改为按钮方式展示」。
fn build_conn_status_button() -> ui_v3::Element {
    let (name, ev_status, connected, version_name, version_code) = {
        let state = STATE.lock().unwrap();
        let addr = state.selected_device_addr.clone();
        let entry = addr
            .as_ref()
            .and_then(|a| state.devices.iter().find(|d| d.addr == *a).cloned());
        (
            state.selected_device_name.clone().unwrap_or_default(),
            entry
                .as_ref()
                .map(|d| d.ev_status.clone())
                .unwrap_or(EvInstallStatus::Unknown),
            entry.as_ref().map(|d| d.connected).unwrap_or(false),
            state.version_name.clone(),
            state.version_code.clone(),
        )
    };

    let (label, color): (String, &str) = if name.is_empty() {
        ("未连接设备（点「切换设备」选择）".to_string(), GREY_BTN)
    } else if ev_status == EvInstallStatus::Installed && connected {
        if version_name.is_empty() && version_code.is_empty() {
            (format!("已连接 EV 课程表 · {}", name), GREEN)
        } else {
            (
                format!("已连接 EV 课程表 v{}（code {}）", version_name, version_code),
                GREEN,
            )
        }
    } else if ev_status == EvInstallStatus::Installed {
        (format!("EV 已安装但设备离线：{}", name), ORANGE)
    } else {
        (format!("EV 课程表状态：{}", ev_status.icon()), ev_status.color())
    };

    primary_button(&label, color, 13, "btn-conn-status")
}

fn build_settings_tab() -> ui_v3::Element {
    let (semester_start, semester_weeks, status_message, nickname, edit_nickname, last_response, version_name, version_code) = {
        let state = STATE.lock().unwrap();
        (
            state.semester_start.clone(),
            state.semester_weeks,
            state.status_message.clone(),
            state.nickname.clone(),
            state.edit_nickname.clone(),
            state.last_response.clone(),
            state.version_name.clone(),
            state.version_code.clone(),
        )
    };

    let mut root = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(6)
        .bg(BG_ROOT);

    root = root.child(section_title("设置"));
    // 连接状态按钮（按钮方式展示「连接成功的通知」），点击可刷新版本号
    root = root.child(build_conn_status_button());

    // ── ① 昵称读测试（置顶，先验证能不能读到）──
    root = root.child(section_title("手环昵称（读测试）"));
    if nickname.is_empty() {
        root = root.child(
            ui_v3::Element::new(
                ui_v3::ElementType::Span,
                Some("尚未读取，点下方「读昵称」验证能否读到"),
            )
            .size(12)
            .text_color(FG_MUTED)
            .margin(2),
        );
    } else {
        let cur = format!("当前昵称：{}", nickname);
        root = root.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&cur))
                .size(14)
                .text_color(GREEN)
                .margin(2),
        );
    }
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, Some(&edit_nickname))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "edit-nickname-input"),
    );
    root = root.child(primary_button(
        "读昵称（从手环）",
        ACCENT_BLUE,
        14,
        "btn-read-from-device",
    ));
    root = root.child(primary_button("保存昵称", GREEN, 13, "btn-save-nickname"));

    // 手环回包原文：联调时直接看手环到底回了什么（含 nickname 字段）
    if !last_response.is_empty() {
        root = root.child(section_title("手环回包（含 nickname）"));
        root = root.child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&last_response))
                .size(10)
                .text_color(FG_SECONDARY)
                .bg("#141414")
                .radius(8)
                .padding(8)
                .margin(4),
        );
    }

    // ── ② 手环版本号（只读，随读昵称一起回传）──
    root = root.child(section_title("手环版本（只读）"));
    let ver_text = if version_name.is_empty() && version_code.is_empty() {
        "尚未读取".to_string()
    } else {
        format!("{}（code {}）", version_name, version_code)
    };
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&ver_text))
            .size(14)
            .text_color(if version_name.is_empty() { FG_MUTED } else { FG_PRIMARY })
            .margin(2),
    );
    root = root.child(primary_button("读版本号（从手环）", ACCENT_BLUE, 13, "btn-read-from-device"));
    root = root.child(primary_button("Ping 探针（验证通道双向通）", PURPLE, 13, "btn-ping"));
    // EV 快应用的 interconnect 接收器只在它自己的 onCreate 里注册；没在运行就收不到回包。
    // 这个按钮用手环 API 启动它（唤醒接收器），启动后再点 Ping 通常就能收到 pong。
    root = root.child(primary_button("启动 EV 课程表（唤醒接收器）", GREEN, 13, "btn-launch-ev"));
    root = root.child(primary_button("查看运行日志", ORANGE, 13, "btn-open-log"));

    // 一直没收到回包的排查提示（目前联调唯一卡点，用醒目色 + 具体步骤）
    if last_response.is_empty() {
        root = root.child(
            ui_v3::Element::new(
                ui_v3::ElementType::Span,
                Some("⚠️ 收不到回包（ping 无 pong）怎么查：① 手环上打开「EV 课程表」→ 设置 → 开启「后台运行」(system.resident)，并让 EV 课程表保持前台/常驻；② 确认 EV 课程表 manifest 声明了 system.interconnect，且包名/签名与手机端一致。通道单向时插件 send 会 Ok，但永远收不到回包。"),
            )
            .size(11)
            .text_color(ORANGE)
            .bg("#241a0a")
            .radius(8)
            .padding(8)
            .margin(4),
        );
    }

    // ── 导出设置（sgschedule 用）──
    // 学期开始日期
    root = root.child(section_title("学期开始日期"));
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, Some(&semester_start))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "settings-start-input"),
    );

    // 学期周数
    let weeks_text = if semester_weeks == 0 {
        String::new()
    } else {
        semester_weeks.to_string()
    };
    root = root.child(section_title("学期总周数"));
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, Some(&weeks_text))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "settings-weeks-input"),
    );

    root = root.child(
        ui_v3::Element::new(
            ui_v3::ElementType::Span,
            Some("用于导出 sgschedule 格式。日期格式 YYYY-MM-DD，周数 1-52；留空则用默认 2026-09-01 / 20 周。"),
        )
        .size(11)
        .text_color(FG_MUTED)
        .margin(4),
    );

    root = root.child(primary_button("保存设置", GREEN, 15, "btn-save-settings"));

    if !status_message.is_empty() {
        root = root.child(build_alert(&status_message, "#2E4A33"));
    }

    root
}

/// 运行日志页：把内存里累积的排错信息（按钮点击 / 注册 / 发送 / 收到回包 / 解析结果）
/// 全部渲染出来。WASI 没有系统日志，这是唯一能看到「点了没反应」到底卡在哪一步的地方。
fn build_log_page() -> ui_v3::Element {
    let (lines, status_message) = {
        let state = STATE.lock().unwrap();
        (state.log_lines.clone(), state.status_message.clone())
    };

    let mut root = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(10)
        .bg(BG_ROOT);

    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("运行日志"))
            .size(18)
            .text_color(FG_PRIMARY)
            .margin(6),
    );

    // 操作反馈
    if !status_message.is_empty() {
        root = root.child(build_alert(&status_message, "#2E4A33"));
    }

    // 日志放进可选中/可滚动的 TEXTAREA。原因：复制按钮的 clipboard::write_text 在本宿主不可用，
    // 所以用文本框让用户手动滚动 + 选中复制。布局与「导入」页 JSON 文本框一致（文本框在上、按钮在下），
    // 该布局已被真机验证按钮可点。文本框固定高度，内容多时内部滚动，不会把下方按钮顶出屏。
    let text = if lines.is_empty() {
        "暂无日志。点任意按钮（如「读昵称」「同步到手环」）后，这里会记录每一步。".to_string()
    } else {
        lines.join("\n")
    };
    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Textarea, Some(&text))
            .width_full()
            .height(160)
            .size(11)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(10)
            .padding(8)
            .margin(4)
            // 必须挂 Change 处理器：离开本页时宿主触发 textarea 的 change/blur 事件，
            // 无处理器会报「Plugin thread dropped the response」崩溃。
            .on(ui_v3::Event::Change, "log-textarea"),
    );

    // 按钮放文本框下方（与导入页一致；文本框固定高度，按钮不会被顶出屏）
    root = root.child(primary_button("返回", GREY_BTN, 14, "btn-back-main"));
    root = root.child(primary_button("清空日志", GREY_BTN, 13, "btn-clear-log"));

    root.child(build_footer())
}

fn build_device_row(d: &DeviceEntry) -> ui_v3::Element {
    let conn_text = if d.connected { "● 已连接" } else { "○ 离线" };
    let conn_color = if d.connected { GREEN } else { FG_MUTED };
    let ev_text = format!("EV 课程表：{}", d.ev_status.icon());
    let ev_color = d.ev_status.color();
    let ready = d.is_ready();

    let mut card = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg(BG_CARD)
        .radius(10)
        .padding(10)
        .margin(6);

    let title = format!("{}  {}", d.name, conn_text);
    card = card.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&title))
            .size(15)
            .text_color(conn_color)
            .margin(2),
    );
    card = card.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&ev_text))
            .size(12)
            .text_color(ev_color)
            .margin(2),
    );

    // ── 诊断信息：os 接口没有写日志/写文件能力，只能把宿主返回的原始数据直接显示出来 ──
    let diag_color = if d.query_error { ORANGE } else { FG_MUTED };
    let diag_text = if d.query_error {
        d.sample_pkgs.clone()
    } else {
        format!("应用 {} 个：{}", d.app_count, d.sample_pkgs)
    };
    card = card.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(&diag_text))
            .size(10)
            .text_color(diag_color)
            .margin(2),
    );

    let mut action = ui_v3::Element::new(ui_v3::ElementType::Button, Some(d.action_label()))
        .width_full()
        .size(13)
        .text_color(FG_PRIMARY)
        .bg(if ready { GREEN } else { GREY_BTN })
        .radius(8)
        .padding(9)
        .margin(4)
        .on(ui_v3::Event::Click, &format!("btn-pick-device-{}", d.addr));

    if !ready {
        action = action.disabled();
    }

    card.child(action)
}

// ══════════════════════════ Demo JSON 对话框 ══════════════════════════

fn build_demo_overlay() -> ui_v3::Element {
    let (demo_hint, demo_error) = {
        let state = STATE.lock().unwrap();
        (state.demo_hint.clone(), state.demo_error.clone())
    };

    let mut dialog = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg("#262626")
        .radius(14)
        .padding(10)
        .margin(10);

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("快捷导入 Demo"))
            .size(18)
            .text_color(FG_PRIMARY)
            .margin(4),
    );
    dialog = dialog.child(
        ui_v3::Element::new(
            ui_v3::ElementType::Span,
            Some("复制下方 JSON 发给 AI 助手，改好内容后再粘贴回来导入："),
        )
        .size(12)
        .text_color(FG_SECONDARY)
        .margin(4),
    );

    dialog = dialog.child(
        ui_v3::Element::new(
            ui_v3::ElementType::Span,
            Some(demo_template::DEMO_JSON_WITH_NOTES),
        )
        .size(9)
        .text_color("#8a8a8a")
        .bg("#161616")
        .radius(8)
        .padding(8)
        .margin(6),
    );

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Button, Some("复制 Demo JSON"))
            .width_full()
            .size(14)
            .text_color(FG_PRIMARY)
            .bg(PURPLE)
            .radius(8)
            .padding(10)
            .margin(6)
            .on(ui_v3::Event::Click, "btn-copy-demo"),
    );

    if !demo_hint.is_empty() {
        dialog = dialog.child(build_alert(&demo_hint, GREEN));
    }

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("── 粘贴 AI 返回的 JSON ──"))
            .size(12)
            .text_color(FG_MUTED)
            .margin(6),
    );
    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, None)
            .width_full()
            .height(88)
            .size(12)
            .text_color(FG_PRIMARY)
            .bg("#161616")
            .radius(8)
            .padding(8)
            .margin(4)
            .on(ui_v3::Event::Change, "demo-paste-input"),
    );

    if !demo_error.is_empty() {
        dialog = dialog.child(build_alert(&demo_error, RED));
    }

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Button, Some("导入已粘贴的 JSON"))
            .width_full()
            .size(15)
            .text_color(FG_PRIMARY)
            .bg(GREEN)
            .radius(8)
            .padding(11)
            .margin(6)
            .on(ui_v3::Event::Click, "btn-paste-import"),
    );
    dialog = dialog.child(primary_button("关闭", GREY_BTN, 13, "btn-close-demo"));

    ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .absolute()
        .top(0)
        .left(0)
        .width_full()
        .height_full()
        .bg("#000000")
        .opacity(0.93)
        .z_index(99)
        .child(dialog)
}

// ══════════════════════════ 课程编辑页 ══════════════════════════

/// 编辑单门课程的独立页面。
///
/// 课程数据本来就完整存在插件内存的 `state.courses` 里，所以改名、改时间、改教室
/// **都不需要 EV 课程表或设备配合**，纯本地修改；改完再导出即可。
fn build_edit_course_page() -> ui_v3::Element {
    let s = {
        let state = STATE.lock().unwrap();
        (
            state.edit_name.clone(),
            state.edit_teacher.clone(),
            state.edit_location.clone(),
            state.edit_day,
            state.edit_start.clone(),
            state.edit_end.clone(),
            state.edit_weeks.clone(),
            state.edit_week_type.clone(),
            state.edit_error.clone(),
        )
    };
    let (name, teacher, location, day, start, end, weeks, week_type, edit_error) = s;

    let mut root = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(10)
        .bg(BG_ROOT);

    root = root.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("编辑课程"))
            .size(21)
            .text_color(FG_PRIMARY)
            .margin(6),
    );

    root = root.child(edit_field("课程名称", &name, "edit-name-input"));
    root = root.child(edit_field("教师", &teacher, "edit-teacher-input"));
    root = root.child(edit_field("地点", &location, "edit-location-input"));
    root = root.child(edit_field("星期（1-7）", &day.to_string(), "edit-day-input"));
    root = root.child(edit_field("开始时间（HH:MM）", &start, "edit-start-input"));
    root = root.child(edit_field("结束时间（HH:MM）", &end, "edit-end-input"));
    root = root.child(edit_field("周次（如 1,2,3）", &weeks, "edit-weeks-input"));
    root = root.child(edit_field("周类型 all/odd/even", &week_type, "edit-weektype-input"));

    if !edit_error.is_empty() {
        root = root.child(build_alert(&edit_error, RED));
    }

    root = root.child(primary_button("保存修改", GREEN, 15, "btn-save-course"));
    root = root.child(primary_button("删除这门课", RED, 13, "btn-delete-course"));
    root = root.child(primary_button("返回", GREY_BTN, 13, "btn-back-main"));

    root.child(build_footer())
}

/// 编辑页里的一个带标题的输入框
fn edit_field(label: &str, value: &str, id: &str) -> ui_v3::Element {
    let mut box_el = ui_v3::Element::new(ui_v3::ElementType::Div, None).padding(2);

    box_el = box_el.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(label))
            .size(11)
            .text_color(FG_SECONDARY)
            .margin(1),
    );
    box_el = box_el.child(
        ui_v3::Element::new(ui_v3::ElementType::Input, Some(value))
            .width_full()
            .size(13)
            .text_color(FG_PRIMARY)
            .bg(BG_INPUT)
            .radius(8)
            .padding(7)
            .margin(1)
            .on(ui_v3::Event::Change, id),
    );

    box_el
}

// ══════════════════════════ 支持格式与样板 ══════════════════════════

/// 「支持哪些格式」查看对话框 —— 内容取自 `docs/` 下两份格式分析文档
fn build_format_overlay() -> ui_v3::Element {
    let mut dialog = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg("#262626")
        .radius(14)
        .padding(10)
        .margin(10);

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("支持的导入来源"))
            .size(18)
            .text_color(FG_PRIMARY)
            .margin(4),
    );

    for (name, desc) in demo_template::SUPPORTED_PLATFORMS.iter() {
        dialog = dialog.child(build_platform_row(name, desc));
    }

    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some("各格式样板"))
            .size(15)
            .text_color(FG_PRIMARY)
            .margin(8),
    );
    dialog = dialog.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(demo_template::FORMAT_SAMPLES))
            .size(9)
            .text_color("#8a8a8a")
            .bg("#161616")
            .radius(8)
            .padding(8)
            .margin(4),
    );

    dialog = dialog.child(primary_button("关闭", GREY_BTN, 14, "btn-close-format"));

    ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .absolute()
        .top(0)
        .left(0)
        .width_full()
        .height_full()
        .bg("#000000")
        .opacity(0.94)
        .z_index(98)
        .child(dialog)
}

fn build_platform_row(name: &str, desc: &str) -> ui_v3::Element {
    let mut row = ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .bg(BG_CARD)
        .radius(8)
        .padding(8)
        .margin(3);

    row = row.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(name))
            .size(13)
            .text_color(FG_PRIMARY)
            .margin(1),
    );
    row = row.child(
        ui_v3::Element::new(ui_v3::ElementType::Span, Some(desc))
            .size(11)
            .text_color(FG_MUTED)
            .margin(1),
    );

    row
}

// ══════════════════════════ 通用组件 ══════════════════════════

/// 分区小标题（v2 无 scroll-area，间距刻意压小以换取首屏可见内容）
fn section_title(text: &str) -> ui_v3::Element {
    ui_v3::Element::new(ui_v3::ElementType::Span, Some(text))
        .size(13)
        .text_color(FG_SECONDARY)
        .margin(4)
}

/// 通栏主按钮
fn primary_button(label: &str, bg: &str, size: u32, id: &str) -> ui_v3::Element {
    ui_v3::Element::new(ui_v3::ElementType::Button, Some(label))
        .width_full()
        .size(size)
        .text_color(FG_PRIMARY)
        .bg(bg)
        .radius(10)
        .padding(9)
        .margin(3)
        .on(ui_v3::Event::Click, id)
}

/// 提示 / 警告横幅
fn build_alert(text: &str, color: &str) -> ui_v3::Element {
    ui_v3::Element::new(ui_v3::ElementType::Span, Some(text))
        .size(12)
        .text_color(FG_PRIMARY)
        .bg(color)
        .radius(8)
        .padding(9)
        .margin(5)
}

/// 页脚 —— 版本号 + 当前页面名。
///
/// 带页面名是为了排错：如果点了「前往导出」但这里仍显示 `导入`，
/// 说明事件没触发或 render 没生效；若版本号不是最新，说明新包根本没装上。
fn build_footer() -> ui_v3::Element {
    let page_name = {
        let state = STATE.lock().unwrap();
        match state.page {
            Page::Import => "导入",
            Page::Export => "导出",
            Page::SelectDevice => "选设备",
            Page::Settings => "设置",
            Page::EditCourse => "编辑课程",
            Page::Log => "日志",
        }
    };

    let footer_text = format!("v{} · 当前:{}", crate::PLUGIN_VERSION, page_name);
    ui_v3::Element::new(ui_v3::ElementType::Div, None)
        .padding(10)
        .margin(4)
        .child(
            ui_v3::Element::new(ui_v3::ElementType::Span, Some(&footer_text))
                .size(11)
                .text_color(FG_MUTED)
                .margin(2),
        )
}