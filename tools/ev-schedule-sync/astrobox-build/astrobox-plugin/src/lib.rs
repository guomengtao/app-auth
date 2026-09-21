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

pub mod logger;
pub mod ui;
pub mod resources;

struct EvScheduleSyncPlugin;

impl lifecycle::Guest for EvScheduleSyncPlugin {
    fn on_load() {
        logger::init();
        tracing::info!("hello world plugin loaded!");
    }
}

impl event::Guest for EvScheduleSyncPlugin {
    fn on_event(_event_type: EventType, _event_payload: String) -> FutureReader<String> {
        let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
        spawn(async move {
            let _ = writer.write(String::new()).await;
        });
        reader
    }

    fn on_ui_event(
        _event_id: String,
        _event: event::Event,
        _event_payload: String,
    ) -> FutureReader<String> {
        let vtable = &<String as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<String>(String::new, vtable) };
        spawn(async move {
            let _ = writer.write(String::new()).await;
        });
        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        let vtable = &<() as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<()>(|| (), vtable) };

        ui::render_main_ui(&element_id);

        spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }

    fn on_card_render(card_id: String) -> FutureReader<()> {
        let vtable = &<() as crate::wit_future::FuturePayload>::VTABLE;
        let (writer, reader) = unsafe { future_new::<()>(|| (), vtable) };

        crate::astrobox::psys_host::ui::render_to_text_card(&card_id, "hello world");

        spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }
}

export!(EvScheduleSyncPlugin);