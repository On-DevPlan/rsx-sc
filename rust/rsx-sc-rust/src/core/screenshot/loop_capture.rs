//! `loop_capture` node — continuous region capture at a fixed interval.
//!
//! Single long-running node. Reads ONE config envelope on stdin, then emits a
//! stream of frame envelopes on stdout at `interval_ms` cadence until either
//! `max_frames` is reached or the parent process kills us (SIGTERM / Windows
//! terminate / EOF-on-stdin).
//!
//! ## 坐标系：虚拟桌面绝对坐标
//!
//! `region` 是**虚拟桌面绝对坐标**（原点 = 所有显示器并集的左上角），允许负
//! 坐标、允许跨屏。每帧把区域与各显示器求交后逐块拼接
//! （`capture::capture_virtual_region`）——这是唯一能表达「横跨两块屏的选区」
//! 的模型。单屏场景下它就是原来的行为，只是原点从「该屏左上角」换成了
//! 「并集左上角」，而 `select` 输出的正是同一坐标系，两者直接对接。
//!
//! ## Why not many one-shot `capture` calls?
//!
//! JS-side timing (`setInterval` / `setTimeout`) drifts under GC pressure and
//! EventLoop backpressure. Internal `tokio::time::sleep` is the timing source
//! of truth. Each frame is captured off the async runtime in a
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
//! `capture` node.

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
    capture_virtual_region, encode_png, virtual_desktop_bounds, VirtualRegion,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopCaptureInput {
    /// 虚拟桌面绝对坐标下的矩形；可跨屏、x/y 可为负。
    pub region: VirtualRegion,
    /// Minimum 50 ms; JS-side validation; the Rust side clamps.
    #[serde(default)]
    pub interval_ms: u64,
    /// `None` means run until SIGTERM / max_frames hit externally.
    #[serde(default)]
    pub max_frames: Option<u64>,
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
    // 虚拟桌面并集：用来校验/裁剪 region。光标后续移到哪块屏都不影响。
    let (ox, oy, dw, dh) = tokio::task::spawn_blocking(virtual_desktop_bounds)
        .await
        .map_err(|e| AppError::Capture(format!("bounds join error: {e}")))??;

    let region = clamp_region(&input.region, ox, oy, dw, dh)?;
    let interval_ms = input.interval_ms.max(50);
    let max_frames = input.max_frames.unwrap_or(u64::MAX);

    // Counters shared between capture task and writer task.
    let frames_emitted = Arc::new(AtomicU64::new(0));
    let dropped_total = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(AtomicBool::new(false));

    // Frame channel: bounded mpsc(2). Drop-on-Full.
    let (msg_tx, mut msg_rx) = mpsc::channel::<FrameMsg>(2);

    // Capture task: each iteration composites + crops + encodes off the async
    // runtime. On channel-full, drops the frame.
    let frames_emitted_c = frames_emitted.clone();
    let dropped_total_c = dropped_total.clone();
    let stopped_c = stopped.clone();
    let region_c = region.clone();
    let capture_handle = tokio::spawn(async move {
        let mut seq: u64 = 0;
        for _ in 0..max_frames {
            if stopped_c.load(Ordering::Relaxed) {
                break;
            }
            let captured = {
                let r = region_c.clone();
                tokio::task::spawn_blocking(move || -> AppResult<LoopCaptureFrame> {
                    let (rgba, w, h) = capture_virtual_region(&r)?;
                    let png = encode_png(&rgba, w, h)?;
                    let captured_at_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    Ok(LoopCaptureFrame {
                        seq,
                        captured_at_ms,
                        width: w,
                        height: h,
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
    region_x: i32,
    region_y: i32,
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
                    msg, writer, seq_out, &frames_emitted, &dropped_total,
                    region_x, region_y, region_w, region_h,
                ).await?;
            }
            _ = &mut capture_done => {
                while let Ok(msg) = msg_rx.try_recv() {
                    handle_msg(
                        msg, writer, seq_out, &frames_emitted, &dropped_total,
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
    region_x: i32,
    region_y: i32,
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
                    msg, writer, seq_out, &frames_emitted, &dropped_total,
                    region_x, region_y, region_w, region_h,
                ).await?;
            }
            _ = &mut capture_done => {
                while let Ok(msg) = msg_rx.try_recv() {
                    handle_msg(
                        msg, writer, seq_out, &frames_emitted, &dropped_total,
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
    region_x: i32,
    region_y: i32,
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
                "region": { "x": region_x, "y": region_y, "width": region_w, "height": region_h },
            });
            write_event_line(writer, *seq_out, event).await?;
            *seq_out += 1;
        }
    }
    Ok(())
}

/// 把 region 裁到虚拟桌面并集之内。与并集不相交则报错。
#[cfg(not(target_os = "macos"))]
fn clamp_region(
    input: &VirtualRegion,
    ox: i32,
    oy: i32,
    dw: u32,
    dh: u32,
) -> AppResult<VirtualRegion> {
    let x1 = input.x.max(ox);
    let y1 = input.y.max(oy);
    let x2 = (input.x + input.width as i32).min(ox + dw as i32);
    let y2 = (input.y + input.height as i32).min(oy + dh as i32);
    if x2 <= x1 || y2 <= y1 {
        return Err(AppError::Capture(format!(
            "region ({},{}) {}x{} 与虚拟桌面 ({},{}) {}x{} 不相交",
            input.x, input.y, input.width, input.height, ox, oy, dw, dh
        )));
    }
    Ok(VirtualRegion {
        x: x1,
        y: y1,
        width: (x2 - x1) as u32,
        height: (y2 - y1) as u32,
    })
}