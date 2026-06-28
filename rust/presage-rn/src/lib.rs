//! presage-rn: UniFFI bindings for Presage Signal client library
//!
//! This crate provides React Native bindings for the Presage Signal protocol library,
//! enabling building Signal-compatible messaging apps with React Native.

use std::sync::Once;
use std::fs::OpenOptions;

mod call_manager;
mod callbacks;
mod client;
mod error;
mod signaling;
mod types;

pub use callbacks::*;
pub use client::*;
pub use error::*;
pub use types::*;

static INIT_LOGGING: Once = Once::new();

/// Initialize logging - call this once at startup
pub fn init_logging() {
    INIT_LOGGING.call_once(|| {
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/hush-presage.log")
            .expect("Failed to open log file");
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(log_file)
            .with_ansi(false)
            .init();
        tracing::info!("Presage-RN logging initialized");
    });
}

uniffi::setup_scaffolding!();
