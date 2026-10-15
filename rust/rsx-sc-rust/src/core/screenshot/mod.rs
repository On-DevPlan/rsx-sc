//! Screenshot middleware: pixel-level input/output pipeline.
//!
//! Four nodes:
//!
//! - `capture` — BitBlt the monitor under the cursor, encode as PNG (one-shot)
//! - `crop` — crop a rectangle out of a PNG buffer
//! - `loop_capture` — continuously capture a user-defined region at a fixed
//!   interval, emitting a stream of frame envelopes until SIGTERM or max_frames
//! - `select` — native fullscreen box-select overlay (winit + softbuffer);
//!   prints the chosen region as JSON on stdout
//!
//! All but `select` speak the same wire protocol: JSONL on stdin/stdout, each
//! line an `Envelope<T>` where `T` is the node's input or output payload.
//! `select` is interactive: it opens a window, and prints ONE plain JSON
//! object (not an envelope) when the user finishes or cancels.

pub mod capture;
pub mod crop;
pub mod loop_capture;

use crate::error::{AppError, AppResult};

/// Route a screenshot-package node by name.
/// `select` (原生框选蒙版) lives at the crate root — it's an interactive
/// subcommand, not a JSONL node; see `crate::overlay`.
pub async fn run_node(name: &str) -> AppResult<()> {
    match name {
        "capture" => capture::run().await,
        "crop" => crop::run().await,
        "loop_capture" => loop_capture::run().await,
        "select" => crate::overlay::run().await,
        unknown => Err(AppError::Capture(format!(
            "unknown screenshot node: {unknown}"
        ))),
    }
}