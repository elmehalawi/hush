//! Data types exposed to React Native via UniFFI

/// Represents a conversation channel (contact or group)
#[derive(Debug, Clone, uniffi::Record)]
pub struct Channel {
    /// UUID for contacts, hex-encoded group identifier for groups
    pub id: String,
    /// Display name of the contact or group
    pub name: String,
    /// Whether this is a group conversation
    pub is_group: bool,
    /// Number of unread messages in this channel
    pub unread_count: u32,
    /// Preview of the last message (if any)
    pub last_message: Option<String>,
    /// Timestamp of the last message in milliseconds since epoch
    pub last_message_timestamp: Option<u64>,
}

/// Represents a single message
#[derive(Debug, Clone, uniffi::Record)]
pub struct Message {
    /// Message ID (timestamp as string for uniqueness)
    pub id: String,
    /// Channel ID this message belongs to
    pub channel_id: String,
    /// UUID of the message sender
    pub sender_id: String,
    /// Display name of the sender (if known)
    pub sender_name: Option<String>,
    /// Message text content
    pub body: Option<String>,
    /// Timestamp in milliseconds since epoch
    pub timestamp: u64,
    /// Whether this message was sent by the local user
    pub is_outgoing: bool,
    /// Delivery/read status
    pub status: MessageStatus,
}

/// Message delivery status
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MessageStatus {
    /// Message is being sent
    Sending,
    /// Message was sent to server
    Sent,
    /// Message was delivered to recipient
    Delivered,
    /// Message was read by recipient
    Read,
    /// Message send failed
    Failed,
}

impl Default for MessageStatus {
    fn default() -> Self {
        Self::Sending
    }
}

/// Linking state for the QR code flow
#[derive(Debug, Clone, uniffi::Enum)]
pub enum LinkingState {
    /// Not yet started
    NotStarted,
    /// Waiting for QR code scan, contains the URL to display
    WaitingForScan { qr_url: String },
    /// Linking completed successfully
    Completed,
    /// Linking failed
    Failed { message: String },
}
