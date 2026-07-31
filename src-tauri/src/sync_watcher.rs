//! Per-folder watcher for synced folders. One `notify-debouncer-full`
//! watcher per distinct folder path (shared across pairs); on events it
//! appends an op to each interested pair's OpLog and fans the serialised
//! frame out to `SyncSessionRegistry`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use tauri::{AppHandle, Manager, Runtime};

use marklig_sync_core::ops::{LamportClock, OpLog};

struct FolderEntry {
    pair_ids: Vec<String>,
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::FileIdMap,
    >,
}

pub struct SyncWatcherState {
    inner: Mutex<HashMap<String, FolderEntry>>,
}

impl SyncWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Start watching `folder` for `pair_id_hex`, or register the pair on an
    /// already-running watcher.
    pub fn register<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pair_id_hex: &str,
        folder: &str,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;

        if let Some(entry) = guard.get_mut(folder) {
            if !entry.pair_ids.contains(&pair_id_hex.to_string()) {
                entry.pair_ids.push(pair_id_hex.to_string());
            }
            return Ok(());
        }

        let app_clone = app.clone();
        let folder_str = folder.to_string();
        let pair_id_owned = pair_id_hex.to_string();

        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                let events = match result {
                    Ok(e) => e,
                    Err(_) => return,
                };

                // Collect pair_ids under lock, then release before processing.
                let pair_ids: Vec<String> = {
                    match app_clone.try_state::<Arc<SyncWatcherState>>() {
                        Some(state) => match state.inner.lock() {
                            Ok(guard) => match guard.get(&folder_str) {
                                Some(e) => e.pair_ids.clone(),
                                None => return,
                            },
                            Err(_) => return,
                        },
                        None => return,
                    }
                };

                for ev in &events {
                    for path in &ev.paths {
                        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
                            continue;
                        };
                        if !matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "md" | "markdown" | "mdx" | "mdown"
                        ) {
                            continue;
                        }

                        let Some(relpath) = path
                            .strip_prefix(&folder_str)
                            .ok()
                            .and_then(|p| p.to_str())
                            .map(|s| s.trim_start_matches('/').to_string())
                        else {
                            continue;
                        };
                        if relpath.is_empty() {
                            continue;
                        }

                        let is_remove = matches!(ev.kind, notify::EventKind::Remove(_));

                        for pid in &pair_ids {
                            handle_file_event(&app_clone, pid, &folder_str, &relpath, is_remove);
                        }
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;

        debouncer
            .watcher()
            .watch(&PathBuf::from(folder), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        guard.insert(
            folder.to_string(),
            FolderEntry {
                pair_ids: vec![pair_id_hex.to_string()],
                _debouncer: debouncer,
            },
        );
        let _ = pair_id_owned; // consumed above
        Ok(())
    }

    /// Remove a pair from a folder's watcher. Stops the watcher if no pairs remain.
    pub fn unregister(&self, pair_id_hex: &str, folder: &str) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(entry) = guard.get_mut(folder) {
            entry.pair_ids.retain(|p| p != pair_id_hex);
            if entry.pair_ids.is_empty() {
                guard.remove(folder);
            }
        }
    }
}

impl Default for SyncWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

fn handle_file_event<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
    relpath: &str,
    is_remove: bool,
) {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let Ok(dir) = crate::sync_log::sync_dir(app, pair_id_hex, &folder_id_hex) else {
        return;
    };
    let Ok(mut log) = OpLog::open(&dir) else {
        return;
    };
    let Ok(max) = log.max_mtime() else {
        return;
    };
    let mut clock = LamportClock::from(max);

    let frame = if is_remove {
        match log.append_delete(relpath, &mut clock) {
            Ok(op) => serde_json::json!({
                "type": "op_delete",
                "folder_id_hex": folder_id_hex,
                "relpath": op.relpath,
                "mtime_logical": op.mtime_logical,
            }),
            Err(_) => return,
        }
    } else {
        let Some(pair_key) = crate::pairing::load_pair_key(app, pair_id_hex)
            .ok()
            .flatten()
        else {
            return;
        };
        let Some(folder_id) = hex_to_16(&folder_id_hex) else {
            return;
        };
        let Some(contents) = crate::pairing_ws::read_markdown_file(folder, relpath) else {
            return;
        };
        let file_key = marklig_sync_core::derive_file_key(
            &marklig_sync_core::pair::PairKey(pair_key),
            &marklig_sync_core::pair::PairId(folder_id),
            relpath,
        );
        match log.append_put(relpath, contents.as_bytes(), &file_key, &mut clock) {
            Ok(Some(op)) => {
                let Some(ref_hex) = &op.ciphertext_ref_hex else {
                    return;
                };
                let Some(ct) = log.read_blob(ref_hex) else {
                    return;
                };
                serde_json::json!({
                    "type": "op_put",
                    "folder_id_hex": folder_id_hex,
                    "relpath": op.relpath,
                    "mtime_logical": op.mtime_logical,
                    "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ct),
                })
            }
            Ok(None) => return, // dedup
            Err(_) => return,
        }
    };

    // Fan out to connected sessions for this pair. SyncSessionRegistry is
    // managed in Task 4 — guard with try_state so this compiles now.
    if let Some(registry) = app.try_state::<Arc<crate::sync_session::SyncSessionRegistry>>() {
        registry.push(pair_id_hex, frame);
    }
}

fn hex_to_16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
