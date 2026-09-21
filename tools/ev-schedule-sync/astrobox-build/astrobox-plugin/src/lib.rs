use astrobox_ng_wit::FutureReader;
use astrobox_ng_wit::exports::astrobox::psys_plugin::{
    event_v3::{self, EventType},
    lifecycle,
};

pub mod logger;
pub mod ui;
pub mod resources;

mod models;
mod import_engine;
mod export_engine;
mod adapters;

struct EvScheduleSyncPlugin;

impl lifecycle::Guest for EvScheduleSyncPlugin {
    fn on_load() {
        logger::init();
        tracing::info!("EV course schedule sync loaded!");
    }
}

impl event_v3::Guest for EvScheduleSyncPlugin {
    fn on_event(_event_type: EventType, _event_payload: String) -> FutureReader<String> {
        let (writer, reader) = astrobox_ng_wit::wit_future::new::<String>(|| "".to_string());
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write("".to_string()).await;
        });
        reader
    }

    fn on_ui_event_v3(
        event_id: String,
        _event: event_v3::Event,
        _event_payload: String,
    ) -> FutureReader<String> {
        let (writer, reader) = astrobox_ng_wit::wit_future::new::<String>(|| "".to_string());
        ui::handle_ui_event(&event_id);
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write("".to_string()).await;
        });
        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        let (writer, reader) = astrobox_ng_wit::wit_future::new::<()>(|| ());
        ui::render_main_ui(&element_id);
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }

    fn on_card_render(_card_id: String) -> FutureReader<()> {
        let (writer, reader) = astrobox_ng_wit::wit_future::new::<()>(|| ());
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }
}

astrobox_ng_wit::export!(EvScheduleSyncPlugin);