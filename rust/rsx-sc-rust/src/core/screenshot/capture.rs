//! 像素级截屏原语 + `capture` 节点。
//!
//! ## 坐标系：虚拟桌面绝对坐标
//!
//! 所有区域都是**虚拟桌面绝对坐标**——原点 = 所有显示器并集的左上角，副屏在
//! 主屏左边/上边时 x/y 为负，且可以跨屏。这是多显示器下唯一能表达「横跨两块
//! 屏的选区」的模型，`select`（框选蒙版）输出的也正是这个坐标系。
//!
//! ## 为什么没有「光标所在显示器」那套
//!
//! 早期移植自 tauri2 的版本按「光标所在显示器」定位、region 用显示器相对坐标。
//! 那套模型在多显示器下有根本缺陷（选区出不了单屏、跨屏无法表达），已整体
//! 换成虚拟桌面坐标，光标/显示器枚举相关的代码随之删除。
//!
//! ## 节点
//!
//! - **`capture`** — 截一帧。输入可带 `region`（虚拟桌面坐标）；缺省截整块
//!   虚拟桌面。这是面板「顺序驱动」流程的基本操作：截一张 → 交给模型 → 等回复
//!   → 再截下一张。

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::core::node::{run_node_stdio, Node};
use crate::error::{AppError, AppResult};

// ── 虚拟桌面坐标下的矩形 ────────────────────────────────────────────────────

/// 原点 = 所有显示器并集的左上角，**允许负坐标**（副屏在主屏左边时 x 为负），
/// 且可以**跨屏**。显示器之间的空隙在输出里留黑。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

// ── macOS stubs ─────────────────────────────────────────────────────────────
//
// v1 不支持 macOS。Node 层会先按平台报错；这里保证直接跑二进制时也有清晰错误。

#[cfg(target_os = "macos")]
const MACOS_STUB: &str = "macOS 屏幕截图尚未实现 (v1 仅支持 Windows / Linux)";

#[cfg(target_os = "macos")]
pub fn virtual_desktop_bounds() -> AppResult<(i32, i32, u32, u32)> {
    Err(AppError::Capture(MACOS_STUB.into()))
}

#[cfg(target_os = "macos")]
pub fn capture_virtual_region(_r: &VirtualRegion) -> AppResult<(Vec<u8>, u32, u32)> {
    Err(AppError::Capture(MACOS_STUB.into()))
}

#[cfg(target_os = "macos")]
pub fn capture_virtual_desktop() -> AppResult<(Vec<u8>, u32, u32, i32, i32)> {
    Err(AppError::Capture(MACOS_STUB.into()))
}

// ── 虚拟桌面：边界与抓取（Windows / Linux）──────────────────────────────────

/// 所有显示器并集的包围盒（虚拟桌面），返回 (x, y, width, height)。
#[cfg(not(target_os = "macos"))]
pub fn virtual_desktop_bounds() -> AppResult<(i32, i32, u32, u32)> {
    let all = screenshots::Screen::all()
        .map_err(|e| AppError::Capture(format!("enumerate screens: {e}")))?;
    if all.is_empty() {
        return Err(AppError::Capture("没有检测到任何显示器".into()));
    }
    let min_x = all.iter().map(|s| s.display_info.x).min().unwrap_or(0);
    let min_y = all.iter().map(|s| s.display_info.y).min().unwrap_or(0);
    let max_x = all
        .iter()
        .map(|s| s.display_info.x + s.display_info.width as i32)
        .max()
        .unwrap_or(0);
    let max_y = all
        .iter()
        .map(|s| s.display_info.y + s.display_info.height as i32)
        .max()
        .unwrap_or(0);
    Ok((min_x, min_y, (max_x - min_x).max(0) as u32, (max_y - min_y).max(0) as u32))
}

