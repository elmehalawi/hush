# Hush Calling Architecture

## Overview

This document describes the architecture for adding voice/video calling to Hush, a macOS Signal client built with React Native macOS + Rust (presage) + UniFFI + Swift.

Signal uses **ringrtc** (a WebRTC wrapper) for all call signaling and media. The `CallMessage` protobuf uses `opaque` bytes fields that are ringrtc-encoded — there is no way to participate in Signal calls without ringrtc.

## Current State

Hush currently handles call messages **read-only**:

1. Presage receives `ContentBody::CallMessage(call)` from Signal servers
2. `client.rs:process_content()` extracts offer type (audio/video) and direction
3. Creates `Message` with `MessageType::{MissedAudioCall, MissedVideoCall, AudioCall, VideoCall}`
4. Post-processing upgrades missed calls to answered when a `CallAnswer` is found
5. UI renders gray pills in chat: "Missed video call", "Voice call", etc.

No WebRTC, no audio/video capture, no call answering/declining.

## Signal Call Protocol

### Protobuf Structure

```
CallMessage {
  offer:    { id: u64, type: AudioCall|VideoCall, opaque: bytes }
  answer:   { id: u64, opaque: bytes }
  iceUpdate: [{ id: u64, opaque: bytes }]
  busy:     { id: u64 }
  hangup:   { id: u64, type: Normal|Accepted|Declined|Busy|NeedPermission, deviceId: u32 }
  opaque:   { data: bytes, urgency: Droppable|HandleImmediately }
  destinationDeviceId: u32
}
```

All `opaque` fields contain ringrtc-encoded data. The `sdp` fields are reserved (deprecated).

### Signaling Flow (1:1 Call)

```
Caller                          Signal Server                     Callee
  |                                  |                               |
  |-- CallMessage(offer) ----------->|                               |
  |                                  |-- CallMessage(offer) -------->|
  |                                  |                               |
  |                                  |<-- CallMessage(answer) -------|
  |<-- CallMessage(answer) ---------|                               |
  |                                  |                               |
  |<========== ICE candidates exchanged via CallMessage ==========>|
  |                                  |                               |
  |<=============== SRTP media flows peer-to-peer ================>|
  |                                  |                               |
  |-- CallMessage(hangup) --------->|                               |
  |                                  |-- CallMessage(hangup) ------->|
```

### ringrtc's Role

ringrtc wraps WebRTC and provides:
- `CallManager` — state machine for call lifecycle
- `NativePlatform` — trait for platform-specific callbacks
- Generation of `opaque` bytes for offer/answer/ICE
- SRTP media encryption/decryption
- Audio capture/playback integration
- ICE candidate gathering and connectivity checks

## Architecture: CLI-First Approach

### Why CLI First

Instead of integrating calling into the app immediately, we build a standalone CLI tool (`hush-call`) that exercises the full calling stack in isolation:

- **Confidence**: Verify the WebRTC/ringrtc stack works before touching the app
- **Clear API**: Tested contract for eventual app integration
- **Regression testing**: Automated test harness for the calling stack

### Component Diagram

```
┌─────────────────────────────────────────────┐
│                hush-call CLI                 │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐ │
│  │  clap    │  │  signaling│  │   audio   │ │
│  │ commands │  │  (presage)│  │  (cubeb)  │ │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘ │
│       │              │              │        │
│  ┌────┴──────────────┴──────────────┴─────┐  │
│  │           call_manager                  │  │
│  │    (ringrtc CallManager wrapper)        │  │
│  └────────────────┬───────────────────────┘  │
│                   │                          │
└───────────────────┼──────────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
┌────────┐   ┌──────────┐   ┌──────────┐
│ presage│   │ ringrtc  │   │  cubeb   │
│(Signal │   │(WebRTC   │   │ (audio   │
│protocol│   │ wrapper) │   │  I/O)    │
│  + DB) │   │          │   │          │
└────────┘   └──────────┘   └──────────┘
```

### Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| `main` | `src/main.rs` | CLI entry point, clap subcommands |
| `call_manager` | `src/call_manager.rs` | ringrtc `CallManager` initialization, `NativePlatform` impl, call state machine |
| `signaling` | `src/signaling.rs` | Send/receive `CallMessage` via presage, route to/from `CallManager` |
| `audio` | `src/audio.rs` | Audio device enumeration, test tone generation (440Hz sine), capture/playback |

### CLI Subcommands

