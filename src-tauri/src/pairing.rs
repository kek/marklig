//! Desktop pairing surface: state machine + registry + Tauri commands.
//!
//! v2.0 scope (this module):
//! - Persistent registry of paired phones in `tauri-plugin-store`.
//! - In-memory [`PairingMachine`] that drives a Noise XK handshake against
//!   `marklig-sync-core`. Step 6 will replace the in-memory channel with a
//!   real TCP socket from the LAN transport.
//! - Tauri commands (start / complete / list / unpair / folder sync
//!   enable / disable) that the frontend uses.
//!
//! **Pair-key persistence shortcut for v2.0-alpha+:** we store the 32-byte
//! pair key inside `tauri-plugin-store`'s `viewer.store.json` (in the app
//! data directory). This is NOT keychain-grade — on macOS the key is
//! readable by any process with disk access to the user's app-data
//! folder. The proper fix (macOS Keychain Services, Windows Credential
//! Manager, libsecret on Linux) is a follow-up; it's flagged here and in
//! the spec / plan. v2.0-alpha is opt-in pairing for early users; the
//! threat model assumes a user-controlled laptop.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use marklig_sync_core::pair::{
    HandshakeError, HandshakeInitiator, HandshakeResponder, PairKey, QrPayload, TransportPair,
};

/// Persisted metadata for one paired phone. Stored as
/// `pairings.<pair_id_hex>` in `viewer.store.json`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PairingMeta {
    pub pair_id_hex: String,
    pub friendly_name: String,
    pub paired_at_unix: u64,
    pub last_seen_at_unix: u64,
    /// First 4 bytes of BLAKE2s-style hash of the pair_key, formatted as
    /// "XX-YY-ZZ" hex pairs. Shown to the user during handshake confirm
    /// so both sides can read it aloud.
    pub verification_fingerprint: String,
    pub synced_folders: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PairingStarted {
    pub qr_payload: String,
    pub verification_fingerprint: String,
}

/// In-progress handshake state held in [`PairingState`]. After
/// `pairing_complete(confirm=true)` it becomes a registered pairing.
enum HandshakeStage {
    Idle,
    Responding {
        responder: Box<HandshakeResponder>,
        mdns_instance_name: String,
        qr_payload: String,
    },
    Verifying {
        result: Box<TransportPair>,
    },
}

impl HandshakeStage {
    fn take(&mut self) -> HandshakeStage {
        std::mem::replace(self, HandshakeStage::Idle)
    }
}

/// Per-app singleton holding the current desktop static keypair + the
/// in-progress handshake. Mounted on the Tauri builder via `.manage()`.
pub struct PairingState {
    /// The desktop's long-term static keypair. Generated on first call to
    /// [`PairingState::ensure_keys`], persisted in the store.
    static_keypair: Mutex<Option<StaticKeypair>>,
    stage: Mutex<HandshakeStage>,
}

#[derive(Clone)]
struct StaticKeypair {
    private: [u8; 32],
    public: [u8; 32],
}

impl PairingState {
    pub fn new() -> Self {
        Self {
            static_keypair: Mutex::new(None),
            stage: Mutex::new(HandshakeStage::Idle),
        }
    }
}

impl Default for PairingState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("handshake: {0}")]
    Handshake(#[from] HandshakeError),
    #[error("state error: {0}")]
    State(String),
    #[error("storage error: {0}")]
    Storage(String),
}

impl serde::Serialize for PairingError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

const STORE_KEY_KEYPAIR: &str = "pairing.desktop_static_keypair";
const STORE_KEY_PAIRINGS: &str = "pairings";

