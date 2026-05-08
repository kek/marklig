use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
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

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), FileError> {
    let pb = std::path::PathBuf::from(&path);
    std::fs::write(&pb, contents.as_bytes()).map_err(|e| FileError::Io(e.to_string()))
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct RecoveryEntry {
    pub original_path: String,
    pub contents: String,
    pub timestamp_ms: i64,
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, FileError> {
    let app_dir = app.path().app_data_dir().map_err(|e| FileError::Io(e.to_string()))?;
    let dir = app_dir.join("recovery");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(dir)
}

fn slug_for(path: &str) -> String {
    let mut s = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() { s.push(c); }
        else { s.push('_'); }
    }
    s
}

#[tauri::command]
pub fn write_recovery(
    app: tauri::AppHandle,
    original_path: String,
    contents: String,
) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let entry = RecoveryEntry {
        original_path,
        contents,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
    };
    let json = serde_json::to_vec(&entry).map_err(|e| FileError::Io(e.to_string()))?;
    std::fs::write(dir.join(format!("{}.json", slug)), json)
        .map_err(|e| FileError::Io(e.to_string()))
}

#[tauri::command]
pub fn read_all_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, FileError> {
    let dir = recovery_dir(&app)?;
    let mut out = Vec::new();
    if !dir.exists() { return Ok(out); }
    for entry in std::fs::read_dir(&dir).map_err(|e| FileError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| FileError::Io(e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let bytes = std::fs::read(&path).map_err(|e| FileError::Io(e.to_string()))?;
        if let Ok(rec) = serde_json::from_slice::<RecoveryEntry>(&bytes) {
            out.push(rec);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle, original_path: String) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let path = dir.join(format!("{}.json", slug));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(())
}
