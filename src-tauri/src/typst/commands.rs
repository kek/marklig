//! Tauri invoke handlers: `typst_open`, `typst_compile`, `typst_close`.
//!
//! Session lifecycle:
//! - `typst_open(path)` — reads the entry file, builds a `ViewerWorld`
//!   with system fonts + the default library, stashes the resulting
//!   `TypstSession` under a fresh UUID. Returns the UUID.
//! - `typst_compile(session_id, source)` — overwrites the in-memory main
//!   source with `source`, runs `typst::compile`, returns `CompileResult`
//!   with one SVG per page plus structured diagnostics. **A compile-time
//!   error is NOT a Tauri `Err`** — the frontend always renders pages +
//!   diagnostics together. `Err(TypstError)` is reserved for IO failures,
//!   unknown sessions, and other shell-level problems.
//! - `typst_close(session_id)` — drops the session, freeing fonts/cache.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use ::typst::layout::PagedDocument;

use crate::typst::diagnostics::{to_wire, Diag};
use crate::typst::session::TypstSession;

pub struct TypstState {
    sessions: Mutex<HashMap<String, Arc<TypstSession>>>,
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
    pub diagnostics: Vec<Diag>,
    pub elapsed_ms: u32,
}

#[derive(Serialize, thiserror::Error, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum TypstError {
    #[error("session {0} not found")]
    UnknownSession(String),
    #[error("io: {0}")]
    Io(String),
}

#[tauri::command]
pub fn typst_open(
    state: State<'_, TypstState>,
    path: String,
) -> Result<String, TypstError> {
    let p = PathBuf::from(&path);
    let session =
        TypstSession::open(&p).map_err(|e| TypstError::Io(e.to_string()))?;
    let id = Uuid::new_v4().to_string();
    state.sessions.lock().insert(id.clone(), Arc::new(session));
    Ok(id)
}

#[tauri::command]
pub fn typst_compile(
    state: State<'_, TypstState>,
    session_id: String,
    source: String,
) -> Result<CompileResult, TypstError> {
    let start = std::time::Instant::now();
    // Clone the Arc out under the map lock and release it immediately, so
    // `typst_open` / `typst_close` / other sessions' compiles don't queue
    // behind this potentially-multi-hundred-ms compile call.
    let session = {
        let map = state.sessions.lock();
        map.get(&session_id)
            .ok_or_else(|| TypstError::UnknownSession(session_id.clone()))?
            .clone()
    };
    session.set_source(source);

    let main = session.world.main_source_ref();
    let warned = ::typst::compile::<PagedDocument>(&session.world);
    let mut diagnostics = to_wire(&warned.warnings, &main);
    let pages: Vec<String> = match warned.output {
        Ok(doc) => doc
            .pages
            .iter()
            .map(|p| ::typst_svg::svg(p))
            .collect(),
        Err(errs) => {
            let mut errs_wire = to_wire(&errs, &main);
            errs_wire.append(&mut diagnostics);
            diagnostics = errs_wire;
            Vec::new()
        }
    };

    Ok(CompileResult {
        pages,
        diagnostics,
        elapsed_ms: start.elapsed().as_millis() as u32,
    })
}

#[tauri::command]
pub fn typst_close(state: State<'_, TypstState>, session_id: String) {
    state.sessions.lock().remove(&session_id);
}