/// Generate (or load) the desktop's static keypair. Persisted in the
/// Tauri store at `pairing.desktop_static_keypair`. See module-level note
/// on the v2.0-alpha persistence shortcut.
fn ensure_keypair<R: Runtime>(
    app: &AppHandle<R>,
    state: &PairingState,
) -> Result<StaticKeypair, PairingError> {
    let mut guard = state.static_keypair.lock().map_err(|e| {
        PairingError::State(format!("static_keypair lock poisoned: {e}"))
    })?;
    if let Some(kp) = guard.as_ref() {
        return Ok(kp.clone());
    }

    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    if let Some(value) = store.get(STORE_KEY_KEYPAIR) {
        if let Some(obj) = value.as_object() {
            let priv_hex = obj.get("private").and_then(|v| v.as_str()).unwrap_or("");
            let pub_hex = obj.get("public").and_then(|v| v.as_str()).unwrap_or("");
            if let (Some(priv_bytes), Some(pub_bytes)) =
                (decode_hex_32(priv_hex), decode_hex_32(pub_hex))
            {
                let kp = StaticKeypair {
                    private: priv_bytes,
                    public: pub_bytes,
                };
                *guard = Some(kp.clone());
                return Ok(kp);
            }
        }
    }

    let builder = snow::Builder::new(
        "Noise_XK_25519_ChaChaPoly_BLAKE2s"
            .parse()
            .expect("Noise XK pattern parses"),
    );
    let snow_kp = builder
        .generate_keypair()
        .map_err(|e| PairingError::State(format!("keypair gen: {e}")))?;
    let mut private = [0u8; 32];
    let mut public = [0u8; 32];
    private.copy_from_slice(&snow_kp.private);
    public.copy_from_slice(&snow_kp.public);

    store.set(
        STORE_KEY_KEYPAIR,
        serde_json::json!({
            "private": encode_hex(&private),
            "public": encode_hex(&public),
        }),
    );
    store
        .save()
        .map_err(|e| PairingError::Storage(e.to_string()))?;

    let kp = StaticKeypair { private, public };
    *guard = Some(kp.clone());
    Ok(kp)
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
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

/// Compute a 4-byte verification fingerprint from a pair key, formatted as
/// "AB-CD-EF-12" — short enough for two humans to read aloud.
fn verification_fingerprint(pair_key: &PairKey) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(&pair_key.0);
    format!("{:02X}-{:02X}-{:02X}-{:02X}", h[0], h[1], h[2], h[3])
}

fn mdns_instance_name() -> String {
    // Hostname-derived, sanitized to mDNS-safe ASCII.
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "marklig".to_string());
    let mut out = String::new();
    for ch in host.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
        }
    }
    if out.is_empty() {
        out.push_str("marklig");
    }
    format!("marklig-{}", out)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn pairing_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PairingState>,
) -> Result<PairingStarted, PairingError> {
    let kp = ensure_keypair(&app, state.inner())?;
    let instance = mdns_instance_name();
    let host = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let payload = QrPayload {
        responder_static_pubkey: kp.public,
        host,
        mdns_instance_name: instance.clone(),
        expiry_unix: now_unix() + 300,
    };
    let qr = payload.encode();

    // Arm the WebSocket server so the next inbound connection drives a
    // handshake against our static private key. The private key never
    // crosses the IPC boundary — it lives in the WS server state held by
    // the Rust process.
    crate::pairing_ws::arm(&app, kp.private)
        .map_err(|e| PairingError::State(format!("arm WS: {e}")))?;

    Ok(PairingStarted {
        qr_payload: qr,
        // Verification fingerprint is computed from the eventual pair
        // key, which we don't have until the handshake completes. The
        // frontend listens for `pairing:paired` events to learn the
        // final fingerprint.
        verification_fingerprint: String::new(),
    })
}

#[tauri::command]
pub fn pairing_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PairingState>,
) -> Result<(), PairingError> {
    let mut stage = state.stage.lock().map_err(|e| {
        PairingError::State(format!("stage lock poisoned: {e}"))
    })?;
    *stage = HandshakeStage::Idle;
    let _ = crate::pairing_ws::disarm(&app);
    Ok(())
}

#[tauri::command]
pub fn pairing_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<PairingMeta>, PairingError> {
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let value = match store.get(STORE_KEY_PAIRINGS) {
        Some(v) => v,
        None => return Ok(vec![]),
    };
    let map = match value.as_object() {
        Some(m) => m.clone(),
        None => return Ok(vec![]),
    };
    let mut out = Vec::with_capacity(map.len());
    for (_, v) in map {
        if let Ok(meta) = serde_json::from_value::<PairingMeta>(v) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| b.paired_at_unix.cmp(&a.paired_at_unix));
    Ok(out)
}

