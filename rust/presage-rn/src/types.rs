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

/// An incoming reaction event (for real-time updates)
#[derive(Debug, Clone, uniffi::Record)]
pub struct ReactionEvent {
    /// The channel this reaction belongs to
    pub channel_id: String,
    /// The emoji (e.g. "👍")
    pub emoji: String,
    /// UUID of the person who reacted
    pub sender_id: String,
    /// Timestamp of the target message this reaction applies to
    pub target_timestamp: u64,
    /// Whether this removes a previous reaction
    pub remove: bool,
}

/// A single emoji reaction on a message
#[derive(Debug, Clone, uniffi::Record)]
pub struct Reaction {
    /// The emoji (e.g. "👍")
    pub emoji: String,
    /// UUID of the person who reacted
    pub sender_id: String,
    /// Timestamp of the target message this reaction applies to
    pub target_timestamp: u64,
}

/// A mention of a user within a message body
#[derive(Debug, Clone, uniffi::Record)]
pub struct Mention {
    /// Character offset in body where the mention starts
    pub start: u32,
    /// Number of characters replaced (always 1 for \uFFFC placeholder)
    pub length: u32,
    /// UUID of the mentioned user
    pub uuid: String,
    /// Resolved display name of the mentioned user
    pub name: String,
}

/// Link preview as received/stored (image is an Attachment with file_path)
#[derive(Debug, Clone, uniffi::Record)]
pub struct LinkPreview {
    /// The URL being previewed
    pub url: String,
    /// Title of the linked page
    pub title: Option<String>,
    /// Description / subtitle
    pub description: Option<String>,
    /// Preview image (downloaded attachment)
    pub image: Option<Attachment>,
    /// Publication date (millis since epoch)
    pub date: Option<u64>,
}

/// Link preview data for sending (image is a local file path to upload)
#[derive(Debug, Clone, uniffi::Record)]
pub struct LinkPreviewData {
    /// The URL being previewed
    pub url: String,
    /// Title of the linked page
    pub title: Option<String>,
    /// Description / subtitle
    pub description: Option<String>,
    /// Local file path for the preview image (will be uploaded)
    pub image_path: Option<String>,
    /// Publication date (millis since epoch)
    pub date: Option<u64>,
}

/// A quoted message (reply context)
#[derive(Debug, Clone, uniffi::Record)]
pub struct Quote {
    /// Timestamp of the quoted message (used as identifier)
    pub id: u64,
    /// UUID of the original message author
    pub author_id: String,
    /// Display name of the original author (if resolved)
    pub author_name: Option<String>,
    /// Text snippet of the quoted message
    pub text: Option<String>,
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
    /// Emoji reactions on this message
    pub reactions: Vec<Reaction>,
    /// Mentions of other users in the message body
    pub mentions: Vec<Mention>,
    /// UUIDs of users who have read this message (outgoing only)
    pub read_by: Vec<String>,
    /// Link previews attached to this message
    pub previews: Vec<LinkPreview>,
    /// Quoted message (reply context)
    pub quote: Option<Quote>,
    /// Type of message (regular, missed call, etc.)
    pub message_type: MessageType,
    /// Whether this message has been edited by its sender
    pub edited: bool,
}

/// Type of message (regular text/media or call event)
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MessageType {
    /// Normal user-visible message (text, attachments, etc.)
    Regular,
    /// Incoming audio call that was not answered
    MissedAudioCall,
    /// Incoming video call that was not answered
    MissedVideoCall,
    /// Audio call that was answered/completed
    AudioCall,
    /// Video call that was answered/completed
    VideoCall,
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

/// A session entry for the settings UI
#[derive(Debug, Clone, uniffi::Record)]
pub struct SessionInfo {
    /// UUID of the remote party
    pub address: String,
    /// Number of device sessions for this address
    pub device_count: u32,
    /// Contact name (if known)
    pub contact_name: Option<String>,
    /// Whether this session belongs to our own account (another linked device)
    pub is_self: bool,
}

/// Direction of a call (incoming or outgoing)
#[derive(Debug, Clone, uniffi::Enum)]
pub enum CallDirection {
    Incoming,
    Outgoing,
}

/// Information about an active call
#[derive(Debug, Clone, uniffi::Record)]
pub struct CallInfo {
    pub remote_peer_id: String,
    pub call_id: u64,
    pub is_video: bool,
    pub direction: CallDirection,
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
