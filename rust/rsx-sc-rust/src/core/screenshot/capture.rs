//! `capture` node — BitBlt the monitor under the cursor, encode as PNG (one-shot).
//!
//! Reuses the same primitives as `loop_capture`: `find_cursor_monitor`,
//! `capture_screen_rgba`, `crop_rgba`, `encode_png`. The one-shot node is
//! kept around for diagnostic use (e.g. `echo '{"type":"frame","seq":0,"payload":{}}'
//! | rsx-sc-rust capture` from the shell).

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::core::node::{run_node_stdio, Node};
use crate::error::{AppError, AppResult};

// ── Raw pixel primitives (ported from tauri2) ────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub struct MonitorInfo {
    pub scale_factor: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(not(target_os = "macos"))]
pub struct CursorMonitor {
    pub screen: screenshots::Screen,
    pub monitor: MonitorInfo,
}

/// Find the monitor under the cursor (Windows / Linux).
#[cfg(not(target_os = "macos"))]
pub fn find_cursor_monitor() -> AppResult<CursorMonitor> {
    let (cursor_x, cursor_y) = cursor_position()?;
    let screen = screenshots::Screen::from_point(cursor_x, cursor_y)
        .map_err(|e| AppError::Capture(format!("no screen at ({cursor_x},{cursor_y}): {e}")))?;
    let info = &screen.display_info;
    Ok(CursorMonitor {
        screen,
        monitor: MonitorInfo {
            scale_factor: info.scale_factor as f64,
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
        },
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_screen_rgba(monitor: &CursorMonitor) -> AppResult<(Vec<u8>, u32, u32)> {
    let capture = monitor
        .screen
        .capture()
        .map_err(|e| AppError::Capture(e.to_string()))?;
    let w = capture.width();
    let h = capture.height();
    let rgba = capture.into_raw();
    Ok((rgba, w, h))
}

#[cfg(target_os = "windows")]
fn cursor_position() -> AppResult<(i32, i32)> {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(lpPoint: *mut Point) -> i32;
    }
    let mut pt = Point { x: 0, y: 0 };
    let result = unsafe { GetCursorPos(&mut pt) };
    if result == 0 {
        return Err(AppError::Capture("GetCursorPos failed".into()));
    }
    Ok((pt.x, pt.y))
}

#[cfg(target_os = "linux")]
fn cursor_position() -> AppResult<(i32, i32)> {
    // Wayland doesn't expose global cursor. Linux mint/X11 do via libx11.
    // For v1 we just default to (0,0) which resolves to the primary screen via from_point.
    Ok((0, 0))
}

// ── macOS stubs ─────────────────────────────────────────────────────────────
//
// v1: macOS is unsupported. The Node layer surfaces a clear error before
// even spawning the binary; if the binary is run on macOS anyway, this
// stub fires. To enable, replace with a `screencapture -x -D <id>` shim
// or a CoreGraphics FFI binding.

#[cfg(target_os = "macos")]
pub struct MonitorInfo {
    pub scale_factor: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub display_id: u32,
}

#[cfg(target_os = "macos")]
pub struct CursorMonitor {
    pub monitor: MonitorInfo,
}

#[cfg(target_os = "macos")]
pub fn find_cursor_monitor() -> AppResult<CursorMonitor> {
    Err(AppError::Capture(
        "macOS 屏幕截图尚未实现 (v1 仅支持 Windows / Linux)".into(),
    ))
}

#[cfg(target_os = "macos")]
pub fn capture_screen_rgba(_monitor: &CursorMonitor) -> AppResult<(Vec<u8>, u32, u32)> {
    Err(AppError::Capture(
        "macOS 屏幕截图尚未实现 (v1 仅支持 Windows / Linux)".into(),
    ))
}

// ── Shared utilities used by `crop` and `loop_capture` ──────────────────────

/// Crop a sub-rectangle from a contiguous RGBA buffer (row-major, row stride = img_w * 4).
pub fn crop_rgba(rgba: &[u8], img_w: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in y..(y + h) {
        let start = ((row * img_w + x) * 4) as usize;
        let end = start + (w * 4) as usize;
        if end <= rgba.len() {
            out.extend_from_slice(&rgba[start..end]);
        }
    }
    out
}

/// Encode an RGBA buffer as PNG.
pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> AppResult<Vec<u8>> {
    use image::{ImageBuffer, RgbaImage};
    let img: RgbaImage = ImageBuffer::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| AppError::Capture("invalid RGBA dimensions for PNG".into()))?;
    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| AppError::Capture(format!("PNG encode error: {e}")))?;
    Ok(png)
}

// ── CaptureNode — one-shot middleware node ──────────────────────────────────

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct CaptureInput {}

#[derive(Debug, Serialize)]
pub struct CaptureOutput {
    /// Base64-encoded PNG of the captured monitor.
    pub png_b64: String,
    pub width: u32,
    pub height: u32,
}

pub struct CaptureNode;

#[async_trait]
impl Node for CaptureNode {
    type Input = CaptureInput;
    type Output = CaptureOutput;
    const NAME: &'static str = "capture";

    async fn process(&self, _input: Self::Input) -> AppResult<Self::Output> {
        let (rgba, w, h) = tokio::task::spawn_blocking(crate_core_capture_blocking)
            .await
            .map_err(|e| AppError::Capture(format!("capture join error: {e}")))??;

        let png = encode_png(&rgba, w, h)?;
        Ok(CaptureOutput {
            png_b64: BASE64.encode(&png),
            width: w,
            height: h,
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn crate_core_capture_blocking() -> AppResult<(Vec<u8>, u32, u32)> {
    let monitor = find_cursor_monitor()?;
    capture_screen_rgba(&monitor)
}

#[cfg(target_os = "macos")]
fn crate_core_capture_blocking() -> AppResult<(Vec<u8>, u32, u32)> {
    Err(AppError::Capture(
        "macOS 屏幕截图尚未实现 (v1 仅支持 Windows / Linux)".into(),
    ))
}

/// Subprocess entry: invoked as `rsx-sc-rust capture`.
pub async fn run() -> AppResult<()> {
    run_node_stdio(CaptureNode).await
}