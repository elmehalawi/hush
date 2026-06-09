//! Signal client implementation wrapping Presage

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_channel::oneshot;
use futures_util::StreamExt;
use parking_lot::RwLock;
use presage::libsignal_service::configuration::SignalServers;
use presage::libsignal_service::content::{Content, ContentBody};
use presage::libsignal_service::protocol::{Aci, ServiceId};
use presage::libsignal_service::sender::AttachmentSpec;
use presage::libsignal_service::zkgroup::profiles::ProfileKey;
use presage::manager::Registered;
use presage::model::identity::OnNewIdentity;
use presage::proto::attachment_pointer::AttachmentIdentifier;
use presage::proto::{receipt_message, AttachmentPointer, DataMessage, GroupContextV2, ReceiptMessage};
use presage::store::{ContentsStore, Thread};
use presage_store_sqlite::SqliteStore;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::callbacks::{LinkingCallback, MessageListener};
use crate::error::SignalError;
use crate::types::{Attachment, Channel, Message, MessageStatus, Reaction, ReactionEvent, SessionInfo};

type PresageManager = presage::Manager<SqliteStore, Registered>;

/// The main Signal client object
#[derive(uniffi::Object)]
pub struct SignalClient {
    /// The presage manager (None if not linked)
    manager: RwLock<Option<PresageManager>>,
    /// SQLite store path
    store_path: PathBuf,
    /// Data directory (parent of store_path)
    data_dir: PathBuf,
    /// The tokio runtime for async operations
    runtime: tokio::runtime::Runtime,
    /// Flag to stop receiving
    stop_flag: Arc<AtomicBool>,
    /// Our own user ID (set after linking)
    user_id: RwLock<Option<Uuid>>,
    /// Guard to prevent spawning multiple receive threads
    is_receiving: Arc<AtomicBool>,
    /// Per-channel last-read timestamp, persisted to read_state.json
    read_state: Arc<RwLock<HashMap<String, u64>>>,
    /// Shared listener reference for background attachment downloads
    listener: Arc<RwLock<Option<Arc<dyn MessageListener>>>>,
    /// Set of cache keys currently being downloaded (dedup concurrent downloads)
    inflight_downloads: Arc<RwLock<HashSet<String>>>,
}

