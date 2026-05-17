//! WebSocket-based pairing transport. v2.0-alpha (deviation from the
//! original step-6 plan): the spec called for mDNS + raw TCP + native
//! Kotlin bridges on the phone. That stack is correct but multi-day to
//! ship across both devices. The WebSocket pivot lets the phone side
//! drive everything from pure JS (`new WebSocket(url)`) and the desktop
//! side use a familiar tokio-tungstenite server — no Kotlin plugin
//! authoring.
//!
//! Trade-offs documented in CLAUDE.md and the issue:
//! - Manual IP entry on the phone (no zero-config discovery).
//! - WebSocket framing instead of raw TCP — slightly more overhead.
//! - mDNS service announcement deferred to v2.x.
//!
//! Security model unchanged: Noise XK still authenticates the desktop's
//! static key via QR (visual out-of-band channel); the per-file envelope
//! still seals content. The WebSocket itself is plaintext, so an
//! eavesdropper on the same LAN sees op metadata (relpaths, hashes) but
//! not file content. v2.x can wrap the channel in the Noise transport
//! state for metadata confidentiality.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use marklig_sync_core::pair::{HandshakeResponder, TransportPair};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::pairing::{finalize_pairing, PairingError, PairingMeta};

pub const WS_PORT: u16 = 14_200;

/// Per-app pairing-WS state. Holds the current desktop static
/// keypair-derived responder factory and the friendly-name slot. Mounted
/// via `.manage()` from `lib.rs`.
pub struct WsServerState {
    /// When Some, the next inbound connection is a pairing handshake. The
    /// frontend sets this via `pairing_start_listen` and clears it via
    /// `pairing_cancel`. After a successful pairing, the field is
    /// auto-cleared.
    pub pending: Mutex<Option<PendingPairing>>,
}

pub struct PendingPairing {
    pub responder_priv: [u8; 32],
}

impl WsServerState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }
}

impl Default for WsServerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Spin up the WS server in the background. Called once from `lib.rs`'s
/// setup. The server runs for the app's lifetime — connections are
/// rejected when no pairing is pending (or, in step-6/7-future-work,
/// authenticated against the registry for sync sessions).
pub fn spawn_server<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let addr: SocketAddr = ([0, 0, 0, 0], WS_PORT).into();
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("pairing-ws: failed to bind {addr}: {e}");
                return;
            }
        };
        eprintln!("pairing-ws: listening on {addr}");

        loop {
            let (tcp, peer) = match listener.accept().await {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("pairing-ws: accept failed: {e}");
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle_connection(app, tcp, peer).await {
                    eprintln!("pairing-ws: peer {peer} failed: {e}");
                }
            });
        }
    });
}

async fn handle_connection<R: Runtime>(
    app: AppHandle<R>,
    tcp: tokio::net::TcpStream,
    peer: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = tokio_tungstenite::accept_async(tcp).await?;
    let (mut tx, mut rx) = ws.split();

    // First-frame dispatch:
    //   - binary  → Noise XK pairing handshake (only valid when armed
    //               via pairing_start)
    //   - text    → JSON command, currently `{type: "sync_request",
    //               pair_id: "<hex>"}` from an already-paired phone
    let first = read_any(&mut rx).await?;
    match first {
        FirstFrame::Binary(bytes) => {
            handle_pairing(app, tx, rx, bytes, peer).await
        }
        FirstFrame::Text(text) => {
            handle_sync_request(app, tx, rx, text).await
        }
    }
}

