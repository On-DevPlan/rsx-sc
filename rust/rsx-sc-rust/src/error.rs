//! 错误类型。手动实现 Display / From（不依赖 thiserror），让编译时间与
//! 二进制体积都比 tauri2 的实现更小。
//!
//! Serialize 形态与 tauri2 一致：直接序列化为错误字符串 —— 给 Node 端的
//! 错误提示已经够用，避免为每个 variant 单独定义序列化字段。
use serde::{Serialize, Serializer};

#[derive(Debug)]
pub enum AppError {
    Capture(String),
    Image(image::ImageError),
    Io(std::io::Error),
    Json(serde_json::Error),
    Base64(base64::DecodeError),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Capture(msg) => write!(f, "capture error: {msg}"),
            AppError::Image(e) => write!(f, "image error: {e}"),
            AppError::Io(e) => write!(f, "io error: {e}"),
            AppError::Json(e) => write!(f, "json error: {e}"),
            AppError::Base64(e) => write!(f, "base64 error: {e}"),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Capture(_) => None,
            AppError::Image(e) => Some(e),
            AppError::Io(e) => Some(e),
            AppError::Json(e) => Some(e),
            AppError::Base64(e) => Some(e),
        }
    }
}

impl From<image::ImageError> for AppError {
    fn from(value: image::ImageError) -> Self {
        AppError::Image(value)
    }
}
impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value)
    }
}
impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Json(value)
    }
}
impl From<base64::DecodeError> for AppError {
    fn from(value: base64::DecodeError) -> Self {
        AppError::Base64(value)
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;