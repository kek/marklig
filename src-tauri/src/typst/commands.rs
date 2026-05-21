use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;

pub struct TypstState {
    #[allow(dead_code)]
    sessions: Mutex<HashMap<String, ()>>, // placeholder; replaced in C7
}

impl TypstState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TypstState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
pub struct CompileResult {
    pub pages: Vec<String>,
    pub diagnostics: Vec<()>,
    pub elapsed_ms: u32,
}

#[derive(Serialize, thiserror::Error, Debug)]
pub enum TypstError {
    #[error("not implemented")]
    NotImplemented,
}

#[tauri::command]
pub fn typst_open(_path: String) -> Result<String, TypstError> {
    Err(TypstError::NotImplemented)
}

#[tauri::command]
pub fn typst_compile(
    _session_id: String,
    _source: String,
) -> Result<CompileResult, TypstError> {
    Err(TypstError::NotImplemented)
}

#[tauri::command]
pub fn typst_close(_session_id: String) -> Result<(), TypstError> {
    Ok(())
}
