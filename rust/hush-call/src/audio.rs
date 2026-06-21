//! Audio utilities for hush-call.
//!
//! Provides audio device enumeration and test tone generation (440Hz sine wave).

use anyhow::Result;
use ringrtc::webrtc::peer_connection_factory::{AudioConfig, PeerConnectionFactory};
use tracing::info;

/// List available audio devices using ringrtc's PeerConnectionFactory
pub fn list_audio_devices() -> Result<Vec<String>> {
    let mut pcf = PeerConnectionFactory::new(&AudioConfig::default(), false, "", None)
        .map_err(|e| anyhow::anyhow!("Failed to create PeerConnectionFactory: {}", e))?;

    // Wait briefly for devices to enumerate
    std::thread::sleep(std::time::Duration::from_millis(500));

    let mut devices = vec![];

    match pcf.get_audio_playout_devices() {
        Ok(playout) => {
            for (i, dev) in playout.iter().enumerate() {
                devices.push(format!("Playout [{}]: {} ({})", i, dev.name, dev.unique_id));
            }
        }
        Err(e) => {
            devices.push(format!("Playout error: {}", e));
        }
    }

    match pcf.get_audio_recording_devices() {
        Ok(recording) => {
            for (i, dev) in recording.iter().enumerate() {
                devices.push(format!("Recording [{}]: {} ({})", i, dev.name, dev.unique_id));
            }
        }
        Err(e) => {
            devices.push(format!("Recording error: {}", e));
        }
    }

    Ok(devices)
}

/// Generate a 440Hz sine wave as PCM samples.
///
/// Returns interleaved i16 samples at the given sample rate and channel count.
pub fn generate_sine_wave(
    frequency_hz: f32,
    sample_rate: u32,
    channels: u16,
    duration_ms: u32,
) -> Vec<i16> {
    let num_samples = (sample_rate as f32 * duration_ms as f32 / 1000.0) as usize;
    let mut samples = Vec::with_capacity(num_samples * channels as usize);

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let value = (2.0 * std::f32::consts::PI * frequency_hz * t).sin();
        let sample = (value * 0.8 * i16::MAX as f32) as i16; // 80% volume
        for _ in 0..channels {
            samples.push(sample);
        }
    }

    info!(
        "Generated {}ms of {}Hz sine wave ({} samples, {} channels)",
        duration_ms, frequency_hz, num_samples, channels
    );
    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sine_wave_generation() {
        let samples = generate_sine_wave(440.0, 48000, 1, 100);
        assert_eq!(samples.len(), 4800); // 48000 * 0.1s

        // Check that samples are within i16 range and not all zero
        assert!(samples.iter().any(|&s| s != 0));
        assert!(samples.iter().all(|&s| s >= i16::MIN && s <= i16::MAX));
    }

    #[test]
    fn test_stereo_sine_wave() {
        let samples = generate_sine_wave(440.0, 48000, 2, 100);
        assert_eq!(samples.len(), 9600); // 48000 * 0.1s * 2 channels

        // Stereo: each pair should be identical (same value duplicated)
        for i in (0..samples.len()).step_by(2) {
            assert_eq!(samples[i], samples[i + 1]);
        }
    }
}
