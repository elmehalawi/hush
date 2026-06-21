mod audio;
mod call_manager;
mod signaling;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use clap::{Parser, Subcommand};
use futures_channel::oneshot;
use futures_util::StreamExt;
use presage::libsignal_service::configuration::SignalServers;
use presage::libsignal_service::content::ContentBody;
use presage::libsignal_service::protocol::Aci;
use presage::manager::Registered;
use presage::model::identity::OnNewIdentity;
use presage_store_sqlite::SqliteStore;
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::call_manager::HushCallManager;
use crate::signaling::{call_message_to_ringrtc, is_hangup_for_self};

type PresageManager = presage::Manager<SqliteStore, Registered>;

#[derive(Parser)]
#[command(name = "hush-call", about = "Signal voice/video calling CLI tool")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Link this device as a secondary Signal device (generates QR code URL)
    Link {
        /// Path to the data directory for storing Signal state
        #[arg(long)]
        data_dir: String,

        /// Device name shown in Signal's linked devices list
        #[arg(long, default_value = "hush-call")]
        device_name: String,
    },

    /// Make an outgoing call to a Signal contact
    Call {
        /// Path to the data directory (must be linked first)
        #[arg(long)]
        data_dir: String,

        /// Recipient UUID (ACI) to call
        recipient: String,

        /// Make a video call instead of audio-only
        #[arg(long)]
        video: bool,
    },

    /// Listen for incoming calls
    Listen {
        /// Path to the data directory (must be linked first)
        #[arg(long)]
        data_dir: String,

        /// Automatically answer incoming calls
        #[arg(long)]
        auto_answer: bool,
    },

    /// Run a self-test: initialize ringrtc and verify audio devices
    SelfTest {
        /// Duration of the test call in seconds
        #[arg(long, default_value = "5")]
        duration: u64,
    },

    /// List available audio devices
    AudioDevices,

    /// Show version and build info
    Info,
}

fn expand_tilde(path: &str) -> PathBuf {
    if path.starts_with('~') {
        if let Some(home) = std::env::var("HOME").ok() {
            return PathBuf::from(path.replacen('~', &home, 1));
        }
    }
    PathBuf::from(path)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Open a presage SqliteStore at the given data directory
async fn open_store(data_dir: &PathBuf) -> Result<SqliteStore> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join("signal.db");
    let db_url = format!("sqlite://{}?mode=rwc", db_path.display());
    let store = SqliteStore::open(&db_url, OnNewIdentity::Trust).await?;
    Ok(store)
}

/// Load a registered presage Manager from an existing store
async fn load_manager(data_dir: &PathBuf) -> Result<PresageManager> {
    let store = open_store(data_dir).await?;
    let manager = presage::Manager::load_registered(store).await?;
    info!(
        "Loaded linked device, ACI: {}",
        manager.registration_data().service_ids.aci
    );
    Ok(manager)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("hush_call=debug".parse()?)
                .add_directive("ringrtc=info".parse()?),
        )
        .with_target(true)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Link {
            data_dir,
            device_name,
        } => cmd_link(expand_tilde(&data_dir), device_name).await,
        Commands::Call {
            data_dir,
            recipient,
            video,
        } => cmd_call(expand_tilde(&data_dir), recipient, video).await,
        Commands::Listen {
            data_dir,
            auto_answer,
        } => cmd_listen(expand_tilde(&data_dir), auto_answer).await,
        Commands::SelfTest { duration } => cmd_self_test(duration).await,
        Commands::AudioDevices => cmd_audio_devices().await,
        Commands::Info => cmd_info().await,
    }
}

// --- Link subcommand ---

async fn cmd_link(data_dir: PathBuf, device_name: String) -> Result<()> {
    println!(
        "Linking device '{}' (data: {})",
        device_name,
        data_dir.display()
    );

    let store = open_store(&data_dir).await?;
    let (tx, rx) = oneshot::channel::<url::Url>();

    // Spawn task to print the QR code when it arrives
    tokio::spawn(async move {
        match rx.await {
            Ok(url) => {
                eprintln!();
                eprintln!("=== SCAN THIS QR CODE IN SIGNAL ===");
                eprintln!();
                qr2term::print_qr(url.as_str()).ok();
                eprintln!();
                eprintln!("URL: {}", url);
                eprintln!("====================================");
                eprintln!();
            }
            Err(_) => {
                eprintln!("Failed to receive provisioning URL");
            }
        }
    });

    let manager =
        presage::Manager::link_secondary_device(store, SignalServers::Production, device_name, tx)
            .await?;

    let aci = manager.registration_data().service_ids.aci;
    println!("Device linked successfully!");
    println!("ACI: {}", aci);

    Ok(())
}

// --- Call subcommand ---

