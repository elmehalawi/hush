//! ringrtc CallManager wrapper for presage-rn.
//!
//! Adapted from hush-call's call_manager.rs. Uses a callback trait for
//! call state events (forwarded to Swift via UniFFI) and an mpsc channel
//! for outgoing signaling (consumed by the send loop in client.rs).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use ringrtc::{
    common::{CallId, CallMediaType, CallConfig, DataMode, DeviceId, Result as RtcResult},
    core::{call_manager::CallManager, group_call, signaling},
    lite::{
        http,
        sfu::{DemuxId, UserId},
    },
    native::{
        CallState, CallStateHandler, GroupUpdate, GroupUpdateHandler, NativeCallContext,
        NativePlatform, PeerId, SignalingSender,
    },
    webrtc::{
        media::{VideoFrame, VideoSink},
        peer_connection::AudioLevel,
        peer_connection_factory::{self as pcf, IceServer, PeerConnectionFactory},
        peer_connection_observer::NetworkRoute,
    },
};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// Outgoing signaling message to be sent via presage
#[derive(Debug)]
pub struct OutgoingSignaling {
    pub recipient_id: String,
    pub call_id: CallId,
    pub receiver_device_id: Option<DeviceId>,
    pub message: signaling::Message,
}

/// Internal callback for call events (stays in Rust, bridges to UniFFI CallEventListener)
pub(crate) trait CallEventCallback: Send + Sync {
    fn on_call_state(&self, peer_id: String, state: String, call_id: u64);
    fn on_incoming_call(&self, peer_id: String, call_id: u64, is_video: bool);
    fn on_call_ended(&self, peer_id: String, reason: String);
}

/// Shared state accessible from callback handlers
struct SharedState {
    /// Reference to CallManager for calling proceed() from callbacks
    call_manager: Option<CallManager<NativePlatform>>,
    /// Call context needed for proceed()
    call_context: Option<NativeCallContext>,
    /// Callback for events → Swift
    callback: Option<Arc<dyn CallEventCallback>>,
}

/// The main call manager that wraps ringrtc
pub struct HushCallManager {
    call_manager: CallManager<NativePlatform>,
    call_context: NativeCallContext,
    pcf: PeerConnectionFactory,
    device_id: DeviceId,
    shared: Arc<Mutex<SharedState>>,
    outgoing_audio_track: ringrtc::webrtc::media::AudioTrack,
    /// Receiver for outgoing signaling messages (taken by client.rs for send loop)
    signaling_rx: Option<mpsc::UnboundedReceiver<OutgoingSignaling>>,
}

/// Handler that implements ringrtc's callback traits
#[derive(Clone)]
struct CallHandler {
    shared: Arc<Mutex<SharedState>>,
    signaling_tx: mpsc::UnboundedSender<OutgoingSignaling>,
}

