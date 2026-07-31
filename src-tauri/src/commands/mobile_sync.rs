//! Phone-side sync: pulls files from a paired desktop. v2.0-alpha:
//! one-shot pull triggered by a "Sync now" button on the paired-desktop
//! row in the library.
//!
//! Flow:
//! 1. Phone opens ws://<desktop_host>:14200.
//! 2. Sends `{"type":"sync_request","pair_id":"abcd..."}` as a text frame.
//! 3. Desktop responds with a stream of `{"type":"op_put","folder_id_hex":...,
//!    "folder_label":...,"relpath":...,"ciphertext_b64":"..."}` frames.
//! 4. Phone decrypts each blob via marklig-sync-core::envelope::open and
//!    writes the plaintext under `<files_dir>/synced/<pair_id>/<folder_id>/<relpath>`.
//! 5. Desktop ends with `{"type":"sync_done","files":N}`; phone closes.
//!
//! Everything here except `sync_compact` is `#[cfg(mobile)]`. The module is
//! compiled on every target (see `commands/mod.rs`) because `sync_compact` is
//! desktop-only maintenance, but the phone-side commands are wired into the
//! `#[cfg(mobile)]` invoke handler alone — so on a desktop build they had no
//! caller at all and accounted for 10 of the tree's dead-code warnings. The
//! `cfg` is the honest statement of what was already true.

#[cfg(mobile)]
use std::path::PathBuf;

#[cfg(mobile)]
use base64::Engine as _;
#[cfg(mobile)]
use futures_util::{SinkExt, StreamExt};
#[cfg(mobile)]
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
#[cfg(mobile)]
use tauri::Manager;
#[cfg(mobile)]
use tokio_tungstenite::tungstenite::Message;

#[cfg(mobile)]
const WS_PORT: u16 = 14_200;

#[cfg(mobile)]
#[derive(Serialize)]
pub struct MobileSyncResult {
    pub files: u64,
    pub folders: Vec<String>,
}

#[cfg(mobile)]
#[derive(Deserialize)]
pub struct MobileSyncNowArgs {
    pub pair_id_hex: String,
    pub host: String,
}

