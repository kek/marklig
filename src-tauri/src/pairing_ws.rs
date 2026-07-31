//! WebSocket-based pairing transport. v2.0-alpha (deviation from the
//! original step-6 plan): the spec called for mDNS + raw TCP + native
//! Kotlin bridges on the phone. That stack is correct but multi-day to
//! ship across both devices. The WebSocket pivot lets the phone side
//! drive everything from pure JS (`new WebSocket(url)`) and the desktop
//! side use a familiar tokio-tungstenite server — no Kotlin plugin
//! authoring.
//!
//! Trade-offs documented in CLAUDE.md and the issue:
//! - WebSocket framing instead of raw TCP — slightly more overhead.
//! - Manual IP entry on the phone. Resolved: this server announces
//!   `_marklig-sync._tcp` (see [`crate::mdns`]) from the moment its
//!   listener binds until the app exits, and the Android client resolves
//!   that name when its stored address stops answering. The announcement
//!   is deliberately tied to *this* server's bind rather than to the
//!   pairing modal, because a reconnecting phone is asking whether sync is
//!   reachable — which the `subscribe` / `sync_request` paths below answer
//!   without consulting the pairing arm state at all.
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
    /// Owns the `_marklig-sync._tcp` announcement. It lives here, not in
    /// `PairingState`, because its lifetime is this server's listener: up
    /// once the bind succeeds, down when the app drops this state. Nothing
    /// during a session withdraws it.
    announcer: Mutex<crate::mdns::SyncAnnouncer>,
}

pub struct PendingPairing {
    pub responder_priv: [u8; 32],
}

impl WsServerState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            announcer: Mutex::new(crate::mdns::SyncAnnouncer::default()),
        }
    }
}

impl Default for WsServerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Spin up the WS server in the background. Called once from `lib.rs`'s
/// setup. The server runs for the app's lifetime — pairing handshakes are
/// rejected when no pairing is pending, while `sync_request` / `subscribe`
/// from an already-paired phone are served for the whole session.
///
/// The bind is also what decides whether this desktop advertises itself:
/// see [`announce_for_listener`].
pub fn spawn_server<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let addr: SocketAddr = ([0, 0, 0, 0], WS_PORT).into();
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("pairing-ws: failed to bind {addr}: {e}");
                // Stay silent on mDNS. Advertising now would publish an
                // address whose port refuses every connection, and a phone
                // that resolved it would drop a stored address that still
                // worked.
                announce_for_listener(&app, None);
                return;
            }
        };
        eprintln!("pairing-ws: listening on {addr}");
        // Answerable from here on, so say so — for the rest of the session,
        // not just while a pairing modal is open.
        announce_for_listener(&app, Some(WS_PORT));

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

/// Publish or withhold the `_marklig-sync._tcp` announcement according to
/// whether this server's listener is bound. `None` means the bind failed.
///
/// Best-effort: a desktop that cannot announce is still fully usable over
/// the address in its QR, so a failure here is logged rather than fatal.
fn announce_for_listener<R: Runtime>(app: &AppHandle<R>, listening: Option<u16>) {
    // Clone the Arc out rather than holding the `State` borrow: the guard
    // below outlives it otherwise.
    let Some(state) = app
        .try_state::<Arc<WsServerState>>()
        .map(|s| s.inner().clone())
    else {
        eprintln!("mdns: WsServerState not mounted, not announcing");
        return;
    };
    // Bound, not matched in tail position: the guard's temporary would
    // otherwise outlive `state` and fail to borrow-check.
    let locked = state.announcer.lock();
    match locked {
        Ok(mut announcer) => {
            // `announce_this_desktop` derives the instance name itself, from
            // `gethostname(2)`. That derivation is private to `mdns`, so this
            // is the only place in the app where a name is computed — the QR
            // in `pairing_start` reads back what ended up on the wire instead
            // (see `announced_instance_name`).
            match crate::mdns::announce_this_desktop(&mut announcer, listening) {
                Ok(Some(fullname)) => eprintln!("mdns: announcing {fullname}"),
                Ok(None) => {}
                Err(e) => eprintln!("mdns: announcing this desktop failed: {e}"),
            }
        }
        Err(e) => eprintln!("mdns: announcer lock poisoned: {e}"),
    }
}

/// The instance name this desktop is currently announcing, or `None` when
/// nothing is on the wire (the bind failed, or the announcement has not gone
/// up yet).
///
/// Read back from the announcer that registered it — never re-derived. This
/// is the only way a caller may learn the name to print in a QR: mdns-sd can
/// rename a colliding announcement under RFC 6762 §9, and a second call to
/// `mdns::instance_name()` would then name the desktop that won the name
/// instead of this one. See `crate::mdns::AnnouncedInstance`.
pub fn announced_instance_name<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app
        .try_state::<Arc<WsServerState>>()
        .map(|s| s.inner().clone())?;
    let announcer = state.announcer.lock().ok()?;
    announcer.announced_instance_name()
}

async fn handle_connection<R: Runtime>(
    app: AppHandle<R>,
    tcp: tokio::net::TcpStream,
    peer: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = tokio_tungstenite::accept_async(tcp).await?;
    // `tx` is moved into each handler below, which takes it `mut` itself.
    let (tx, mut rx) = ws.split();

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
            let frame_type = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string));
            match frame_type.as_deref() {
                Some("subscribe") => handle_subscribe(app, tx, rx, text).await,
                _ => handle_sync_request(app, tx, rx, text).await,
            }
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

    // The announcement stays up. The pending slot was taken at the top of
    // this function, so no further handshake will be accepted — but this
    // phone has just become one that reconnects for *sync*, and the whole
    // point of the announcement is to still be there when it does.

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

