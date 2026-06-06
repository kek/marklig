//! Desktop-side helpers for maintaining an `OpLog` per synced folder.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use marklig_sync_core::ops::{LamportClock, OpKind, OpLog, SyncError};

/// `<app_data>/sync/<pair_id_hex>/<folder_id_hex>/`
pub fn sync_dir<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder_id_hex: &str,
) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data.join("sync").join(pair_id_hex).join(folder_id_hex))
}

/// Seed a newly-enabled folder: walk all `.md` files and append Put ops.
/// Returns the number of ops written.
pub fn seed_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<u64, String> {
    use marklig_sync_core::pair::{PairId, PairKey};

    let pair_key = crate::pairing::load_pair_key(app, pair_id_hex)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no pair key for {pair_id_hex}"))?;
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let folder_id = hex_to_16(&folder_id_hex)
        .ok_or_else(|| "folder_id malformed".to_string())?;
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    let mut log = OpLog::open(&dir).map_err(|e: SyncError| e.to_string())?;
    let max = log.max_mtime().map_err(|e: SyncError| e.to_string())?;
    let mut clock = LamportClock::from(max);
    let mut count = 0u64;

    for (relpath, contents) in crate::pairing_ws::walk_markdown(folder) {
        let file_key = marklig_sync_core::derive_file_key(
            &PairKey(pair_key),
            &PairId(folder_id),
            &relpath,
        );
        if log
            .append_put(&relpath, contents.as_bytes(), &file_key, &mut clock)
            .map_err(|e: SyncError| e.to_string())?
            .is_some()
        {
            count += 1;
        }
    }
    Ok(count)
}

/// Startup drift reconciliation: diff current FS against the log's
/// head-state. Returns `(puts, deletes)`.
pub fn reconcile_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<(u64, u64), String> {
    use marklig_sync_core::pair::{PairId, PairKey};
    use sha2::{Digest, Sha256};

    let pair_key = crate::pairing::load_pair_key(app, pair_id_hex)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no pair key for {pair_id_hex}"))?;
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let folder_id = hex_to_16(&folder_id_hex)
        .ok_or_else(|| "folder_id malformed".to_string())?;
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    let mut log = OpLog::open(&dir).map_err(|e: SyncError| e.to_string())?;
    let max = log.max_mtime().map_err(|e: SyncError| e.to_string())?;
    let mut clock = LamportClock::from(max);
    let head = log.head_state().map_err(|e: SyncError| e.to_string())?;

    let fs_files: std::collections::HashMap<String, String> =
        crate::pairing_ws::walk_markdown(folder).into_iter().collect();

    let mut puts = 0u64;
    let mut deletes = 0u64;

    // New or changed
    for (relpath, contents) in &fs_files {
        let digest = Sha256::digest(contents.as_bytes());
        let hash_hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
        let needs_put = match head.get(relpath) {
            Some(op) if op.kind == OpKind::Put => op.hash_hex != hash_hex,
            _ => true,
        };
        if needs_put {
            let file_key = marklig_sync_core::derive_file_key(
                &PairKey(pair_key),
                &PairId(folder_id),
                relpath,
            );
            if log
                .append_put(relpath, contents.as_bytes(), &file_key, &mut clock)
                .map_err(|e: SyncError| e.to_string())?
                .is_some()
            {
                puts += 1;
            }
        }
    }

    // Removed from FS
    for (relpath, op) in &head {
        if op.kind == OpKind::Put && !fs_files.contains_key(relpath) {
            log.append_delete(relpath, &mut clock)
                .map_err(|e: SyncError| e.to_string())?;
            deletes += 1;
        }
    }

    Ok((puts, deletes))
}

/// Delete the op log and blob store for one `(pair_id, folder)` tuple.
pub fn teardown_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<(), String> {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("teardown {dir:?}: {e}")),
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
