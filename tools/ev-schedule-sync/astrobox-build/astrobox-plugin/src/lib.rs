use wit_bindgen::rt::async_support::{FutureReader, future_new};
use wit_bindgen::spawn;
use std::sync::Mutex;

wit_bindgen::generate!({
    path: "wit",
    world: "psys-world",
    generate_all,
});

use exports::astrobox::psys_plugin::{
    event::{self, EventType},
    lifecycle,
};

use crate::astrobox::psys_host::ui::Event as UiEvent;
use crate::astrobox::psys_host::clipboard;

pub mod logger;
pub mod ui;
pub mod resources;
pub mod models;
pub mod adapters;
pub mod import_engine;
pub mod export_engine;
pub mod device;
pub mod demo_template;

use models::{UnifiedCourse, UnifiedSchedule};
use adapters::FormatType;
use device::{DeviceEntry, EvInstallStatus};

/// 插件版本号。
///
/// ⚠️ 必须与 `manifest.json` 的 `version` **保持一致**（打包前核对一次）。
/// 之所以在界面上显示它：设备里到底装成功了哪个版本，光看文件名很容易搞混，
/// 打开插件看一眼版本号是最快的核对方式（也方便远程让用户报版本排查）。
pub const PLUGIN_VERSION: &str = "1.0.20";

/// DESIGN.md §1.5 的页面状态机：主页 → 选择设备 → 导入/导出
#[derive(Clone, Debug, PartialEq)]
pub enum Page {
    Main,
    SelectDevice,
}

struct PluginState {
    // ── 原有：导入导出数据 ──
    imported_json: String,
    schedule_name: String,
    courses: Vec<UnifiedCourse>,
    last_format: Option<FormatType>,
    status_message: String,
    export_result: String,
    render_target: String,

    // ── 新增（DESIGN.md §5）──
    page: Page,
    devices: Vec<DeviceEntry>,
    selected_device_addr: Option<String>,
    selected_device_name: Option<String>,
    /// §2.2 守卫不通过时的错误提示，空串表示通过
    guard_error: String,
    show_demo_dialog: bool,
    demo_pasted: String,
    /// Demo JSON 校验/解析的错误，显示在粘贴框下方
    demo_error: String,
    /// 「复制 Demo JSON」之后的轻提示
    demo_hint: String,
}

impl PluginState {
    const fn new() -> Self {
        Self {
            imported_json: String::new(),
            schedule_name: String::new(),
            courses: Vec::new(),
            last_format: None,
            status_message: String::new(),
            export_result: String::new(),
            render_target: String::new(),

            page: Page::Main,
            devices: Vec::new(),
            selected_device_addr: None,
            selected_device_name: None,
            guard_error: String::new(),
            show_demo_dialog: false,
            demo_pasted: String::new(),
            demo_error: String::new(),
            demo_hint: String::new(),
        }
    }
}

static STATE: Mutex<PluginState> = Mutex::new(PluginState::new());

struct EvScheduleSyncPlugin;

fn make_empty_string_future() -> FutureReader<String> {
    let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
    spawn(async move {
        let _ = writer.write(String::new()).await;
    });
    reader
}

fn make_empty_unit_future() -> FutureReader<()> {
    let vtable = &<() as crate::wit_future::FuturePayload>::VTABLE;
    let (writer, reader) = unsafe { future_new::<()>(|| (), vtable) };
    spawn(async move {
        let _ = writer.write(()).await;
    });
    reader
}

impl lifecycle::Guest for EvScheduleSyncPlugin {
    fn on_load() {
        logger::init();
    }
}

impl event::Guest for EvScheduleSyncPlugin {
    fn on_event(_event_type: EventType, _event_payload: String) -> FutureReader<String> {
        make_empty_string_future()
    }

    fn on_ui_event(
        event_id: String,
        event: event::Event,
        event_payload: String,
    ) -> FutureReader<String> {
        let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };

        spawn(async move {
            let needs_render = handle_ui_event_inner(&event_id, &event, &event_payload).await;
            if needs_render {
                let target = STATE.lock().unwrap().render_target.clone();
                if !target.is_empty() {
                    ui::render_main_ui(&target);
                }
            }
            let _ = writer.write(String::new()).await;
        });

        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        {
            let mut state = STATE.lock().unwrap();
            state.render_target = element_id.clone();
        }
        ui::render_main_ui(&element_id);
        make_empty_unit_future()
    }

    fn on_card_render(card_id: String) -> FutureReader<()> {
        let text = {
            let state = STATE.lock().unwrap();
            if state.courses.is_empty() {
                "EV Schedule Sync\nTap to import schedule data".to_string()
            } else {
                format!(
                    "{} ({} courses)",
                    state.schedule_name,
                    state.courses.len()
                )
            }
        };
        crate::astrobox::psys_host::ui::render_to_text_card(&card_id, &text);
        make_empty_unit_future()
    }
}