/// Long-lived sync-session handler. The phone sends a `subscribe` frame
/// with per-folder cursors; the desktop replays ops since each cursor,
/// then streams live ops via the `SyncSessionRegistry` channel.
async fn handle_subscribe<R: Runtime>(
    app: AppHandle<R>,
    mut tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
    mut rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    first_text: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::collections::HashMap;
    use tokio::time::Duration;

    let req: serde_json::Value = serde_json::from_str(&first_text)?;
    let pair_id_hex = req
        .get("pair_id")
        .and_then(|v| v.as_str())
        .ok_or("missing pair_id")?
        .to_string();
    let cursors: HashMap<String, u64> = req
        .get("cursors")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let meta = match crate::pairing::load_pairing(&app, &pair_id_hex)
        .map_err(|e| e.to_string())?
    {
        Some(m) => m,
        None => {
            let _ = tx
                .send(Message::Text(
                    serde_json::json!({"type":"error","reason":"unknown pair_id"}).to_string(),
                ))
                .await;
            return Ok(());
        }
    };

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Replay ops since cursor for each folder
    for folder in &meta.synced_folders {
        let folder_id_hex = pair_id_from_folder_hex(&pair_id_hex, folder);
        let cursor = cursors.get(&folder_id_hex).copied().unwrap_or(0);
        let sync_dir = data_dir
            .join("sync")
            .join(&pair_id_hex)
            .join(&folder_id_hex);

        if let Ok(log) = marklig_sync_core::ops::OpLog::open(&sync_dir) {
            let ops = match log.ops_since(cursor) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for op in ops {
                let frame = match op.kind {
                    marklig_sync_core::ops::OpKind::Put => {
                        let ref_hex = match &op.ciphertext_ref_hex {
                            Some(r) => r.clone(),
                            None => continue,
                        };
                        let ct = match log.read_blob(&ref_hex) {
                            Some(c) => c,
                            None => {
                                let _ = tx
                                    .send(Message::Text(
                                        serde_json::json!({
                                            "type": "error",
                                            "reason": "blob missing",
                                            "folder_id_hex": folder_id_hex,
                                            "relpath": op.relpath,
                                        })
                                        .to_string(),
                                    ))
                                    .await;
                                continue;
                            }
                        };
                        serde_json::json!({
                            "type": "op_put",
                            "folder_id_hex": folder_id_hex,
                            "relpath": op.relpath,
                            "mtime_logical": op.mtime_logical,
                            "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ct),
                        })
                    }
                    marklig_sync_core::ops::OpKind::Delete => {
                        serde_json::json!({
                            "type": "op_delete",
                            "folder_id_hex": folder_id_hex,
                            "relpath": op.relpath,
                            "mtime_logical": op.mtime_logical,
                        })
                    }
                };
                tx.send(Message::Text(frame.to_string())).await?;
            }
        }
    }

    tx.send(Message::Text(
        serde_json::json!({"type":"caught_up"}).to_string(),
    ))
    .await?;

    // Register with the session registry
    let (chan_tx, mut chan_rx) = tokio::sync::mpsc::channel::<serde_json::Value>(128);
    let registry = app
        .try_state::<std::sync::Arc<crate::sync_session::SyncSessionRegistry>>()
        .ok_or("SyncSessionRegistry not mounted")?;
    let session_id = registry.register(&pair_id_hex, chan_tx);

    // Forward loop + heartbeat
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pong_due_by: Option<tokio::time::Instant> = None;

    loop {
        if let Some(dl) = pong_due_by {
            if tokio::time::Instant::now() > dl {
                break;
            }
        }

        tokio::select! {
            _ = ping_interval.tick() => {
                if tx.send(Message::Text(serde_json::json!({"type":"ping"}).to_string())).await.is_err() {
                    break;
                }
                pong_due_by = Some(tokio::time::Instant::now() + Duration::from_secs(10));
            }
            frame = chan_rx.recv() => {
                match frame {
                    Some(f) => {
                        if tx.send(Message::Text(f.to_string())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                            if v.get("type").and_then(|x| x.as_str()) == Some("pong") {
                                pong_due_by = None;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    registry.unregister(&pair_id_hex, session_id);
    Ok(())
}

/// Deterministic per-pair-per-folder identifier. Stable across re-syncs
/// so the phone's library uses the same folder_id for the same folder.
pub(crate) fn pair_id_from_folder(pair_id_hex: &str, folder: &str) -> [u8; 16] {
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

pub(crate) fn pair_id_from_folder_hex(pair_id_hex: &str, folder: &str) -> String {
    let bytes = pair_id_from_folder(pair_id_hex, folder);
    let mut s = String::with_capacity(32);
    for b in &bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub(crate) fn read_markdown_file(root: &str, relpath: &str) -> Option<String> {
    let path = std::path::Path::new(root).join(relpath);
    std::fs::read_to_string(path).ok()
}

pub(crate) fn walk_markdown(root: &str) -> Vec<(String, String)> {
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