impl HushCallManager {
    pub fn new(device_id: DeviceId) -> Result<Self> {
        // Initialize PeerConnectionFactory with default audio config
        let mut pcf = PeerConnectionFactory::new(&pcf::AudioConfig::default(), false, "", None)
            .map_err(|e| anyhow::anyhow!("Failed to create PeerConnectionFactory: {}", e))?;

        // Wait for audio devices to be available
        for _ in 0..30 {
            if pcf.get_audio_playout_devices().is_ok_and(|d| !d.is_empty())
                && pcf.get_audio_recording_devices().is_ok_and(|d| !d.is_empty())
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Log available devices
        match pcf.get_audio_playout_devices() {
            Ok(devices) => info!("Audio playout devices: {:?}", devices),
            Err(e) => warn!("No audio playout devices: {}", e),
        }
        match pcf.get_audio_recording_devices() {
            Ok(devices) => info!("Audio recording devices: {:?}", devices),
            Err(e) => warn!("No audio recording devices: {}", e),
        }

        // Use first available devices
        let _ = pcf.set_audio_playout_device(0);
        let _ = pcf.set_audio_recording_device(0);

        let (signaling_tx, signaling_rx) = mpsc::unbounded_channel();

        let shared = Arc::new(Mutex::new(SharedState {
            call_manager: None,
            call_context: None,
            callback: None,
        }));

        let handler = CallHandler {
            shared: shared.clone(),
            signaling_tx,
        };

        // Build NativePlatform with our handler implementations
        let signaling_sender = Box::new(handler.clone());
        let should_assume_messages_sent = true;
        let state_handler = Box::new(handler.clone());
        let group_handler = Box::new(handler.clone());

        let platform = NativePlatform::new(
            pcf.clone(),
            signaling_sender,
            should_assume_messages_sent,
            state_handler,
            group_handler,
        );

        let http_client = http::DelegatingClient::new(handler.clone());
        let call_manager = CallManager::new(platform, http_client)
            .map_err(|e| anyhow::anyhow!("Failed to create CallManager: {}", e))?;

        // Create call context (audio/video tracks)
        let outgoing_audio_track = pcf
            .create_outgoing_audio_track()
            .map_err(|e| anyhow::anyhow!("Failed to create audio track: {}", e))?;
        let outgoing_video_source = pcf
            .create_outgoing_video_source()
            .map_err(|e| anyhow::anyhow!("Failed to create video source: {}", e))?;
        let outgoing_video_track = pcf
            .create_outgoing_video_track(&outgoing_video_source)
            .map_err(|e| anyhow::anyhow!("Failed to create video track: {}", e))?;
        let incoming_video_sink = Box::new(LoggingVideoSink);

        // Clone audio track before it's moved into call context (for mute toggle)
        let audio_track_for_mute = outgoing_audio_track.clone();

        let hide_ip = false;
        let ice_servers = vec![IceServer::none()];
        let call_context = NativeCallContext::new(
            hide_ip,
            ice_servers,
            outgoing_audio_track,
            outgoing_video_track,
            incoming_video_sink,
        );

        // Store call_manager and call_context in shared state so callbacks can call proceed()
        {
            let mut state = shared.lock().unwrap();
            state.call_manager = Some(call_manager.clone());
            state.call_context = Some(call_context.clone());
        }

        Ok(Self {
            call_manager,
            call_context,
            pcf,
            device_id,
            shared,
            outgoing_audio_track: audio_track_for_mute,
            signaling_rx: Some(signaling_rx),
        })
    }

    /// Take the signaling receiver (can only be called once, before wrapping in Mutex)
    pub fn take_signaling_rx(&mut self) -> Option<mpsc::UnboundedReceiver<OutgoingSignaling>> {
        self.signaling_rx.take()
    }

    /// Set the callback for call events
    pub fn set_callback(&self, callback: Arc<dyn CallEventCallback>) {
        let mut state = self.shared.lock().unwrap();
        state.callback = Some(callback);
    }

    /// Start an outgoing call
    pub fn start_outgoing_call(&mut self, recipient: &str, video: bool) -> Result<()> {
        let peer_id = PeerId::from(recipient);
        let call_id = CallId::random();
        let media_type = if video {
            CallMediaType::Video
        } else {
            CallMediaType::Audio
        };

        info!(
            "Creating outgoing {} call to {} (call_id: {})",
            if video { "video" } else { "audio" },
            recipient,
            call_id
        );

        self.call_manager
            .create_outgoing_call(peer_id, call_id, media_type, self.device_id)
            .map_err(|e| anyhow::anyhow!("Failed to create outgoing call: {}", e))?;

        Ok(())
    }

    /// Accept an incoming call
    pub fn accept_call(&mut self, call_id: CallId) -> Result<()> {
        info!("Accepting call {}", call_id);
        self.call_manager
            .accept_call(call_id)
            .map_err(|e| anyhow::anyhow!("Failed to accept call: {}", e))?;
        Ok(())
    }

    /// Hang up the current call
    pub fn hangup(&mut self) -> Result<()> {
        info!("Hanging up");
        self.call_manager
            .hangup()
            .map_err(|e| anyhow::anyhow!("Failed to hang up: {}", e))?;
        Ok(())
    }

    /// Toggle microphone mute
    pub fn set_muted(&self, muted: bool) {
        info!("Setting muted: {}", muted);
        self.outgoing_audio_track.set_enabled(!muted);
    }

    /// Route an incoming call signaling message to ringrtc
    pub fn handle_incoming_signaling(
        &mut self,
        sender_id: &str,
        sender_device_id: DeviceId,
        call_id: CallId,
        msg: signaling::Message,
        sender_identity_key: Vec<u8>,
        receiver_identity_key: Vec<u8>,
    ) -> Result<()> {
        match msg {
            signaling::Message::Offer(offer) => {
                info!("Received offer from {} (call {})", sender_id, call_id);
                self.call_manager
                    .received_offer(
                        PeerId::from(sender_id),
                        call_id,
                        signaling::ReceivedOffer {
                            offer,
                            age: std::time::Duration::from_secs(0),
                            sender_device_id,
                            receiver_device_id: self.device_id,
                            sender_identity_key,
                            receiver_identity_key,
                        },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to process offer: {}", e))?;
            }
            signaling::Message::Answer(answer) => {
                info!("Received answer from {} (call {})", sender_id, call_id);
                self.call_manager
                    .received_answer(
                        PeerId::from(sender_id),
                        call_id,
                        signaling::ReceivedAnswer {
                            answer,
                            sender_device_id,
                            sender_identity_key,
                            receiver_identity_key,
                        },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to process answer: {}", e))?;
            }
            signaling::Message::Ice(ice) => {
                debug!("Received ICE from {} (call {})", sender_id, call_id);
                self.call_manager
                    .received_ice(
                        PeerId::from(sender_id),
                        call_id,
                        signaling::ReceivedIce {
                            ice,
                            sender_device_id,
                        },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to process ICE: {}", e))?;
            }
            signaling::Message::Hangup(hangup) => {
                info!("Received hangup from {} (call {})", sender_id, call_id);
                self.call_manager
                    .received_hangup(
                        PeerId::from(sender_id),
                        call_id,
                        signaling::ReceivedHangup {
                            hangup,
                            sender_device_id,
                        },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to process hangup: {}", e))?;
            }
            signaling::Message::Busy => {
                info!("Received busy from {} (call {})", sender_id, call_id);
                self.call_manager
                    .received_busy(
                        PeerId::from(sender_id),
                        call_id,
                        signaling::ReceivedBusy { sender_device_id },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to process busy: {}", e))?;
            }
        }
        Ok(())
    }
}

// --- ringrtc callback trait implementations ---

impl SignalingSender for CallHandler {
    fn send_signaling(
        &self,
        recipient_id: &str,
        call_id: CallId,
        receiver_device_id: Option<DeviceId>,
        msg: signaling::Message,
    ) -> RtcResult<()> {
        info!(
            "Sending signaling {} to {} (call {}, device {:?})",
            msg, recipient_id, call_id, receiver_device_id
        );

        let outgoing = OutgoingSignaling {
            recipient_id: recipient_id.to_string(),
            call_id,
            receiver_device_id,
            message: msg,
        };

        if let Err(e) = self.signaling_tx.send(outgoing) {
            warn!("Failed to queue outgoing signaling: {}", e);
        }

        Ok(())
    }

    fn send_call_message(
        &self,
        _recipient_id: UserId,
        _msg: Vec<u8>,
        _urgency: group_call::SignalingMessageUrgency,
    ) -> RtcResult<()> {
        warn!("send_call_message not implemented (group calls)");
        Ok(())
    }

    fn send_call_message_to_group(
        &self,
        _group_id: group_call::GroupId,
        _msg: Vec<u8>,
        _urgency: group_call::SignalingMessageUrgency,
        _recipients_override: HashSet<UserId>,
    ) -> RtcResult<()> {
        warn!("send_call_message_to_group not implemented");
        Ok(())
    }

    fn send_call_message_to_adhoc_group(
        &self,
        _message: Vec<u8>,
        _urgency: group_call::SignalingMessageUrgency,
        _expiration: u64,
        _recipients_to_endorsements: HashMap<UserId, Vec<u8>>,
    ) -> RtcResult<()> {
        warn!("send_call_message_to_adhoc_group not implemented");
        Ok(())
    }
}

impl CallStateHandler for CallHandler {
    fn handle_call_state(
        &self,
        remote_peer_id: &str,
        call_id: CallId,
        call_state: CallState,
    ) -> RtcResult<()> {
        info!(
            "Call state changed: {} (call {}) -> {:?}",
            remote_peer_id, call_id, call_state
        );

        let state = self.shared.lock().unwrap();

        // Call proceed() when entering Incoming or Outgoing state
        if let CallState::Incoming(_) | CallState::Outgoing(_) = &call_state {
            if let (Some(cm), Some(ctx)) = (&state.call_manager, &state.call_context) {
                let mut cm = cm.clone();
                let ctx = ctx.clone();
                let call_config = CallConfig {
                    data_mode: DataMode::Low,
                    ..Default::default()
                };
                if let Err(e) = cm.proceed(call_id, ctx, call_config, None) {
                    warn!("Failed to proceed with call: {}", e);
                }
            }
        }

        let callback = state.callback.clone();
        drop(state); // Release lock before calling callback

        if let Some(cb) = callback {
            match call_state {
                CallState::Incoming(media_type) => {
                    let is_video = media_type == CallMediaType::Video;
                    cb.on_incoming_call(
                        remote_peer_id.to_string(),
                        u64::from(call_id),
                        is_video,
                    );
                    cb.on_call_state(
                        remote_peer_id.to_string(),
                        "incoming".to_string(),
                        u64::from(call_id),
                    );
                }
                CallState::Outgoing(_) => {
                    cb.on_call_state(
                        remote_peer_id.to_string(),
                        "outgoing".to_string(),
                        u64::from(call_id),
                    );
                }
                CallState::Ringing => {
                    cb.on_call_state(
                        remote_peer_id.to_string(),
                        "ringing".to_string(),
                        u64::from(call_id),
                    );
                }
                CallState::Connected => {
                    cb.on_call_state(
                        remote_peer_id.to_string(),
                        "connected".to_string(),
                        u64::from(call_id),
                    );
                }
                CallState::Connecting => {
                    cb.on_call_state(
                        remote_peer_id.to_string(),
                        "reconnecting".to_string(),
                        u64::from(call_id),
                    );
                }
                CallState::Ended(reason, _) => {
                    cb.on_call_ended(
                        remote_peer_id.to_string(),
                        format!("{:?}", reason),
                    );
                }
                CallState::Rejected(reason) => {
                    cb.on_call_ended(
                        remote_peer_id.to_string(),
                        format!("Rejected: {:?}", reason),
                    );
                }
                CallState::Concluded => {
                    cb.on_call_ended(
                        remote_peer_id.to_string(),
                        "Concluded".to_string(),
                    );
                }
            }
        }

        Ok(())
    }

    fn handle_network_route(
        &self,
        remote_peer_id: &str,
        network_route: NetworkRoute,
    ) -> RtcResult<()> {
        debug!(
            "Network route changed for {}: {:?}",
            remote_peer_id, network_route
        );
        Ok(())
    }

    fn handle_audio_levels(
        &self,
        remote_peer_id: &str,
        captured_level: AudioLevel,
        received_level: AudioLevel,
    ) -> RtcResult<()> {
        debug!(
            "Audio levels for {}: captured={}, received={}",
            remote_peer_id, captured_level, received_level
        );
        Ok(())
    }

    fn handle_low_bandwidth_for_video(
        &self,
        remote_peer_id: &str,
        recovered: bool,
    ) -> RtcResult<()> {
        info!(
            "Low bandwidth for video with {}: recovered={}",
            remote_peer_id, recovered
        );
        Ok(())
    }

    fn handle_remote_audio_state(&self, remote_peer_id: &str, enabled: bool) -> RtcResult<()> {
        info!(
            "Remote audio state for {}: {}",
            remote_peer_id,
            if enabled { "enabled" } else { "muted" }
        );
        Ok(())
    }

    fn handle_remote_video_state(&self, remote_peer_id: &str, enabled: bool) -> RtcResult<()> {
        info!(
            "Remote video state for {}: {}",
            remote_peer_id,
            if enabled { "enabled" } else { "disabled" }
        );
        Ok(())
    }

    fn handle_remote_sharing_screen(&self, remote_peer_id: &str, enabled: bool) -> RtcResult<()> {
        info!(
            "Remote screen sharing for {}: {}",
            remote_peer_id,
            if enabled { "enabled" } else { "disabled" }
        );
        Ok(())
    }
}

impl GroupUpdateHandler for CallHandler {
    fn handle_group_update(&self, update: GroupUpdate) -> RtcResult<()> {
        info!("Group update: {}", update);
        Ok(())
    }
}

impl http::Delegate for CallHandler {
    fn send_request(&self, _request_id: u32, _request: http::Request) {
        warn!("HTTP delegate send_request not implemented");
    }
}

/// Video sink that logs received frames (for debugging)
#[derive(Clone)]
struct LoggingVideoSink;

impl VideoSink for LoggingVideoSink {
    fn on_video_frame(&self, demux_id: DemuxId, frame: VideoFrame) {
        debug!(
            "Received video frame from demux {}: {}x{}",
            demux_id,
            frame.width(),
            frame.height()
        );
    }

    fn box_clone(&self) -> Box<dyn VideoSink> {
        Box::new(self.clone())
    }
}