#[uniffi::export]
impl SignalClient {
    /// Create a new Signal client with the given data directory
    #[uniffi::constructor]
    pub fn new(data_dir: String) -> Result<Arc<Self>, SignalError> {
        // Initialize logging
        crate::init_logging();
        eprintln!("[RUST] Creating SignalClient with data_dir: {}", data_dir);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(8 * 1024 * 1024)
            .build()
            .map_err(|e| SignalError::InternalError {
                message: format!("Failed to create runtime: {}", e),
            })?;

        let store_path = PathBuf::from(&data_dir).join("signal.db");

        // Ensure parent directory exists
        if let Some(parent) = store_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SignalError::StorageError {
                message: format!("Failed to create data directory: {}", e),
            })?;
        }

        // Try to load existing manager
        let local = tokio::task::LocalSet::new();
        let (manager, user_id) = local.block_on(&runtime, async {
            // SqliteStore expects a sqlite:// URL or plain path
            let db_url = format!("sqlite://{}?mode=rwc", store_path.display());
            info!("Opening database at: {}", db_url);

            let store = SqliteStore::open(&db_url, OnNewIdentity::Trust)
                .await
                .map_err(|e| SignalError::StorageError {
                    message: e.to_string(),
                })?;

            match presage::Manager::load_registered(store).await {
                Ok(mgr) => {
                    let user_id = mgr.registration_data().service_ids.aci;
                    info!("Loaded existing registration for user {}", user_id);
                    Ok((Some(mgr), Some(user_id)))
                }
                Err(presage::Error::NotYetRegisteredError) => {
                    info!("No existing registration found");
                    Ok((None, None))
                }
                Err(e) => Err(SignalError::from(e)),
            }
        })?;

        let data_dir = PathBuf::from(&data_dir);

        // Load persisted read state
        let read_state = load_read_state(&data_dir);

        Ok(Arc::new(Self {
            manager: RwLock::new(manager),
            store_path,
            data_dir,
            runtime,
            stop_flag: Arc::new(AtomicBool::new(false)),
            user_id: RwLock::new(user_id),
            is_receiving: Arc::new(AtomicBool::new(false)),
            read_state: Arc::new(RwLock::new(read_state)),
            listener: Arc::new(RwLock::new(None)),
            inflight_downloads: Arc::new(RwLock::new(HashSet::new())),
        }))
    }

    /// Check if the client is linked to a Signal account
    pub fn is_linked(&self) -> bool {
        self.manager.read().is_some()
    }

    /// Get the current user's UUID (if linked)
    pub fn get_user_id(&self) -> Option<String> {
        self.user_id.read().map(|id| id.to_string())
    }

    /// Start the device linking process with callbacks
    /// This function blocks until linking is complete
    /// The callback's on_qr_code_url will be called with the QR URL to display
    pub fn start_linking(
        &self,
        device_name: String,
        callback: Box<dyn LinkingCallback>,
    ) -> Result<(), SignalError> {
        eprintln!("[RUST] start_linking called with device_name: {}", device_name);

        if self.is_linked() {
            eprintln!("[RUST] Already linked, returning error");
            return Err(SignalError::AlreadyLinked);
        }

        eprintln!("[RUST] About to call runtime.block_on");

        // Use stacker for dynamic stack growth - crypto operations during linking are stack-hungry
        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
                eprintln!("[RUST] Inside block_on async block");
            // SqliteStore expects a sqlite:// URL or plain path
            let db_url = format!("sqlite://{}?mode=rwc", self.store_path.display());
            eprintln!("[RUST] Opening store at: {}", db_url);

            let store = SqliteStore::open(&db_url, OnNewIdentity::Trust)
                .await
                .map_err(|e| {
                    eprintln!("[RUST] Failed to open store: {}", e);
                    SignalError::StorageError {
                        message: e.to_string(),
                    }
                })?;

            eprintln!("[RUST] Store opened successfully, starting link_secondary_device");

            let (tx, rx) = oneshot::channel();

            // Create the linking future
            let link_task = async {
                eprintln!("[RUST] Calling presage::Manager::link_secondary_device...");
                let result = presage::Manager::link_secondary_device(
                    store,
                    SignalServers::Production,
                    device_name,
                    tx,
                )
                .await;

                match &result {
                    Ok(_) => eprintln!("[RUST] link_secondary_device completed successfully"),
                    Err(e) => eprintln!("[RUST] link_secondary_device failed: {:?}", e),
                }

                result.map_err(SignalError::from)
            };

            // Task to receive QR URL and call the callback
            let callback_ref = &callback;
            let qr_callback_task = async move {
                eprintln!("[RUST] Waiting for QR code URL from channel...");
                match rx.await {
                    Ok(qr_url) => {
                        let url_string = qr_url.to_string();
                        eprintln!("[RUST] Got QR code URL: {}", url_string);
                        callback_ref.on_qr_code_url(url_string);
                        Ok::<_, SignalError>(())
                    }
                    Err(e) => {
                        eprintln!("[RUST] Failed to receive QR code URL from channel: {:?}", e);
                        Err(SignalError::LinkingFailed {
                            message: "Failed to receive QR code URL".to_string(),
                        })
                    }
                }
            };

            // Run both linking and QR callback concurrently
            eprintln!("[RUST] Running link_task and qr_callback_task concurrently...");
            let result = tokio::try_join!(link_task, qr_callback_task);

            match result {
                Ok((manager, _)) => {
                    let new_user_id = manager.registration_data().service_ids.aci;
                    eprintln!("[RUST] Linking completed for user {}", new_user_id);

                    // Store the manager
                    *self.manager.write() = Some(manager);
                    *self.user_id.write() = Some(new_user_id);

                    callback.on_linking_complete();
                    Ok(())
                }
                Err(e) => {
                    eprintln!("[RUST] Linking failed with error: {}", e);
                    callback.on_linking_error(e.to_string());
                    Err(e)
                }
            }
        })
        })
    }

    /// Get the list of all channels (contacts and groups)
    pub fn get_channels(&self) -> Result<Vec<Channel>, SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;
        let avatars_dir = self.data_dir.join("avatars");
        let _ = std::fs::create_dir_all(&avatars_dir);

        let local = tokio::task::LocalSet::new();
        local.block_on(&self.runtime, async {
            let mut channels = Vec::new();

            // Query threads table directly via rusqlite to discover ALL conversations,
            // not just those with synced contacts/groups.
            let conn = rusqlite::Connection::open_with_flags(
                &self.store_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| SignalError::StorageError {
                message: format!("Failed to open DB for thread scan: {}", e),
            })?;

            let mut stmt = conn
                .prepare("SELECT id, group_master_key, recipient_id FROM threads")
                .map_err(|e| SignalError::StorageError {
                    message: format!("Failed to query threads: {}", e),
                })?;

            struct ThreadRow {
                group_master_key: Option<Vec<u8>>,
                recipient_id: Option<Vec<u8>>,
            }

            let thread_rows: Vec<ThreadRow> = stmt
                .query_map([], |row| {
                    Ok(ThreadRow {
                        group_master_key: row.get(1)?,
                        recipient_id: row.get(2)?,
                    })
                })
                .map_err(|e| SignalError::StorageError {
                    message: format!("Failed to iterate threads: {}", e),
                })?
                .filter_map(|r| r.ok())
                .collect();

            // Done with rusqlite — drop connection before entering presage store calls
            drop(stmt);
            drop(conn);

            for thread_row in &thread_rows {
                if let Some(master_key_bytes) = &thread_row.group_master_key {
                    // Group thread
                    if master_key_bytes.len() != 32 {
                        continue;
                    }
                    let key: [u8; 32] = master_key_bytes.as_slice().try_into().unwrap();
                    let group_id = hex::encode(&key);

                    let name = match manager.store().group(key).await {
                        Ok(Some(g)) => g.title,
                        _ => group_id.clone(),
                    };

                    let avatar_file = avatars_dir.join(&group_id);
                    let mut avatar_path = if avatar_file.exists() {
                        Some(avatar_file.to_string_lossy().to_string())
                    } else {
                        None
                    };

                    if avatar_path.is_none() {
                        if let Ok(Some(avatar_bytes)) =
                            manager.store().group_avatar(key).await
                        {
                            if !avatar_bytes.is_empty() {
                                if std::fs::write(&avatar_file, &avatar_bytes).is_ok() {
                                    avatar_path =
                                        Some(avatar_file.to_string_lossy().to_string());
                                }
                            }
                        }
                    }

                    channels.push(Channel {
                        id: group_id,
                        name,
                        is_group: true,
                        unread_count: 0,
                        last_message: None,
                        last_message_timestamp: None,
                        avatar_path,
                        phone_number: None,
                    });
                } else if let Some(recipient_id_bytes) = &thread_row.recipient_id {
                    // Contact thread — recipient_id is stored as a 16-byte UUID blob
                    let uuid = match Uuid::from_slice(recipient_id_bytes) {
                        Ok(u) => u,
                        Err(_) => continue,
                    };
                    let channel_id = uuid.to_string();
                    let service_id = ServiceId::from(Aci::from(uuid));

                    let (name, phone_number) =
                        resolve_contact_name(manager, uuid, &service_id).await;

                    let avatar_file = avatars_dir.join(&channel_id);
                    let mut avatar_path = if avatar_file.exists() {
                        Some(avatar_file.to_string_lossy().to_string())
                    } else {
                        None
                    };

                    // If not on disk, try reading from the store cache
                    if avatar_path.is_none() {
                        let profile_key = manager
                            .store()
                            .profile_key(&service_id)
                            .await
                            .ok()
                            .flatten();

                        if let Some(profile_key) = profile_key {
                            if let Ok(Some(avatar_bytes)) =
                                manager.store().profile_avatar(uuid, profile_key).await
                            {
                                if !avatar_bytes.is_empty() {
                                    if std::fs::write(&avatar_file, &avatar_bytes).is_ok() {
                                        avatar_path =
                                            Some(avatar_file.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                    }

                    channels.push(Channel {
                        id: channel_id,
                        name,
                        is_group: false,
                        unread_count: 0,
                        last_message: None,
                        last_message_timestamp: None,
                        avatar_path,
                        phone_number,
                    });
                }
            }

            // Read the persisted read-state so we can compute unread counts
            let read_state = self.read_state.read().clone();
            let my_user_id = self.user_id.read();

            // Populate last message timestamps and unread counts from stored messages
            for channel in &mut channels {
                let thread = if channel.is_group {
                    let key_bytes = match hex::decode(&channel.id) {
                        Ok(b) if b.len() == 32 => b,
                        _ => continue,
                    };
                    let key: [u8; 32] = key_bytes.try_into().unwrap();
                    Thread::Group(key)
                } else {
                    match channel.id.parse::<Uuid>() {
                        Ok(uuid) => Thread::Contact(ServiceId::from(Aci::from(uuid))),
                        Err(_) => continue,
                    }
                };

                let last_read_ts = read_state.get(&channel.id).copied().unwrap_or(0);

                // messages() returns results ordered by ts DESC, so first = most recent
                if let Ok(messages_iter) = manager.store().messages(&thread, ..).await {
                    let mut got_last = false;
                    let mut unread = 0u32;
                    // Cap iteration to avoid scanning thousands of messages for
                    // channels that have never been read (last_read_ts == 0)
                    const MAX_SCAN: u32 = 500;
                    let mut scanned = 0u32;
                    for result in messages_iter {
                        if let Ok(content) = result {
                            let ts = content.metadata.timestamp;
                            let sender_uuid = content.metadata.sender.raw_uuid();
                            let is_outgoing = my_user_id.map_or(false, |me| sender_uuid == me);

                            // Skip protocol-level messages (profile key updates, etc.)
                            // and reaction messages (they aren't visible as standalone messages)
                            let should_skip = match &content.body {
                                ContentBody::DataMessage(dm) => {
                                    if dm.reaction.is_some() {
                                        true
                                    } else {
                                        let flags = dm.flags.unwrap_or(0);
                                        flags != 0 && dm.body.is_none() && dm.attachments.is_empty()
                                    }
                                }
                                ContentBody::SynchronizeMessage(sync) => {
                                    if let Some(sent) = &sync.sent {
                                        if let Some(dm) = &sent.message {
                                            if dm.reaction.is_some() {
                                                true
                                            } else {
                                                let flags = dm.flags.unwrap_or(0);
                                                flags != 0 && dm.body.is_none() && dm.attachments.is_empty()
                                            }
                                        } else {
                                            false
                                        }
                                    } else {
                                        false
                                    }
                                }
                                _ => false,
                            };
                            if should_skip {
                                continue;
                            }

                            scanned += 1;

                            if !got_last {
                                channel.last_message_timestamp = Some(ts);
                                let (body, attachments) = match &content.body {
                                    ContentBody::DataMessage(dm) => {
                                        (dm.body.clone(), &dm.attachments)
                                    }
                                    ContentBody::SynchronizeMessage(sync) => {
                                        if let Some(sent) = &sync.sent {
                                            if let Some(dm) = &sent.message {
                                                (dm.body.clone(), &dm.attachments)
                                            } else {
                                                (None, &vec![] as &Vec<AttachmentPointer>)
                                            }
                                        } else {
                                            (None, &vec![] as &Vec<AttachmentPointer>)
                                        }
                                    }
                                    _ => (None, &vec![] as &Vec<AttachmentPointer>),
                                };
                                channel.last_message = body.or_else(|| {
                                    attachment_preview_text(attachments)
                                });
                                got_last = true;
                            }

                            // Count incoming messages newer than last_read_ts
                            if !is_outgoing && ts > last_read_ts {
                                unread += 1;
                            }

                            // Once we're past the last-read boundary, no more unreads
                            if ts <= last_read_ts {
                                break;
                            }

                            // Cap to avoid scanning entire history for never-read channels
                            if scanned >= MAX_SCAN {
                                break;
                            }
                        }
                    }
                    channel.unread_count = unread;
                }
            }

            // Sort by most recent message first
            channels.sort_by(|a, b| b.last_message_timestamp.cmp(&a.last_message_timestamp));

            Ok(channels)
        })
    }

    /// Get messages for a specific channel
    pub fn get_messages(
        &self,
        channel_id: String,
        limit: u32,
    ) -> Result<Vec<Message>, SignalError> {
        let manager_guard = self.manager.read();
        let manager = manager_guard.as_ref().ok_or(SignalError::NotLinked)?;
        let my_user_id = self.user_id.read().ok_or(SignalError::NotLinked)?;
        let attachments_dir = self.data_dir.join("attachments");
        let _ = std::fs::create_dir_all(&attachments_dir);
        let listener = self.listener.read().clone();
        let inflight = self.inflight_downloads.clone();
        let runtime_handle = self.runtime.handle().clone();

        let local = tokio::task::LocalSet::new();
        local.block_on(&self.runtime, async {
            let thread = if channel_id.len() == 64 {
                // Hex-encoded group master key
                let key_bytes = hex::decode(&channel_id).map_err(|_| SignalError::ParseError {
                    message: "Invalid group ID".to_string(),
                })?;
                let key: [u8; 32] = key_bytes.try_into().map_err(|_| SignalError::ParseError {
                    message: "Invalid group key length".to_string(),
                })?;
                Thread::Group(key)
            } else {
                let uuid: Uuid = channel_id.parse().map_err(|_| SignalError::ParseError {
                    message: "Invalid UUID".to_string(),
                })?;
                Thread::Contact(ServiceId::from(Aci::from(uuid)))
            };

            let mut messages_with_pointers = Vec::new();
            let mut reaction_events = Vec::new();

            if let Ok(iter) = manager.store().messages(&thread, ..).await {
                // Messages come DESC (newest first); take `limit` newest
                let limit = limit as usize;
                for result in iter {
                    if let Ok(content) = result {
                        match process_content(&content, my_user_id, Some(&channel_id)) {
                            Some(ProcessedContent::Message(msg, pointers)) => {
                                messages_with_pointers.push((msg, pointers));
                                if limit > 0 && messages_with_pointers.len() >= limit {
                                    break;
                                }
                            }
                            Some(ProcessedContent::Reaction(reaction)) => {
                                reaction_events.push(reaction);
                            }
                            None => {}
                        }
                    }
                }
            }

            // Check attachment cache (no network) and spawn background downloads for uncached
            let is_group = channel_id.len() == 64;
            let mut sender_name_cache: HashMap<String, Option<String>> = HashMap::new();
            let mut messages = Vec::new();
            for (mut msg, pointers) in messages_with_pointers {
                if !pointers.is_empty() {
                    for (idx, pointer) in pointers.iter().enumerate() {
                        let (attachment, cache_key) =
                            check_attachment_cache(pointer, &attachments_dir);

                        // If not cached and we have a listener, spawn background download
                        if attachment.file_path.is_none() {
                            if let Some(ref listener) = listener {
                                spawn_background_download(
                                    &runtime_handle,
                                    manager.clone(),
                                    pointer.clone(),
                                    attachments_dir.clone(),
                                    channel_id.clone(),
                                    msg.id.clone(),
                                    idx as u32,
                                    listener.clone(),
                                    inflight.clone(),
                                    cache_key,
                                );
                            }
                        }
                        msg.attachments.push(attachment);
                    }
                }
                // Resolve sender name for incoming group messages
                if is_group && !msg.is_outgoing {
                    let sid = &msg.sender_id;
                    if !sender_name_cache.contains_key(sid) {
                        let name = if let Ok(uuid) = sid.parse::<Uuid>() {
                            let service_id = ServiceId::from(Aci::from(uuid));
                            let (n, _) = resolve_contact_name_readonly(manager, uuid, &service_id).await;
                            // Only use the name if it's a real name, not a UUID fallback
                            if n.is_empty() || n == uuid.to_string() { None } else { Some(n) }
                        } else {
                            None
                        };
                        sender_name_cache.insert(sid.clone(), name);
                    }
                    msg.sender_name = sender_name_cache.get(sid).cloned().flatten();
                }
                messages.push(msg);
            }

            // Aggregate reactions onto their target messages.
            let mut reaction_map: HashMap<u64, HashMap<String, String>> = HashMap::new();
            for evt in &reaction_events {
                let entry = reaction_map
                    .entry(evt.target_timestamp)
                    .or_default();
                if evt.remove {
                    entry.remove(&evt.sender_id);
                } else {
                    entry.insert(evt.sender_id.clone(), evt.emoji.clone());
                }
            }

            // Attach reactions to their target messages
            for msg in &mut messages {
                if let Some(sender_emoji_map) = reaction_map.remove(&msg.timestamp) {
                    for (sender_id, emoji) in sender_emoji_map {
                        msg.reactions.push(Reaction {
                            emoji,
                            sender_id,
                            target_timestamp: msg.timestamp,
                        });
                    }
                }
            }

            // messages() returns DESC order; reverse to chronological
            messages.reverse();
            Ok(messages)
        })
    }

    /// Send a text message to a channel
    pub fn send_message(&self, channel_id: String, text: String) -> Result<Message, SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;

        let my_user_id = self.user_id.read().ok_or(SignalError::NotLinked)?;

        // Use stacker for dynamic stack growth - encryption operations are stack-hungry
        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        // Log device_id for sync debugging
        tracing::info!(
            "HUSH_SYNC_DEBUG: device_id={:?}, my_user_id={}, channel_id={}",
            manager.device_id(),
            my_user_id,
            channel_id
        );

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let data_message = DataMessage {
                body: Some(text.clone()),
                timestamp: Some(timestamp),
                ..Default::default()
            };

            // Check if this is a group or direct message
            if channel_id.len() == 64 {
                // Hex-encoded master key bytes (32 bytes = 64 hex chars) -> group
                let master_key_bytes = hex::decode(&channel_id).map_err(|_| {
                    SignalError::ParseError {
                        message: "Invalid group ID".to_string(),
                    }
                })?;

                // For groups, we need to include group context
                let mut data_message = data_message;
                data_message.group_v2 = Some(GroupContextV2 {
                    master_key: Some(master_key_bytes.clone()),
                    revision: Some(0),
                    ..Default::default()
                });

                // presage's send_message_to_group handles sync messages internally
                tracing::info!("HUSH_SYNC: sending group message (presage handles sync internally)");
                manager
                    .send_message_to_group(&master_key_bytes, data_message.clone(), timestamp)
                    .await
                    .map_err(|e| {
                        tracing::error!("HUSH_SYNC: group send failed: {}", e);
                        SignalError::SendFailed {
                            message: e.to_string(),
                        }
                    })?;
                tracing::info!("HUSH_SYNC: group message sent successfully (sync should have been sent by presage)");
            } else {
                // UUID -> direct message
                let recipient_uuid: Uuid =
                    channel_id.parse().map_err(|_| SignalError::ParseError {
                        message: "Invalid UUID".to_string(),
                    })?;

                let recipient_aci = Aci::from(recipient_uuid);
                // presage's send_message handles sync messages internally
                tracing::info!("HUSH_SYNC: sending direct message to {:?} (presage handles sync internally)", recipient_aci);
                let body = ContentBody::DataMessage(data_message.clone());
                manager
                    .send_message(recipient_aci, body, timestamp)
                    .await
                    .map_err(|e| {
                        tracing::error!("HUSH_SYNC: direct send failed: {}", e);
                        SignalError::SendFailed {
                            message: e.to_string(),
                        }
                    })?;
                tracing::info!("HUSH_SYNC: direct message sent successfully (sync should have been sent by presage)");
            }

            Ok(Message {
                id: timestamp.to_string(),
                channel_id,
                sender_id: my_user_id.to_string(),
                sender_name: None,
                body: Some(text),
                timestamp,
                is_outgoing: true,
                status: MessageStatus::Sent,
                attachments: vec![],
                reactions: vec![],
            })
        })
        })
    }

    /// Send a message with file attachments to a channel
    pub fn send_message_with_attachments(
        &self,
        channel_id: String,
        text: Option<String>,
        attachment_paths: Vec<String>,
    ) -> Result<Message, SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;

        let my_user_id = self.user_id.read().ok_or(SignalError::NotLinked)?;

        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;

                // Read files and build attachment specs
                let mut specs: Vec<(AttachmentSpec, Vec<u8>)> = Vec::new();
                let mut file_names: Vec<Option<String>> = Vec::new();
                let mut content_types: Vec<String> = Vec::new();

                for path_str in &attachment_paths {
                    let path = std::path::Path::new(path_str);
                    let data = std::fs::read(path).map_err(|e| SignalError::InternalError {
                        message: format!("Failed to read file {}: {}", path_str, e),
                    })?;

                    let mime = mime_guess::from_path(path)
                        .first_or_octet_stream()
                        .to_string();
                    let file_name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string());

                    let spec = AttachmentSpec {
                        content_type: mime.clone(),
                        length: data.len(),
                        file_name: file_name.clone(),
                        ..Default::default()
                    };

                    content_types.push(mime);
                    file_names.push(file_name);
                    specs.push((spec, data));
                }

                // Upload attachments
                let results = manager
                    .upload_attachments(specs)
                    .await
                    .map_err(|e| SignalError::SendFailed {
                        message: format!("Failed to upload attachments: {}", e),
                    })?;

                let mut pointers = Vec::new();
                for result in results {
                    match result {
                        Ok(pointer) => pointers.push(pointer),
                        Err(e) => {
                            warn!("Failed to upload attachment: {:?}", e);
                        }
                    }
                }

                if pointers.is_empty() && text.is_none() {
                    return Err(SignalError::SendFailed {
                        message: "All attachment uploads failed".to_string(),
                    });
                }

                // Build data message
                let mut data_message = DataMessage {
                    body: text.clone(),
                    timestamp: Some(timestamp),
                    attachments: pointers,
                    ..Default::default()
                };

                // Send to group or direct
                if channel_id.len() == 64 {
                    let master_key_bytes =
                        hex::decode(&channel_id).map_err(|_| SignalError::ParseError {
                            message: "Invalid group ID".to_string(),
                        })?;

                    data_message.group_v2 = Some(GroupContextV2 {
                        master_key: Some(master_key_bytes.clone()),
                        revision: Some(0),
                        ..Default::default()
                    });

                    // presage handles sync messages internally
                    manager
                        .send_message_to_group(&master_key_bytes, data_message.clone(), timestamp)
                        .await
                        .map_err(|e| SignalError::SendFailed {
                            message: e.to_string(),
                        })?;
                } else {
                    let recipient_uuid: Uuid =
                        channel_id.parse().map_err(|_| SignalError::ParseError {
                            message: "Invalid UUID".to_string(),
                        })?;

                    let recipient_aci = Aci::from(recipient_uuid);
                    // presage handles sync messages internally
                    let body = ContentBody::DataMessage(data_message.clone());
                    manager
                        .send_message(recipient_aci, body, timestamp)
                        .await
                        .map_err(|e| SignalError::SendFailed {
                            message: e.to_string(),
                        })?;
                }

                // Build return attachments from original file paths
                let attachments: Vec<Attachment> = attachment_paths
                    .iter()
                    .enumerate()
                    .map(|(i, path)| Attachment {
                        content_type: content_types
                            .get(i)
                            .cloned()
                            .unwrap_or_else(|| "application/octet-stream".to_string()),
                        file_path: Some(path.clone()),
                        file_name: file_names.get(i).cloned().flatten(),
                        width: None,
                        height: None,
                        size: None,
                    })
                    .collect();

                Ok(Message {
                    id: timestamp.to_string(),
                    channel_id,
                    sender_id: my_user_id.to_string(),
                    sender_name: None,
                    body: text,
                    timestamp,
                    is_outgoing: true,
                    status: MessageStatus::Sent,
                    attachments,
                    reactions: vec![],
                })
            })
        })
    }

    /// Fetch profile avatars for all contacts and group avatars from the network.
    /// Writes avatar images to disk so that get_channels() can return their paths.
    pub fn fetch_all_avatars(&self) -> Result<(), SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;
        let avatars_dir = self.data_dir.join("avatars");
        let _ = std::fs::create_dir_all(&avatars_dir);

        let local = tokio::task::LocalSet::new();
        local.block_on(&self.runtime, async {
            // Collect contacts with profile keys
            let contacts: Vec<_> = match manager.store().contacts().await {
                Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
                Err(e) => {
                    warn!("Failed to load contacts for avatar fetch: {e}");
                    vec![]
                }
            };

            for contact in &contacts {
                if contact.name.is_empty() {
                    continue;
                }
                let avatar_file = avatars_dir.join(contact.uuid.to_string());
                if avatar_file.exists() {
                    continue;
                }
                // Resolve profile key: try contact field first, then store
                let profile_key =
                    if let Ok(key_bytes) = <Vec<u8> as TryInto<[u8; 32]>>::try_into(
                        contact.profile_key.clone(),
                    ) {
                        Some(ProfileKey::create(key_bytes))
                    } else {
                        let sid: ServiceId = Aci::from(contact.uuid).into();
                        manager
                            .store()
                            .profile_key(&sid)
                            .await
                            .ok()
                            .flatten()
                    };
                let Some(profile_key) = profile_key else {
                    continue;
                };
                match manager
                    .retrieve_profile_avatar_by_uuid(contact.uuid, profile_key)
                    .await
                {
                    Ok(Some(avatar_bytes)) if !avatar_bytes.is_empty() => {
                        if let Err(e) = std::fs::write(&avatar_file, &avatar_bytes) {
                            warn!("Failed to write avatar for {}: {e}", contact.uuid);
                        } else {
                            info!("Saved avatar for contact {}", contact.name);
                        }
                    }
                    Ok(_) => {} // No avatar set
                    Err(e) => {
                        warn!("Failed to fetch avatar for {}: {e}", contact.name);
                    }
                }
            }

            // Collect groups
            let groups: Vec<_> = match manager.store().groups().await {
                Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
                Err(e) => {
                    warn!("Failed to load groups for avatar fetch: {e}");
                    vec![]
                }
            };

            for (master_key_bytes, group) in &groups {
                let group_id = hex::encode(master_key_bytes);
                let avatar_file = avatars_dir.join(&group_id);
                if avatar_file.exists() {
                    continue;
                }
                if group.avatar.is_empty() {
                    continue;
                }
                let context = GroupContextV2 {
                    master_key: Some(master_key_bytes.to_vec()),
                    revision: Some(group.revision),
                    ..Default::default()
                };
                match manager.retrieve_group_avatar(context).await {
                    Ok(Some(avatar_bytes)) if !avatar_bytes.is_empty() => {
                        if let Err(e) = std::fs::write(&avatar_file, &avatar_bytes) {
                            warn!("Failed to write group avatar for {}: {e}", group.title);
                        } else {
                            info!("Saved avatar for group {}", group.title);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!("Failed to fetch group avatar for {}: {e}", group.title);
                    }
                }
            }

            Ok(())
        })
    }

    /// Start receiving messages
    /// Spawns a dedicated thread with 8MB stack for Signal Protocol crypto operations.
    /// Guards against multiple concurrent receive threads.
    /// Call stop_receiving to stop.
    pub fn start_receiving(&self, listener: Box<dyn MessageListener>) -> Result<(), SignalError> {
        // If already receiving, don't disturb the existing loop
        if self.is_receiving.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Atomically claim the receive slot
        if self.is_receiving.swap(true, Ordering::SeqCst) {
            return Ok(()); // Someone else claimed it between load and swap
        }

        self.stop_flag.store(false, Ordering::SeqCst);

        let manager_guard = self.manager.read();
        let manager = match manager_guard.as_ref() {
            Some(m) => m,
            None => {
                self.is_receiving.store(false, Ordering::SeqCst);
                return Err(SignalError::NotLinked);
            }
        };

        let my_user_id = match *self.user_id.read() {
            Some(id) => id,
            None => {
                self.is_receiving.store(false, Ordering::SeqCst);
                return Err(SignalError::NotLinked);
            }
        };

        // Wrap listener in Arc and store for shared access (get_messages, retry_download)
        let listener: Arc<dyn MessageListener> = Arc::from(listener);
        *self.listener.write() = Some(listener.clone());

        let stop_flag = self.stop_flag.clone();
        let is_receiving = self.is_receiving.clone();
        let self_listener = self.listener.clone();
        let manager_for_stream = manager.clone();
        let manager_for_attachments = manager.clone();
        let attachments_dir = self.data_dir.join("attachments");
        let _ = std::fs::create_dir_all(&attachments_dir);
        let avatars_dir = self.data_dir.join("avatars");
        let _ = std::fs::create_dir_all(&avatars_dir);
        let runtime_handle = self.runtime.handle().clone();
        let read_state = self.read_state.clone();
        let inflight = self.inflight_downloads.clone();

        std::thread::Builder::new()
            .name("signal-receive".to_string())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                const RED_ZONE: usize = 512 * 1024;
                const STACK_SIZE: usize = 8 * 1024 * 1024;

                stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
                    let local = tokio::task::LocalSet::new();
                    let runtime_handle_inner = runtime_handle.clone();
                    runtime_handle.block_on(local.run_until(async move {
                        info!("Starting message receive loop");

                        let mut manager_for_stream = manager_for_stream;
                        loop {
                            if stop_flag.load(Ordering::SeqCst) {
                                break;
                            }

                            match manager_for_stream.receive_messages().await {
                                Ok(stream) => {
                                    let mut stream = Box::pin(stream);
                                    while let Some(received) = stream.next().await {
                                        if stop_flag.load(Ordering::SeqCst) {
                                            info!("Stop flag set, exiting receive loop");
                                            break;
                                        }

                                        // Parse message inside stacker (crypto may need stack space)
                                        let result = stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
                                            match received {
                                                presage::model::messages::Received::Content(content) => {
                                                    process_content(&content, my_user_id, None)
                                                }
                                                presage::model::messages::Received::QueueEmpty => {
                                                    info!("Message queue is empty");
                                                    None
                                                }
                                                presage::model::messages::Received::Contacts => {
                                                    info!("Received contacts sync");
                                                    None
                                                }
                                            }
                                        });

                                        // Handle reaction events
                                        if let Some(ProcessedContent::Reaction(reaction_event)) = &result {
                                            listener.on_reaction(reaction_event.clone());
                                            continue;
                                        }

                                        // Check cache only (no blocking downloads)
                                        let (mut message, pointers) = match result {
                                            Some(ProcessedContent::Message(msg, ptrs)) => (msg, ptrs),
                                            _ => continue,
                                        };

                                        {
                                            for (idx, pointer) in pointers.iter().enumerate() {
                                                let (attachment, cache_key) =
                                                    check_attachment_cache(pointer, &attachments_dir);

                                                // Spawn background download for uncached
                                                if attachment.file_path.is_none() {
                                                    spawn_background_download(
                                                        &runtime_handle_inner,
                                                        manager_for_attachments.clone(),
                                                        pointer.clone(),
                                                        attachments_dir.clone(),
                                                        message.channel_id.clone(),
                                                        message.id.clone(),
                                                        idx as u32,
                                                        listener.clone(),
                                                        inflight.clone(),
                                                        cache_key,
                                                    );
                                                }
                                                message.attachments.push(attachment);
                                            }

                                            // For incoming messages, look up sender name and emit channel update
                                            if !message.is_outgoing {
                                                let channel_id = message.channel_id.clone();
                                                let is_group = message.channel_id.len() == 64;

                                                // Look up real name and avatar from the store
                                                let (name, avatar_path, phone_number) = if is_group {
                                                    // Group: look up by master key
                                                    let name = if let Ok(key_bytes) = hex::decode(&channel_id) {
                                                        if let Ok(key) = <[u8; 32]>::try_from(key_bytes.as_slice()) {
                                                            manager_for_attachments.store().group(key).await
                                                                .ok().flatten().map(|g| g.title).unwrap_or_default()
                                                        } else { String::new() }
                                                    } else { String::new() };
                                                    let avatar_file = avatars_dir.join(&channel_id);
                                                    let avatar = if avatar_file.exists() {
                                                        Some(avatar_file.to_string_lossy().to_string())
                                                    } else { None };
                                                    (name, avatar, None)
                                                } else {
                                                    // Contact: look up by UUID with profile fallback
                                                    let (name, phone) = if let Ok(uuid) = channel_id.parse::<Uuid>() {
                                                        let sid = ServiceId::from(Aci::from(uuid));
                                                        let (n, p) = resolve_contact_name_readonly(&manager_for_attachments, uuid, &sid).await;
                                                        // If name is just the UUID fallback, use empty string
                                                        // so the JS store keeps the existing resolved name
                                                        if n == uuid.to_string() {
                                                            (String::new(), p)
                                                        } else {
                                                            (n, p)
                                                        }
                                                    } else { (String::new(), None) };
                                                    let avatar_file = avatars_dir.join(&channel_id);
                                                    let avatar = if avatar_file.exists() {
                                                        Some(avatar_file.to_string_lossy().to_string())
                                                    } else { None };
                                                    (name, avatar, phone)
                                                };

                                                // Set sender_name on the message
                                                if is_group {
                                                    // For group messages, resolve the individual sender's name
                                                    if let Ok(sender_uuid) = message.sender_id.parse::<Uuid>() {
                                                        let sender_sid = ServiceId::from(Aci::from(sender_uuid));
                                                        let (sender_name, _) = resolve_contact_name_readonly(&manager_for_attachments, sender_uuid, &sender_sid).await;
                                                        // Only use the name if it's a real name, not a UUID fallback
                                                        if !sender_name.is_empty() && sender_name != sender_uuid.to_string() {
                                                            message.sender_name = Some(sender_name);
                                                        }
                                                    }
                                                } else if !name.is_empty() {
                                                    message.sender_name = Some(name.clone());
                                                }

                                                let state = read_state.read();
                                                let last_read = state.get(&channel_id).copied().unwrap_or(0);
                                                if message.timestamp > last_read {
                                                    drop(state);
                                                    listener.on_channel_updated(Channel {
                                                        id: channel_id,
                                                        name,
                                                        is_group,
                                                        unread_count: 0,
                                                        last_message: message.body.clone(),
                                                        last_message_timestamp: Some(message.timestamp),
                                                        avatar_path,
                                                        phone_number,
                                                    });
                                                }
                                            }

                                            listener.on_message(message);
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Error receiving messages: {}", e);
                                    listener.on_error(e.to_string());
                                }
                            }

                            // Stream ended (disconnected) — wait before retry
                            if stop_flag.load(Ordering::SeqCst) {
                                break;
                            }
                            info!("Receive stream ended, reconnecting in 5 seconds...");
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        }

                        info!("Message receive loop ended");
                    }));
                });

                // Clear the guard so a new receive thread can be spawned
                is_receiving.store(false, Ordering::SeqCst);
                // Clear the shared listener
                *self_listener.write() = None;
            })
            .map_err(|e| {
                self.is_receiving.store(false, Ordering::SeqCst);
                SignalError::InternalError {
                    message: format!("Failed to spawn receive thread: {}", e),
                }
            })?;

        Ok(())
    }

    /// Stop receiving messages
    pub fn stop_receiving(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // Clear the shared listener (in-flight tasks hold their own Arc clones)
        *self.listener.write() = None;
        info!("Stop receiving requested");
    }

    /// Send an emoji reaction to a message
    pub fn send_reaction(
        &self,
        channel_id: String,
        emoji: String,
        target_timestamp: u64,
        remove: bool,
    ) -> Result<(), SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;

        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;

                let reaction = presage::proto::data_message::Reaction {
                    emoji: Some(emoji),
                    remove: Some(remove),
                    target_sent_timestamp: Some(target_timestamp),
                    ..Default::default()
                };

                let data_message = DataMessage {
                    reaction: Some(reaction),
                    timestamp: Some(timestamp),
                    ..Default::default()
                };

                if channel_id.len() == 64 {
                    let master_key_bytes =
                        hex::decode(&channel_id).map_err(|_| SignalError::ParseError {
                            message: "Invalid group ID".to_string(),
                        })?;

                    let mut data_message = data_message;
                    data_message.group_v2 = Some(GroupContextV2 {
                        master_key: Some(master_key_bytes.clone()),
                        revision: Some(0),
                        ..Default::default()
                    });

                    // presage handles sync messages internally
                    manager
                        .send_message_to_group(&master_key_bytes, data_message.clone(), timestamp)
                        .await
                        .map_err(|e| SignalError::SendFailed {
                            message: e.to_string(),
                        })?;
                } else {
                    let recipient_uuid: Uuid =
                        channel_id.parse().map_err(|_| SignalError::ParseError {
                            message: "Invalid UUID".to_string(),
                        })?;

                    let recipient_aci = Aci::from(recipient_uuid);
                    // presage handles sync messages internally
                    let body = ContentBody::DataMessage(data_message.clone());
                    manager
                        .send_message(recipient_aci, body, timestamp)
                        .await
                        .map_err(|e| SignalError::SendFailed {
                            message: e.to_string(),
                        })?;
                }

                info!(
                    "Sent reaction {} to message {} in channel {}",
                    if remove { "(remove)" } else { "" },
                    target_timestamp,
                    channel_id
                );
                Ok(())
            })
        })
    }

    /// Mark a channel as read up to the given timestamp.
    /// Updates the persisted read state and returns the updated unread count (always 0).
    pub fn mark_as_read(&self, channel_id: String, up_to_timestamp: u64) -> Result<(), SignalError> {
        {
            let mut state = self.read_state.write();
            let current = state.get(&channel_id).copied().unwrap_or(0);
            if up_to_timestamp > current {
                state.insert(channel_id.clone(), up_to_timestamp);
                save_read_state(&self.data_dir, &state);
            }
        }
        info!("Marked channel {} as read up to {}", channel_id, up_to_timestamp);
        Ok(())
    }

    /// Get all sessions in the database, grouped by address, with contact names where known.
    pub fn get_all_sessions(&self) -> Result<Vec<SessionInfo>, SignalError> {
        let manager_guard = self.manager.read();
        let manager = manager_guard.as_ref().ok_or(SignalError::NotLinked)?;
        let my_user_id = self.user_id.read();

        let local = tokio::task::LocalSet::new();
        local.block_on(&self.runtime, async {
            // Build a name lookup from contacts + profiles
            let mut name_map: HashMap<String, String> = HashMap::new();
            if let Ok(contacts_iter) = manager.store().contacts().await {
                for contact_result in contacts_iter {
                    if let Ok(contact) = contact_result {
                        if !contact.name.is_empty() {
                            name_map.insert(contact.uuid.to_string(), contact.name.clone());
                        }
                    }
                }
            }
            // Also check profiles table for names not in contacts
            let db_path_str = self.store_path.to_string_lossy().to_string();
            if let Ok(profile_output) = std::process::Command::new("sqlite3")
                .arg(&db_path_str)
                .arg("SELECT lower(hex(uuid)), given_name, family_name FROM profiles WHERE given_name IS NOT NULL AND given_name != '';")
                .output()
            {
                let profile_stdout = String::from_utf8_lossy(&profile_output.stdout);
                for line in profile_stdout.lines() {
                    let parts: Vec<&str> = line.split('|').collect();
                    if parts.len() >= 2 {
                        // Convert hex UUID to dashed format
                        let hex = parts[0];
                        if hex.len() == 32 {
                            let uuid_str = format!(
                                "{}-{}-{}-{}-{}",
                                &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]
                            );
                            if !name_map.contains_key(&uuid_str) {
                                let mut name = parts[1].to_string();
                                if parts.len() >= 3 && !parts[2].is_empty() {
                                    name.push(' ');
                                    name.push_str(parts[2]);
                                }
                                name_map.insert(uuid_str, name);
                            }
                        }
                    }
                }
            }

            // Query distinct session addresses directly from the DB
            let db_path = self.store_path.to_string_lossy().to_string();
            let output = std::process::Command::new("sqlite3")
                .arg(&db_path)
                .arg("SELECT address, COUNT(*) FROM sessions WHERE identity = 'aci' GROUP BY address ORDER BY address;")
                .output()
                .map_err(|e| SignalError::InternalError {
                    message: format!("Failed to query sessions: {}", e),
                })?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut sessions = Vec::new();

            for line in stdout.lines() {
                let parts: Vec<&str> = line.split('|').collect();
                if parts.len() == 2 {
                    let address = parts[0].to_string();
                    let device_count: u32 = parts[1].parse().unwrap_or(0);

                    let is_self = match *my_user_id {
                        Some(my_id) => address == my_id.to_string(),
                        None => false,
                    };

                    let contact_name = name_map.get(&address).cloned();

                    sessions.push(SessionInfo {
                        address,
                        device_count,
                        contact_name,
                        is_self,
                    });
                }
            }

            // Sort: self first, then named contacts, then unknown by address
            sessions.sort_by(|a, b| {
                match (a.is_self, b.is_self) {
                    (true, false) => return std::cmp::Ordering::Less,
                    (false, true) => return std::cmp::Ordering::Greater,
                    _ => {}
                }
                match (&a.contact_name, &b.contact_name) {
                    (Some(na), Some(nb)) => na.cmp(nb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.address.cmp(&b.address),
                }
            });

            Ok(sessions)
        })
    }

    /// Reset the encrypted session with a contact.
    /// Sends an END_SESSION message so the remote side resets their session,
    /// then deletes local session records to force a fresh key exchange.
    pub fn reset_session(&self, channel_id: String) -> Result<(), SignalError> {
        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;

        let uuid: Uuid = channel_id.parse().map_err(|_| SignalError::ParseError {
            message: "Invalid UUID".to_string(),
        })?;

        let service_id = ServiceId::from(Aci::from(uuid));

        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;

                // 1. Send END_SESSION to all of the recipient's devices
                info!("Sending session reset (END_SESSION) to {}", channel_id);
                manager
                    .send_session_reset(&service_id, timestamp)
                    .await
                    .map_err(|e| SignalError::SendFailed {
                        message: format!("Failed to send session reset: {}", e),
                    })?;
                info!("Session reset sent to {}", channel_id);

                // 2. Delete local session records so incoming messages
                //    trigger a fresh PreKey exchange
                use presage::libsignal_service::session_store::SessionStoreExt;
                use presage::store::Store;
                let deleted = manager
                    .store()
                    .aci_protocol_store()
                    .delete_all_sessions(&service_id)
                    .await
                    .map_err(|e| SignalError::InternalError {
                        message: format!("Failed to delete local sessions: {:?}", e),
                    })?;
                info!("Deleted {} local sessions for {}", deleted, channel_id);

                Ok(())
            })
        })
    }

    /// Send a read receipt for the given message timestamps to a specific sender.
    /// For group messages, receipts go to individual senders, not the group.
    pub fn send_read_receipt(
        &self,
        sender_uuid: String,
        timestamps: Vec<u64>,
    ) -> Result<(), SignalError> {
        if timestamps.is_empty() {
            return Ok(());
        }

        let mut manager_guard = self.manager.write();
        let manager = manager_guard.as_mut().ok_or(SignalError::NotLinked)?;

        let recipient: Uuid = sender_uuid.parse().map_err(|_| SignalError::ParseError {
            message: "Invalid sender UUID".to_string(),
        })?;

        let receipt = ReceiptMessage {
            r#type: Some(receipt_message::Type::Read as i32),
            timestamp: timestamps.clone(),
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        const RED_ZONE: usize = 512 * 1024;
        const STACK_SIZE: usize = 8 * 1024 * 1024;

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            let local = tokio::task::LocalSet::new();
            local.block_on(&self.runtime, async {
                let recipient_aci = Aci::from(recipient);
                manager
                    .send_message(recipient_aci, ContentBody::ReceiptMessage(receipt), now)
                    .await
                    .map_err(|e| SignalError::SendFailed {
                        message: format!("Failed to send read receipt: {}", e),
                    })?;
                info!("Sent read receipt for {} timestamps to {}", timestamps.len(), sender_uuid);
                Ok(())
            })
        })
    }
    /// Retry downloading a specific attachment for a message.
    /// Re-reads the message from the store by timestamp, extracts the pointer,
    /// and spawns a background download.
    pub fn retry_download(
        &self,
        channel_id: String,
        message_id: String,
        attachment_index: u32,
    ) -> Result<(), SignalError> {
        let manager_guard = self.manager.read();
        let manager = manager_guard.as_ref().ok_or(SignalError::NotLinked)?;
        let listener_guard = self.listener.read();
        let listener = listener_guard.as_ref().ok_or(SignalError::InternalError {
            message: "No active listener — call startReceiving first".to_string(),
        })?.clone();
        let attachments_dir = self.data_dir.join("attachments");
        let _ = std::fs::create_dir_all(&attachments_dir);
        let inflight = self.inflight_downloads.clone();
        let runtime_handle = self.runtime.handle().clone();

        let local = tokio::task::LocalSet::new();
        local.block_on(&self.runtime, async {
            let thread = if channel_id.len() == 64 {
                let key_bytes = hex::decode(&channel_id).map_err(|_| SignalError::ParseError {
                    message: "Invalid group ID".to_string(),
                })?;
                let key: [u8; 32] = key_bytes.try_into().map_err(|_| SignalError::ParseError {
                    message: "Invalid group key length".to_string(),
                })?;
                Thread::Group(key)
            } else {
                let uuid: Uuid = channel_id.parse().map_err(|_| SignalError::ParseError {
                    message: "Invalid UUID".to_string(),
                })?;
                Thread::Contact(ServiceId::from(Aci::from(uuid)))
            };

            // Find the message by timestamp (message_id == timestamp string)
            let target_ts: u64 = message_id.parse().map_err(|_| SignalError::ParseError {
                message: "Invalid message ID (expected timestamp)".to_string(),
            })?;

            if let Ok(iter) = manager.store().messages(&thread, ..).await {
                for result in iter {
                    if let Ok(content) = result {
                        if content.metadata.timestamp == target_ts {
                            // Extract the attachment pointer
                            let pointers = match &content.body {
                                ContentBody::DataMessage(dm) => &dm.attachments,
                                ContentBody::SynchronizeMessage(sync) => {
                                    if let Some(sent) = &sync.sent {
                                        if let Some(dm) = &sent.message {
                                            &dm.attachments
                                        } else {
                                            return Err(SignalError::InternalError {
                                                message: "No data message in sync".to_string(),
                                            });
                                        }
                                    } else {
                                        return Err(SignalError::InternalError {
                                            message: "No sent message in sync".to_string(),
                                        });
                                    }
                                }
                                _ => {
                                    return Err(SignalError::InternalError {
                                        message: "Unexpected content body type".to_string(),
                                    });
                                }
                            };

                            let idx = attachment_index as usize;
                            if idx >= pointers.len() {
                                return Err(SignalError::InternalError {
                                    message: format!(
                                        "Attachment index {} out of range ({})",
                                        idx,
                                        pointers.len()
                                    ),
                                });
                            }

                            let pointer = &pointers[idx];
                            let (_, cache_key) = check_attachment_cache(pointer, &attachments_dir);

                            spawn_background_download(
                                &runtime_handle,
                                manager.clone(),
                                pointer.clone(),
                                attachments_dir,
                                channel_id,
                                message_id,
                                attachment_index,
                                listener,
                                inflight,
                                cache_key,
                            );

                            return Ok(());
                        }
                    }
                }
            }

            Err(SignalError::InternalError {
                message: format!("Message {} not found in channel {}", message_id, channel_id),
            })
        })
    }
}

