//! Test provisioning/linking flow to reproduce "no provisioning message received" error
//!
//! Run with: cargo run
//!
//! This test:
//! 1. Creates a fresh SQLite store
//! 2. Starts the linking process with presage
//! 3. Waits for the provisioning timeout (don't scan the QR code)
//! 4. Captures and reports the error

use std::error::Error as StdError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use futures_channel::oneshot;
use presage::libsignal_service::configuration::SignalServers;
use presage::model::identity::OnNewIdentity;
use presage_store_sqlite::SqliteStore;
use tracing::error;

#[tokio::main]
async fn main() -> Result<()> {
    // Enable logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("presage=debug".parse()?)
                .add_directive("libsignal_service=debug".parse()?)
                .add_directive("test_provisioning=debug".parse()?),
        )
        .with_target(true)
        .with_thread_ids(true)
        .init();

    println!("==============================================");
    println!("Signal Provisioning Error Test");
    println!("==============================================\n");

    // Use a fresh temporary directory
    let data_dir = std::env::temp_dir().join("signal-provisioning-test");
    println!("Data directory: {}", data_dir.display());

    // Clean up any existing data
    if data_dir.exists() {
        println!("Cleaning up existing data...");
        std::fs::remove_dir_all(&data_dir)?;
    }
    std::fs::create_dir_all(&data_dir)?;

    let db_path = data_dir.join("signal.db");
    let db_url = format!("sqlite://{}?mode=rwc", db_path.display());
    println!("Database URL: {}", db_url);

    // Open the store
    println!("\nOpening SQLite store...");
    let store = SqliteStore::open(&db_url, OnNewIdentity::Trust).await?;
    println!("Store opened successfully");

    // Create oneshot channel for QR code URL
    let (tx, rx) = oneshot::channel::<url::Url>();

    // Flag to track if QR was received
    let qr_received = Arc::new(AtomicBool::new(false));
    let qr_received_clone = qr_received.clone();

    // Start linking process
    println!("\nStarting device linking...");
    println!("A QR code URL will be generated.");
    println!("DO NOT scan it - we're testing the timeout error.\n");

    let start = Instant::now();

    // Spawn a task to receive the QR code
    let qr_task = tokio::spawn(async move {
        match rx.await {
            Ok(url) => {
                let url_str = url.to_string();
                println!("\n=== QR CODE URL RECEIVED ===");
                println!("URL length: {}", url_str.len());
                println!("URL (first 100 chars): {}...", &url_str[..url_str.len().min(100)]);
                println!("============================\n");
                println!(">>> DO NOT SCAN - waiting for timeout error <<<\n");
                qr_received_clone.store(true, Ordering::SeqCst);
                Ok(url_str)
            }
            Err(e) => {
                error!("Failed to receive QR code URL: {:?}", e);
                Err(anyhow::anyhow!("QR channel cancelled: {:?}", e))
            }
        }
    });

    // Run the linking process
    println!("Calling presage::Manager::link_secondary_device...");

    let link_result = presage::Manager::link_secondary_device(
        store,
        SignalServers::Production,
        "Test Device".to_string(),
        tx,
    )
    .await;

    let elapsed = start.elapsed();

    // Report results
    println!("\n==============================================");
    println!("TEST RESULTS");
    println!("==============================================");
    println!("Total time: {:.1}s", elapsed.as_secs_f64());
    println!("QR code received: {}", qr_received.load(Ordering::SeqCst));

    match link_result {
        Ok(manager) => {
            println!("\nUNEXPECTED: Linking succeeded!");
            println!("User ID: {}", manager.registration_data().service_ids.aci);
            println!("\nDid someone scan the QR code?");
        }
        Err(e) => {
            println!("\n=== CAPTURED ERROR ===");
            println!("Error: {:?}", e);
            println!("Error (Display): {}", e);
            println!("======================\n");

            let err_str = e.to_string();
            let err_debug = format!("{:?}", e);

            // Check for specific error patterns
            if err_str.to_lowercase().contains("provisioning")
                || err_debug.to_lowercase().contains("provisioning")
            {
                println!(">>> CONFIRMED: 'provisioning' error detected! <<<");
            }
            if err_str.to_lowercase().contains("timeout")
                || err_debug.to_lowercase().contains("timeout")
            {
                println!(">>> CONFIRMED: 'timeout' error detected! <<<");
            }
            if err_str.contains("no provisioning message")
                || err_debug.contains("no provisioning message")
            {
                println!(">>> CONFIRMED: 'no provisioning message received' error! <<<");
            }

            // Show the full error chain
            println!("\nFull error chain:");
            let mut source: Option<&(dyn StdError + 'static)> = StdError::source(&e);
            let mut depth = 0;
            while let Some(s) = source {
                println!("  [{depth}] {}", s);
                source = s.source();
                depth += 1;
            }
        }
    }

    // Wait for QR task
    let _ = qr_task.await;

    println!("\n==============================================");

    // Cleanup
    println!("\nCleaning up test data...");
    let _ = std::fs::remove_dir_all(&data_dir);

    Ok(())
}
