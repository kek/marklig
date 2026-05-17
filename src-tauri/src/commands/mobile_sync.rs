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

use std::path::PathBuf;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio_tungstenite::tungstenite::Message;

const WS_PORT: u16 = 14_200;

#[derive(Serialize)]
pub struct MobileSyncResult {
    pub files: u64,
    pub folders: Vec<String>,
}

#[derive(Deserialize)]
pub struct MobileSyncNowArgs {
    pub pair_id_hex: String,
    pub host: String,
}

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

fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
