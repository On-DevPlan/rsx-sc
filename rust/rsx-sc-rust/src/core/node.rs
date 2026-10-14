//! The `Node` trait and the JSONL stdin/stdout runners.
//!
//! Every middleware node implements [`Node`]:
//!
//! - Associated types `Input` / `Output` declare the wire payload shape
//! - `NAME` is the stable argv name (`"capture"`, `"crop"`, `"loop_capture"`)
//! - `process()` is the pure logic — it must not touch stdin/stdout
//!
//! [`run_node_stdio`] wraps any `Node` with the JSONL line loop: read one
//! envelope from stdin, call `process()`, write one envelope to stdout.
//! This is what `main.rs` calls when the binary is invoked as
//! `rsx-sc-rust <node>`.

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::core::envelope::Envelope;
use crate::error::AppResult;

/// A pure stdin → stdout middleware node.
#[async_trait]
pub trait Node: Send + Sync + 'static {
    type Input: DeserializeOwned + Send + 'static;
    type Output: Serialize + Send + 'static;

    /// Stable name used for argv dispatch (e.g. `"capture"`).
    const NAME: &'static str;

    /// The pure logic. May perform IO, call APIs, etc.
    async fn process(&self, input: Self::Input) -> AppResult<Self::Output>;
}

/// Read JSONL envelopes from stdin, dispatch to `process`, write results to
/// stdout. Exits on EOF. Logs lifecycle events to stderr.
pub async fn run_node_stdio<N: Node>(node: N) -> AppResult<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut writer = stdout;

    let mut seq_out: u64 = 0;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            eprintln!("[{}] stdin EOF, exiting", N::NAME);
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let env: Envelope<N::Input> = match serde_json::from_str(trimmed) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[{}] malformed envelope: {e}; line was: {trimmed}", N::NAME);
                continue;
            }
        };

        let input = match env {
            Envelope::Frame { payload, .. } => payload,
            Envelope::Event { payload, .. } => {
                eprintln!("[{}] ignoring event: {payload}", N::NAME);
                continue;
            }
            Envelope::Error { payload, .. } => {
                eprintln!("[{}] ignoring error envelope: {payload}", N::NAME);
                continue;
            }
        };

        match node.process(input).await {
            Ok(output) => {
                write_envelope_line(&mut writer, seq_out, output).await?;
                seq_out += 1;
            }
            Err(e) => {
                write_error_envelope::<N, _>(&mut writer, seq_out, &format!("{e}")).await?;
                seq_out += 1;
                // Continue the loop; the orchestrator decides whether to kill us.
            }
        }
    }
    Ok(())
}

pub async fn write_envelope_line<W, T>(writer: &mut W, seq: u64, payload: T) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin,
    T: Serialize,
{
    let env = Envelope::<T>::frame(seq, payload);
    let json = serde_json::to_string(&env)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

/// Write a JSON event envelope line. Used by streaming nodes for control
/// signals that aren't data payloads (e.g. `{type:"loop_complete", frames, dropped}`).
pub async fn write_event_line<W>(
    writer: &mut W,
    seq: u64,
    payload: serde_json::Value,
) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let env = Envelope::<()>::event(seq, payload);
    let json = serde_json::to_string(&env)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

async fn write_error_envelope<N, W>(writer: &mut W, seq: u64, message: &str) -> AppResult<()>
where
    N: Node,
    W: tokio::io::AsyncWrite + Unpin,
{
    let env = Envelope::<N::Output>::Error {
        seq,
        payload: message.to_string(),
    };
    let json = serde_json::to_string(&env)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}