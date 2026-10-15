//! `loop_capture` node — continuous region capture at a fixed interval.
//!
//! Single long-running node. Reads ONE config envelope on stdin, then emits a
//! stream of frame envelopes on stdout at `interval_ms` cadence until either
//! `max_frames` is reached or the parent process kills us (SIGTERM / Windows
//! terminate / EOF-on-stdin).
//!
//! ## Why not many one-shot `capture` calls?
//!
//! JS-side timing (`setInterval` / `setTimeout`) drifts under GC pressure and
//! EventLoop backpressure. Internal `tokio::time::sleep` is the timing source
//! of truth. Each frame is also cropped + PNG-encoded inside a
//! `spawn_blocking` so the JSONL writer is never starved.
//!
//! ## Backpressure
//!
//! The capture task writes frames to a bounded mpsc(2). When the channel is
//! full, the frame is dropped and `dropped_total` is incremented; the writer
//! emits a `{type:"status", frames_emitted, dropped_total}` event envelope
//! after each drop so the UI can show 「已丢 X 帧」 without parsing every
//! frame.
//!
//! ## Stop signal
//!
//! The Node driver writes the config envelope to stdin, then leaves stdin
//! open without sending anything more. To stop, the driver sends SIGTERM
//! (or just `proc.kill()` on Windows). This node installs a `tokio::signal`
//! handler (Unix only) and races the loop against SIGINT/SIGTERM; whichever
//! fires first ends the loop cleanly with a final `loop_complete` event
//! envelope. On Windows, the parent terminates the process and Tokio drops
//! the runtime — the in-flight `process()` future is cancelled.
//!
//! ## macOS
//!
//! Stub returning the same "v1 仅支持 Windows / Linux" error as the one-shot
//! `capture` node. The Node layer is responsible for gating per-platform, but
//! the binary still produces a useful error envelope if invoked directly.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::time::Duration;

use crate::core::node::{write_envelope_line, write_event_line};
use crate::core::screenshot::capture::{
    capture_screen_rgba, crop_rgba, encode_png, find_cursor_monitor, monitor_from_index,
    MonitorInfo,
};
use crate::error::{AppError, AppResult};

/// User-defined rectangle in monitor-relative pixel coordinates. Origin is the
/// top-left of the monitor under the cursor at the moment the loop kicks off;
/// the monitor does NOT re-resolve on each frame (cursor might wander).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopCaptureInput {
    pub region: Region,
    /// Minimum 50 ms; JS-side validation; the Rust side clamps.
    #[serde(default)]
    pub interval_ms: u64,
    /// `None` means run until SIGTERM / max_frames hit externally.
    #[serde(default)]
    pub max_frames: Option<u64>,
    /// 显示器下标（`Screen::all()` 顺序，由 `select` 输出的 monitorIndex 提供）。
    /// `None` = 光标所在显示器。显式指定可避免「框选完鼠标挪走」导致的错屏。
    #[serde(default)]
    pub monitor: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopCaptureFrame {
    /// Monotonic per-session sequence (0-based).
    pub seq: u64,
    /// UNIX-epoch milliseconds when the capture finished.
    pub captured_at_ms: u64,
    pub width: u32,
    pub height: u32,
    /// Base64-encoded PNG of the cropped region.
    pub png_b64: String,
}

/// Internal message carried on the bounded mpsc between capture and writer
/// tasks. The writer turns each `Frame` into a JSON envelope and emits a
/// status event after each `Dropped`.
enum FrameMsg {
    Frame(LoopCaptureFrame),
    Dropped,
}

/// Subprocess entry: invoked as `rsx-sc-rust loop_capture`. Owns its own
/// stdin/stdout lifecycle: reads ONE config envelope, then streams.
pub async fn run() -> AppResult<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut writer = stdout;

    // Read config envelope.
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 {
        eprintln!("[loop_capture] stdin EOF before config; exiting");
        return Ok(());
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let env: crate::core::envelope::Envelope<LoopCaptureInput> = match serde_json::from_str(trimmed)
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[loop_capture] malformed config: {e}; line was: {trimmed}");
            return Ok(());
        }
    };
    let input = match env {
        crate::core::envelope::Envelope::Frame { payload, .. } => payload,
        _ => {
            eprintln!("[loop_capture] config must be a frame envelope");
            return Ok(());
        }
    };

    drop(reader);

    run_loop(input, &mut writer).await
}