/// 抓取虚拟桌面坐标下的任意矩形：与每块显示器求交，逐块捕获后拷贝进输出缓冲。
///
/// 返回 (rgba, width, height)。宽松实现——每块屏整屏捕获再裁切，与单屏路径
/// 一样的成本量级，换来的是「跨屏选区」能用一个统一模型表达。
#[cfg(not(target_os = "macos"))]
pub fn capture_virtual_region(r: &VirtualRegion) -> AppResult<(Vec<u8>, u32, u32)> {
    if r.width == 0 || r.height == 0 {
        return Err(AppError::Capture(format!(
            "region 宽高不能为零: {}x{}",
            r.width, r.height
        )));
    }
    let screens = screenshots::Screen::all()
        .map_err(|e| AppError::Capture(format!("enumerate screens: {e}")))?;
    let mut out = vec![0u8; (r.width as usize) * (r.height as usize) * 4];
    let mut covered = false;

    for screen in screens {
        let di = &screen.display_info;
        // 选区与本显示器的交集（虚拟桌面绝对坐标）
        let ix1 = r.x.max(di.x);
        let iy1 = r.y.max(di.y);
        let ix2 = (r.x + r.width as i32).min(di.x + di.width as i32);
        let iy2 = (r.y + r.height as i32).min(di.y + di.height as i32);
        if ix2 <= ix1 || iy2 <= iy1 {
            continue; // 不相交
        }

        let cap = screen
            .capture()
            .map_err(|e| AppError::Capture(e.to_string()))?;
        let (cw, ch) = (cap.width(), cap.height());
        let src = cap.into_raw();

        let bw = (ix2 - ix1) as u32;
        let bh = (iy2 - iy1) as u32;
        let sx = (ix1 - di.x) as u32;
        let sy = (iy1 - di.y) as u32;
        let dx = (ix1 - r.x) as u32;
        let dy = (iy1 - r.y) as u32;

        // 报告分辨率与实际捕获不符时跳过这一块，别越界读
        if sx + bw > cw || sy + bh > ch {
            continue;
        }
        for row in 0..bh {
            let s = (((sy + row) * cw + sx) as usize) * 4;
            let d = ((((dy + row) * r.width) + dx) as usize) * 4;
            let len = (bw as usize) * 4;
            out[d..d + len].copy_from_slice(&src[s..s + len]);
        }
        covered = true;
    }

    if !covered {
        return Err(AppError::Capture(format!(
            "region ({},{}) {}x{} 与任何显示器都不相交",
            r.x, r.y, r.width, r.height
        )));
    }
    Ok((out, r.width, r.height))
}

/// 把整个虚拟桌面截下来（供框选蒙版当底图，也可作 capture 的缺省范围）。
/// 返回 (rgba, width, height, origin_x, origin_y)。
#[cfg(not(target_os = "macos"))]
pub fn capture_virtual_desktop() -> AppResult<(Vec<u8>, u32, u32, i32, i32)> {
    let (ox, oy, w, h) = virtual_desktop_bounds()?;
    let (rgba, rw, rh) = capture_virtual_region(&VirtualRegion {
        x: ox,
        y: oy,
        width: w,
        height: h,
    })?;
    Ok((rgba, rw, rh, ox, oy))
}

// ── 共用像素工具 ─────────────────────────────────────────────────────────────

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

// ── CaptureNode：截一帧 ─────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInput {
    /// 可选：只截虚拟桌面上的这个矩形。缺省 = 整块虚拟桌面。
    #[serde(default)]
    pub region: Option<VirtualRegion>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutput {
    /// Base64-encoded PNG of the captured region.
    pub png_b64: String,
    pub width: u32,
    pub height: u32,
    /// 这次实际截取的矩形（缺省整屏时由 Rust 回填，方便调用方知道自己拿到了哪里）。
    pub x: i32,
    pub y: i32,
}

pub struct CaptureNode;

#[async_trait]
impl Node for CaptureNode {
    type Input = CaptureInput;
    type Output = CaptureOutput;
    const NAME: &'static str = "capture";

    async fn process(&self, input: Self::Input) -> AppResult<Self::Output> {
        // 抓屏是阻塞调用，丢到 blocking 线程，让 async 运行时留给 JSONL 循环。
        let (rgba, w, h, x, y) =
            tokio::task::spawn_blocking(move || -> AppResult<(Vec<u8>, u32, u32, i32, i32)> {
                match input.region {
                    Some(r) => {
                        let (rgba, w, h) = capture_virtual_region(&r)?;
                        Ok((rgba, w, h, r.x, r.y))
                    }
                    None => capture_virtual_desktop(),
                }
            })
            .await
            .map_err(|e| AppError::Capture(format!("capture join error: {e}")))??;

        let png = encode_png(&rgba, w, h)?;
        Ok(CaptureOutput {
            png_b64: BASE64.encode(&png),
            width: w,
            height: h,
            x,
            y,
        })
    }
}

/// Subprocess entry: invoked as `rsx-sc-rust capture`.
pub async fn run() -> AppResult<()> {
    run_node_stdio(CaptureNode).await
}