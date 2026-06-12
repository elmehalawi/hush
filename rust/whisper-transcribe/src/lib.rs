//! whisper-transcribe: UniFFI bindings for mlx-whisper-rs speech recognition
//!
//! Provides on-device transcription using MLX-accelerated Whisper models
//! on Apple Silicon, with automatic language detection for Arabic/English.

use std::path::PathBuf;

use mlx_whisper_rs::audio::audio_from_wav_bytes;
use mlx_whisper_rs::load_models::load_model;
use mlx_whisper_rs::transcribe::{transcribe, TranscribeOptions};
use mlx_whisper_rs::whisper::Whisper;

/// Wrapper to assert Send + Sync for Whisper.
///
/// The underlying MLX C objects use raw pointers but the MLX runtime
/// serializes GPU operations internally. We only ever access the model
/// behind a Mutex, so this is safe.
struct WhisperModel(Whisper);

// SAFETY: MLX operations are internally synchronized. We protect all access
// with a std::sync::Mutex which provides exclusive access.
unsafe impl Send for WhisperModel {}
unsafe impl Sync for WhisperModel {}

/// A single transcribed segment with timing information.
#[derive(uniffi::Record, Clone)]
pub struct TranscriptionSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// The result of a transcription.
#[derive(uniffi::Record, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    pub language: String,
    pub segments: Vec<TranscriptionSegment>,
}

/// Errors that can occur during transcription.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TranscribeError {
    #[error("Model not available: {reason}")]
    ModelNotAvailable { reason: String },

    #[error("Failed to load audio: {reason}")]
    AudioLoadFailed { reason: String },

    #[error("Transcription failed: {reason}")]
    TranscriptionFailed { reason: String },
}

/// The transcription engine wrapping mlx-whisper-rs.
///
/// Manages model lifecycle and provides transcription capabilities.
#[derive(uniffi::Object)]
pub struct TranscriptionEngine {
    assets_dir: PathBuf,
    model_repo: String,
    model: std::sync::Mutex<Option<WhisperModel>>,
}

#[uniffi::export]
impl TranscriptionEngine {
    /// Create a new TranscriptionEngine.
    ///
    /// - `assets_dir`: Path to directory containing tokenizer assets
    ///   (multilingual.tiktoken, gpt2.tiktoken, mel_filters_*.npy)
    /// - `model_repo`: HuggingFace model repo ID (e.g. "mlx-community/whisper-large-v3-turbo")
    #[uniffi::constructor]
    pub fn new(assets_dir: String, model_repo: String) -> Self {
        Self {
            assets_dir: PathBuf::from(assets_dir),
            model_repo,
            model: std::sync::Mutex::new(None),
        }
    }

    /// Download (if needed) and load the Whisper model into memory.
    /// This is a blocking call that may take significant time on first use.
    pub fn prepare_model(&self) -> Result<(), TranscribeError> {
        tracing::info!("Loading whisper model: {}", self.model_repo);
        let whisper = load_model(&self.model_repo).map_err(|e| {
            TranscribeError::ModelNotAvailable {
                reason: format!("Failed to load model '{}': {}", self.model_repo, e),
            }
        })?;
        let mut guard = self.model.lock().unwrap();
        *guard = Some(WhisperModel(whisper));
        tracing::info!("Whisper model loaded successfully");
        Ok(())
    }

    /// Check if the model is currently loaded in memory.
    pub fn is_model_loaded(&self) -> bool {
        self.model.lock().unwrap().is_some()
    }

    /// Transcribe an audio file.
    ///
    /// - `audio_path`: Path to a 16kHz mono WAV file
    /// - `language`: Optional language hint (e.g. "en", "ar"). If empty, auto-detects.
    pub fn transcribe_file(
        &self,
        audio_path: String,
        language: Option<String>,
    ) -> Result<TranscriptionResult, TranscribeError> {
        let mut guard = self.model.lock().unwrap();
        let model = guard.as_mut().ok_or_else(|| TranscribeError::ModelNotAvailable {
            reason: "Model not loaded. Call prepareModel() first.".to_string(),
        })?;

        // Load audio from WAV file
        let wav_bytes = std::fs::read(&audio_path).map_err(|e| TranscribeError::AudioLoadFailed {
            reason: format!("Cannot read '{}': {}", audio_path, e),
        })?;

        let (audio, _sample_rate) =
            audio_from_wav_bytes(&wav_bytes).map_err(|e| {
                TranscribeError::AudioLoadFailed {
                    reason: format!("Invalid WAV data in '{}': {}", audio_path, e),
                }
            })?;

        // Set up transcription options
        let lang = language.filter(|s| !s.is_empty());
        let options = TranscribeOptions {
            language: lang,
            ..Default::default()
        };

        // Run transcription
        let result =
            transcribe(audio, &mut model.0, &self.assets_dir, &options).map_err(|e| {
                TranscribeError::TranscriptionFailed {
                    reason: format!("{}", e),
                }
            })?;

        // Convert segments
        let segments = result
            .segments
            .iter()
            .map(|seg| TranscriptionSegment {
                start: seg.start as f64,
                end: seg.end as f64,
                text: seg.text.clone(),
            })
            .collect();

        Ok(TranscriptionResult {
            text: result.text.clone(),
            language: result.language.clone(),
            segments,
        })
    }

    /// Unload the model from memory to free resources.
    pub fn unload_model(&self) {
        let mut guard = self.model.lock().unwrap();
        *guard = None;
        tracing::info!("Whisper model unloaded");
    }
}

uniffi::setup_scaffolding!();
