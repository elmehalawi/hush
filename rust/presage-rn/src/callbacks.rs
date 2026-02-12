//! Callback interfaces for receiving messages and events

use crate::types::{Channel, Message, ReactionEvent};

/// Callback interface for receiving real-time updates from Signal
#[uniffi::export(callback_interface)]
pub trait MessageListener: Send + Sync {
    /// Called when a new message is received or sent
    fn on_message(&self, message: Message);

    /// Called when a reaction is received on an existing message
    fn on_reaction(&self, reaction: ReactionEvent);

    /// Called when a channel's metadata is updated (new message, name change, etc.)
    fn on_channel_updated(&self, channel: Channel);

    /// Called when an error occurs during message receiving
    fn on_error(&self, error: String);
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