#[tauri::command]
pub fn pairing_unpair<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
) -> Result<(), PairingError> {
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let mut map = store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    // Load meta before removal to iterate synced_folders for teardown.
    let meta: Option<PairingMeta> = map
        .get(&pair_id_hex)
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    map.remove(&pair_id_hex);
    store.set(STORE_KEY_PAIRINGS, serde_json::Value::Object(map));
    store.save().map_err(|e| PairingError::Storage(e.to_string()))?;

    if let Some(meta) = meta {
        for folder in &meta.synced_folders {
            let _ = crate::sync_log::teardown_folder(&app, &pair_id_hex, folder);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn folder_sync_enable<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder: String,
) -> Result<(), PairingError> {
    update_pairing(&app, &pair_id_hex, |meta| {
        add_synced_folder(&mut meta.synced_folders, &folder);
    })?;
    if let Err(e) = crate::sync_log::seed_folder(&app, &pair_id_hex, &folder) {
        eprintln!("sync seed {folder}: {e}");
    }
    Ok(())
}

/// Add `folder` to a pairing's synced set, canonicalizing first so the same
/// folder reached by different spellings never produces a duplicate entry.
/// See issue #99.
pub(crate) fn add_synced_folder(folders: &mut Vec<String>, folder: &str) {
    let canonical = crate::commands::files::canonicalize_path_str(folder);
    if !folders.iter().any(|f| f == &canonical) {
        folders.push(canonical);
    }
}

/// Remove `folder` from a pairing's synced set. Canonicalizes the argument so a
/// caller passing a different spelling (e.g. a symlink) than the one stored at
/// enable time still matches and removes the entry. See issue #99.
pub(crate) fn remove_synced_folder(folders: &mut Vec<String>, folder: &str) {
    let canonical = crate::commands::files::canonicalize_path_str(folder);
    folders.retain(|f| f != &canonical);
}

#[tauri::command]
pub fn folder_sync_disable<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder: String,
) -> Result<(), PairingError> {
    update_pairing(&app, &pair_id_hex, |meta| {
        remove_synced_folder(&mut meta.synced_folders, &folder);
    })?;
    let _ = crate::sync_log::teardown_folder(&app, &pair_id_hex, &folder);
    Ok(())
}

fn update_pairing<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    f: impl FnOnce(&mut PairingMeta),
) -> Result<(), PairingError> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let mut map = store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let entry = map
        .entry(pair_id_hex.to_string())
        .or_insert_with(|| serde_json::Value::Null);
    let mut meta: PairingMeta = if entry.is_null() {
        return Err(PairingError::State(format!(
            "no such pairing: {pair_id_hex}"
        )));
    } else {
        serde_json::from_value(entry.clone())
            .map_err(|e| PairingError::Storage(format!("decode pairing: {e}")))?
    };
    // PRESERVE pair_key_hex across the deserialize → mutate → reserialize
    // cycle. PairingMeta doesn't declare the field (and shouldn't — it's
    // sent to the JS frontend via pairing_list and the 32-byte key must
    // not leak through IPC), so serde_json::to_value(&meta) drops it.
    // Without this fence, calling folder_sync_enable / folder_sync_disable
    // silently destroys the key and subsequent sync requests fail with
    // "pair key missing — re-pair".
    let preserved_pair_key_hex = entry
        .get("pair_key_hex")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    f(&mut meta);
    let mut next = serde_json::to_value(&meta)
        .map_err(|e| PairingError::Storage(format!("encode pairing: {e}")))?;
    if let (Some(obj), Some(k)) = (next.as_object_mut(), preserved_pair_key_hex) {
        obj.insert("pair_key_hex".to_string(), serde_json::Value::String(k));
    }
    *entry = next;
    store.set(STORE_KEY_PAIRINGS, serde_json::Value::Object(map));
    store
        .save()
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    Ok(())
}

/// Helper used by the in-memory loopback test in step-5 unit tests and by
/// the LAN transport (step 6) to commit a completed handshake into the
/// persistent registry.
pub fn finalize_pairing<R: Runtime>(
    app: &AppHandle<R>,
    transport: TransportPair,
    friendly_name: String,
) -> Result<PairingMeta, PairingError> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let pair_id_hex = transport.pair_id.to_hex();
    let now = now_unix();
    let meta = PairingMeta {
        pair_id_hex: pair_id_hex.clone(),
        friendly_name,
        paired_at_unix: now,
        last_seen_at_unix: now,
        verification_fingerprint: verification_fingerprint(&transport.pair_key),
        synced_folders: Vec::new(),
    };
    let mut map = store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    // Persist the pair_key alongside the meta so the sync engine can
    // derive per-file keys later. v2.0-alpha shortcut: key bytes live in
    // tauri-plugin-store rather than the OS keychain. Documented at the
    // module level.
    let mut entry = serde_json::to_value(&meta)
        .map_err(|e| PairingError::Storage(format!("encode pairing: {e}")))?;
    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "pair_key_hex".to_string(),
            serde_json::Value::String(encode_hex(&transport.pair_key.0)),
        );
    }
    map.insert(pair_id_hex, entry);
    store.set(STORE_KEY_PAIRINGS, serde_json::Value::Object(map));
    store
        .save()
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    Ok(meta)
}

