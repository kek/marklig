//! Noise XK pairing handshake + QR payload codec + pair-key derivation.
//!
//! Wire protocol mirror of the spec §6.1:
//!
//! 1. Desktop generates a static X25519 keypair (persisted in OS keychain).
//! 2. Desktop encodes its static pubkey + mDNS instance name + expiry into
//!    a [`QrPayload`] and renders it as `marklig-pair://v1/…`.
//! 3. Phone scans, decodes, resolves desktop via mDNS, opens a TCP channel.
//! 4. Phone runs Noise XK initiator; desktop runs responder.
//! 5. After three handshake messages, both sides derive:
//!    - a 32-byte symmetric [`PairKey`] (long-term file-key parent), and
//!    - a 16-byte [`PairId`] (stable identifier for the pair).
//!
//! Re-pairing the same two static keys deterministically produces the same
//! pair-id (HKDF over the Noise handshake hash), so a fresh handshake is
//! idempotent from the registry's point of view.
//!
//! **Stability boundary:** the HKDF salt (`b"marklig-pair-v1"`) and the two
//! info strings (`b"pair-key"`, `b"pair-id"`) are part of the wire ABI. Once
//! a phone is in the wild with a derived pair key, changing these strings
//! invalidates every paired device. Bump the `-v1` suffix as a deliberate
//! migration when changing.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use sha2::Sha256;
use thiserror::Error;

/// Long-term symmetric key shared by a paired (desktop, phone) tuple.
/// Derived from the Noise XK handshake hash via HKDF-SHA256. Stored in
/// the OS keychain on desktop and Android Keystore on phone. Never
/// crosses the FFI boundary as raw bytes in production code paths —
/// wrap behind opaque handles for keychain-backed storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairKey(pub [u8; 32]);

/// Stable 16-byte identifier for a pair. Used as the lookup key in the
/// desktop pairing registry and as part of the per-file key derivation
/// (so changing the pair invalidates all derived file keys).
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PairId(pub [u8; 16]);

impl PairId {
    /// Hex-string form used in storage keys and friendly logs.
    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(32);
        for b in &self.0 {
            out.push_str(&format!("{:02x}", b));
        }
        out
    }
}

/// What the desktop encodes into the QR. The phone scans this, resolves
/// the desktop via mDNS using `mdns_instance_name`, opens a TCP socket,
/// and runs the handshake against `responder_static_pubkey`.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct QrPayload {
    pub responder_static_pubkey: [u8; 32],
    pub mdns_instance_name: String,
    pub expiry_unix: u64,
}

impl QrPayload {
    /// Encode as `marklig-pair://v1/<base64url(pubkey || u16le name_len ||
    /// name_utf8 || u64le expiry)>`. The base64-url alphabet (`A-Za-z0-9-_`)
    /// fits cleanly inside a QR's alphanumeric mode for compactness.
    pub fn encode(&self) -> String {
        let name_bytes = self.mdns_instance_name.as_bytes();
        let mut buf = Vec::with_capacity(32 + 2 + name_bytes.len() + 8);
        buf.extend_from_slice(&self.responder_static_pubkey);
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);
        buf.extend_from_slice(&self.expiry_unix.to_le_bytes());
        format!("marklig-pair://v1/{}", URL_SAFE_NO_PAD.encode(&buf))
    }

    pub fn decode(s: &str) -> Result<Self, PairError> {
        let body = s
            .strip_prefix("marklig-pair://v1/")
            .ok_or(PairError::QrSchemeMismatch)?;
        let buf = URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| PairError::QrBase64)?;
        if buf.len() < 32 + 2 + 8 {
            return Err(PairError::QrTruncated);
        }
        let mut pubkey = [0u8; 32];
        pubkey.copy_from_slice(&buf[0..32]);
        let name_len = u16::from_le_bytes([buf[32], buf[33]]) as usize;
        let name_end = 34 + name_len;
        if buf.len() < name_end + 8 {
            return Err(PairError::QrTruncated);
        }
        let mdns_instance_name = std::str::from_utf8(&buf[34..name_end])
            .map_err(|_| PairError::QrInvalidUtf8)?
            .to_string();
        let mut exp = [0u8; 8];
        exp.copy_from_slice(&buf[name_end..name_end + 8]);
        let expiry_unix = u64::from_le_bytes(exp);
        Ok(QrPayload {
            responder_static_pubkey: pubkey,
            mdns_instance_name,
            expiry_unix,
        })
    }
}

