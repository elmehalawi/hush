//! Signaling conversion utilities.
//!
//! Provides types and functions to convert between Signal's CallMessage protobuf
//! (as used by presage) and ringrtc's signaling types.

use presage::proto::{call_message, CallMessage};
use ringrtc::{
    common::{CallId, CallMediaType, DeviceId},
    core::signaling,
};
use tracing::{debug, error};

/// Check if a CallMessage is a hangup that says our own device accepted.
/// These should be ignored — they're meant for OTHER devices on our account.
pub fn is_hangup_for_self(call_msg: &CallMessage, my_device_id: u32) -> bool {
    if let Some(hangup) = &call_msg.hangup {
        let hangup_type = hangup.r#type.unwrap_or(0);
        let device_id = hangup.device_id.unwrap_or(0);
        // HangupAccepted = 1 in the proto enum
        if hangup_type == call_message::hangup::Type::HangupAccepted as i32
            && device_id == my_device_id
        {
            debug!(
                "Ignoring HangupAccepted for our own device {}",
                my_device_id
            );
            return true;
        }
    }
    false
}

/// A parsed signaling message with its call ID
pub struct ParsedSignaling {
    pub call_id: CallId,
    pub message: signaling::Message,
}

// --- ringrtc → presage CallMessage conversion ---