/// Load a paired phone's pair_key from the registry by pair_id_hex.
/// Returns None if no such pairing exists or the entry doesn't have a
/// stored pair_key (e.g. it was created before v2.0-alpha-sync landed).
pub fn load_pair_key<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
) -> Result<Option<[u8; 32]>, PairingError> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let map = store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let entry = match map.get(pair_id_hex) {
        Some(v) => v.clone(),
        None => return Ok(None),
    };
    let hex = entry
        .get("pair_key_hex")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(hex.and_then(|h| decode_hex_32(&h)))
}

/// Return all registered pairings. Used at startup for reconciliation.
pub fn list_all_pairings<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<PairingMeta>, PairingError> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let obj = match store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
    {
        Some(o) => o,
        None => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for v in obj.values() {
        if let Ok(meta) = serde_json::from_value::<PairingMeta>(v.clone()) {
            out.push(meta);
        }
    }
    Ok(out)
}

/// Load the full meta for a single pair_id, including synced_folders.
pub fn load_pairing<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
) -> Result<Option<PairingMeta>, PairingError> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| PairingError::Storage(e.to_string()))?;
    let map = store
        .get(STORE_KEY_PAIRINGS)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let entry = match map.get(pair_id_hex) {
        Some(v) => v.clone(),
        None => return Ok(None),
    };
    let meta: PairingMeta = serde_json::from_value(entry)
        .map_err(|e| PairingError::Storage(format!("decode pairing: {e}")))?;
    Ok(Some(meta))
}

// Suppress unused-warning for the in-progress handshake fields that the
// LAN transport (step 6) will start consuming.
#[allow(dead_code)]
impl PairingState {
    pub(crate) fn stage_for_test(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HandshakeStage>, PairingError> {
        self.stage
            .lock()
            .map_err(|e| PairingError::State(format!("stage lock: {e}")))
    }
}

#[allow(dead_code)]
fn drive_initiator_against_responder(
    initiator: &mut HandshakeInitiator,
    responder: &mut HandshakeResponder,
) -> Result<(), HandshakeError> {
    let mut buf = Vec::new();
    initiator.write_message(&mut buf)?;
    responder.read_message(&buf)?;
    buf.clear();
    responder.write_message(&mut buf)?;
    initiator.read_message(&buf)?;
    buf.clear();
    initiator.write_message(&mut buf)?;
    responder.read_message(&buf)?;
    Ok(())
}

#[cfg(test)]
mod synced_folder_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_tempdir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "marklig-pairing-test-{}-{}-{}",
            label,
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create tempdir");
        path
    }

    #[test]
    fn add_synced_folder_stores_canonical_path_and_dedups() {
        let base = unique_tempdir("add");
        let real = base.join("proj");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("proj-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let canonical = std::fs::canonicalize(&real)
            .unwrap()
            .to_string_lossy()
            .to_string();

        let mut folders: Vec<String> = Vec::new();
        add_synced_folder(&mut folders, &real.to_string_lossy());
        // Adding the same folder via its symlinked spelling must not create
        // a second entry — same folder, same identity.
        add_synced_folder(&mut folders, &link.to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(folders, vec![canonical]);
    }

    #[test]
    fn remove_synced_folder_matches_symlinked_spelling() {
        // The folder was enabled via its real path (canonical), then the UI
        // hands `folder_sync_disable` a different spelling (e.g. a symlink).
        // Disable must canonicalize too, or the entry can never be removed.
        let base = unique_tempdir("remove");
        let real = base.join("proj");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("proj-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut folders: Vec<String> = Vec::new();
        add_synced_folder(&mut folders, &real.to_string_lossy());
        assert_eq!(folders.len(), 1);

        remove_synced_folder(&mut folders, &link.to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);

        assert!(
            folders.is_empty(),
            "disable should canonicalize the arg and remove the matching entry"
        );
    }
}