#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_sync_now<R: Runtime>(
    app: AppHandle<R>,
    args: MobileSyncNowArgs,
) -> Result<MobileSyncResult, String> {
    // Load the pair_key for this paired desktop.
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| e.to_string())?;
    let pairings = store
        .get("mobile.pairings")
        .and_then(|v| v.as_object().cloned())
        .ok_or_else(|| "no pairings stored".to_string())?;
    let entry = pairings
        .get(&args.pair_id_hex)
        .cloned()
        .ok_or_else(|| format!("no such pair_id: {}", args.pair_id_hex))?;
    let pair_key_hex = entry
        .get("pair_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "stored pairing missing pair_key".to_string())?
        .to_string();
    let pair_key = hex_to_32(&pair_key_hex)
        .ok_or_else(|| "stored pair_key is malformed".to_string())?;

    let url = format!("ws://{}:{}", args.host.trim(), WS_PORT);
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    let req = serde_json::json!({
        "type": "sync_request",
        "pair_id": args.pair_id_hex,
    });
    tx.send(Message::Text(req.to_string()))
        .await
        .map_err(|e| format!("send req: {e}"))?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let synced_root: PathBuf = app_data.join("synced").join(&args.pair_id_hex);
    let _ = std::fs::create_dir_all(&synced_root);

    let mut file_count = 0u64;
    let mut folder_labels: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    let mut written: Vec<serde_json::Value> = Vec::new();

    while let Some(msg) = rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => return Err(format!("recv: {e}")),
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Binary(_) => continue,
        };
        let val: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("parse frame: {e}"))?;
        let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "op_put" => {
                let folder_id_hex = val
                    .get("folder_id_hex")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "op_put missing folder_id_hex".to_string())?
                    .to_string();
                let folder_label = val
                    .get("folder_label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("folder")
                    .to_string();
                let relpath = val
                    .get("relpath")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "op_put missing relpath".to_string())?
                    .to_string();
                let ct_b64 = val
                    .get("ciphertext_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "op_put missing ciphertext_b64".to_string())?;
                let ct = base64::engine::general_purpose::STANDARD
                    .decode(ct_b64)
                    .map_err(|e| format!("b64 decode: {e}"))?;

                let folder_id = hex_to_16(&folder_id_hex)
                    .ok_or_else(|| format!("folder_id_hex malformed: {folder_id_hex}"))?;
                let file_key = marklig_sync_core::envelope::derive_file_key(
                    &marklig_sync_core::pair::PairKey(pair_key),
                    &marklig_sync_core::pair::PairId(folder_id),
                    &relpath,
                );
                let plaintext = marklig_sync_core::envelope::open(&file_key, &ct)
                    .map_err(|e| format!("envelope open: {e}"))?;

                let mut target = synced_root.join(&folder_id_hex);
                let _ = std::fs::create_dir_all(&target);
                target.push(&relpath);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&target, &plaintext)
                    .map_err(|e| format!("write {target:?}: {e}"))?;

                folder_labels.insert(folder_id_hex.clone(), folder_label);
                written.push(serde_json::json!({
                    "pair_id_hex": args.pair_id_hex,
                    "folder_id_hex": folder_id_hex,
                    "relpath": relpath,
                    "abs_path": target.to_string_lossy(),
                    "synced_at_unix": now_unix(),
                }));
                file_count += 1;
            }
            "sync_done" => break,
            "error" => {
                let reason = val
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error");
                return Err(format!("desktop rejected: {reason}"));
            }
            _ => {}
        }
    }

    // Persist a flat synced-files index for the library UI to list.
    let mut idx = store
        .get("mobile.synced_files")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let scoped = idx
        .entry(args.pair_id_hex.clone())
        .or_insert_with(|| serde_json::Value::Array(vec![]));
    *scoped = serde_json::Value::Array(written);
    store.set("mobile.synced_files", serde_json::Value::Object(idx));

    // Persist folder labels so the UI can group by folder.
    let mut labels = store
        .get("mobile.synced_folder_labels")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let scoped = labels
        .entry(args.pair_id_hex.clone())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let mut by_id = serde_json::Map::new();
    for (k, v) in &folder_labels {
        by_id.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    *scoped = serde_json::Value::Object(by_id);
    store.set("mobile.synced_folder_labels", serde_json::Value::Object(labels));

    store.save().map_err(|e| e.to_string())?;

    Ok(MobileSyncResult {
        files: file_count,
        folders: folder_labels.values().cloned().collect(),
    })
}

#[cfg(mobile)]
fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(mobile)]
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

