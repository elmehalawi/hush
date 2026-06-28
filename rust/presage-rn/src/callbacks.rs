//! Callback interfaces for receiving messages and events

use crate::types::{Attachment, CallInfo, Channel, Message, ReactionEvent};

/// Callback interface for receiving real-time updates from Signal
#[uniffi::export(callback_interface)]
pub trait MessageListener: Send + Sync {
    /// Called when a new message is received or sent
    fn on_message(&self, message: Message);

    /// Called when a reaction is received on an existing message
    fn on_reaction(&self, reaction: ReactionEvent);

    /// Called when a channel's metadata is updated (new message, name change, etc.)
    fn on_channel_updated(&self, channel: Channel);

    /// Called when a read receipt is received (the contact read our messages)
    fn on_read_receipt(&self, sender_id: String, timestamps: Vec<u64>);

    /// Called when an error occurs during message receiving
    fn on_error(&self, error: String);

    /// Called when a background attachment download completes
    fn on_attachment_downloaded(
        &self,
        channel_id: String,
        message_id: String,
        attachment_index: u32,
        attachment: Attachment,
    );

    /// Called when a link preview image download completes
    fn on_link_preview_image_downloaded(
        &self,
        channel_id: String,
        message_id: String,
        preview_index: u32,
        attachment: Attachment,
    );

    /// Called when a contact starts or stops typing
    fn on_typing(&self, channel_id: String, sender_id: String, started: bool);
}

/// Callback interface for call events (ringrtc → Swift/React Native)
#[uniffi::export(callback_interface)]
pub trait CallEventListener: Send + Sync {
    /// Called when an incoming call is received
    fn on_incoming_call(&self, call: CallInfo);

    /// Called when the call state changes (outgoing, ringing, connected, reconnecting)
    fn on_call_state_changed(&self, remote_peer_id: String, state: String, call_id: u64);

    /// Called when a call ends (normal hangup, rejected, error, etc.)
    fn on_call_ended(&self, remote_peer_id: String, reason: String);
}

/// Callback interface for the device linking process
#[uniffi::export(callback_interface)]
pub trait LinkingCallback: Send + Sync {
    /// Called when the QR code URL is available for display
    fn on_qr_code_url(&self, url: String);

    /// Called when linking completes successfully
    fn on_linking_complete(&self);

    /// Called when linking fails
    fn on_linking_error(&self, error: String);
}
