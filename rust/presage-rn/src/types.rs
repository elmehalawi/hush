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
    /// File path to the avatar image on disk (if available)
    pub avatar_path: Option<String>,
    /// Phone number in E.164 format (contacts only)
    pub phone_number: Option<String>,
}

/// Represents a message attachment (image, video, file, etc.)
#[derive(Debug, Clone, uniffi::Record)]
pub struct Attachment {
    /// MIME content type (e.g. "image/jpeg", "video/mp4")
    pub content_type: String,
    /// File path on disk (None if download failed)
    pub file_path: Option<String>,
    /// Original file name (if available)
    pub file_name: Option<String>,
    /// Width in pixels (for images/videos)
    pub width: Option<u32>,
    /// Height in pixels (for images/videos)
    pub height: Option<u32>,
    /// File size in bytes
    pub size: Option<u32>,
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
    /// Attachments (images, videos, files)
    pub attachments: Vec<Attachment>,
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