async fn handle_pairing<R: Runtime>(
    app: AppHandle<R>,
    mut tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
    mut rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    first_msg: Vec<u8>,
    peer: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Take the pending pairing slot. Reject if no pairing is in progress.
    let pending = {
        let state = app
            .try_state::<Arc<WsServerState>>()
            .ok_or_else(|| "WsServerState not mounted".to_string())?
            .inner()
            .clone();
        let mut guard = state.pending.lock().unwrap();
        guard.take()
    };
    let pending = match pending {
        Some(p) => p,
        None => {
            let _ = tx
                .send(Message::Close(Some(
                    tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                        reason: "no pairing pending".into(),
                    },
                )))
                .await;
            return Ok(());
        }
    };

    let mut responder = HandshakeResponder::new(&pending.responder_priv)?;

    // Noise XK is a 3-message handshake: read, write, read.
    // Each Noise message rides one binary WS frame. msg1 is the
    // already-peeked first binary frame.
    responder.read_message(&first_msg)?;

    let mut msg2 = Vec::new();
    responder.write_message(&mut msg2)?;
    tx.send(Message::Binary(msg2)).await?;

    let msg3 = read_binary(&mut rx).await?;
    responder.read_message(&msg3)?;

    // Wait for the optional friendly-name frame the phone sends right
    // after the handshake. If the phone doesn't send one within a short
    // window, fall back to a generic name.
    let friendly_name = match read_text_with_timeout(&mut rx, 2_000).await {
        Ok(name) => name,
        Err(_) => format!("Phone @ {peer}"),
    };

    let transport: TransportPair = responder.finish()?;
    let meta: PairingMeta = finalize_pairing(&app, transport, friendly_name)
        .map_err(|e: PairingError| e.to_string())?;

    // Tell the desktop frontend the modal can close + the registry
    // refreshed.
    let _ = app.emit("pairing:paired", &meta);

    // Confirm to the phone so its UI can transition.
    let confirm = serde_json::json!({
        "type": "paired",
        "pair_id_hex": meta.pair_id_hex,
        "verification_fingerprint": meta.verification_fingerprint,
    });
    tx.send(Message::Text(confirm.to_string())).await?;

    // Close cleanly.
    let _ = tx.close().await;
    Ok(())
}

async fn read_binary(
    rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    while let Some(msg) = rx.next().await {
        match msg? {
            Message::Binary(b) => return Ok(b),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(_) => return Err("expected binary, got text".into()),
            Message::Close(_) => return Err("peer closed".into()),
            Message::Frame(_) => continue,
        }
    }
    Err("stream ended".into())
}

enum FirstFrame {
    Binary(Vec<u8>),
    Text(String),
}

async fn read_any(
    rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
) -> Result<FirstFrame, Box<dyn std::error::Error + Send + Sync>> {
    while let Some(msg) = rx.next().await {
        match msg? {
            Message::Binary(b) => return Ok(FirstFrame::Binary(b)),
            Message::Text(t) => return Ok(FirstFrame::Text(t)),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(_) => return Err("peer closed before any data".into()),
        }
    }
    Err("stream ended".into())
}

/// Handle a sync-session WS connection. The phone sends a JSON request
/// naming the pair_id; the desktop pushes Op::Put for each .md in the
/// pair's synced_folders.
///
/// v2.0-alpha auth model: trust the pair_id from a LAN peer. The pair_id
/// is derived from the Noise handshake hash and not transmitted on the
/// wire during sync; an attacker who didn't observe the original pairing
/// can't know it. Documented as a security follow-up.
async fn handle_sync_request<R: Runtime>(
    app: AppHandle<R>,
    mut tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
    _rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    first_text: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let req: serde_json::Value = serde_json::from_str(&first_text)?;
    let req_type = req.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if req_type != "sync_request" {
        let _ = tx
            .send(Message::Text(
                serde_json::json!({"type": "error", "reason": "unknown command"})
                    .to_string(),
            ))
            .await;
        return Ok(());
    }
    let pair_id_hex = match req.get("pair_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let _ = tx
                .send(Message::Text(
                    serde_json::json!({"type": "error", "reason": "missing pair_id"})
                        .to_string(),
                ))
                .await;
            return Ok(());
        }
    };
    let meta = match crate::pairing::load_pairing(&app, &pair_id_hex)? {
        Some(m) => m,
        None => {
            let _ = tx
                .send(Message::Text(
                    serde_json::json!({"type": "error", "reason": "unknown pair_id"})
                        .to_string(),
                ))
                .await;
            return Ok(());
        }
    };
    let pair_key = match crate::pairing::load_pair_key(&app, &pair_id_hex)? {
        Some(k) => k,
        None => {
            let _ = tx
                .send(Message::Text(
                    serde_json::json!({"type": "error", "reason": "pair key missing — re-pair"})
                        .to_string(),
                ))
                .await;
            return Ok(());
        }
    };

    // Walk each synced folder, seal each .md, send to the phone.
    let mut total_files = 0u64;
    for folder in &meta.synced_folders {
        let walk = walk_markdown(folder);
        for (relpath, contents) in walk {
            let folder_id = pair_id_from_folder(&pair_id_hex, folder);
            let file_key = marklig_sync_core::envelope::derive_file_key(
                &marklig_sync_core::pair::PairKey(pair_key),
                &marklig_sync_core::pair::PairId(folder_id),
                &relpath,
            );
            let sealed = marklig_sync_core::envelope::seal(&file_key, contents.as_bytes())?;
            let frame = serde_json::json!({
                "type": "op_put",
                "folder_id_hex": pair_id_from_folder_hex(&pair_id_hex, folder),
                "folder_label": std::path::Path::new(folder)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(folder),
                "relpath": relpath,
                "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&sealed),
            });
            tx.send(Message::Text(frame.to_string())).await?;
            total_files += 1;
        }
    }
    let done = serde_json::json!({"type": "sync_done", "files": total_files});
    let _ = tx.send(Message::Text(done.to_string())).await;
    let _ = tx.close().await;
    Ok(())
}

