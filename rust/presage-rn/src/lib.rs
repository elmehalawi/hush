//! presage-rn: UniFFI bindings for Presage Signal client library
//!
//! This crate provides React Native bindings for the Presage Signal protocol library,
//! enabling building Signal-compatible messaging apps with React Native.

use std::sync::Once;

mod callbacks;
mod client;
mod error;
mod types;

pub use callbacks::*;
pub use client::*;
pub use error::*;
pub use types::*;

static INIT_LOGGING: Once = Once::new();

/// Initialize logging - call this once at startup
pub fn init_logging() {
    INIT_LOGGING.call_once(|| {
        // Use oslog for macOS - logs will appear in Console.app
        let oslog = tracing_oslog::OsLogger::new("org.reactjs.native.signal-app", "presage");
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(std::io::stderr)
            .init();
        tracing::info!("Presage-RN logging initialized");
    });
}

uniffi::setup_scaffolding!();