/// Check the filesystem cache for an attachment. Returns (Attachment, cache_key).
/// `file_path` is `Some` if cached on disk, `None` otherwise. No network call.
fn check_attachment_cache(
    pointer: &AttachmentPointer,
    attachments_dir: &std::path::Path,
) -> (Attachment, String) {
    let content_type = pointer
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let file_name = pointer.file_name.clone();
    let width = pointer.width;
    let height = pointer.height;
    let size = pointer.size;

    let cache_key = if let Some(digest) = &pointer.digest {
        hex::encode(digest)
    } else {
        match &pointer.attachment_identifier {
            Some(AttachmentIdentifier::CdnId(id)) => format!("cdn_{}", id),
            Some(AttachmentIdentifier::CdnKey(key)) => {
                format!("key_{}", key.replace('/', "_"))
            }
            None => format!(
                "unknown_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
        }
    };

    let ext = extension_from_content_type(&content_type);
    let file_path = attachments_dir.join(format!("{}.{}", cache_key, ext));

    let attachment = Attachment {
        content_type,
        file_path: if file_path.exists() {
            Some(file_path.to_string_lossy().to_string())
        } else {
            None
        },
        file_name,
        width,
        height,
        size,
    };

    (attachment, cache_key)
}

/// Spawn a background tokio task to download an attachment and notify the listener.
fn spawn_background_download(
    runtime_handle: &tokio::runtime::Handle,
    manager: PresageManager,
    pointer: AttachmentPointer,
    attachments_dir: PathBuf,
    channel_id: String,
    message_id: String,
    attachment_index: u32,
    listener: Arc<dyn MessageListener>,
    inflight: Arc<RwLock<HashSet<String>>>,
    cache_key: String,
) {
    // Check and insert into inflight set atomically
    {
        let mut set = inflight.write();
        if set.contains(&cache_key) {
            return; // Already downloading
        }
        set.insert(cache_key.clone());
    }

    runtime_handle.spawn(async move {
        // Re-check cache (another task may have completed)
        let content_type = pointer
            .content_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let ext = extension_from_content_type(&content_type);
        let file_path = attachments_dir.join(format!("{}.{}", cache_key, ext));

        let attachment = if file_path.exists() {
            Attachment {
                content_type,
                file_path: Some(file_path.to_string_lossy().to_string()),
                file_name: pointer.file_name.clone(),
                width: pointer.width,
                height: pointer.height,
                size: pointer.size,
            }
        } else {
            download_and_save_attachment(&manager, &pointer, &attachments_dir).await
        };

        // Remove from inflight set
        {
            let mut set = inflight.write();
            set.remove(&cache_key);
        }

        // Notify listener
        listener.on_attachment_downloaded(
            channel_id,
            message_id,
            attachment_index,
            attachment,
        );
    });
}

/// Result of processing a Content message
enum ProcessedContent {
    /// A regular user-visible message (with attachment pointers to download)
    Message(Message, Vec<AttachmentPointer>),
    /// A reaction on an existing message
    Reaction(ReactionEvent),
}

/// Extract channel_id from a DataMessage (group context or sender UUID)
fn channel_id_from_dm(dm: &DataMessage, fallback_uuid: Uuid) -> Option<String> {
    if let Some(group_v2) = &dm.group_v2 {
        group_v2.master_key.as_ref().map(hex::encode)
    } else {
        Some(fallback_uuid.to_string())
    }
}

/// Process incoming content and convert to our Message type or a reaction event.
/// `fallback_channel_id` is used when the content doesn't carry a destination
/// (e.g. stored SynchronizeMessage blobs that lack destination_service_id).
fn process_content(
    content: &Content,
    my_user_id: Uuid,
    fallback_channel_id: Option<&str>,
) -> Option<ProcessedContent> {
    let sender_service_id = content.metadata.sender;
    let sender_uuid = sender_service_id.raw_uuid();
    let timestamp = content.metadata.timestamp;
    let is_outgoing = sender_uuid == my_user_id;

    match &content.body {
        ContentBody::DataMessage(dm) => {
            // Check if this is a reaction
            if let Some(reaction) = &dm.reaction {
                if let Some(emoji) = &reaction.emoji {
                    let channel_id = channel_id_from_dm(dm, sender_uuid)?;
                    return Some(ProcessedContent::Reaction(ReactionEvent {
                        channel_id,
                        emoji: emoji.clone(),
                        sender_id: sender_uuid.to_string(),
                        target_timestamp: reaction.target_sent_timestamp.unwrap_or(0),
                        remove: reaction.remove.unwrap_or(false),
                    }));
                }
            }

            // Skip protocol-level messages that aren't user-visible
            // (profile key updates, expiration timer changes, end-session)
            let flags = dm.flags.unwrap_or(0);
            if flags != 0 && dm.body.is_none() && dm.attachments.is_empty() {
                return None;
            }

            let body = dm.body.clone();
            let pointers = dm.attachments.clone();
            let channel_id = channel_id_from_dm(dm, sender_uuid)?;

            Some(ProcessedContent::Message(
                Message {
                    id: timestamp.to_string(),
                    channel_id,
                    sender_id: sender_uuid.to_string(),
                    sender_name: None,
                    body,
                    timestamp,
                    is_outgoing,
                    status: MessageStatus::Delivered,
                    attachments: vec![],
                    reactions: vec![],
                },
                pointers,
            ))
        }
        ContentBody::SynchronizeMessage(sync) => {
            if let Some(sent) = &sync.sent {
                if let Some(dm) = &sent.message {
                    // Check if this is a reaction we sent from another device
                    if let Some(reaction) = &dm.reaction {
                        if let Some(emoji) = &reaction.emoji {
                            let channel_id = if let Some(group_v2) = &dm.group_v2 {
                                group_v2.master_key.as_ref().map(hex::encode)?
                            } else if let Some(dest) = &sent.destination_service_id {
                                dest.clone()
                            } else if let Some(fallback) = fallback_channel_id {
                                fallback.to_string()
                            } else {
                                return None;
                            };
                            return Some(ProcessedContent::Reaction(ReactionEvent {
                                channel_id,
                                emoji: emoji.clone(),
                                sender_id: my_user_id.to_string(),
                                target_timestamp: reaction.target_sent_timestamp.unwrap_or(0),
                                remove: reaction.remove.unwrap_or(false),
                            }));
                        }
                    }

                    let flags = dm.flags.unwrap_or(0);
                    if flags != 0 && dm.body.is_none() && dm.attachments.is_empty() {
                        return None;
                    }

                    let body = dm.body.clone();
                    let pointers = dm.attachments.clone();

                    let channel_id = if let Some(group_v2) = &dm.group_v2 {
                        group_v2.master_key.as_ref().map(hex::encode)?
                    } else if let Some(dest) = &sent.destination_service_id {
                        dest.clone()
                    } else if let Some(fallback) = fallback_channel_id {
                        fallback.to_string()
                    } else {
                        return None;
                    };

                    return Some(ProcessedContent::Message(
                        Message {
                            id: timestamp.to_string(),
                            channel_id,
                            sender_id: my_user_id.to_string(),
                            sender_name: None,
                            body,
                            timestamp,
                            is_outgoing: true,
                            status: MessageStatus::Sent,
                            attachments: vec![],
                            reactions: vec![],
                        },
                        pointers,
                    ));
                }
            }
            None
        }
        _ => None,
    }
}

/// Resolve a contact's display name with fallback chain:
/// 1. Contact name from contacts table
/// 2. Cached profile name (given_name + family_name) from profiles table
/// 3. Fetch profile from Signal servers (requires &mut manager) and cache it
/// 4. UUID string as final fallback
///
/// Also returns phone number if available from the contact record.
async fn resolve_contact_name(
    manager: &mut PresageManager,
    uuid: Uuid,
    service_id: &ServiceId,
) -> (String, Option<String>) {
    // Try contact name first
    if let Ok(Some(contact)) = manager.store().contact_by_id(service_id).await {
        if !contact.name.is_empty() {
            return (
                contact.name.clone(),
                contact.phone_number.as_ref().map(|p| p.to_string()),
            );
        }
    }

    // Try cached profile name, or fetch from network
    if let Ok(Some(profile_key)) = manager.store().profile_key(service_id).await {
        // Check local cache first
        if let Ok(Some(profile)) = manager.store().profile(uuid, profile_key).await {
            if let Some(profile_name) = &profile.name {
                let name = profile_name.to_string();
                if !name.is_empty() {
                    return (name, None);
                }
            }
        }

        // Not cached — fetch from Signal servers (also saves to store)
        match manager.retrieve_profile_by_uuid(uuid, profile_key).await {
            Ok(profile) => {
                if let Some(profile_name) = &profile.name {
                    let name = profile_name.to_string();
                    if !name.is_empty() {
                        return (name, None);
                    }
                }
            }
            Err(e) => {
                warn!("Failed to fetch profile for {}: {}", uuid, e);
            }
        }
    }

    // Final fallback: UUID string
    (uuid.to_string(), None)
}

/// Read-only variant that only checks local store (no network fetch).
/// Used in the receive loop where we only have a shared reference.
async fn resolve_contact_name_readonly(
    manager: &PresageManager,
    uuid: Uuid,
    service_id: &ServiceId,
) -> (String, Option<String>) {
    // Try contact name first
    if let Ok(Some(contact)) = manager.store().contact_by_id(service_id).await {
        if !contact.name.is_empty() {
            return (
                contact.name.clone(),
                contact.phone_number.as_ref().map(|p| p.to_string()),
            );
        }
    }

    // Try cached profile name
    if let Ok(Some(profile_key)) = manager.store().profile_key(service_id).await {
        if let Ok(Some(profile)) = manager.store().profile(uuid, profile_key).await {
            if let Some(profile_name) = &profile.name {
                let name = profile_name.to_string();
                if !name.is_empty() {
                    return (name, None);
                }
            }
        }
    }

    // Final fallback: UUID string
    (uuid.to_string(), None)
}

/// Load read state from disk, returning empty map on any error.
fn load_read_state(data_dir: &std::path::Path) -> HashMap<String, u64> {
    let path = data_dir.join("read_state.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Persist read state to disk. Best-effort; errors are logged.
fn save_read_state(data_dir: &std::path::Path, state: &HashMap<String, u64>) {
    let path = data_dir.join("read_state.json");
    match serde_json::to_string(state) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                warn!("Failed to write read_state.json: {}", e);
            }
        }
        Err(e) => {
            warn!("Failed to serialize read state: {}", e);
        }
    }
}

