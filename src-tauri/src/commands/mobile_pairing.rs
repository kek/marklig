//! Phone-side pairing via WebSocket. Mirrors `pairing_ws.rs` on the
//! desktop: opens a WebSocket connection to `ws_url`, drives Noise XK as
//! the initiator, and persists the resulting pair metadata so the
//! library can list it.

use futures_util::{SinkExt, StreamExt};
use marklig_sync_core::pair::{HandshakeInitiator, QrPayload};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};
use tokio_tungstenite::tungstenite::Message;

const WS_PORT: u16 = 14_200;

#[derive(Serialize, Deserialize)]
pub struct MobilePairResult {
    pub pair_id_hex: String,
    pub verification_fingerprint: String,
    pub friendly_name: String,
}

#[derive(Deserialize)]
pub struct MobilePairingStartArgs {
    pub qr_payload: String,
    pub host: String,
    pub friendly_name: String,
}

/// Drive a pairing handshake against a desktop. The phone scans a QR
/// containing the desktop's static pubkey, then enters (or auto-detects)
/// the desktop's LAN IP; this command opens a WS to
/// `ws://<host>:14200`, runs Noise XK initiator, and persists the
/// resulting pair locally.
#[tauri::command]
pub async fn mobile_pairing_start<R: Runtime>(
    app: AppHandle<R>,
    args: MobilePairingStartArgs,
) -> Result<MobilePairResult, String> {
    let qr = QrPayload::decode(&args.qr_payload).map_err(|e| e.to_string())?;
    let initiator_kp = ensure_initiator_keypair(&app)?;

    let url = format!("ws://{}:{}", args.host.trim(), WS_PORT);
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    let mut initiator =
        HandshakeInitiator::new(&initiator_kp.private, &qr.responder_static_pubkey)
            .map_err(|e| e.to_string())?;

    let mut msg1 = Vec::new();
    initiator.write_message(&mut msg1).map_err(|e| e.to_string())?;
    tx.send(Message::Binary(msg1))
        .await
        .map_err(|e| format!("send msg1: {e}"))?;

    let msg2 = read_binary(&mut rx).await?;
    initiator.read_message(&msg2).map_err(|e| e.to_string())?;

    let mut msg3 = Vec::new();
    initiator.write_message(&mut msg3).map_err(|e| e.to_string())?;
    tx.send(Message::Binary(msg3))
        .await
        .map_err(|e| format!("send msg3: {e}"))?;

    // Send the phone's friendly name so the desktop can label this
    // pairing in its registry.
    tx.send(Message::Text(args.friendly_name.clone()))
        .await
        .map_err(|e| format!("send name: {e}"))?;

    let transport = initiator.finish().map_err(|e| e.to_string())?;
    let pair_id_hex = transport.pair_id.to_hex();
    let fingerprint = verification_fingerprint(&transport.pair_key.0);

    // Read the desktop's "paired" confirmation. Best-effort — the
    // handshake-level success is the real signal.
    let _ = read_text_with_timeout(&mut rx, 3_000).await;
    let _ = tx.close().await;

    // Persist on the phone side so the library can show paired desktops
    // and (step 6 sync work) the sync engine can address them.
    persist_phone_pairing(
        &app,
        &pair_id_hex,
        &args.friendly_name,
        &fingerprint,
        &transport.pair_key.0,
    )?;

    Ok(MobilePairResult {
        pair_id_hex,
        verification_fingerprint: fingerprint,
        friendly_name: args.friendly_name,
    })
}

#[derive(Clone)]
struct InitiatorKeypair {
    private: [u8; 32],
    #[allow(dead_code)]
    public: [u8; 32],
}

fn ensure_initiator_keypair<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<InitiatorKeypair, String> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| e.to_string())?;
    if let Some(v) = store.get("mobile.pairing.static_keypair") {
        if let Some(obj) = v.as_object() {
            let priv_hex = obj.get("private").and_then(|v| v.as_str()).unwrap_or("");
            let pub_hex = obj.get("public").and_then(|v| v.as_str()).unwrap_or("");
            if let (Some(p), Some(q)) = (hex_to_32(priv_hex), hex_to_32(pub_hex)) {
                return Ok(InitiatorKeypair {
                    private: p,
                    public: q,
                });
            }
        }
    }
    let kp = snow::Builder::new(
        "Noise_XK_25519_ChaChaPoly_BLAKE2s"
            .parse()
            .expect("Noise XK pattern parses"),
    )
    .generate_keypair()
    .map_err(|e| e.to_string())?;
    let mut private = [0u8; 32];
    let mut public = [0u8; 32];
    private.copy_from_slice(&kp.private);
    public.copy_from_slice(&kp.public);
    store.set(
        "mobile.pairing.static_keypair",
        serde_json::json!({
            "private": hex_32(&private),
            "public": hex_32(&public),
        }),
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(InitiatorKeypair { private, public })
}

fn persist_phone_pairing<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    friendly_name: &str,
    fingerprint: &str,
    pair_key: &[u8; 32],
) -> Result<(), String> {
    let store = tauri_plugin_store::StoreExt::store(app, "viewer.store.json")
        .map_err(|e| e.to_string())?;
    let mut map = store
        .get("mobile.pairings")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let now = now_unix();
    map.insert(
        pair_id_hex.to_string(),
        serde_json::json!({
            "pair_id_hex": pair_id_hex,
            "friendly_name": friendly_name,
            "verification_fingerprint": fingerprint,
            "paired_at_unix": now,
            "last_seen_at_unix": now,
            "pair_key": hex_32(pair_key),
        }),
    );
    store.set("mobile.pairings", serde_json::Value::Object(map));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

async fn read_binary(
    rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) -> Result<Vec<u8>, String> {
    while let Some(msg) = rx.next().await {
        match msg.map_err(|e| e.to_string())? {
            Message::Binary(b) => return Ok(b),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Text(_) => return Err("expected binary, got text".into()),
            Message::Close(_) => return Err("peer closed".into()),
        }
    }
    Err("stream ended".into())
}

async fn read_text_with_timeout(
    rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    timeout_ms: u64,
) -> Result<String, String> {
    let fut = async {
        while let Some(msg) = rx.next().await {
            match msg.map_err(|e| e.to_string())? {
                Message::Text(t) => return Ok::<String, String>(t),
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                Message::Binary(_) => return Err("expected text, got binary".into()),
                Message::Close(_) => return Err("peer closed".into()),
            }
        }
        Err("stream ended".into())
    };
    tokio::time::timeout(tokio::time::Duration::from_millis(timeout_ms), fut)
        .await
        .map_err(|_| "timeout".to_string())
        .and_then(|r| r)
}

fn verification_fingerprint(pair_key: &[u8; 32]) -> String {
    let h = Sha256::digest(pair_key);
    format!("{:02X}-{:02X}-{:02X}-{:02X}", h[0], h[1], h[2], h[3])
}

fn hex_32(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
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

fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