/// Convert a ringrtc offer to a presage CallMessage proto
pub fn ringrtc_offer_to_call_message(
    call_id: CallId,
    media_type: CallMediaType,
    opaque: Vec<u8>,
) -> CallMessage {
    let offer_type = if media_type == CallMediaType::Video {
        call_message::offer::Type::OfferVideoCall
    } else {
        call_message::offer::Type::OfferAudioCall
    };

    CallMessage {
        offer: Some(call_message::Offer {
            id: Some(u64::from(call_id)),
            r#type: Some(offer_type as i32),
            opaque: Some(opaque),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Convert a ringrtc answer to a presage CallMessage proto
pub fn ringrtc_answer_to_call_message(call_id: CallId, opaque: Vec<u8>) -> CallMessage {
    CallMessage {
        answer: Some(call_message::Answer {
            id: Some(u64::from(call_id)),
            opaque: Some(opaque),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Convert ringrtc ICE candidates to a presage CallMessage proto
pub fn ringrtc_ice_to_call_message(
    call_id: CallId,
    candidates: &[signaling::IceCandidate],
) -> CallMessage {
    let ice_updates = candidates
        .iter()
        .map(|c| call_message::IceUpdate {
            id: Some(u64::from(call_id)),
            opaque: Some(c.opaque.clone()),
            ..Default::default()
        })
        .collect();

    CallMessage {
        ice_update: ice_updates,
        ..Default::default()
    }
}

/// Convert a ringrtc hangup to a presage CallMessage proto
pub fn ringrtc_hangup_to_call_message(
    call_id: CallId,
    hangup_type: signaling::HangupType,
    device_id: DeviceId,
) -> CallMessage {
    let proto_type = match hangup_type {
        signaling::HangupType::Normal => call_message::hangup::Type::HangupNormal,
        signaling::HangupType::AcceptedOnAnotherDevice => call_message::hangup::Type::HangupAccepted,
        signaling::HangupType::DeclinedOnAnotherDevice => call_message::hangup::Type::HangupDeclined,
        signaling::HangupType::BusyOnAnotherDevice => call_message::hangup::Type::HangupBusy,
        signaling::HangupType::NeedPermission => call_message::hangup::Type::HangupNeedPermission,
    };

    CallMessage {
        hangup: Some(call_message::Hangup {
            id: Some(u64::from(call_id)),
            r#type: Some(proto_type as i32),
            device_id: Some(device_id as u32),
        }),
        ..Default::default()
    }
}

/// Convert a ringrtc busy signal to a presage CallMessage proto
pub fn ringrtc_busy_to_call_message(call_id: CallId) -> CallMessage {
    CallMessage {
        busy: Some(call_message::Busy {
            id: Some(u64::from(call_id)),
        }),
        ..Default::default()
    }
}

/// Convert a full ringrtc signaling::Message to a presage CallMessage
pub fn ringrtc_to_call_message(
    call_id: CallId,
    msg: &signaling::Message,
) -> CallMessage {
    match msg {
        signaling::Message::Offer(offer) => {
            ringrtc_offer_to_call_message(call_id, offer.call_media_type, offer.opaque.clone())
        }
        signaling::Message::Answer(answer) => {
            ringrtc_answer_to_call_message(call_id, answer.opaque.clone())
        }
        signaling::Message::Ice(ice) => {
            ringrtc_ice_to_call_message(call_id, &ice.candidates)
        }
        signaling::Message::Hangup(hangup) => {
            let (hangup_type, device_id) = hangup.to_type_and_device_id();
            ringrtc_hangup_to_call_message(call_id, hangup_type, device_id.unwrap_or(0))
        }
        signaling::Message::Busy => ringrtc_busy_to_call_message(call_id),
    }
}

// --- presage CallMessage → ringrtc conversion ---

/// Parse a presage CallMessage into a ringrtc signaling message.
/// Returns None if the CallMessage doesn't contain a recognized signaling type.
pub fn call_message_to_ringrtc(call_msg: &CallMessage) -> Option<ParsedSignaling> {
    if let Some(offer) = &call_msg.offer {
        let call_id = offer.id?;
        let is_video = offer
            .r#type
            .map(|t| t == call_message::offer::Type::OfferVideoCall as i32)
            .unwrap_or(false);
        let opaque = offer.opaque.clone()?;
        return parse_offer(call_id, is_video, opaque);
    }

    if let Some(answer) = &call_msg.answer {
        let call_id = answer.id?;
        let opaque = answer.opaque.clone()?;
        return parse_answer(call_id, opaque);
    }

    if !call_msg.ice_update.is_empty() {
        // Use call_id from first ICE candidate
        let call_id = call_msg.ice_update.first()?.id?;
        let candidates: Vec<Vec<u8>> = call_msg
            .ice_update
            .iter()
            .filter_map(|c| c.opaque.clone())
            .collect();
        return Some(parse_ice(call_id, candidates));
    }

    if let Some(hangup) = &call_msg.hangup {
        let call_id = hangup.id?;
        let hangup_type = hangup.r#type.unwrap_or(0);
        let device_id = hangup.device_id.unwrap_or(0);
        return Some(parse_hangup(call_id, hangup_type, device_id));
    }

    if let Some(busy) = &call_msg.busy {
        let call_id = busy.id?;
        return Some(parse_busy(call_id));
    }

    None
}

// --- Low-level parsing helpers ---

/// Parse an offer from opaque bytes
pub fn parse_offer(call_id: u64, is_video: bool, opaque: Vec<u8>) -> Option<ParsedSignaling> {
    let call_media_type = if is_video {
        CallMediaType::Video
    } else {
        CallMediaType::Audio
    };
    match signaling::Offer::new(call_media_type, opaque) {
        Ok(offer) => Some(ParsedSignaling {
            call_id: CallId::new(call_id),
            message: signaling::Message::Offer(offer),
        }),
        Err(e) => {
            error!("Failed to parse offer opaque data: {}", e);
            None
        }
    }
}

/// Parse an answer from opaque bytes
pub fn parse_answer(call_id: u64, opaque: Vec<u8>) -> Option<ParsedSignaling> {
    match signaling::Answer::new(opaque) {
        Ok(answer) => Some(ParsedSignaling {
            call_id: CallId::new(call_id),
            message: signaling::Message::Answer(answer),
        }),
        Err(e) => {
            error!("Failed to parse answer opaque data: {}", e);
            None
        }
    }
}

/// Parse ICE candidates from opaque bytes
pub fn parse_ice(call_id: u64, candidates_opaque: Vec<Vec<u8>>) -> ParsedSignaling {
    let candidates = candidates_opaque
        .into_iter()
        .map(signaling::IceCandidate::new)
        .collect();
    ParsedSignaling {
        call_id: CallId::new(call_id),
        message: signaling::Message::Ice(signaling::Ice { candidates }),
    }
}

/// Parse a hangup from type + device_id
pub fn parse_hangup(call_id: u64, hangup_type: i32, device_id: u32) -> ParsedSignaling {
    let typ = signaling::HangupType::from_i32(hangup_type)
        .unwrap_or(signaling::HangupType::Normal);
    let hangup = signaling::Hangup::from_type_and_device_id(typ, device_id as DeviceId);
    ParsedSignaling {
        call_id: CallId::new(call_id),
        message: signaling::Message::Hangup(hangup),
    }
}

/// Parse a busy signal
pub fn parse_busy(call_id: u64) -> ParsedSignaling {
    ParsedSignaling {
        call_id: CallId::new(call_id),
        message: signaling::Message::Busy,
    }
}