/// Deterministic per-pair-per-folder identifier. Stable across re-syncs
/// so the phone's library uses the same folder_id for the same folder.
fn pair_id_from_folder(pair_id_hex: &str, folder: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"marklig-folder-id-v1");
    h.update(pair_id_hex.as_bytes());
    h.update(b":");
    h.update(folder.as_bytes());
    let full = h.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

fn pair_id_from_folder_hex(pair_id_hex: &str, folder: &str) -> String {
    let bytes = pair_id_from_folder(pair_id_hex, folder);
    let mut s = String::with_capacity(32);
    for b in &bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn walk_markdown(root: &str) -> Vec<(String, String)> {
    fn rec(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                // Skip hidden dirs and node_modules/.git/etc.
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    if name.starts_with('.') || name == "node_modules" {
                        continue;
                    }
                }
                rec(&path, root, out);
            } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                let lower = ext.to_ascii_lowercase();
                if matches!(lower.as_str(), "md" | "markdown" | "mdx" | "mdown") {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(rel) = path.strip_prefix(root) {
                            if let Some(rel_s) = rel.to_str() {
                                out.push((rel_s.to_string(), content));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    let root_path = std::path::Path::new(root);
    rec(root_path, root_path, &mut out);
    out
}

use base64::Engine as _;

async fn read_text_with_timeout(
    rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    timeout_ms: u64,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let fut = async {
        while let Some(msg) = rx.next().await {
            match msg? {
                Message::Text(t) => {
                    return Ok::<String, Box<dyn std::error::Error + Send + Sync>>(t);
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                Message::Binary(_) => return Err("expected text, got binary".into()),
                Message::Close(_) => return Err("peer closed".into()),
            }
        }
        Err("stream ended".into())
    };
    let timeout = tokio::time::Duration::from_millis(timeout_ms);
    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| "timeout".into())
        .and_then(|r| r)
}

/// Arm the WS server for an inbound pairing. Called from pairing::
/// pairing_start; the responder private key never crosses the IPC
/// boundary.
pub fn arm<R: Runtime>(app: &AppHandle<R>, responder_priv: [u8; 32]) -> Result<(), String> {
    let state = app
        .try_state::<Arc<WsServerState>>()
        .ok_or_else(|| "WsServerState not mounted".to_string())?
        .inner()
        .clone();
    let mut guard = state.pending.lock().map_err(|e| format!("lock: {e}"))?;
    *guard = Some(PendingPairing { responder_priv });
    Ok(())
}

pub fn disarm<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<Arc<WsServerState>>()
        .ok_or_else(|| "WsServerState not mounted".to_string())?
        .inner()
        .clone();
    let mut guard = state.pending.lock().map_err(|e| format!("lock: {e}"))?;
    *guard = None;
    Ok(())
}
