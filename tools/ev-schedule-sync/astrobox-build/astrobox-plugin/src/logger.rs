use std::io::{self, Write};

use tracing_subscriber::fmt;

pub fn init() {
    let writer = move || PluginWriter(io::stdout());
    fmt::fmt()
        .with_target(false)
        .with_ansi(false)
        .with_writer(writer)
        .with_max_level(tracing::Level::INFO)
        .compact()
        .init();
}

struct PluginWriter<W: Write>(W);

impl<W: Write> Write for PluginWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_all(b"[Plugin] ")?;
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}