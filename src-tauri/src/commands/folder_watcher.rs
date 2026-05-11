use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

use super::files::is_ignored;

#[derive(Debug, Serialize, Clone)]
pub struct FolderWatcherEvent {
    pub root: String,
}

/// Per-window recursive directory watcher. Distinct from the file watcher in
/// `watcher.rs`: that one is per-document and non-recursive; this one is per
/// open project tree and recursive, used to refresh the folder sidebar when
/// files appear or disappear.
pub struct FolderWatcherState {
    inner: Mutex<HashMap<String, FolderWatcherInner>>,
}

struct FolderWatcherInner {
    #[allow(dead_code)]
    root: PathBuf,
    _debouncer:
        notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>,
}

impl FolderWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

/// True when any path component (relative to the watched root) is a directory
/// the tree walker would skip — node_modules, .git, target, .cache, etc.
/// Filtering events here saves the frontend from a refresh storm whenever a
/// build tool churns through generated files.
fn path_is_ignored(root: &Path, p: &Path) -> bool {
    let rel = match p.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    rel.components().any(|c| {
        if let std::path::Component::Normal(os) = c {
            if let Some(s) = os.to_str() {
                return is_ignored(s);
            }
        }
        false
    })
}

#[tauri::command]
pub fn folder_watcher_start(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, FolderWatcherState>,
    root: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {}", root));
    }
    let label = window.label().to_string();
    let label_for_handler = label.clone();
    let app_for_handler = app.clone();
    let root_for_handler = root_path.clone();
    let root_str_for_handler = root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let events = match result {
                Ok(ev) => ev,
                Err(_) => return,
            };
            let mut relevant = false;
            'outer: for ev in &events {
                for p in &ev.paths {
                    if !path_is_ignored(&root_for_handler, p) {
                        relevant = true;
                        break 'outer;
                    }
                }
            }
            if !relevant {
                return;
            }
            // Target the originating window only so other windows watching
            // different roots don't get spurious refreshes.
            let _ = app_for_handler.emit_to(
                label_for_handler.as_str(),
                "viewer://folder-changed",
                FolderWatcherEvent {
                    root: root_str_for_handler.clone(),
                },
            );
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // Replace any prior watcher for this window; dropping the previous
    // debouncer cancels the underlying notify::Watcher.
    guard.insert(
        label,
        FolderWatcherInner {
            root: root_path,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn folder_watcher_stop(
    window: Window,
    state: tauri::State<'_, FolderWatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.remove(window.label());
    Ok(())
}