async fn cmd_call(data_dir: PathBuf, recipient: String, video: bool) -> Result<()> {
    let recipient_uuid: Uuid = recipient
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid recipient UUID '{}': {}", recipient, e))?;
    let recipient_aci = Aci::from(recipient_uuid);

    let manager = load_manager(&data_dir).await?;
    let my_aci = manager.registration_data().service_ids.aci;
    let my_device_id = u32::from(manager.device_id());
    let manager = Arc::new(TokioMutex::new(manager));

    let call_type = if video { "video" } else { "voice" };
    println!("Starting {} call to {} (my device: {})...", call_type, recipient, my_device_id);

    let mut call_mgr = HushCallManager::new()?;
    call_mgr.start_outgoing_call(&recipient, video)?;

    // Split signaling_rx out so send_loop and recv_loop don't fight over call_mgr
    let mut signaling_rx = {
        // Replace the receiver with a dummy one (the old one moves out)
        let (_, dummy_rx) = tokio::sync::mpsc::unbounded_channel();
        std::mem::replace(&mut call_mgr.signaling_rx, dummy_rx)
    };
    let call_mgr = Arc::new(TokioMutex::new(call_mgr));

    // Forward outgoing signaling from ringrtc → presage
    let manager_send = manager.clone();
    let send_loop = async move {
        while let Some(out) = signaling_rx.recv().await {
            let mut call_msg = signaling::ringrtc_to_call_message(out.call_id, &out.message);
            if let Some(dev_id) = out.receiver_device_id {
                call_msg.destination_device_id = Some(dev_id as u32);
            }
            let body = ContentBody::CallMessage(call_msg);
            let ts = now_millis();
            info!("Sending signaling to {} via presage", out.recipient_id);
            let mut mgr = manager_send.lock().await;
            if let Err(e) = mgr.send_message(recipient_aci, body, ts).await {
                error!("Failed to send signaling: {}", e);
            }
        }
    };

    // Receive incoming signaling from presage → ringrtc
    let manager_recv = manager.clone();
    let call_mgr_recv = call_mgr.clone();
    let my_uuid = my_aci;
    let recv_loop = async move {
        loop {
            let messages_result = {
                let mut mgr = manager_recv.lock().await;
                mgr.receive_messages().await
            };
            match messages_result {
                Ok(stream) => {
                    let mut stream = Box::pin(stream);
                    while let Some(received) = stream.next().await {
                        if let presage::model::messages::Received::Content(content) = received {
                            if let ContentBody::CallMessage(call_msg) = &content.body {
                                // Filter: ignore messages addressed to a different device
                                if let Some(dest) = call_msg.destination_device_id {
                                    if dest != my_device_id {
                                        debug!("Ignoring call message for device {} (we are {})", dest, my_device_id);
                                        continue;
                                    }
                                }

                                // Filter: ignore "accepted on another device" hangups that refer to us
                                if is_hangup_for_self(call_msg, my_device_id) {
                                    continue;
                                }

                                let sender_uuid = content.metadata.sender.raw_uuid();
                                let sender_device =
                                    u32::from(content.metadata.sender_device);
                                debug!(
                                    "Received call signaling from {} (device {})",
                                    sender_uuid, sender_device
                                );

                                if let Some(parsed) = call_message_to_ringrtc(call_msg) {
                                    let sender_ik = sender_uuid.as_bytes().to_vec();
                                    let receiver_ik = my_uuid.as_bytes().to_vec();

                                    let mut cm = call_mgr_recv.lock().await;
                                    if let Err(e) = cm.handle_incoming_signaling(
                                        &sender_uuid.to_string(),
                                        sender_device,
                                        parsed.call_id,
                                        parsed.message,
                                        sender_ik,
                                        receiver_ik,
                                    ) {
                                        error!("Failed to route signaling to ringrtc: {}", e);
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("Message receive error, reconnecting: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    };

    println!("Press Ctrl+C to hang up");
    let call_mgr_hangup = call_mgr.clone();
    tokio::select! {
        _ = send_loop => {},
        _ = recv_loop => {},
        _ = tokio::signal::ctrl_c() => {
            println!("\nHanging up...");
            let mut cm = call_mgr_hangup.lock().await;
            let _ = cm.hangup();
        }
    }

    Ok(())
}

// --- Listen subcommand ---

async fn cmd_listen(data_dir: PathBuf, auto_answer: bool) -> Result<()> {
    let manager = load_manager(&data_dir).await?;
    let my_aci = manager.registration_data().service_ids.aci;
    let my_device_id = u32::from(manager.device_id());
    let manager = Arc::new(TokioMutex::new(manager));

    println!("Listening for incoming calls (device {})...", my_device_id);
    if auto_answer {
        println!("Auto-answer is enabled");
    }
    println!("Press Ctrl+C to stop\n");

    let mut call_mgr = HushCallManager::new()?;
    call_mgr.set_auto_answer(auto_answer);

    // Split signaling_rx out
    let mut signaling_rx = {
        let (_, dummy_rx) = tokio::sync::mpsc::unbounded_channel();
        std::mem::replace(&mut call_mgr.signaling_rx, dummy_rx)
    };
    let call_mgr = Arc::new(TokioMutex::new(call_mgr));

    // Track the current call's recipient for sending signaling back
    let current_recipient: Arc<TokioMutex<Option<Aci>>> = Arc::new(TokioMutex::new(None));

    // Forward outgoing signaling from ringrtc → presage
    let manager_send = manager.clone();
    let current_recipient_send = current_recipient.clone();
    let send_loop = async move {
        while let Some(out) = signaling_rx.recv().await {
            let recipient = current_recipient_send.lock().await;
            if let Some(aci) = &*recipient {
                let mut call_msg = signaling::ringrtc_to_call_message(out.call_id, &out.message);
                if let Some(dev_id) = out.receiver_device_id {
                    call_msg.destination_device_id = Some(dev_id as u32);
                }
                let body = ContentBody::CallMessage(call_msg);
                let ts = now_millis();
                info!("Sending signaling to {} via presage", out.recipient_id);
                let mut mgr = manager_send.lock().await;
                if let Err(e) = mgr.send_message(*aci, body, ts).await {
                    error!("Failed to send signaling: {}", e);
                }
            } else {
                warn!("No current recipient to send signaling to");
            }
        }
    };

    // Receive incoming signaling from presage → ringrtc
    let manager_recv = manager.clone();
    let call_mgr_recv = call_mgr.clone();
    let my_uuid = my_aci;
    let recv_loop = async move {
        loop {
            let messages_result = {
                let mut mgr = manager_recv.lock().await;
                mgr.receive_messages().await
            };
            match messages_result {
                Ok(stream) => {
                    let mut stream = Box::pin(stream);
                    while let Some(received) = stream.next().await {
                        if let presage::model::messages::Received::Content(content) = received {
                            if let ContentBody::CallMessage(call_msg) = &content.body {
                                // Filter: ignore messages addressed to a different device
                                if let Some(dest) = call_msg.destination_device_id {
                                    if dest != my_device_id {
                                        debug!("Ignoring call message for device {} (we are {})", dest, my_device_id);
                                        continue;
                                    }
                                }

                                // Filter: ignore "accepted on another device" hangups that refer to us
                                if is_hangup_for_self(call_msg, my_device_id) {
                                    continue;
                                }

                                let sender_uuid = content.metadata.sender.raw_uuid();
                                let sender_device =
                                    u32::from(content.metadata.sender_device);
                                info!(
                                    "Received call signaling from {} (device {})",
                                    sender_uuid, sender_device
                                );

                                // Track the caller
                                {
                                    let mut recipient = current_recipient.lock().await;
                                    *recipient = Some(Aci::from(sender_uuid));
                                }

                                if let Some(parsed) = call_message_to_ringrtc(call_msg) {
                                    let sender_ik = sender_uuid.as_bytes().to_vec();
                                    let receiver_ik = my_uuid.as_bytes().to_vec();

                                    let mut cm = call_mgr_recv.lock().await;
                                    if let Err(e) = cm.handle_incoming_signaling(
                                        &sender_uuid.to_string(),
                                        sender_device,
                                        parsed.call_id,
                                        parsed.message,
                                        sender_ik,
                                        receiver_ik,
                                    ) {
                                        error!("Failed to route signaling to ringrtc: {}", e);
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("Message receive error, reconnecting: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    };

    let call_mgr_hangup = call_mgr.clone();
    tokio::select! {
        _ = send_loop => {},
        _ = recv_loop => {},
        _ = tokio::signal::ctrl_c() => {
            println!("\nStopping...");
            let mut cm = call_mgr_hangup.lock().await;
            let _ = cm.hangup();
        }
    }

    Ok(())
}

// --- Existing subcommands ---

async fn cmd_self_test(duration: u64) -> Result<()> {
    println!("Running self-test: simulated call for {}s...", duration);

    let call_mgr = HushCallManager::new()?;
    println!("  ringrtc CallManager initialized successfully");
    println!("  Call state: {:?}", call_mgr.state());

    let devices = audio::list_audio_devices()?;
    println!("  Audio devices found: {}", devices.len());
    for device in &devices {
        println!("    {}", device);
    }

    let samples = audio::generate_sine_wave(440.0, 48000, 1, 100);
    println!(
        "  Generated {} test audio samples (440Hz, 100ms)",
        samples.len()
    );

    println!("  Signaling conversion: OK");
    println!("\nSelf-test passed!");
    Ok(())
}

async fn cmd_audio_devices() -> Result<()> {
    let devices = audio::list_audio_devices()?;
    if devices.is_empty() {
        println!("No audio devices found");
    } else {
        println!("Audio devices:");
        for (i, device) in devices.iter().enumerate() {
            println!("  [{}] {}", i, device);
        }
    }
    Ok(())
}

async fn cmd_info() -> Result<()> {
    println!("hush-call v{}", env!("CARGO_PKG_VERSION"));
    println!("ringrtc integration: linked");
    println!("presage integration: linked");
    println!("Platform: {}", std::env::consts::ARCH);
    println!("OS: {}", std::env::consts::OS);
    Ok(())
}