async fn run_loop<W>(input: LoopCaptureInput, writer: &mut W) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // macOS early-out: surface the error as a single Error envelope rather
    // than silently exiting 0.
    #[cfg(target_os = "macos")]
    {
        let env: crate::core::envelope::Envelope<()> =
            crate::core::envelope::Envelope::Error {
                seq: 0,
                payload: "macOS 屏幕截图尚未实现 (v1 仅支持 Windows / Linux)".to_string(),
            };
        let json = serde_json::to_string(&env)?;
        writer.write_all(json.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    run_loop_inner(input, writer).await
}

#[cfg(not(target_os = "macos"))]
async fn run_loop_inner<W>(input: LoopCaptureInput, writer: &mut W) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Resolve monitor ONCE. The cursor moving during the loop does not
    // change which monitor the user originally selected.
    let cursor_monitor = match input.monitor {
        Some(index) => tokio::task::spawn_blocking(move || monitor_from_index(index))
            .await
            .map_err(|e| AppError::Capture(format!("monitor join error: {e}")))??,
        None => tokio::task::spawn_blocking(find_cursor_monitor)
            .await
            .map_err(|e| AppError::Capture(format!("monitor join error: {e}")))??,
    };
    let MonitorInfo {
        scale_factor: _,
        x: mon_x,
        y: mon_y,
        width: mon_w,
        height: mon_h,
    } = cursor_monitor.monitor;

    let region = clamp_region(&input.region, mon_w, mon_h)?;
    let interval_ms = input.interval_ms.max(50);
    let max_frames = input.max_frames.unwrap_or(u64::MAX);

    // Wrap in Arcs so the capture task can borrow them across spawn_blocking
    // calls without moving out of the outer scope.
    let region = Arc::new(region);
    let cursor_monitor = Arc::new(cursor_monitor);

    // Counters shared between capture task and writer task.
    let frames_emitted = Arc::new(AtomicU64::new(0));
    let dropped_total = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(AtomicBool::new(false));

    // Frame channel: bounded mpsc(2). Drop-on-Full.
    let (msg_tx, mut msg_rx) = mpsc::channel::<FrameMsg>(2);

    // Capture task: each iteration captures+crops+encodes via spawn_blocking.
    let frames_emitted_c = frames_emitted.clone();
    let dropped_total_c = dropped_total.clone();
    let stopped_c = stopped.clone();
    let region_c = region.clone();
    let mon_c = cursor_monitor.clone();
    let capture_handle = tokio::spawn(async move {
        let mut seq: u64 = 0;
        for _ in 0..max_frames {
            if stopped_c.load(Ordering::Relaxed) {
                break;
            }
            let captured = {
                let r = (*region_c).clone();
                let mon = mon_c.clone(); // Arc::clone, not inner Clone
                tokio::task::spawn_blocking(move || -> AppResult<LoopCaptureFrame> {
                    let (rgba, img_w, img_h) = capture_screen_rgba(&mon)?;
                    if r.x + r.width > img_w || r.y + r.height > img_h {
                        return Err(AppError::Capture(format!(
                            "region out of bounds: {}x{} within {}x{}",
                            r.width, r.height, img_w, img_h
                        )));
                    }
                    let cropped = crop_rgba(&rgba, img_w, r.x, r.y, r.width, r.height);
                    let png = encode_png(&cropped, r.width, r.height)?;
                    let captured_at_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    Ok(LoopCaptureFrame {
                        seq,
                        captured_at_ms,
                        width: r.width,
                        height: r.height,
                        png_b64: BASE64.encode(&png),
                    })
                })
                .await
            };

            let frame = match captured {
                Ok(Ok(f)) => f,
                Ok(Err(e)) => {
                    eprintln!("[loop_capture] capture error: {e}");
                    stopped_c.store(true, Ordering::Relaxed);
                    break;
                }
                Err(e) => {
                    eprintln!("[loop_capture] join error: {e}");
                    stopped_c.store(true, Ordering::Relaxed);
                    break;
                }
            };

            match msg_tx.try_send(FrameMsg::Frame(frame)) {
                Ok(()) => {
                    seq += 1;
                    frames_emitted_c.fetch_add(1, Ordering::Relaxed);
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    dropped_total_c.fetch_add(1, Ordering::Relaxed);
                    // Best-effort status notice — channel may already be full.
                    let _ = msg_tx.try_send(FrameMsg::Dropped);
                    eprintln!(
                        "[loop_capture] dropped frame (channel full); dropped_total={}",
                        dropped_total_c.load(Ordering::Relaxed)
                    );
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }

            // Throttle. Skip the sleep on the last iteration so max_frames=1
            // still emits its frame.
            if seq < max_frames {
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            }
        }
    });

    // Unix-only signal handlers.
    #[cfg(unix)]
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| AppError::Capture(format!("signal handler: {e}")))?;
    #[cfg(unix)]
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|e| AppError::Capture(format!("signal handler: {e}")))?;

    let stopped_w = stopped.clone();
    let capture_done = tokio::task::spawn(async move {
        let _ = capture_handle.await;
    });

    let mut seq_out: u64 = 0;
    let region_x = region.x;
    let region_y = region.y;
    let region_w = region.width;
    let region_h = region.height;

    run_select_loop(
        #[cfg(unix)]
        &mut sigterm,
        #[cfg(unix)]
        &mut sigint,
        &mut msg_rx,
        capture_done,
        stopped_w,
        writer,
        &mut seq_out,
        frames_emitted.clone(),
        dropped_total.clone(),
        mon_x,
        mon_y,
        mon_w,
        mon_h,
        region_x,
        region_y,
        region_w,
        region_h,
    )
    .await?;

    // Final loop_complete event.
    let total = frames_emitted.load(Ordering::Relaxed);
    let drops = dropped_total.load(Ordering::Relaxed);
    let event = serde_json::json!({
        "type": "loop_complete",
        "frames": total,
        "dropped": drops,
    });
    let _ = write_event_line(writer, seq_out, event).await;
    writer.flush().await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(unix)]
