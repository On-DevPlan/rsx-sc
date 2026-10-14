//! Screenshot middleware: pixel-level input/output pipeline.
//!
//! Three nodes, all input-driven (see `core::node::Node`):
//!
//! - `capture` — BitBlt the monitor under the cursor, encode as PNG (one-shot)
//! - `crop` — crop a rectangle out of a PNG buffer
//! - `loop_capture` — continuously capture a user-defined region at a fixed
//!   interval, emitting a stream of frame envelopes until SIGTERM or max_frames
//!
//! All three speak the same wire protocol: JSONL on stdin/stdout, each line
//! an `Envelope<T>` where `T` is the node's input or output payload.

pub mod capture;
pub mod crop;
pub mod loop_capture;

use crate::error::{AppError, AppResult};

/// Route a screenshot-package node by name.
pub async fn run_node(name: &str) -> AppResult<()> {
    match name {
        "capture" => capture::run().await,
        "crop" => crop::run().await,
        "loop_capture" => loop_capture::run().await,
        unknown => Err(AppError::Capture(format!(
            "unknown screenshot node: {unknown}"
        ))),
    }
}