/// DESIGN.md §2.1 守卫检查：Ok = 允许操作；Err = 给用户的提示文案
fn check_guard(state: &PluginState) -> Result<(), String> {
    let addr = match &state.selected_device_addr {
        Some(a) => a.clone(),
        None => return Err("请先选择目标设备".to_string()),
    };

    let device = state
        .devices
        .iter()
        .find(|d| &d.addr == &addr)
        .ok_or_else(|| "已选设备已失效，请重新选择".to_string())?;

    if !device.connected {
        return Err(format!("设备「{}」已断开连接，请重新连接", device.name));
    }
    if device.ev_status != EvInstallStatus::Installed {
        return Err(format!("设备「{}」上未安装 EV 课程表，请先安装", device.name));
    }
    Ok(())
}

/// 取当前守卫错误；None 表示通过
fn current_guard_error() -> Option<String> {
    check_guard(&STATE.lock().unwrap()).err()
}

/// 把守卫错误写进 state（页面顶部横幅会显示）
fn fail_guard() -> bool {
    if let Some(err) = current_guard_error() {
        STATE.lock().unwrap().guard_error = err;
        return true;
    }
    false
}

async fn handle_ui_event_inner(event_id: &str, event: &event::Event, event_payload: &str) -> bool {
    match event {
        UiEvent::Change => {
            let mut state = STATE.lock().unwrap();
            match event_id {
                "import-json-input" => state.imported_json = event_payload.to_string(),
                "import-name-input" => state.schedule_name = event_payload.to_string(),
                "demo-paste-input" => state.demo_pasted = event_payload.to_string(),
                _ => {}
            }
            false
        }
        UiEvent::Click => match event_id {
            // ── 设备选择（DESIGN.md §1）──
            "btn-goto-select-device" | "btn-refresh-devices" => {
                let devices = device::fetch_devices().await;
                let mut state = STATE.lock().unwrap();
                state.devices = devices;
                state.page = Page::SelectDevice;
                state.guard_error.clear();
                true
            }
            "btn-back-main" => {
                STATE.lock().unwrap().page = Page::Main;
                true
            }
            id if id.starts_with("btn-pick-device-") => {
                let addr = id.trim_start_matches("btn-pick-device-").to_string();
                let mut state = STATE.lock().unwrap();
                let picked = state.devices.iter().find(|d| d.addr == addr).cloned();
                match picked {
                    Some(d) if d.is_ready() => {
                        state.selected_device_addr = Some(d.addr);
                        state.selected_device_name = Some(d.name.clone());
                        state.guard_error.clear();
                        state.page = Page::Main;
                        state.status_message = format!("已选择设备「{}」", d.name);
                    }
                    Some(d) => {
                        state.guard_error = match d.ev_status {
                            EvInstallStatus::NotInstalled => format!(
                                "设备「{}」未找到 EV 课程表（{}），请先安装后再同步",
                                d.name,
                                device::EV_PACKAGE_NAME
                            ),
                            EvInstallStatus::Unknown => format!(
                                "无法读取设备「{}」的应用列表，请点刷新重试",
                                d.name
                            ),
                            EvInstallStatus::Checking => "设备仍在检测中，请稍候".to_string(),
                            EvInstallStatus::Installed => {
                                format!("设备「{}」已离线，请先连接", d.name)
                            }
                        };
                    }
                    None => state.guard_error = "设备不存在，请刷新列表".to_string(),
                }
                true
            }

            // ── Demo JSON 对话框（DESIGN.md §3）──
            "btn-show-demo" => {
                let mut state = STATE.lock().unwrap();
                state.show_demo_dialog = true;
                state.demo_error.clear();
                state.demo_hint.clear();
                true
            }
            "btn-close-demo" => {
                let mut state = STATE.lock().unwrap();
                state.show_demo_dialog = false;
                state.demo_error.clear();
                true
            }
            "btn-copy-demo" => {
                let demo_text = demo_template::demo_json_text();
                let ok = clipboard::write_text(&demo_text).await.is_ok();
                STATE.lock().unwrap().demo_hint = if ok {
                    "已复制到剪贴板，发给 AI 助手即可".to_string()
                } else {
                    "复制失败，请手动长按选中复制".to_string()
                };
                true
            }
            "btn-paste-import" => {
                let pasted = STATE.lock().unwrap().demo_pasted.clone();
                if pasted.trim().is_empty() {
                    STATE.lock().unwrap().demo_error =
                        "请先把 AI 返回的 JSON 粘贴到输入框".to_string();
                    return true;
                }
                // §2.3：执行导入前再查一次守卫
                if fail_guard() {
                    return true;
                }
                match adapters::demo::parse(&pasted) {
                    Ok(courses) => {
                        let count = courses.len();
                        let name = adapters::demo::extract_schedule_name(&pasted)
                            .unwrap_or_else(|| "导入的课程表".to_string());
                        let mut state = STATE.lock().unwrap();
                        state.courses = courses;
                        state.schedule_name = name.clone();
                        state.last_format = Some(FormatType::DemoSchedule);
                        state.status_message =
                            format!("已从 Demo JSON 导入 {} 门课程（{}）", count, name);
                        state.demo_error.clear();
                        state.demo_pasted.clear();
                        state.show_demo_dialog = false;
                        state.export_result.clear();
                    }
                    Err(e) => {
                        STATE.lock().unwrap().demo_error = format!("{}", e);
                    }
                }
                true
            }

            // ── 原有导入导出，统一加上守卫（§2.3）──
            "import-btn" => {
                if fail_guard() {
                    return true;
                }
                let (json, name) = {
                    let state = STATE.lock().unwrap();
                    (state.imported_json.clone(), state.schedule_name.clone())
                };
                if json.trim().is_empty() {
                    STATE.lock().unwrap().status_message =
                        "请先粘贴课程表 JSON 数据".to_string();
                    return true;
                }
                match import_engine::import_from_json(&json, &name) {
                    Ok(result) => {
                        let mut state = STATE.lock().unwrap();
                        state.courses = result.courses.clone();
                        state.last_format = Some(result.format.clone());
                        state.schedule_name = result.schedule_name.clone();
                        state.status_message = format!(
                            "已导入 {} 门课程（格式：{}）。",
                            result.total_count,
                            result.format.display_name()
                        );
                        state.guard_error.clear();
                        state.export_result.clear();
                    }
                    Err(e) => {
                        STATE.lock().unwrap().status_message = format!("导入失败：{}", e);
                    }
                }
                true
            }
            "export-ev-btn" => {
                if fail_guard() {
                    return true;
                }
                let (courses, name) = {
                    let state = STATE.lock().unwrap();
                    (state.courses.clone(), state.schedule_name.clone())
                };
                if courses.is_empty() {
                    STATE.lock().unwrap().status_message = "还没有课程，请先导入".to_string();
                    return true;
                }
                let json = export_engine::export_as_evschedule(&UnifiedSchedule {
                    id: "ev-sync-1".to_string(),
                    name,
                    courses,
                });
                let mut state = STATE.lock().unwrap();
                state.export_result = json;
                state.status_message =
                    format!("已导出 {} 门课程（EV 课程表格式）", state.courses.len());
                true
            }
            "export-sg-btn" => {
                if fail_guard() {
                    return true;
                }
                let courses = STATE.lock().unwrap().courses.clone();
                if courses.is_empty() {
                    STATE.lock().unwrap().status_message = "还没有课程，请先导入".to_string();
                    return true;
                }
                let json = export_engine::export_as_sgschedule(&courses, "2024-09-01", 20);
                let mut state = STATE.lock().unwrap();
                state.export_result = json;
                state.status_message =
                    format!("已导出 {} 门课程（sgschedule 格式）", state.courses.len());
                true
            }
            "clear-btn" => {
                // 保留已选设备，其余清空
                let (page, devices, addr, dev_name) = {
                    let state = STATE.lock().unwrap();
                    (
                        state.page.clone(),
                        state.devices.clone(),
                        state.selected_device_addr.clone(),
                        state.selected_device_name.clone(),
                    )
                };
                let mut fresh = PluginState::new();
                fresh.page = page;
                fresh.devices = devices;
                fresh.selected_device_addr = addr;
                fresh.selected_device_name = dev_name;
                *STATE.lock().unwrap() = fresh;
                true
            }
            _ => false,
        },
        _ => false,
    }
}

export!(EvScheduleSyncPlugin);