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
use crate::astrobox::psys_host::{clipboard, interconnect, register, thirdpartyapp, timer};

pub mod logger;
pub mod ui;
pub mod resources;
pub mod models;
pub mod adapters;
pub mod import_engine;
pub mod export_engine;
pub mod device;
pub mod demo_template;
pub mod protocol;

use models::{generate_id, UnifiedCourse, UnifiedSchedule, WeekType};
use adapters::FormatType;
use device::{DeviceEntry, EvInstallStatus};

/// 插件版本号。
///
/// ⚠️ 必须与 `manifest.json` 的 `version` **保持一致**（打包前核对一次）。
/// 之所以在界面上显示它：设备里到底装成功了哪个版本，光看文件名很容易搞混，
/// 打开插件看一眼版本号是最快的核对方式（也方便远程让用户报版本排查）。
pub const PLUGIN_VERSION: &str = "1.0.59";

/// 页面状态机：导入 Tab ⇄ 导出 Tab，两者都能临时跳到选择设备页
#[derive(Clone, Debug, PartialEq)]
pub enum Page {
    Import,
    Export,
    SelectDevice,
    Settings,
    /// 单门课程的编辑页
    EditCourse,
    /// 运行日志页（WASI 无系统日志，排错信息在内存里累积后在此页渲染）
    Log,
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
    /// 进入选择设备页之前所在的标签页，用于选完设备后原路返回
    previous_tab: Page,
    devices: Vec<DeviceEntry>,

    // ── 设置项（此前是硬编码在导出函数里的）──
    /// sgschedule 导出的学期开始日期，格式 YYYY-MM-DD
    semester_start: String,
    /// sgschedule 导出的学期总周数
    semester_weeks: u32,

    // ── 课程编辑（数据在插件内存里，可自由修改）──
    /// 正在编辑的课程在 `courses` 中的下标
    editing_index: Option<usize>,
    edit_name: String,
    edit_teacher: String,
    edit_location: String,
    edit_day: u8,
    edit_start: String,
    edit_end: String,
    /// 周次的字符串形式（如 "1,2,3,4"），保存时再解析为 Vec<u32>
    edit_weeks: String,
    edit_week_type: String,
    /// 编辑校验失败时的提示
    edit_error: String,

    // ── 对接协议（手环侧配置，见 protocol.rs）──
    /// 手环昵称（由 {action:"export"} 读回）
    nickname: String,
    /// 昵称编辑框的临时值
    edit_nickname: String,
    /// 手环首页设置**原始 JSON**（读-改-写用，避免重建导致丢字段）
    homepage_json: String,
    /// 手环版本号（由 {action:"export"} 读回，只读不可写）
    version_name: String,
    /// 手环版本号 versionCode（数字）
    version_code: String,
    /// 最近一次手环回包原文（排错用，界面上可看到）
    last_response: String,
    selected_device_addr: Option<String>,
    selected_device_name: Option<String>,
    /// §2.2 守卫不通过时的错误提示，空串表示通过
    guard_error: String,
    show_demo_dialog: bool,
    /// 「支持的格式与样板」查看对话框（来源见 docs/ 下两份格式分析文档）
    show_format_dialog: bool,
    demo_pasted: String,
    /// Demo JSON 校验/解析的错误，显示在粘贴框下方
    demo_error: String,
    /// 「复制 Demo JSON」之后的轻提示
    demo_hint: String,
    /// 内存运行日志（WASI 无系统日志，排错信息都累积这里，由「日志」页渲染）
    log_lines: Vec<String>,
    /// 已向手环发出的请求序号（每次 send 递增）
    tx_seq: u64,
    /// 已收到的回包序号（每次收到 InterconnectMessage 递增）
    rx_seq: u64,
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

            page: Page::Import,
            previous_tab: Page::Import,
            devices: Vec::new(),
            semester_start: String::new(),
            semester_weeks: 0,
            editing_index: None,
            edit_name: String::new(),
            edit_teacher: String::new(),
            edit_location: String::new(),
            edit_day: 1,
            edit_start: String::new(),
            edit_end: String::new(),
            edit_weeks: String::new(),
            edit_week_type: String::new(),
            edit_error: String::new(),
            nickname: String::new(),
            edit_nickname: String::new(),
            homepage_json: String::new(),
            version_name: String::new(),
            version_code: String::new(),
            last_response: String::new(),
            selected_device_addr: None,
            selected_device_name: None,
            guard_error: String::new(),
            show_demo_dialog: false,
            show_format_dialog: false,
            demo_pasted: String::new(),
            demo_error: String::new(),
            demo_hint: String::new(),
            log_lines: Vec::new(),
            tx_seq: 0,
            rx_seq: 0,
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
        push_log("[init] 插件已加载");
    }
}

impl event::Guest for EvScheduleSyncPlugin {
    fn on_event(event_type: EventType, event_payload: String) -> FutureReader<String> {
        // 打印完整事件类型 + payload：区分「timer(我们自己设的 300ms)」与真正的 interconnect-message 回包
        push_log(format!(
            "[event] {:?} payload={}",
            event_type,
            protocol::truncate(&event_payload, 160)
        ));
        // 手环回包：需先用 register::register_interconnect_recv 订阅才会派发到这里
        if matches!(event_type, EventType::InterconnectMessage) {
            handle_device_message(&event_payload);

            // 与 on_ui_event 同理：render 必须同步，不能 spawn 延后
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        } else if matches!(event_type, EventType::Timer) && event_payload.contains("tx-timeout-") {
            // 发出去的请求 5 秒没回包 → 给用户一条明确结论（而不是一直停在「已发送」）
            handle_tx_timeout(&event_payload);
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        } else if matches!(event_type, EventType::Timer)
            && event_payload.contains("auto-ping-after-launch")
        {
            // 启动 EV 快应用后的延时自动 ping（见选设备流程）。用宿主 timer 做异步延时，
            // 绝不能用 std::thread::sleep（会阻塞整个 wasm 事件循环导致卡死）。
            push_log("[WAKE] 延时到，自动 ping EV 课程表".to_string());
            send_ping();
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        }
        make_empty_string_future()
    }