#[cfg(mobile)]
fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Apply a single live-sync op from the desktop to phone-side storage.
/// Called by the phone's `SyncClient` for each incoming `op_put` /
/// `op_delete` frame.
#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_apply_sync_op<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder_id_hex: String,
    relpath: String,
    mtime_logical: u64,
    ciphertext_b64: Option<String>,
    kind: String,
) -> Result<(), String> {
    if !pair_id_hex.chars().all(|c| c.is_ascii_hexdigit()) || pair_id_hex.len() != 32 {
        return Err("invalid pair_id_hex".into());
    }
    if !folder_id_hex.chars().all(|c| c.is_ascii_hexdigit()) || folder_id_hex.len() != 32 {
        return Err("invalid folder_id_hex".into());
    }
    for part in relpath.split('/') {
        if part == ".." || part.is_empty() {
            return Err("relpath contains forbidden component".into());
        }
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let synced_root = app_data
        .join("synced")
        .join(&pair_id_hex)
        .join(&folder_id_hex);
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| e.to_string())?;

    match kind.as_str() {
        "put" => {
            let ct_b64 =
                ciphertext_b64.ok_or_else(|| "put op requires ciphertext_b64".to_string())?;
            let ct = base64::engine::general_purpose::STANDARD
                .decode(&ct_b64)
                .map_err(|e| format!("b64 decode: {e}"))?;

            let pairings = store
                .get("mobile.pairings")
                .and_then(|v| v.as_object().cloned())
                .ok_or_else(|| "no pairings stored".to_string())?;
            let entry = pairings
                .get(&pair_id_hex)
                .cloned()
                .ok_or_else(|| format!("no such pair_id: {pair_id_hex}"))?;
            let pair_key_hex = entry
                .get("pair_key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "stored pairing missing pair_key".to_string())?
                .to_string();
            let pair_key = hex_to_32(&pair_key_hex)
                .ok_or_else(|| "stored pair_key malformed".to_string())?;
            let folder_id = hex_to_16(&folder_id_hex)
                .ok_or_else(|| format!("folder_id_hex malformed: {folder_id_hex}"))?;

            let file_key = marklig_sync_core::envelope::derive_file_key(
                &marklig_sync_core::pair::PairKey(pair_key),
                &marklig_sync_core::pair::PairId(folder_id),
                &relpath,
            );
            let plaintext = marklig_sync_core::envelope::open(&file_key, &ct)
                .map_err(|e| format!("envelope open: {e}"))?;

            std::fs::create_dir_all(&synced_root).map_err(|e| e.to_string())?;
            let target = synced_root.join(&relpath);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, &plaintext)
                .map_err(|e| format!("write {target:?}: {e}"))?;

            let mut idx = store
                .get("mobile.synced_files")
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            let scoped = idx
                .entry(pair_id_hex.clone())
                .or_insert_with(|| serde_json::Value::Array(vec![]));
            let mut files: Vec<serde_json::Value> =
                scoped.as_array().cloned().unwrap_or_default();
            files.retain(|f| {
                !(f.get("folder_id_hex").and_then(|v| v.as_str()) == Some(&folder_id_hex)
                    && f.get("relpath").and_then(|v| v.as_str()) == Some(&relpath))
            });
            files.push(serde_json::json!({
                "pair_id_hex": pair_id_hex,
                "folder_id_hex": folder_id_hex,
                "relpath": relpath,
                "abs_path": target.to_string_lossy(),
                "synced_at_unix": now_unix(),
            }));
            *scoped = serde_json::Value::Array(files);
            store.set("mobile.synced_files", serde_json::Value::Object(idx));
            store.save().map_err(|e| e.to_string())?;
        }
        "delete" => {
            let target = synced_root.join(&relpath);
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove {target:?}: {e}")),
            }

            let mut idx = store
                .get("mobile.synced_files")
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            if let Some(scoped) = idx.get_mut(&pair_id_hex) {
                if let Some(files) = scoped.as_array_mut() {
                    files.retain(|f| {
                        !(f.get("folder_id_hex").and_then(|v| v.as_str())
                            == Some(&folder_id_hex)
                            && f.get("relpath").and_then(|v| v.as_str()) == Some(&relpath))
                    });
                }
            }
            store.set("mobile.synced_files", serde_json::Value::Object(idx));
            store.save().map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("unknown op kind: {kind}")),
    }

    let _ = mtime_logical; // cursor advance is done in JS
    Ok(())
}

/// Compact the op log for a single `(pair_id, folder)` — desktop-side
/// maintenance command for settings or diagnostics.
#[cfg(desktop)]
#[tauri::command]
pub async fn sync_compact<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder: String,
) -> Result<(u64, u64), String> {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(&pair_id_hex, &folder);
    let dir = crate::sync_log::sync_dir(&app, &pair_id_hex, &folder_id_hex)?;
    let mut log = marklig_sync_core::ops::OpLog::open(&dir)
        .map_err(|e: marklig_sync_core::ops::SyncError| e.to_string())?;
    let (ops, blobs) = log
        .compact()
        .map_err(|e: marklig_sync_core::ops::SyncError| e.to_string())?;
    Ok((ops as u64, blobs as u64))
}

