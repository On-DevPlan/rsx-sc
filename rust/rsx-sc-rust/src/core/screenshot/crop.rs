//! `crop` node — crop a rectangle from a base64-encoded PNG.
//!
//! If `rect` is omitted in the input, falls back to a fixed 800×600 region
//! in the top-left of the image. This default is for manual pipe testing;
//! the orchestrator always supplies an explicit rect.

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::core::node::{run_node_stdio, Node};
use crate::core::screenshot::capture::{crop_rgba, encode_png};
use crate::error::{AppError, AppResult};

/// Selection rectangle in screenshot pixel coordinates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropInput {
    pub png_b64: String,
    #[serde(default)]
    pub rect: Option<CaptureRect>,
}

#[derive(Debug, Serialize)]
pub struct CropOutput {
    pub png_b64: String,
    pub width: u32,
    pub height: u32,
}

pub struct CropNode;

#[async_trait]
impl Node for CropNode {
    type Input = CropInput;
    type Output = CropOutput;
    const NAME: &'static str = "crop";

    async fn process(&self, input: Self::Input) -> AppResult<Self::Output> {
        let png_bytes = BASE64
            .decode(input.png_b64.as_bytes())
            .map_err(|e| AppError::Capture(format!("base64 decode: {e}")))?;

        let img = image::load_from_memory(&png_bytes)
            .map_err(|e| AppError::Capture(format!("PNG decode: {e}")))?;
        let rgba = img.to_rgba8();
        let (img_w, img_h) = (rgba.width(), rgba.height());

        let rect = input.rect.unwrap_or_else(|| {
            let w = 800.min(img_w);
            let h = 600.min(img_h);
            CaptureRect {
                x: 0,
                y: 0,
                width: w,
                height: h,
            }
        });

        if rect.x + rect.width > img_w || rect.y + rect.height > img_h {
            return Err(AppError::Capture(format!(
                "rect {:?} out of image bounds ({}x{})",
                rect, img_w, img_h
            )));
        }

        let cropped = crop_rgba(rgba.as_raw(), img_w, rect.x, rect.y, rect.width, rect.height);
        let png = encode_png(&cropped, rect.width, rect.height)?;
        Ok(CropOutput {
            png_b64: BASE64.encode(&png),
            width: rect.width,
            height: rect.height,
        })
    }
}

/// Subprocess entry: invoked as `rsx-sc-rust crop`.
pub async fn run() -> AppResult<()> {
    run_node_stdio(CropNode).await
}