//! Signal client implementation wrapping Presage

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_channel::oneshot;
use futures_util::StreamExt;
use parking_lot::RwLock;
use presage::libsignal_service::configuration::SignalServers;
use presage::libsignal_service::content::{Content, ContentBody};
use presage::libsignal_service::protocol::{Aci, ServiceId};
use presage::libsignal_service::zkgroup::profiles::ProfileKey;
use presage::manager::Registered;
use presage::model::identity::OnNewIdentity;
use presage::proto::{DataMessage, GroupContextV2};
use presage::store::{ContentsStore, Thread};
use presage_store_sqlite::SqliteStore;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::callbacks::{LinkingCallback, MessageListener};
use crate::error::SignalError;
use crate::types::{Channel, Message, MessageStatus};

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
        let (manager, user_id) = runtime.block_on(async {
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

        Ok(Arc::new(Self {
            manager: RwLock::new(manager),
            store_path,
            data_dir,
            runtime,
            stop_flag: Arc::new(AtomicBool::new(false)),
            user_id: RwLock::new(user_id),
            is_receiving: Arc::new(AtomicBool::new(false)),
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
            self.runtime.block_on(async {
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
        let manager_guard = self.manager.read();
        let manager = manager_guard.as_ref().ok_or(SignalError::NotLinked)?;
        let avatars_dir = self.data_dir.join("avatars");
        let _ = std::fs::create_dir_all(&avatars_dir);

        self.runtime.block_on(async {
            let mut channels = Vec::new();

            // Get contacts
            if let Ok(contacts_iter) = manager.store().contacts().await {
                for contact_result in contacts_iter {
                    if let Ok(contact) = contact_result {
                        if contact.name.is_empty() {
                            continue;
                        }

                        let channel_id = contact.uuid.to_string();
                        let avatar_file = avatars_dir.join(&channel_id);

                        // Check if avatar is already on disk
                        let mut avatar_path = if avatar_file.exists() {
                            Some(avatar_file.to_string_lossy().to_string())
                        } else {
                            None
                        };

                        // If not on disk, try reading from the store cache
                        if avatar_path.is_none() {
                            // Resolve profile key: try contact field first, then store
                            let profile_key = if let Ok(key_bytes) =
                                <Vec<u8> as TryInto<[u8; 32]>>::try_into(
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

                            if let Some(profile_key) = profile_key {
                                if let Ok(Some(avatar_bytes)) =
                                    manager.store().profile_avatar(contact.uuid, profile_key).await
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
                            name: contact.name.clone(),
                            is_group: false,
                            unread_count: 0,
                            last_message: None,
                            last_message_timestamp: None,
                            avatar_path,
                            phone_number: contact
                                .phone_number
                                .as_ref()
                                .map(|p| p.to_string()),
                        });
                    }
                }
            }

            // Get groups
            match manager.store().groups().await {
                Ok(groups_iter) => {
                    let mut group_count = 0u32;
                    for group_result in groups_iter {
                        match group_result {
                            Ok((master_key_bytes, group)) => {
                                let group_id = hex::encode(&master_key_bytes);
                                let avatar_file = avatars_dir.join(&group_id);

                                // Check if avatar is already on disk
                                let mut avatar_path = if avatar_file.exists() {
                                    Some(avatar_file.to_string_lossy().to_string())
                                } else {
                                    None
                                };

                                // If not on disk, try reading from the store cache
                                if avatar_path.is_none() {
                                    if let Ok(Some(avatar_bytes)) =
                                        manager.store().group_avatar(master_key_bytes).await
                                    {
                                        if !avatar_bytes.is_empty() {
                                            if std::fs::write(&avatar_file, &avatar_bytes).is_ok()
                                            {
                                                avatar_path = Some(
                                                    avatar_file.to_string_lossy().to_string(),
                                                );
                                            }
                                        }
                                    }
                                }

                                info!("Found group: '{}' (id: {})", group.title, group_id);
                                channels.push(Channel {
                                    id: group_id,
                                    name: group.title,
                                    is_group: true,
                                    unread_count: 0,
                                    last_message: None,
                                    last_message_timestamp: None,
                                    avatar_path,
                                    phone_number: None,
                                });
                                group_count += 1;
                            }
                            Err(e) => {
                                error!("Failed to read group: {e}");
                            }
                        }
                    }
                    info!("Loaded {group_count} groups");
                }
                Err(e) => {
                    error!("Failed to fetch groups from store: {e}");
                }
            }

            // Populate last message timestamps from stored messages
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
                        Ok(uuid) => Thread::Contact(uuid),
                        Err(_) => continue,
                    }
                };

                // messages() returns results ordered by ts DESC, so first = most recent
                if let Ok(mut messages_iter) = manager.store().messages(&thread, ..).await {
                    if let Some(Ok(content)) = messages_iter.next() {
                        channel.last_message_timestamp = Some(content.metadata.timestamp);
                        match &content.body {
                            ContentBody::DataMessage(dm) => {
                                channel.last_message = dm.body.clone();
                            }
                            ContentBody::SynchronizeMessage(sync) => {
                                if let Some(sent) = &sync.sent {
                                    if let Some(dm) = &sent.message {
                                        channel.last_message = dm.body.clone();
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
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
        _limit: u32,
    ) -> Result<Vec<Message>, SignalError> {
        let manager_guard = self.manager.read();
        let manager = manager_guard.as_ref().ok_or(SignalError::NotLinked)?;
        let my_user_id = self.user_id.read().ok_or(SignalError::NotLinked)?;

        self.runtime.block_on(async {
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
                Thread::Contact(uuid)
            };

            let mut messages = Vec::new();
            if let Ok(iter) = manager.store().messages(&thread, ..).await {
                for result in iter {
                    if let Ok(content) = result {
                        if let Some(msg) = process_content(&content, my_user_id) {
                            messages.push(msg);
                        }
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

        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
            self.runtime.block_on(async {
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

                manager
                    .send_message_to_group(&master_key_bytes, data_message, timestamp)
                    .await
                    .map_err(|e| SignalError::SendFailed {
                        message: e.to_string(),
                    })?;
            } else {
                // UUID -> direct message
                let recipient_uuid: Uuid =
                    channel_id.parse().map_err(|_| SignalError::ParseError {
                        message: "Invalid UUID".to_string(),
                    })?;

                let recipient_aci = Aci::from(recipient_uuid);
                let body = ContentBody::DataMessage(data_message);
                manager
                    .send_message(recipient_aci, body, timestamp)
                    .await
                    .map_err(|e| SignalError::SendFailed {
                        message: e.to_string(),
                    })?;
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

        self.runtime.block_on(async {
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

        let stop_flag = self.stop_flag.clone();
        let is_receiving = self.is_receiving.clone();
        let manager_clone = manager.clone();
        let runtime_handle = self.runtime.handle().clone();

        std::thread::Builder::new()
            .name("signal-receive".to_string())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                const RED_ZONE: usize = 512 * 1024;
                const STACK_SIZE: usize = 8 * 1024 * 1024;

                stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
                    runtime_handle.block_on(async move {
                        info!("Starting message receive loop");

                        let mut manager_clone = manager_clone;
                        loop {
                            if stop_flag.load(Ordering::SeqCst) {
                                break;
                            }

                            match manager_clone.receive_messages().await {
                                Ok(stream) => {
                                    let mut stream = Box::pin(stream);
                                    while let Some(received) = stream.next().await {
                                        if stop_flag.load(Ordering::SeqCst) {
                                            info!("Stop flag set, exiting receive loop");
                                            break;
                                        }

                                        stacker::maybe_grow(RED_ZONE, STACK_SIZE, || {
                                            match received {
                                                presage::model::messages::Received::Content(content) => {
                                                    if let Some(message) = process_content(&content, my_user_id) {
                                                        listener.on_message(message);
                                                    }
                                                }
                                                presage::model::messages::Received::QueueEmpty => {
                                                    info!("Message queue is empty");
                                                }
                                                presage::model::messages::Received::Contacts => {
                                                    info!("Received contacts sync");
                                                }
                                            }
                                        });
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
                    });
                });

                // Clear the guard so a new receive thread can be spawned
                is_receiving.store(false, Ordering::SeqCst);
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
        info!("Stop receiving requested");
    }
}

/// Process incoming content and convert to our Message type
fn process_content(content: &Content, my_user_id: Uuid) -> Option<Message> {
    let sender_service_id = content.metadata.sender;
    let sender_uuid = sender_service_id.raw_uuid();
    let timestamp = content.metadata.timestamp;
    let is_outgoing = sender_uuid == my_user_id;

    match &content.body {
        ContentBody::DataMessage(dm) => {
            let body = dm.body.clone();
            let channel_id = if let Some(group_v2) = &dm.group_v2 {
                // Group message
                if let Some(master_key) = &group_v2.master_key {
                    hex::encode(master_key)
                } else {
                    return None;
                }
            } else {
                // Direct message - use sender ID as channel
                sender_uuid.to_string()
            };

            Some(Message {
                id: timestamp.to_string(),
                channel_id,
                sender_id: sender_uuid.to_string(),
                sender_name: None,
                body,
                timestamp,
                is_outgoing,
                status: MessageStatus::Delivered,
            })
        }
        ContentBody::SynchronizeMessage(sync) => {
            // Handle sent messages (messages we sent from another device)
            if let Some(sent) = &sync.sent {
                if let Some(dm) = &sent.message {
                    let body = dm.body.clone();

                    // Check for group context first — group messages also
                    // have destination_service_id set, so we must prioritize
                    // the group_v2 field to route them correctly.
                    let channel_id = if let Some(group_v2) = &dm.group_v2 {
                        if let Some(master_key) = &group_v2.master_key {
                            hex::encode(master_key)
                        } else {
                            return None;
                        }
                    } else if let Some(dest) = &sent.destination_service_id {
                        dest.clone()
                    } else {
                        return None;
                    };

                    return Some(Message {
                        id: timestamp.to_string(),
                        channel_id,
                        sender_id: my_user_id.to_string(),
                        sender_name: None,
                        body,
                        timestamp,
                        is_outgoing: true,
                        status: MessageStatus::Sent,
                    });
                }
            }
            None
        }
        _ => None,
    }
}