/// Generate a preview string for attachment-only messages (e.g. "📷 Photo")
fn attachment_preview_text(attachments: &[AttachmentPointer]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }
    let first_type = attachments[0]
        .content_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    let label = if first_type.starts_with("image/") {
        "📷 Photo"
    } else if first_type.starts_with("video/") {
        "🎥 Video"
    } else if first_type.starts_with("audio/") {
        "🎵 Audio"
    } else {
        "📎 File"
    };
    if attachments.len() > 1 {
        Some(format!("{} (+{})", label, attachments.len() - 1))
    } else {
        Some(label.to_string())
    }
}

/// Determine file extension from a MIME content type
fn extension_from_content_type(content_type: &str) -> &str {
    match content_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/3gpp" => "3gp",
        "audio/aac" => "aac",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        _ => "bin",
    }
}

/// Download an attachment from Signal CDN, cache it to disk, and return metadata.
async fn download_and_save_attachment(
    manager: &PresageManager,
    pointer: &AttachmentPointer,
    attachments_dir: &std::path::Path,
) -> Attachment {
    let content_type = pointer
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let file_name = pointer.file_name.clone();
    let width = pointer.width;
    let height = pointer.height;
    let size = pointer.size;

    // Build a unique cache key from digest or CDN identifier
    let cache_key = if let Some(digest) = &pointer.digest {
        hex::encode(digest)
    } else {
        match &pointer.attachment_identifier {
            Some(AttachmentIdentifier::CdnId(id)) => format!("cdn_{}", id),
            Some(AttachmentIdentifier::CdnKey(key)) => {
                format!("key_{}", key.replace('/', "_"))
            }
            None => format!(
                "unknown_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
        }
    };

    let ext = extension_from_content_type(&content_type);
    let file_path = attachments_dir.join(format!("{}.{}", cache_key, ext));

    // Return cached file if it exists
    if file_path.exists() {
        return Attachment {
            content_type,
            file_path: Some(file_path.to_string_lossy().to_string()),
            file_name,
            width,
            height,
            size,
        };
    }

    // Download and decrypt from Signal CDN
    match manager.get_attachment(pointer).await {
        Ok(data) => {
            if std::fs::write(&file_path, &data).is_ok() {
                info!(
                    "Saved attachment {} ({} bytes)",
                    file_path.display(),
                    data.len()
                );
                Attachment {
                    content_type,
                    file_path: Some(file_path.to_string_lossy().to_string()),
                    file_name,
                    width,
                    height,
                    size,
                }
            } else {
                warn!("Failed to write attachment to disk");
                Attachment {
                    content_type,
                    file_path: None,
                    file_name,
                    width,
                    height,
                    size,
                }
            }
        }
        Err(e) => {
            warn!("Failed to download attachment: {}", e);
            Attachment {
                content_type,
                file_path: None,
                file_name,
                width,
                height,
                size,
            }
        }
    }
}