/// Read a synced file's plaintext from the phone's app-private storage.
///
/// The plugin-fs scope on Android doesn't grant access to arbitrary
/// absolute paths under `/data/user/0/<pkg>/files/...`, so calling
/// `readTextFile(abs_path)` from JS gets rejected. This command does the
/// read on the Rust side, where we control the path strictly: only files
/// inside `<app_data_dir>/synced/<pair_id_hex>/<folder_id_hex>/...` are
/// served, and any traversal-style relpath component (`..`) is refused.
#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_read_synced_file<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder_id_hex: String,
    relpath: String,
) -> Result<String, String> {
    if !pair_id_hex.chars().all(|c| c.is_ascii_hexdigit())
        || pair_id_hex.len() != 32
    {
        return Err("invalid pair_id_hex".into());
    }
    if !folder_id_hex.chars().all(|c| c.is_ascii_hexdigit())
        || folder_id_hex.len() != 32
    {
        return Err("invalid folder_id_hex".into());
    }
    for part in relpath.split('/') {
        if part == ".." || part.is_empty() {
            return Err("relpath contains forbidden component".into());
        }
    }
    if relpath.starts_with('/') {
        return Err("relpath must be relative".into());
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let path = app_data
        .join("synced")
        .join(&pair_id_hex)
        .join(&folder_id_hex)
        .join(&relpath);

    let synced_root = app_data.join("synced").join(&pair_id_hex);
    let canon = std::fs::canonicalize(&path)
        .map_err(|e| format!("canonicalize {path:?}: {e}"))?;
    let canon_root = std::fs::canonicalize(&synced_root)
        .map_err(|e| format!("canonicalize synced root: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err("path escaped synced root".into());
    }

    std::fs::read_to_string(&canon).map_err(|e| format!("read {canon:?}: {e}"))
}

/// Remove a paired desktop from the phone-side store and delete the
/// cached synced files for it.
///
/// Phone-side unpair is local-only by design (see issue #95): the desktop
/// is not notified. The desktop entry becomes stale but harmless — the
/// pair_id is derived deterministically from the static keys, so a future
/// re-pair produces the same id and overwrites cleanly.
///
/// Wipes:
///   - `mobile.pairings[pair_id_hex]`
///   - `mobile.synced_files[pair_id_hex]`
///   - `mobile.synced_folder_labels[pair_id_hex]`
///   - `<app_data>/synced/<pair_id_hex>/` (cached plaintext)
#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_unpair<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
) -> Result<(), String> {
    if !pair_id_hex.chars().all(|c| c.is_ascii_hexdigit())
        || pair_id_hex.len() != 32
    {
        return Err("invalid pair_id_hex".into());
    }

    // Nuke cached plaintext FIRST. A missing dir is fine (nothing was ever
    // synced); other errors are surfaced because they may leak plaintext on
    // disk. We delete before touching the store so that a failed delete
    // leaves the pairing intact in the store rather than stranding the UI on
    // an error screen for a pairing that no longer exists.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let synced_dir = app_data.join("synced").join(&pair_id_hex);
    match std::fs::remove_dir_all(&synced_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove {synced_dir:?}: {e}")),
    }

    // Cache directory is gone — now drop the pairing and its indexes.
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| e.to_string())?;

    for key in [
        "mobile.pairings",
        "mobile.synced_files",
        "mobile.synced_folder_labels",
        "mobile.sync_cursors",
    ] {
        if let Some(mut map) = store.get(key).and_then(|v| v.as_object().cloned()) {
            map.remove(&pair_id_hex);
            store.set(key, serde_json::Value::Object(map));
        }
    }
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}