    fn on_ui_event(
        event_id: String,
        event: event::Event,
        event_payload: String,
    ) -> FutureReader<String> {
        // ⚠️ 必须同步：状态变更 + ui::render() 都要在本次回调的调用栈内完成。
        // 之前把这段包进 spawn(async { ... })，render 被延后到回调返回之后执行，
        // 宿主不认这次重绘 → 切页 / 切 Tab 全部失效。
        // 详见「Tab切换失效-根因-异步渲染.md」。需要 await 的宿主 IO 用 wit_bindgen::block_on。
        let needs_render = handle_ui_event_inner(&event_id, &event, &event_payload);

        if needs_render {
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        }

        make_empty_string_future()
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

/// 校验 YYYY-MM-DD（宽松：只查格式与月/日范围，不查闰年）
fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let year: u32 = match value[0..4].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let month: u32 = match value[5..7].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let day: u32 = match value[8..10].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    year >= 2000 && (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// 处理手环回包（在 `on_event` 的 InterconnectMessage 分支里调用）
///
/// ⚠️ 任何路径都必须给用户一条可见的 status_message：
/// 之前「点了读没有任何提示」就是因为回包没 data / 解析失败时静默返回，
/// 用户以为没反应。现在 export 无 data、basic 回包、以及两种都解析失败，都会明确提示。
fn handle_device_message(raw: &str) {
    // ⓪ **先解开宿主事件信封**：`on_event` 给的不是业务报文，而是
    //    {"addr":"3333238b-…","payloadHex":"7b22…","payloadText":"{\"ok\":…}"}
    //
    // 历史 bug（v1.0.56 及之前）：插件直接把整个信封当业务报文喂给各 parse_*，
    // 于是 export / ping / update_settings 的回包**全部**解析失败，又被
    // BasicResponse 的"空洞成功"伪装成「收到 basic 回包」→ 表象是"通道不通、读不到数据"。
    // 实际上通道一直是通的（回包一直在到达）。
    let decoded = protocol::decode_event_payload(raw);

    let mut state = STATE.lock().unwrap();
    state.rx_seq += 1;
    state.last_response = decoded.clone();
    push_log_locked(
        &mut state,
        format!(
            "[RX] 收到回包 len={}（信封 {}）；原文：{}",
            decoded.len(),
            raw.len(),
            protocol::truncate(&decoded, 200)
        ),
    );

    // interconnect 传输层可能还把业务报文包进 { "data": "<JSON字符串>" }（文档 §1.2），
    // 再剥一层；兼容不包装的实现。
    let inner = protocol::unwrap_envelope(&decoded);

    // ① ping 探针回包：{ ok, pong, versionName, versionCode }（联调第一步：验证通道双向通）
    if let Ok(pong) = protocol::parse_ping_response(&inner) {
        if let Some(p) = protocol::json_bool(&pong.pong) {
            if let Some(vn) = protocol::json_string(&pong.version_name) {
                state.version_name = vn;
            }
            if let Some(vc) = protocol::json_u32(&pong.version_code) {
                state.version_code = vc.to_string();
            }
            state.status_message = format!(
                "Ping 成功：pong={}，手环版本 {}（code {}）→ 通道双向通",
                p, state.version_name, state.version_code
            );
            push_log_locked(&mut state, "[RX] ping 回包解析成功（通道双向通）".to_string());
            return;
        }
    }

    // ① export 回包：带 data.schedule / nickname / homepage / version
    if let Ok(resp) = protocol::parse_export_response(&inner) {
        if resp.action.as_deref() == Some("export") {
            if let Some(data) = resp.data.clone() {
                if let Some(n) = protocol::json_string(&data.nickname) {
                    state.nickname = n.clone();
                    state.edit_nickname = n;
                }
                // homepage 原样留档，后续 update_settings 时原样回写，避免丢配置
                if let Some(h) = data.homepage.clone() {
                    state.homepage_json = h.to_string();
                }
                // 版本号（只读）
                if let Some(vn) = protocol::json_string(&data.version_name) {
                    state.version_name = vn;
                }
                if let Some(vc) = protocol::json_u32(&data.version_code) {
                    state.version_code = vc.to_string();
                }
                // 课表：宽容扁平化（任何字段类型不符只跳过单条，不会让整包解析失败）
                let flat = protocol::flatten_schedule(&data.schedule);
                if !flat.is_empty() {
                    let courses: Vec<UnifiedCourse> = flat
                        .iter()
                        .map(|c| {
                            let (start, end) = split_time_range(&c.time);
                            UnifiedCourse {
                                id: c.id.clone().unwrap_or_else(generate_id),
                                name: c.name.clone(),
                                teacher: c.teacher.clone(),
                                location: c.location.clone(),
                                day: parse_day_name(&c.day),
                                start_time: start,
                                end_time: end,
                                // v1 手环不返回周次与单双周，留空
                                weeks: Vec::new(),
                                week_type: WeekType::All,
                                color: None,
                                credit: None,
                                remark: c.notes.clone(),
                            }
                        })
                        .collect();
                    state.courses = courses;
                } else if data
                    .schedule
                    .as_ref()
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
                {
                    // 有 schedule 却一条都没拍出来 → 把原文打出来，别静默
                    push_log_locked(
                        &mut state,
                        format!(
                            "[RX] schedule 解析出 0 条，原文：{}",
                            protocol::truncate(
                                &data.schedule.as_ref().map(|v| v.to_string()).unwrap_or_default(),
                                200
                            )
                        ),
                    );
                }
                let mut msg = protocol::summarize_export(&data);
                // 昵称缺失时给明确原因，避免「读不出来」却无任何说明
                if protocol::json_string(&data.nickname).is_none() {
                    msg = format!(
                        "{}（手环未返回昵称：可能未设置，或 profile 域未开放）",
                        msg
                    );
                }
                if state.courses.is_empty() {
                    msg = format!("{}（手环未返回课程：课表可能为空）", msg);
                }
                state.status_message = msg;
                push_log_locked(
                    &mut state,
                    "[RX] export 回包解析成功（已填充昵称/版本/课程）".to_string(),
                );
                return;
            } else {
                // 回了 export 但 data 为空
                state.status_message =
                    "手环回了 export，但 data 为空（课表可能为空，或 schedule/profile 未开放读）"
                        .to_string();
                push_log_locked(&mut state, "[RX] export 回包无 data 字段".to_string());
                return;
            }
        }
    }

    // ①′ 诊断：报文看起来是 export，但反序列化失败 → 明确报出来，别再静默落到 basic 分支
    if inner.contains("\"action\"") && inner.contains("export") {
        let reason = match protocol::parse_export_response(&inner) {
            Ok(r) => format!("action={:?}，但 data 缺失或字段类型不符", r.action),
            Err(e) => e,
        };
        state.status_message = format!("export 回包解析失败：{}", reason);
        push_log_locked(&mut state, format!("[RX] export 回包解析失败：{}", reason));
        return;
    }

    // ② import / update_settings 的回包：{ ok, count?, reason? }
    if let Ok(resp) = protocol::parse_basic_response(&inner) {
        state.status_message = resp.describe("手环已确认");
        push_log_locked(
            &mut state,
            "[RX] 收到 basic 回包（import/update_settings）".to_string(),
        );
        return;
    }

    // ③ 全都不匹配：把原文暴露出来，避免静默无提示
    let err = format!(
        "回包无法识别（可能格式不符）：{}",
        protocol::truncate(&inner, 200)
    );
    push_log_locked(&mut state, format!("[RX] {}", err));
    state.status_message = err;
}

/// "星期一" / "周一" / "Monday" / "1" → 1~7
fn parse_day_name(s: &str) -> u8 {
    match s.trim() {
        "1" | "周一" | "星期一" | "Mon" | "Monday" => 1,
        "2" | "周二" | "星期二" | "Tue" | "Tuesday" => 2,
        "3" | "周三" | "星期三" | "Wed" | "Wednesday" => 3,
        "4" | "周四" | "星期四" | "Thu" | "Thursday" => 4,
        "5" | "周五" | "星期五" | "Fri" | "Friday" => 5,
        "6" | "周六" | "星期六" | "Sat" | "Saturday" => 6,
        "7" | "周日" | "星期日" | "星期天" | "Sun" | "Sunday" => 7,
        _ => 1,
    }
}

/// "08:00 - 08:45" → ("08:00", "08:45")
fn split_time_range(s: &str) -> (String, String) {
    let mut parts = s.splitn(2, '-');
    let start = parts.next().unwrap_or("").trim().to_string();
    let end = parts.next().unwrap_or("").trim().to_string();
    if end.is_empty() {
        (start.clone(), start)
    } else {
        (start, end)
    }
}

/// 校验 HH:MM（00:00-23:59）
fn is_time_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let hh: u32 = match value[0..2].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let mm: u32 = match value[3..5].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    hh <= 23 && mm <= 59
}

/// HH:MM → 当日分钟数（仅供比较，调用前需已确认格式合法）
fn time_minutes(value: &str) -> u32 {
    let hh: u32 = value[0..2].parse().unwrap_or(0);
    let mm: u32 = value[3..5].parse().unwrap_or(0);
    hh * 60 + mm
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

/// 内存运行日志：WASI 环境没有系统日志/写文件能力，所有排错信息都累积到这里，
/// 由 UI 的「运行日志」页渲染。环形保留最近 300 条，避免无限增长。
fn push_log(msg: impl Into<String>) {
    let mut s = STATE.lock().unwrap();
    push_log_locked(&mut s, msg);
}

/// ⚠️ **已经持有 `STATE` 锁时必须用这个版本**。
///
/// `STATE` 是不可重入的 `Mutex`。已持锁的情况下再调 `push_log()`（它会再 lock 一次），
/// 在 wasm 单线程里**没有任何人会释放那把锁** → 永久死锁：宿主调用永不返回，
/// 表现为「点了没反应、日志不动」，而且此后**所有事件（含 timer）都不再派发**，
/// 看起来像插件"死了"。
///
/// 历史上有 8 处踩坑：`handle_device_message` 6 处 + `export-ev-btn` 1 处 + `export-sg-btn` 1 处。
/// 其中 `export-ev-btn`（导入到手环）那处会让「点一下就卡死」。
/// 新增日志语句时：先看当前作用域里有没有活着的 `state` 守卫。
fn push_log_locked(s: &mut PluginState, msg: impl Into<String>) {
    s.log_lines.push(msg.into());
    let len = s.log_lines.len();
    if len > 300 {
        s.log_lines.drain(0..len - 300);
    }
}

/// 每次向手环发消息后调用：登记一次「待回包」并排一个 5 秒超时定时器。
///
/// 背景：QAIC 下发**没有 ACK**，`send_qaic_message` 返回 `Ok` 只代表宿主受理。
/// 手环侧不回包时（手环息屏、EV 被系统挂起、未开「后台运行」等），
/// 界面上会一直停在「已发送」，用户无法判断是"手环没回"还是"插件卡了"。
fn schedule_tx_timeout(label: &str) {
    let n = {
        let mut s = STATE.lock().unwrap();
        s.tx_seq += 1;
        s.tx_seq
    };
    let payload = format!("tx-timeout-{}|{}", n, label);
    let _ = wit_bindgen::block_on(async { timer::set_timeout(5000, &payload).await });
}

/// `on_event` 收到 `Timer` 且 payload 是本模块排的 `tx-timeout-<n>|<label>` 时调用。
///
/// ⚠️ 不要在持有 `STATE` 锁时调 `push_log()`（会死锁，见 `push_log_locked` 注释）。
fn handle_tx_timeout(event_payload: &str) {
    let Some(rest) = event_payload.split("tx-timeout-").nth(1) else {
        return;
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let Ok(n) = digits.parse::<u64>() else {
        return;
    };
    let label: String = rest
        .split_once('|')
        .map(|(_, l)| {
            l.chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect::<String>()
        })
        .unwrap_or_default();
    let label = if label.is_empty() {
        "请求".to_string()
    } else {
        label
    };

    let pending = {
        let mut s = STATE.lock().unwrap();
        if n > s.rx_seq {
            s.status_message = format!(
                "⚠️ {} 发出 5 秒内没有收到回包（已发出 {} 次 / 收到 {} 次）",
                label, s.tx_seq, s.rx_seq
            );
            true
        } else {
            false
        }
    };

    if pending {
        push_log(format!(
            "[TIMEOUT] {} 5 秒内没有收到回包。持续出现时：① 手环息屏/回桌面会挂起 EV，请在 EV 设置里开「后台运行」；② 确认蓝牙连接正常；③ 可再点一次重试",
            label
        ));
    }
}

/// 启动手环上的 EV 课程表快应用（`thirdpartyapp::launch-qa`）。
///
/// 关键根因（v1.0.54）：EV 快应用只在自身 `onCreate()` 里注册 interconnect 接收器；
/// 若它当前没在运行（未启动/未常驻），宿主 `send_qaic_message` 仍返回 Ok（因为快应用「存在」），
/// 但快应用收不到、也回不了 → 插件永远等不到 `interconnect-message`。
/// 这里主动启动它（触发 `onCreate` → 注册接收器），启动后再发消息即可收到回包。
fn launch_ev_app(addr: &str, app_info: &thirdpartyapp::AppInfo) -> bool {
    let res = wit_bindgen::block_on(async {
        thirdpartyapp::launch_qa(addr, app_info, "pages/welcome").await
    });
    let ok = res.is_ok();
    push_log(format!("[WAKE] 启动 EV 课程表 launch-qa => {:?}", res));
    ok
}

/// 发送 ping 探针（协议 ping，联调第一步）。返回是否需要重绘。
/// 抽成独立函数，供「Ping 探针」按钮与「连接状态」按钮共用。
fn send_ping() -> bool {
    if fail_guard() {
        return true;
    }
    let addr = {
        let state = STATE.lock().unwrap();
        state.selected_device_addr.clone()
    };
    let Some(addr) = addr else {
        STATE.lock().unwrap().status_message = "请先选择设备".to_string();
        return true;
    };

    push_log(format!("[TX] 向 {} 发起 ping 探针", addr));

    let reg = wit_bindgen::block_on(async {
        register::register_interconnect_recv(&addr, device::EV_PACKAGE_NAME).await
    });

    // 注：原实现在这里 set_timeout(300, "interconnect-ready")「等 300ms 让注册生效」，
    // 但 set_timeout 是异步立即返回的、该 payload 也没有任何消费方 → 实际什么都没等，
    // 而且日志里的「注册后等待 300ms 完成」是假的，排错时极具误导性。已删除。
    // 真要等注册生效，必须像 auto-ping 那样「设 timer → 立即 return → 在 on_event 里再发送」。

    let msg = protocol::build_ping_request();
    let send = wit_bindgen::block_on(async {
        interconnect::send_qaic_message(&addr, device::EV_PACKAGE_NAME, &msg).await
    });

    push_log(format!(
        "[TX] ping register={:?} send={:?} msg={}",
        reg,
        send,
        protocol::truncate(&msg, 80)
    ));

    // 5 秒内没回包就给明确提示（QAIC 无 ACK）
    schedule_tx_timeout("ping");

    let mut state = STATE.lock().unwrap();
    state.status_message = match send {
        Ok(()) => {
            "Ping 已发送：收到 pong 回包即代表通道双向通（回包显示在下方）".to_string()
        }
        Err(()) => {
            "Ping 发送失败：请确认手环已开启「后台运行」且 EV 课程表已安装".to_string()
        }
    };
    true
}

/// v3 表单控件的 change 事件 payload 是结构化 JSON：
/// `{"type":"change","value":"...","checked":false}`
/// 这里统一提取出真正的输入值；若不是该结构则原样返回（向后兼容 v2 单行 payload）。
fn extract_input_value(payload: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
        if let Some(s) = v.get("value").and_then(|x| x.as_str()) {
            return s.to_string();
        }
    }
    payload.to_string()
}

fn handle_ui_event_inner(event_id: &str, event: &event::Event, event_payload: &str) -> bool {
    // 任何按钮点击都记一条日志，便于在没有系统日志的环境里排查「点了没反应」
    if matches!(event, UiEvent::Click) {
        push_log(format!("[UI] click: {}", event_id));
    }
    match event {
        UiEvent::Change => {
            // v3 控件回传的是结构化 JSON，先取出真正的输入值（见 extract_input_value）
            let raw = extract_input_value(event_payload);
            let mut state = STATE.lock().unwrap();
            match event_id {
                "import-json-input" => state.imported_json = raw,
                "import-name-input" => state.schedule_name = raw,
                "demo-paste-input" => state.demo_pasted = raw,
                "settings-start-input" => state.semester_start = raw,
                "settings-weeks-input" => {
                    // 非法输入回退为 0，保存时再统一提示
                    state.semester_weeks = raw.trim().parse::<u32>().unwrap_or(0);
                }
                // ── 课程编辑字段 ──
                "edit-name-input" => state.edit_name = raw,
                "edit-teacher-input" => state.edit_teacher = raw,
                "edit-location-input" => state.edit_location = raw,
                "edit-day-input" => {
                    state.edit_day = raw.trim().parse::<u8>().unwrap_or(0);
                }
                "edit-start-input" => state.edit_start = raw,
                "edit-end-input" => state.edit_end = raw,
                "edit-weeks-input" => state.edit_weeks = raw,
                "edit-weektype-input" => state.edit_week_type = raw,
                "edit-nickname-input" => state.edit_nickname = raw,
                _ => {}
            }
            false
        }
        UiEvent::Click => match event_id {
            // ── 课程编辑（数据在插件内存里，可自由改）──
            id if id.starts_with("btn-edit-course-") => {
                let idx: usize = id
                    .trim_start_matches("btn-edit-course-")
                    .parse()
                    .unwrap_or(usize::MAX);

                let mut state = STATE.lock().unwrap();
                let course = state.courses.get(idx).cloned();
                match course {
                    Some(c) => {
                        state.editing_index = Some(idx);
                        state.edit_name = c.name.clone();
                        state.edit_teacher = c.teacher.clone();
                        state.edit_location = c.location.clone();
                        state.edit_day = c.day;
                        state.edit_start = c.start_time.clone();
                        state.edit_end = c.end_time.clone();
                        state.edit_weeks = c
                            .weeks
                            .iter()
                            .map(|w| w.to_string())
                            .collect::<Vec<_>>()
                            .join(",");
                        state.edit_week_type = match c.week_type {
                            WeekType::All => "all",
                            WeekType::Odd => "odd",
                            WeekType::Even => "even",
                        }
                        .to_string();
                        state.edit_error.clear();
                        if state.page != Page::EditCourse {
                            state.previous_tab = Page::Export;
                        }
                        state.page = Page::EditCourse;
                    }
                    None => state.status_message = "课程不存在，请返回重试".to_string(),
                }
                true
            }
            "btn-save-course" => {
                let (idx, name, teacher, location, day, start, end, weeks_s, wt) = {
                    let state = STATE.lock().unwrap();
                    (
                        state.editing_index,
                        state.edit_name.clone(),
                        state.edit_teacher.clone(),
                        state.edit_location.clone(),
                        state.edit_day,
                        state.edit_start.clone(),
                        state.edit_end.clone(),
                        state.edit_weeks.clone(),
                        state.edit_week_type.clone(),
                    )
                };

                // ── 校验（沿用 Demo 适配器同一套规则）──
                let mut error = String::new();
                if name.trim().is_empty() {
                    error = "课程名称不能为空".to_string();
                } else if !(1..=7).contains(&day) {
                    error = "星期应为 1-7".to_string();
                } else if !is_time_hhmm(&start) {
                    error = "开始时间格式应为 HH:MM".to_string();
                } else if !is_time_hhmm(&end) {
                    error = "结束时间格式应为 HH:MM".to_string();
                } else if time_minutes(&start) >= time_minutes(&end) {
                    error = "开始时间须早于结束时间".to_string();
                } else if !(wt == "all" || wt == "odd" || wt == "even") {
                    error = "周类型应为 all / odd / even".to_string();
                }

                if error.is_empty() {
                    // 解析周次
                    let weeks: Vec<u32> = weeks_s
                        .split(|c| c == ',' || c == '，' || c == ' ')
                        .filter(|s| !s.trim().is_empty())
                        .filter_map(|s| s.trim().parse::<u32>().ok())
                        .collect();
                    if weeks.is_empty() {
                        error = "周次不能为空，例如 1,2,3,4".to_string();
                    } else if let Some(i) = idx {
                        let week_type = match wt.as_str() {
                            "odd" => WeekType::Odd,
                            "even" => WeekType::Even,
                            _ => WeekType::All,
                        };
                        let mut state = STATE.lock().unwrap();
                        if let Some(c) = state.courses.get_mut(i) {
                            c.name = name.trim().to_string();
                            c.teacher = teacher.trim().to_string();
                            c.location = location.trim().to_string();
                            c.day = day;
                            c.start_time = start.trim().to_string();
                            c.end_time = end.trim().to_string();
                            c.week_type = week_type;
                            let mut sorted = weeks;
                            sorted.sort_unstable();
                            sorted.dedup();
                            c.weeks = sorted;
                        }
                        state.status_message = "课程已更新".to_string();
                        state.edit_error.clear();
                        // 导出结果已过期，改动后需重新导出
                        state.export_result.clear();
                        state.page = Page::Export;
                        return true;
                    }
                }

                STATE.lock().unwrap().edit_error = error;
                true
            }
            "btn-delete-course" => {
                let idx = {
                    let state = STATE.lock().unwrap();
                    state.editing_index
                };
                let mut state = STATE.lock().unwrap();
                if let Some(i) = idx {
                    if i < state.courses.len() {
                        let removed = state.courses.remove(i);
                        state.status_message = format!("已删除课程「{}」", removed.name);
                    }
                }
                state.editing_index = None;
                state.edit_error.clear();
                state.export_result.clear();
                state.page = Page::Export;
                true
            }

            // ── 从手环读取（协议 export：请求课表与配置回传）──
            "btn-read-from-device" => {
                if fail_guard() {
                    return true;
                }
                let addr = {
                    let state = STATE.lock().unwrap();
                    state.selected_device_addr.clone()
                };
                let Some(addr) = addr else {
                    STATE.lock().unwrap().status_message = "请先选择设备".to_string();
                    return true;
                };

                // 先注册接收，否则手环的回包派发不到插件。
                // 注册失败（如 manifest 没声明 register_interconnect_recv）会导致永远收不到回包，
                // 必须把结果暴露出来，不能像以前那样 `let _ =` 静默忽略。
                push_log(format!("[TX] 向 {} 发起 export 读取", addr));

                let reg = wit_bindgen::block_on(async {
                    register::register_interconnect_recv(&addr, device::EV_PACKAGE_NAME).await
                });

                // 预注册已在选设备时完成，这里再注册一次是安全网。
                // 注：原实现在这里 set_timeout(300, "interconnect-ready") 并打印
                //     「注册后等待 300ms 完成」，但 set_timeout 异步立即返回、payload 无人消费，
                //     实际是「注册后立刻发送」，那句日志是假的。已删除（不做假等待）。
                // ⚠️ 待办：若确认存在「注册刚返回 Ok 但宿主未就绪」的竞态，
                //    正确做法是「设 timer → 立即 return → 在 on_event 里再发送」。

                let msg = protocol::build_export_request();
                let send = wit_bindgen::block_on(async {
                    interconnect::send_qaic_message(&addr, device::EV_PACKAGE_NAME, &msg).await
                });

                push_log(format!(
                    "[TX] register={:?} send={:?} msg={}",
                    reg,
                    send,
                    protocol::truncate(&msg, 80)
                ));

                // 5 秒内没回包就给明确提示（QAIC 无 ACK）
                schedule_tx_timeout("export");

                let mut state = STATE.lock().unwrap();
                state.status_message = match send {
                    Ok(()) => {
                        if reg.is_ok() {
                            "已请求手环导出：收到回包后会显示昵称/版本/课程（见下方「手环回包」原文）"
                                .to_string()
                        } else {
                            "已发送，但「接收注册」失败：可能收不到回包，请确认 manifest 已声明 register_interconnect_recv 权限".to_string()
                        }
                    }
                    Err(()) => {
                        "请求发送失败：请确认手环已开启「后台运行」，且 EV 课程表在前台/已安装".to_string()
                    }
                };
                true
            }

            // ── Ping 探针（协议 ping，联调第一步）──
            "btn-ping" => return send_ping(),
            // 连接状态按钮点击：同样触发 ping 刷新版本号
            "btn-conn-status" => return send_ping(),

            // ── 启动/唤醒 EV 课程表快应用（唤醒其 interconnect 接收器）──
            "btn-launch-ev" => {
                if fail_guard() {
                    return true;
                }
                let (addr, app_info) = {
                    let state = STATE.lock().unwrap();
                    let addr = state.selected_device_addr.clone();
                    let app_info = addr
                        .as_deref()
                        .and_then(|a| state.devices.iter().find(|d| d.addr == a))
                        .and_then(|d| d.ev_app_info.clone());
                    (addr, app_info)
                };
                let Some(addr) = addr else {
                    STATE.lock().unwrap().status_message = "请先选择设备".to_string();
                    return true;
                };
                let Some(app_info) = app_info else {
                    STATE.lock().unwrap().status_message =
                        "未取到 EV 课程表 app-info：请回设备页刷新一次后再试".to_string();
                    return true;
                };
                push_log(format!("[WAKE] 向 {} 发起启动 EV 课程表", addr));
                let ok = launch_ev_app(&addr, &app_info);
                if ok {
                    // 与「选设备」流程保持一致：启动后 1.5s 自动 ping（payload 由 on_event 消费）。
                    // 之前手动启动分支漏了这一步，用户必须自己记得点 Ping，行为不一致。
                    let _ = wit_bindgen::block_on(async {
                        timer::set_timeout(1500, "auto-ping-after-launch").await
                    });
                    push_log("[WAKE] 已请求启动 EV 课程表，1.5s 后自动 ping".to_string());
                }
                let mut state = STATE.lock().unwrap();
                state.status_message = if ok {
                    "已请求启动 EV 课程表：1.5 秒后会自动 Ping，也可手动点「Ping 探针」".to_string()
                } else {
                    "启动 EV 课程表失败（launch-qa 返回 Err）".to_string()
                };
                true
            }

            // ── 昵称编辑（协议 update_settings）──
            "btn-save-nickname" => {
                if fail_guard() {
                    return true;
                }
                let (addr, nickname) = {
                    let state = STATE.lock().unwrap();
                    (
                        state.selected_device_addr.clone(),
                        state.edit_nickname.clone(),
                    )
                };
                if nickname.trim().is_empty() {
                    STATE.lock().unwrap().status_message = "昵称不能为空".to_string();
                    return true;
                }
                let Some(addr) = addr else {
                    STATE.lock().unwrap().status_message = "请先选择设备".to_string();
                    return true;
                };

                // 只改昵称，homepage 原样回写（读-改-写，避免丢配置）
                let homepage = {
                    let state = STATE.lock().unwrap();
                    if state.homepage_json.is_empty() {
                        None
                    } else {
                        Some(state.homepage_json.clone())
                    }
                };
                let msg = protocol::build_update_settings(
                    Some(nickname.trim()),
                    homepage.as_deref(),
                    None,
                    None,
                );

                let send = wit_bindgen::block_on(async {
                    interconnect::send_qaic_message(&addr, device::EV_PACKAGE_NAME, &msg).await
                });

                push_log(format!("[TX] update_settings(nickname) send={:?}", send));

                // 5 秒内没回包就给明确提示（QAIC 无 ACK）
                schedule_tx_timeout("update_settings");

                let mut state = STATE.lock().unwrap();
                if send.is_ok() {
                    state.nickname = nickname.trim().to_string();
                    state.status_message = format!("昵称已更新为「{}」", state.nickname);
                } else {
                    state.status_message =
                        "昵称发送失败：请确认手环已开启「后台运行」".to_string();
                }
                true
            }

            // ── 设置页（独立页面，与选择设备页同一套跳转机制）──
            "btn-goto-settings" => {
                let mut state = STATE.lock().unwrap();
                // 只在标签页之间跳转时记录来源，避免覆盖页内部互相覆盖 previous_tab
                if state.page != Page::SelectDevice && state.page != Page::Settings {
                    state.previous_tab = state.page.clone();
                }
                state.page = Page::Settings;
                state.show_format_dialog = false;
                state.show_demo_dialog = false;
                true
            }
            "btn-save-settings" => {
                let (start, weeks) = {
                    let state = STATE.lock().unwrap();
                    (state.semester_start.clone(), state.semester_weeks)
                };

                let date_ok = start.is_empty() || is_valid_date(&start);
                let weeks_ok = weeks == 0 || (1..=52).contains(&weeks);

                let mut state = STATE.lock().unwrap();
                if !date_ok {
                    state.status_message =
                        "学期开始日期格式应为 YYYY-MM-DD，例如 2026-09-01".to_string();
                } else if !weeks_ok {
                    state.status_message = "学期周数应为 1-52 之间的整数".to_string();
                } else {
                    state.status_message = format!(
                        "设置已保存：起始 {}，{} 周",
                        if start.is_empty() { "2026-09-01（默认）" } else { &start },
                        if weeks == 0 { 20 } else { weeks }
                    );
                }
                true
            }

            // ── Tab 切换 ──
            "btn-tab-import" => {
                let mut state = STATE.lock().unwrap();
                state.page = Page::Import;
                state.show_format_dialog = false;
                state.show_demo_dialog = false;
                true
            }
            "btn-tab-export" => {
                let mut state = STATE.lock().unwrap();
                state.page = Page::Export;
                state.show_format_dialog = false;
                state.show_demo_dialog = false;
                true
            }
            "btn-tab-settings" => {
                let mut state = STATE.lock().unwrap();
                state.page = Page::Settings;
                state.show_format_dialog = false;
                state.show_demo_dialog = false;
                true
            }
            "btn-open-log" => {
                let mut state = STATE.lock().unwrap();
                // 只在标签页之间跳转时记录来源，避免覆盖页内部互相覆盖 previous_tab
                if state.page != Page::SelectDevice
                    && state.page != Page::Settings
                    && state.page != Page::Log
                {
                    state.previous_tab = state.page.clone();
                }
                state.page = Page::Log;
                true
            }
            "btn-clear-log" => {
                STATE.lock().unwrap().log_lines.clear();
                true
            }

            // ── 设备选择（DESIGN.md §1）──
            "btn-goto-select-device" | "btn-refresh-devices" => {
                // 需要 await 的宿主 IO：block_on 同步等结果，再回到同步路径统一 render。
                // （宿主 import 返回的是 RawFutureReader，只实现 IntoFuture，需用 async 块包一层）
                let devices = wit_bindgen::block_on(async { device::fetch_devices().await });
                let mut state = STATE.lock().unwrap();
                // 已经在设备页时（点的是刷新），别把 SelectDevice 记成来源标签页
                if state.page != Page::SelectDevice {
                    state.previous_tab = state.page.clone();
                }
                state.devices = devices;
                state.page = Page::SelectDevice;
                state.guard_error.clear();
                true
            }
            "btn-back-main" => {
                let mut state = STATE.lock().unwrap();
                state.page = state.previous_tab.clone();
                true
            }
            id if id.starts_with("btn-pick-device-") => {
                let addr = id.trim_start_matches("btn-pick-device-").to_string();
                let mut state = STATE.lock().unwrap();
                let picked = state.devices.iter().find(|d| d.addr == addr).cloned();
                match picked {
                    Some(d) if d.is_ready() => {
                        state.selected_device_addr = Some(d.addr.clone());
                        state.selected_device_name = Some(d.name.clone());
                        state.guard_error.clear();
                        state.page = state.previous_tab.clone();
                        state.status_message = format!("已选择设备「{}」", d.name);
                        drop(state);

                        // 提前注册 interconnect 接收，消除「先注册后发送」之间的竞态窗口。
                        // 之前每次点「读」时才注册，注册刚刚完成就立刻发送，可能宿主侧
                        // 注册尚未就绪，导致手环回包到达时插件还收不到，形成「永远读不到」。
                        let reg = wit_bindgen::block_on(async {
                            register::register_interconnect_recv(&d.addr, device::EV_PACKAGE_NAME).await
                        });
                        push_log(format!("[REG] 已在选设备时预注册 interconnect: {:?}", reg));

                        // 连接即打印 EV 课程表所有信息（满足「日志打印连接到的 EV 课程表所有信息」），
                        // 并自动 ping 拉取版本号（回包返回后会填充「手环版本」与连接状态按钮）。
                        push_log(format!(
                            "[连接] 已连接 EV 课程表：设备={}（{}），连接={}，EV状态={}，检测EV={}/{}，插件用EV包名={}，应用数={}，样本=[{}]",
                            d.name,
                            d.addr,
                            if d.connected { "在线" } else { "离线" },
                            d.ev_status.icon(),
                            d.ev_name,
                            d.ev_pkg,
                            device::EV_PACKAGE_NAME,
                            d.app_count,
                            d.sample_pkgs
                        ));
                        if !d.ev_pkg.is_empty() && d.ev_pkg != device::EV_PACKAGE_NAME {
                            push_log(format!(
                                "[警告] 检测到的 EV 包名 {} 与插件使用 {} 不一致 → register/send 定向错误包，收不到回包",
                                d.ev_pkg,
                                device::EV_PACKAGE_NAME
                            ));
                        }
                        // 关键：先启动 EV 快应用（其接收器只在 onCreate 注册），再用宿主 timer 做延时自动 ping。
                        // EV 应用启动需要一点时间，所以不立即 ping，而是等 1.5s——
                        // on_event 收到 Timer(payload=auto-ping-after-launch) 时再发 ping。
                        if let Some(info) = d.ev_app_info.clone() {
                            let _ = launch_ev_app(&d.addr, &info);
                            let _ = wit_bindgen::block_on(async {
                                timer::set_timeout(1500, "auto-ping-after-launch").await
                            });
                            push_log("[WAKE] 已请求启动 EV 课程表，1.5s 后自动 ping".to_string());
                        } else {
                            push_log("[WAKE] 未取到 EV app-info，跳过启动，直接 ping".to_string());
                            let ping_msg = protocol::build_ping_request();
                            let ping_send = wit_bindgen::block_on(async {
                                interconnect::send_qaic_message(&d.addr, device::EV_PACKAGE_NAME, &ping_msg).await
                            });
                            push_log(format!(
                                "[TX] 自动 ping send={:?} msg={}",
                                ping_send,
                                protocol::truncate(&ping_msg, 80)
                            ));
                        }
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

            // ── 支持的格式与样板查看 ──
            "btn-show-format" => {
                let mut state = STATE.lock().unwrap();
                state.show_format_dialog = true;
                true
            }
            "btn-close-format" => {
                let mut state = STATE.lock().unwrap();
                state.show_format_dialog = false;
                true
            }

            // ── Demo JSON 对话框（DESIGN.md §3）──
            // ── 填入最小可用示例（无需 AI 修改即可直接导入，名称带随机后缀）──
            "btn-fill-demo" => {
                let (json, name) = demo_template::minimal_demo_json();
                let mut state = STATE.lock().unwrap();
                state.imported_json = json;
                state.schedule_name = name.clone();
                state.status_message =
                    format!("已填入示例数据（课表 {}），可直接点「导入」", name);
                true
            }
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
                let ok =
                    wit_bindgen::block_on(async { clipboard::write_text(&demo_text).await }).is_ok();
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
                let (courses, name, addr) = {
                    let state = STATE.lock().unwrap();
                    (
                        state.courses.clone(),
                        state.schedule_name.clone(),
                        state.selected_device_addr.clone(),
                    )
                };
                if courses.is_empty() {
                    STATE.lock().unwrap().status_message = "还没有课程，请先导入".to_string();
                    return true;
                }
                // 按《EV课程表 同步对接协议》v1 构造报文：
                // { action:"import", payload:{ courses:[...] } }
                let json = protocol::build_import_message(&courses);
                let total = courses.len();
                let _ = name; // v1 协议不带课表名，导入为覆盖式

                let send_result = if let Some(ref addr) = addr {
                    wit_bindgen::block_on(async {
                        interconnect::send_qaic_message(addr, device::EV_PACKAGE_NAME, &json).await
                    })
                } else {
                    Err(())
                };

                let mut state = STATE.lock().unwrap();
                state.export_result = json;
                state.last_response.clear();
                // ⚠️ 这里原来用的是 push_log()，而 state 守卫还活着 → 永久死锁
                // （表现为「点导入到手环没反应、日志不动」），必须用 _locked 版本
                push_log_locked(&mut state, format!("[TX] import send={:?}", send_result));
                drop(state);
                schedule_tx_timeout("import");
                let mut state = STATE.lock().unwrap();
                state.status_message = match send_result {
                    Ok(()) => format!(
                        "已发送 {} 门课程到手环（import 已投递，导入为覆盖式）",
                        total
                    ),
                    Err(()) => "发送失败：请确认手环已开启「后台运行」，报文已生成".to_string(),
                };
                true
            }
            "export-sg-btn" => {
                if fail_guard() {
                    return true;
                }
                let (courses, addr) = {
                    let state = STATE.lock().unwrap();
                    (
                        state.courses.clone(),
                        state.selected_device_addr.clone(),
                    )
                };
                if courses.is_empty() {
                    STATE.lock().unwrap().status_message = "还没有课程，请先导入".to_string();
                    return true;
                }
                // 使用设置页的学期起始日期与周数（留空则用默认值）
                let (start, weeks) = {
                    let state = STATE.lock().unwrap();
                    let s = if state.semester_start.is_empty() {
                        "2026-09-01".to_string()
                    } else {
                        state.semester_start.clone()
                    };
                    let w = if state.semester_weeks == 0 {
                        20
                    } else {
                        state.semester_weeks
                    };
                    (s, w)
                };
                let json = export_engine::export_as_sgschedule(&courses, &start, weeks);
                let total = courses.len();

                let send_result = if let Some(ref addr) = addr {
                    wit_bindgen::block_on(async {
                        interconnect::send_qaic_message(addr, device::EV_PACKAGE_NAME, &json).await
                    })
                } else {
                    Err(())
                };

                let mut state = STATE.lock().unwrap();
                state.export_result = json;
                // ⚠️ 同上：持锁期间只能用 _locked 版本，否则死锁
                push_log_locked(&mut state, format!("[TX] sgschedule send={:?}", send_result));
                drop(state);
                schedule_tx_timeout("sgschedule");
                let mut state = STATE.lock().unwrap();
                state.status_message = match send_result {
                    Ok(()) => format!(
                        "已发送 {} 门课程到 EV 课程表（sgschedule 格式）",
                        total
                    ),
                    Err(()) => format!(
                        "发送失败，但 JSON 已生成可手动复制",
                    ),
                };
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