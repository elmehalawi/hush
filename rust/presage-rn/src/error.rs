//! Error types for the Signal client

use thiserror::Error;

/// Errors that can occur when using the Signal client
#[derive(Error, Debug, uniffi::Error)]
pub enum SignalError {
    /// Client is not linked to a Signal account
    #[error("Not linked to a device")]
    NotLinked,

    /// Client is already linked
    #[error("Already linked to a device")]
    AlreadyLinked,

    /// Device linking failed
    #[error("Linking failed: {message}")]
    LinkingFailed { message: String },

    /// Network or connection error
    #[error("Network error: {message}")]
    NetworkError { message: String },

    /// Database or storage error
    #[error("Storage error: {message}")]
    StorageError { message: String },

    /// Requested channel does not exist
    #[error("Unknown channel: {id}")]
    UnknownChannel { id: String },

    /// Failed to send a message
    #[error("Send failed: {message}")]
    SendFailed { message: String },

    /// Failed to parse or decode data
    #[error("Parse error: {message}")]
    ParseError { message: String },

    /// Internal error
    #[error("Internal error: {message}")]
    InternalError { message: String },
}

impl From<presage::Error<presage_store_sqlite::SqliteStoreError>> for SignalError {
    fn from(err: presage::Error<presage_store_sqlite::SqliteStoreError>) -> Self {
        match err {
            presage::Error::NotYetRegisteredError => SignalError::NotLinked,
            presage::Error::AlreadyRegisteredError => SignalError::AlreadyLinked,
            presage::Error::ServiceError(e) => SignalError::NetworkError {
                message: e.to_string(),
            },
            presage::Error::Store(e) => SignalError::StorageError {
                message: e.to_string(),
            },
            other => SignalError::InternalError {
                message: other.to_string(),
            },
        }
    }
}

impl From<presage_store_sqlite::SqliteStoreError> for SignalError {
    fn from(err: presage_store_sqlite::SqliteStoreError) -> Self {
        SignalError::StorageError {
            message: err.to_string(),
        }
    }
}