| Command | Description |
|---------|-------------|
| `hush-call link` | Link a second Signal account via QR code |
| `hush-call call <phone-or-uuid>` | Initiate a voice call |
| `hush-call call --video <phone-or-uuid>` | Initiate a video call |
| `hush-call listen` | Wait for incoming calls, auto-answer or prompt |
| `hush-call test-audio <phone-or-uuid>` | Call with 440Hz sine wave test tone |
| `hush-call hangup` | End the active call |
| `hush-call status` | Show call state, connected peer, duration |

### Two-Account Testing Flow

1. Register a second phone number with Signal
2. `hush-call link` on account B (QR code from phone)
3. Terminal A: `hush-call listen` (account A)
4. Terminal B: `hush-call call <account-A-number>` (account B)
5. Verify: call connects, audio flows, hangup works
6. Swap directions and repeat

## Implementation Phases

### Phase 0: Documentation (this file)

### Phase 1: Build ringrtc for macOS

1. Clone ringrtc into `rust/ringrtc/`
2. Build with `cargo build -p ringrtc --features prebuilt_webrtc`
3. Fallbacks if prebuilt fails:
   - Extract WebRTC binary from Signal Desktop's `@signalapp/ringrtc` npm package
   - Build WebRTC from source via ringrtc's `make cli`
4. Verify: `libringrtc.a` exists, key symbols present

### Phase 2: CLI calling tool (`hush-call`)

Build `rust/hush-call/` — standalone CLI binary linking presage + ringrtc.

**What it tests:**
- ringrtc `CallManager` initialization
- Creating outgoing call offers (opaque bytes generation)
- Sending offers/answers/ICE via presage
- Receiving and routing incoming call messages to ringrtc
- Full WebRTC peer connection establishment (ICE, DTLS, SRTP)
- Audio capture/playback
- Call state machine transitions
- Hangup, decline, busy handling

### Phase 3: Shared calling library (future)

Extract tested calling code from hush-call into `hush-calling` crate.

### Phase 4: App integration (future)

Integrate `hush-calling` into presage-rn, expose via UniFFI to Swift/RN.

### Phase 5: Call UI (future)

Swift `CallModule` + React Native call UI (incoming ring, in-call controls, etc).

## Key Dependencies

| Dependency | Purpose | Source |
|-----------|---------|--------|
| `ringrtc` | WebRTC wrapper, call state machine | `github.com/nicozanf/nicozanf-ringrtc` (or `signalapp/ringrtc`) |
| `presage` | Signal protocol, message send/receive | `github.com/whisperfish/presage` rev `c3d4dd56444e` |
| `cubeb` | Cross-platform audio I/O | crates.io |
| `clap` | CLI argument parsing | crates.io |
| `tokio` | Async runtime | crates.io |

## Risks & Findings

1. **ringrtc prebuilt_webrtc works on macOS aarch64** — Signal publishes prebuilt WebRTC binaries for `mac-arm64` at `https://build-artifacts.signal.org/libraries/`. The `prebuilt_webrtc` feature downloads and links them automatically. **RESOLVED.**
2. **Dependency conflict: presage + ringrtc cannot coexist in one crate** — presage depends on `libsignal v0.87.4` (via whisperfish's libsignal-service-rs) while ringrtc depends on `libsignal v0.89.2` (for zkgroup). These require incompatible versions of `hax-lib` (0.3.5 vs 0.3.6). **Workaround:** hush-call depends only on ringrtc; presage integration will be added via IPC or by updating presage's libsignal to match ringrtc's version.
3. **ringrtc API is well-documented by example** — The `direct.rs` binary in ringrtc's repo shows exactly how to use `CallManager`, `NativePlatform`, `SignalingSender`, `CallStateHandler`, etc. **RESOLVED.**
4. **Second Signal account** — Need a second phone number for end-to-end testing.

## File Layout

```
rust/
├── ringrtc/                    # ringrtc repo (git submodule or clone)
├── hush-call/
│   ├── Cargo.toml              # depends on presage + ringrtc
│   ├── Cargo.lock              # independent lock file
│   └── src/
│       ├── main.rs             # CLI entry, clap subcommands
│       ├── call_manager.rs     # ringrtc CallManager wrapper
│       ├── signaling.rs        # presage-based call signaling
│       └── audio.rs            # audio device enum, test tones
├── presage-rn/                 # existing app crate (unchanged)
├── whisper-transcribe/         # existing transcription crate (unchanged)
└── test-provisioning/          # existing provisioning tool (unchanged)
```
