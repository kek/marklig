use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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

pub struct WatcherState {
    inner: Mutex<Option<WatcherInner>>,
}

struct WatcherInner {
    target: PathBuf,
    self_write_ts: Option<Instant>,
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl WatcherState {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(500);

#[tauri::command]
pub fn watcher_start(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?
        .to_path_buf();
    let target_for_handler = target.clone();
    let app_for_handler = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            let events = match result { Ok(ev) => ev, Err(_) => return };
            for ev in events {
                if ev.path != target_for_handler {
                    continue;
                }
                // Self-write filter: if we wrote within the window, suppress.
                // We emit anyway and let the JS-side filter make the final call,
                // because access to the Mutex from inside this closure would
                // deadlock if the user's save-and-reload cycle is racing.
                let kind = match ev.kind {
                    DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous => {
                        WatcherEventKind::Modified
                    }
                    _ => WatcherEventKind::Modified,
                };
                let _ = app_for_handler.emit(
                    "viewer://file-changed",
                    WatcherEvent {
                        kind,
                        path: ev.path.to_string_lossy().to_string(),
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
    *guard = Some(WatcherInner {
        target,
        self_write_ts: None,
        _debouncer: debouncer,
    });
    Ok(())
}

#[tauri::command]
pub fn watcher_stop(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn watcher_mark_self_write(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut inner) = *guard {
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
