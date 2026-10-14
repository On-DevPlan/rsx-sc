//! Wire-level envelope wrapping node payloads on the JSONL stream.
//!
//! Every line on a node's stdin / stdout is an [`Envelope<T>`] serialized as
//! JSON. Three variants, discriminated by the `type` tag:
//!
//! - [`Envelope::Frame`] — normal data: a node's input or output payload
//! - [`Envelope::Event`] — control signal (e.g. "iteration finished", "loop complete")
//! - [`Envelope::Error`] — error from a node, with a human-readable message
//!
//! `T` is the node's payload type. For an `Envelope<CaptureOutput>` on
//! stdout, `T = CaptureOutput`. For an `Envelope<CropInput>` on stdin,
//! `T = CropInput`. Different nodes see different `T`s — the envelope only
//! fixes the wire shape, the payload schema is per-node.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Envelope<T> {
    Frame { seq: u64, payload: T },
    Event { seq: u64, payload: serde_json::Value },
    Error { seq: u64, payload: String },
}

impl<T> Envelope<T> {
    pub fn frame(seq: u64, payload: T) -> Self {
        Self::Frame { seq, payload }
    }

    pub fn event(seq: u64, payload: serde_json::Value) -> Self {
        Self::Event { seq, payload }
    }

    pub fn seq(&self) -> u64 {
        match self {
            Self::Frame { seq, .. }
            | Self::Event { seq, .. }
            | Self::Error { seq, .. } => *seq,
        }
    }
}