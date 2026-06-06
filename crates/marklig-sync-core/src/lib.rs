//! marklig-sync-core: E2E-encrypted pairing + envelope + sync op log.
//!
//! This crate is Tauri-independent on purpose:
//! - it ships into `src-tauri` as a path dependency for the desktop;
//! - it builds for `aarch64-linux-android` so the same code can drive
//!   the phone side;
//! - eventually it powers the relay (v2.1+) without dragging Tauri in.
//!
//! Three modules:
//! - [`pair`] — Noise XK handshake driver, QR payload codec, pair-key
//!   derivation (long-term symmetric key + stable pair id).
//! - [`envelope`] — per-file ChaCha20-Poly1305 seal/open with HKDF-derived
//!   per-file keys. Transport-agnostic: the same ciphertext blob can flow
//!   over LAN today or through a relay later without re-encryption.
//! - [`ops`] — append-only sync op log + Lamport clock + deterministic
//!   conflict resolution.
//!
//! See `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §6.1
//! and §7 for the design rationale.

pub mod envelope;
pub mod ops;
pub mod pair;

pub use envelope::{derive_file_key, open, seal, EnvelopeError};
pub use ops::{LamportClock, LoggedOp, Op, OpKind, OpLog, SyncError, resolve};
pub use pair::{
    HandshakeError, HandshakeInitiator, HandshakeResponder, PairId, PairKey, QrPayload,
    TransportPair,
};
