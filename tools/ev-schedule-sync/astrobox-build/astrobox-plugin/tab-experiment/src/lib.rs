use std::sync::Mutex;
use wit_bindgen::rt::async_support::{FutureReader, future_new};
use wit_bindgen::spawn;

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
use crate::astrobox::psys_host::{device, thirdpartyapp};

mod ui;

pub const PLUGIN_VERSION: &str = "1.1.1";

#[derive(Clone, Debug, PartialEq)]
pub enum Page {
    TabA,
    TabB,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EvConnectionStatus {
    Idle,
    Checking,
    Connected(String),
    NotConnected,
}

struct PluginState {
    page: Page,
    ev_status: EvConnectionStatus,
    render_target: String,
}

impl PluginState {
    const fn new() -> Self {
        Self {
            page: Page::TabA,
            ev_status: EvConnectionStatus::Idle,
            render_target: String::new(),
        }
    }
}

static STATE: Mutex<PluginState> = Mutex::new(PluginState::new());

pub struct TabExperiment;

fn make_empty_unit_future() -> FutureReader<()> {
    let vtable = &<() as crate::wit_future::FuturePayload>::VTABLE;
    let (writer, reader) = unsafe { future_new::<()>(|| (), vtable) };
    spawn(async move {
        let _ = writer.write(()).await;
    });
    reader
}

impl lifecycle::Guest for TabExperiment {
    fn on_load() {}
}

fn make_empty_string_future() -> FutureReader<String> {
    let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
    let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
    spawn(async move {
        let _ = writer.write(String::new()).await;
    });
    reader
}

impl event::Guest for TabExperiment {
    fn on_event(_event_type: EventType, _event_payload: String) -> FutureReader<String> {
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

    fn on_ui_event(
        event_id: String,
        event: event::Event,
        _event_payload: String,
    ) -> FutureReader<String> {
        // ⚠️ 必须同步：状态变更 + ui::render() 都要在本次回调的调用栈内完成。
        // 之前把这段包进 spawn(async { ... })，render 延后到回调返回之后执行，切 Tab 不刷新。
        // 详见「Tab切换失效-根因-异步渲染.md」。
        let needs_render = handle_ui_event_inner(&event_id, &event);

        if needs_render {
            let target = STATE.lock().unwrap().render_target.clone();
            if !target.is_empty() {
                ui::render_main_ui(&target);
            }
        }

        make_empty_string_future()
    }

    fn on_card_render(_card_id: String) -> FutureReader<()> {
        make_empty_unit_future()
    }
}

fn handle_ui_event_inner(event_id: &str, event: &event::Event) -> bool {
    match event {
        UiEvent::Click => match event_id {
            "btn-tab-a" => {
                STATE.lock().unwrap().page = Page::TabA;
                true
            }
            "btn-tab-b" => {
                STATE.lock().unwrap().page = Page::TabB;
                true
            }
            "btn-check-ev" => {
                // 需要 await 的宿主 IO：用 block_on 同步等到结果，再回到同步路径统一 render。
                let status = wit_bindgen::block_on(check_ev_connection());
                STATE.lock().unwrap().ev_status = status;
                true
            }
            _ => false,
        },
        _ => false,
    }
}

async fn check_ev_connection() -> EvConnectionStatus {
    const EV_PACKAGE_NAME: &str = "com.application.watch.classschedule";

    let connected = device::get_connected_device_list().await;

    if connected.is_empty() {
        return EvConnectionStatus::NotConnected;
    }

    for dev in &connected {
        match thirdpartyapp::get_thirdparty_app_list(&dev.addr).await {
            Ok(apps) => {
                for app in &apps {
                    let pkg = app.package_name.trim().to_lowercase();
                    let name = app.app_name.trim().to_lowercase();
                    if pkg == EV_PACKAGE_NAME
                        || name.contains("ev课程表")
                        || name.contains("ev 课程表")
                    {
                        return EvConnectionStatus::Connected(dev.name.clone());
                    }
                }
            }
            Err(_) => continue,
        }
    }

    EvConnectionStatus::NotConnected
}

export!(TabExperiment);