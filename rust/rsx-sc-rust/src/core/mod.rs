//! Core middleware packages.
//!
//! Three domains:
//!
//! - [`screenshot`] — pixel-level input/output pipeline (capture, crop, loop_capture)
//!
//! Only screenshot is ported from tauri2 — the `ai_qa` (translate / ocr / qa)
//! side moved to the Node.js layer (`src/core/llm-client.js`) so providers
//! can be swapped without rebuilding Rust.

pub mod envelope;
pub mod node;
pub mod screenshot;

use crate::error::{AppError, AppResult};

/// Multi-call dispatcher: when the binary is invoked as `rsx-sc-rust <name>`,
/// route to the right node subprocess entry. Unknown names return an error
/// so typos surface as clear messages rather than silent no-ops.
pub async fn run_node(name: &str) -> AppResult<()> {
    match name {
        "capture" | "crop" | "loop_capture" => screenshot::run_node(name).await,
        unknown => Err(AppError::Capture(format!("unknown node: {unknown}"))),
    }
}