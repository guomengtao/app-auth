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

pub mod logger;
pub mod ui;
pub mod resources;
pub mod models;
pub mod adapters;
pub mod import_engine;
pub mod export_engine;

use models::{UnifiedCourse, UnifiedSchedule};
use adapters::FormatType;

struct PluginState {
    imported_json: String,
    schedule_name: String,
    courses: Vec<UnifiedCourse>,
    last_format: Option<FormatType>,
    status_message: String,
    export_result: String,
    render_target: String,
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
            let needs_render = handle_ui_event_inner(&event_id, &event, &event_payload);
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

fn handle_ui_event_inner(event_id: &str, event: &event::Event, event_payload: &str) -> bool {
    let mut state = STATE.lock().unwrap();

    match event {
        UiEvent::Change => {
            match event_id {
                "import-json-input" => {
                    state.imported_json = event_payload.to_string();
                }
                "import-name-input" => {
                    state.schedule_name = event_payload.to_string();
                }
                _ => {}
            }
        }
        UiEvent::Click => {
            match event_id {
                "import-btn" => {
                    let json = state.imported_json.clone();
                    let name = state.schedule_name.clone();
                    if json.trim().is_empty() {
                        state.status_message = "Please paste JSON schedule data first.".to_string();
                        return true;
                    }
                    match import_engine::import_from_json(&json, &name) {
                        Ok(result) => {
                            state.courses = result.courses.clone();
                            state.last_format = Some(result.format.clone());
                            state.status_message = format!(
                                "Imported {} courses (format: {}, schedule: {}).",
                                result.total_count,
                                result.format.display_name(),
                                result.schedule_name
                            );
                            state.export_result.clear();
                        }
                        Err(e) => {
                            state.status_message = format!("Import failed: {}", e);
                        }
                    }
                    return true;
                }
                "export-ev-btn" => {
                    let courses = state.courses.clone();
                    let name = state.schedule_name.clone();
                    if courses.is_empty() {
                        state.status_message = "No courses to export. Import first.".to_string();
                        return true;
                    }
                    let schedule = UnifiedSchedule {
                        id: "ev-sync-1".to_string(),
                        name,
                        courses,
                    };
                    let json = export_engine::export_as_evschedule(&schedule);
                    state.export_result = json;
                    state.status_message = format!(
                        "Exported {} courses to EV Schedule format.",
                        state.courses.len()
                    );
                    return true;
                }
                "export-sg-btn" => {
                    let courses = state.courses.clone();
                    if courses.is_empty() {
                        state.status_message = "No courses to export. Import first.".to_string();
                        return true;
                    }
                    let json = export_engine::export_as_sgschedule(&courses, "2024-09-01", 20);
                    state.export_result = json;
                    state.status_message = format!(
                        "Exported {} courses to sgschedule format.",
                        state.courses.len()
                    );
                    return true;
                }
                "clear-btn" => {
                    *state = PluginState::new();
                    return true;
                }
                _ => {}
            }
        }
        _ => {}
    }

    false
}

export!(EvScheduleSyncPlugin);