#[derive(Debug, Error)]
pub enum PairError {
    #[error("QR payload doesn't start with marklig-pair://v1/")]
    QrSchemeMismatch,
    #[error("QR payload isn't valid base64url")]
    QrBase64,
    #[error("QR payload is shorter than the minimum frame")]
    QrTruncated,
    #[error("QR payload's mdns instance name isn't valid UTF-8")]
    QrInvalidUtf8,
}

/// What [`HandshakeInitiator::finish`] / [`HandshakeResponder::finish`]
/// return once the three-message Noise XK exchange completes. The
/// `transport` field is kept around because the same channel runs ops
/// after the handshake — Noise's transport state gives us cheap
/// per-message confidentiality.
pub struct TransportPair {
    pub pair_key: PairKey,
    pub pair_id: PairId,
    pub transport: snow::TransportState,
}

const NOISE_PATTERN: &str = "Noise_XK_25519_ChaChaPoly_BLAKE2s";
const HKDF_SALT: &[u8] = b"marklig-pair-v1";
const HKDF_INFO_PAIR_KEY: &[u8] = b"pair-key";
const HKDF_INFO_PAIR_ID: &[u8] = b"pair-id";

#[derive(Debug, Error)]
pub enum HandshakeError {
    #[error("snow handshake error: {0}")]
    Snow(#[from] snow::Error),
    #[error("handshake produced unexpected key length")]
    BadKeyLength,
}

/// XK initiator side. Owns a `snow::HandshakeState` and exposes
/// length-agnostic read/write so the caller (transport layer) can frame
/// however it likes. Three exchanges:
///   write → read → write.
pub struct HandshakeInitiator {
    state: snow::HandshakeState,
}

impl HandshakeInitiator {
    pub fn new(
        local_static: &[u8; 32],
        remote_static: &[u8; 32],
    ) -> Result<Self, HandshakeError> {
        let state = snow::Builder::new(
            NOISE_PATTERN
                .parse()
                .expect("Noise XK pattern parses"),
        )
        .local_private_key(local_static)?
        .remote_public_key(remote_static)?
        .build_initiator()?;
        Ok(HandshakeInitiator { state })
    }

    /// Produce the next outbound message. The output is appended to `out`
    /// — caller frames it (typically length-prefixed) and ships it.
    pub fn write_message(&mut self, out: &mut Vec<u8>) -> Result<(), HandshakeError> {
        let mut buf = [0u8; 65535];
        let n = self.state.write_message(&[], &mut buf)?;
        out.extend_from_slice(&buf[..n]);
        Ok(())
    }

    pub fn read_message(&mut self, msg: &[u8]) -> Result<(), HandshakeError> {
        let mut buf = [0u8; 65535];
        self.state.read_message(msg, &mut buf)?;
        Ok(())
    }

    pub fn finish(self) -> Result<TransportPair, HandshakeError> {
        finalize(self.state)
    }
}

/// XK responder side. Same shape as the initiator but the message order
/// is read → write → read.
pub struct HandshakeResponder {
    state: snow::HandshakeState,
}

impl HandshakeResponder {
    pub fn new(local_static: &[u8; 32]) -> Result<Self, HandshakeError> {
        let state = snow::Builder::new(
            NOISE_PATTERN
                .parse()
                .expect("Noise XK pattern parses"),
        )
        .local_private_key(local_static)?
        .build_responder()?;
        Ok(HandshakeResponder { state })
    }

    pub fn read_message(&mut self, msg: &[u8]) -> Result<(), HandshakeError> {
        let mut buf = [0u8; 65535];
        self.state.read_message(msg, &mut buf)?;
        Ok(())
    }

    pub fn write_message(&mut self, out: &mut Vec<u8>) -> Result<(), HandshakeError> {
        let mut buf = [0u8; 65535];
        let n = self.state.write_message(&[], &mut buf)?;
        out.extend_from_slice(&buf[..n]);
        Ok(())
    }

    pub fn finish(self) -> Result<TransportPair, HandshakeError> {
        finalize(self.state)
    }
}

fn finalize(state: snow::HandshakeState) -> Result<TransportPair, HandshakeError> {
    let handshake_hash = state.get_handshake_hash().to_vec();
    let transport = state.into_transport_mode()?;

    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &handshake_hash);
    let mut pair_key_bytes = [0u8; 32];
    hk.expand(HKDF_INFO_PAIR_KEY, &mut pair_key_bytes)
        .map_err(|_| HandshakeError::BadKeyLength)?;
    let mut pair_id_bytes = [0u8; 16];
    hk.expand(HKDF_INFO_PAIR_ID, &mut pair_id_bytes)
        .map_err(|_| HandshakeError::BadKeyLength)?;

    Ok(TransportPair {
        pair_key: PairKey(pair_key_bytes),
        pair_id: PairId(pair_id_bytes),
        transport,
    })
}