async fn run_select_loop<W>(
    sigterm: &mut tokio::signal::unix::Signal,
    sigint: &mut tokio::signal::unix::Signal,
    msg_rx: &mut mpsc::Receiver<FrameMsg>,
    mut capture_done: tokio::task::JoinHandle<()>,
    stopped_w: Arc<AtomicBool>,
    writer: &mut W,
    seq_out: &mut u64,
    frames_emitted: Arc<AtomicU64>,
    dropped_total: Arc<AtomicU64>,
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    loop {
        tokio::select! {
            biased;
            _ = sigterm.recv() => {
                eprintln!("[loop_capture] SIGTERM, stopping");
                stopped_w.store(true, Ordering::Relaxed);
            }
            _ = sigint.recv() => {
                eprintln!("[loop_capture] SIGINT, stopping");
                stopped_w.store(true, Ordering::Relaxed);
            }
            maybe_msg = msg_rx.recv() => {
                let Some(msg) = maybe_msg else { break; };
                handle_msg(
                    msg,
                    writer,
                    seq_out,
                    &frames_emitted,
                    &dropped_total,
                    mon_x, mon_y, mon_w, mon_h,
                    region_x, region_y, region_w, region_h,
                ).await?;
            }
            _ = &mut capture_done => {
                while let Ok(msg) = msg_rx.try_recv() {
                    handle_msg(
                        msg,
                        writer,
                        seq_out,
                        &frames_emitted,
                        &dropped_total,
                        mon_x, mon_y, mon_w, mon_h,
                        region_x, region_y, region_w, region_h,
                    ).await?;
                }
                break;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(unix))]
async fn run_select_loop<W>(
    msg_rx: &mut mpsc::Receiver<FrameMsg>,
    mut capture_done: tokio::task::JoinHandle<()>,
    _stopped_w: Arc<AtomicBool>,
    writer: &mut W,
    seq_out: &mut u64,
    frames_emitted: Arc<AtomicU64>,
    dropped_total: Arc<AtomicU64>,
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    loop {
        tokio::select! {
            biased;
            maybe_msg = msg_rx.recv() => {
                let Some(msg) = maybe_msg else { break; };
                handle_msg(
                    msg,
                    writer,
                    seq_out,
                    &frames_emitted,
                    &dropped_total,
                    mon_x, mon_y, mon_w, mon_h,
                    region_x, region_y, region_w, region_h,
                ).await?;
            }
            _ = &mut capture_done => {
                while let Ok(msg) = msg_rx.try_recv() {
                    handle_msg(
                        msg,
                        writer,
                        seq_out,
                        &frames_emitted,
                        &dropped_total,
                        mon_x, mon_y, mon_w, mon_h,
                        region_x, region_y, region_w, region_h,
                    ).await?;
                }
                break;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_msg<W>(
    msg: FrameMsg,
    writer: &mut W,
    seq_out: &mut u64,
    frames_emitted: &Arc<AtomicU64>,
    dropped_total: &Arc<AtomicU64>,
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> AppResult<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    match msg {
        FrameMsg::Frame(frame) => {
            write_envelope_line(writer, *seq_out, frame).await?;
            *seq_out += 1;
        }
        FrameMsg::Dropped => {
            let event = serde_json::json!({
                "type": "status",
                "frames_emitted": frames_emitted.load(Ordering::Relaxed),
                "dropped_total": dropped_total.load(Ordering::Relaxed),
                "monitor": { "x": mon_x, "y": mon_y, "width": mon_w, "height": mon_h },
                "region": { "x": region_x, "y": region_y, "width": region_w, "height": region_h },
            });
            write_event_line(writer, *seq_out, event).await?;
            *seq_out += 1;
        }
    }
    Ok(())
}

/// Clamp a region to monitor bounds. Returns `Err` if the resulting region
/// would be empty or inverted.
#[cfg(not(target_os = "macos"))]
fn clamp_region(input: &Region, mon_w: u32, mon_h: u32) -> AppResult<Region> {
    let x = input.x.min(mon_w);
    let y = input.y.min(mon_h);
    let max_w = mon_w.saturating_sub(x);
    let max_h = mon_h.saturating_sub(y);
    let width = input.width.min(max_w);
    let height = input.height.min(max_h);
    if width == 0 || height == 0 {
        return Err(AppError::Capture(format!(
            "region has zero size after clamping: {}x{} (monitor {}x{})",
            width, height, mon_w, mon_h
        )));
    }
    Ok(Region {
        x,
        y,
        width,
        height,
    })
}