use notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Window};

#[derive(Debug, Serialize, Clone)]
pub struct WatcherEvent {
    pub kind: WatcherEventKind,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum WatcherEventKind {
    Modified,
    Removed,
}

/// Per-window watcher map. Each viewer window owns at most one active watcher
/// (for its current file). Keying by window.label() means File -> New Window
/// can edit a different file with its own watcher and reconciliation flow,
/// instead of stomping the previous window's watcher state.
pub struct WatcherState {
    inner: Mutex<HashMap<String, WatcherInner>>,
}

struct WatcherInner {
    /// Kept for diagnostic/tracing purposes — surfaced via the optional
    /// debug command and also used as the source of truth for what the
    /// watcher is currently watching when reconciling state.
    #[allow(dead_code)]
    target: PathBuf,
    self_write_ts: Option<Instant>,
    _debouncer:
        notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(500);

#[tauri::command]
pub fn watcher_start(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?
        .to_path_buf();
    let target_for_handler = target.clone();
    let label = window.label().to_string();
    let app_for_handler = app.clone();
    let label_for_handler = label.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let events = match result {
                Ok(ev) => ev,
                Err(_) => return,
            };
            for ev in events {
                let touches_target = ev.paths.iter().any(|p| p == &target_for_handler);
                if !touches_target {
                    continue;
                }
                let kind = match ev.kind {
                    EventKind::Remove(_) => WatcherEventKind::Removed,
                    _ => WatcherEventKind::Modified,
                };
                // Target the originating window only — broadcasting would let
                // window A react to window B's file-change events.
                let _ = app_for_handler.emit_to(
                    label_for_handler.as_str(),
                    "viewer://file-changed",
                    WatcherEvent {
                        kind,
                        path: target_for_handler.to_string_lossy().to_string(),
                    },
                );
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // Drop any prior watcher for this window; the debouncer is held in a
    // box and dropping it cancels the underlying notify::Watcher.
    guard.insert(
        label,
        WatcherInner {
            target,
            self_write_ts: None,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn watcher_stop(
    window: Window,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.remove(window.label());
    Ok(())
}

#[tauri::command]
pub fn watcher_mark_self_write(
    window: Window,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(inner) = guard.get_mut(window.label()) {
        inner.self_write_ts = Some(Instant::now());
    }
    Ok(())
}

#[allow(dead_code)]
fn _is_within_self_write_window(ts: Option<Instant>) -> bool {
    match ts {
        Some(t) => Instant::now().duration_since(t) < SELF_WRITE_WINDOW,
        None => false,
    }
}
