use serde::Serialize;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum FileError {
    #[error("io error: {0}")]
    Io(String),
    #[error("not utf-8: {0}")]
    NotUtf8(String),
    #[error("file too large: {0} bytes")]
    TooLarge(u64),
}

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, FileError> {
    let pb = PathBuf::from(&path);
    let meta = std::fs::metadata(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    if meta.len() > MAX_BYTES {
        return Err(FileError::TooLarge(meta.len()));
    }
    let bytes = std::fs::read(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| FileError::NotUtf8(e.to_string()))
}
