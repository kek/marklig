# Mobile companion — Step 4: Crypto core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust crate `marklig-sync-core` that implements the E2E-encrypted pairing handshake (Noise XK), the per-file envelope (ChaCha20-Poly1305 + HKDF-derived per-file keys), and the sync op log format. Tested via desktop ↔ desktop loopback (two `cargo test` processes exchanging messages over an in-memory channel) so all bytes are deterministic before any wire integration. **No transport here** — that's step 6.

**Architecture:** A standalone Rust library crate under `crates/marklig-sync-core/`, depended on by `src-tauri/Cargo.toml`. Keeping it separate means:
- Unit tests against test vectors run independent of Tauri.
- Eventually publishable to crates.io if useful externally.
- Reusable on the eventual relay server (v2.1+) without dragging Tauri in.

The crate exposes three modules:
- `pair` — Noise XK handshake (uses `snow`), QR payload codec, pair-key derivation.
- `envelope` — per-file `seal()` / `open()` returning AEAD-wrapped opaque ciphertext.
- `ops` — append-only op log format (`Op::Put`, `Op::Delete`), serde-compatible.

**Tech stack additions:**
- `snow` (Noise framework, well-audited Rust impl).
- `chacha20poly1305` (RustCrypto, constant-time AEAD).
- `hkdf` + `sha2` (RustCrypto, for per-file key derivation).
- `rand_core` + `getrandom` (CSPRNG for nonces).
- No new JS deps — this crate is Rust-side only.

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §6.1 (pairing protocol), §7 (sync engine + envelope), §9 (transport-agnostic envelope design).

**VCS note:** Jujutsu repo — commits use `jj`, not raw `git`.

---

## Scope boundaries

In scope:
- The crate, its three modules, its test vectors.
- A `pair-cli` binary (under the same crate) that drives a two-process handshake from the command line so the loopback is reproducible.
- Integration into `src-tauri/Cargo.toml` as a path dependency so `cargo check` for the workspace still passes.
- A FFI-friendly interface (no `&'a` borrows in public types — everything `Vec<u8>` / `String` / owned) so the eventual JS bridge and Kotlin bridge can call without lifetime hassles.

Out of scope (later steps):
- Transport (LAN, mDNS, WebRTC) — step 6.
- Desktop pairing UI — step 5.
- Phone pairing UI — step 7.
- Relay — v2.1+.
- iOS — v2.1+.
- Replay protection beyond what Noise XK gives — relay-era concern.

---

## File structure

```
viewer/
├── crates/
│   └── marklig-sync-core/                    (NEW)
│       ├── Cargo.toml
│       ├── src/
│       │   ├── lib.rs
│       │   ├── pair.rs            ← Noise XK handshake + QR codec + pair-key derive
│       │   ├── envelope.rs        ← seal / open with HKDF-derived per-file keys
│       │   ├── ops.rs             ← Op enum + serde + Lamport-clock helper
│       │   └── bin/
│       │       └── pair_cli.rs    ← Two-process handshake driver
│       └── tests/
│           ├── pair.rs            ← Handshake vectors + roundtrip
│           ├── envelope.rs        ← AEAD vectors + tamper detection
│           └── ops.rs             ← Op log determinism
├── src-tauri/Cargo.toml           ← path = "../crates/marklig-sync-core"
└── Cargo.toml                     (NEW at repo root)  ← workspace declaration
```

---

## Task 1: Workspace + crate scaffold

**Files:**
- Create: repo-root `Cargo.toml` (workspace).
- Create: `crates/marklig-sync-core/Cargo.toml`.
- Create: `crates/marklig-sync-core/src/lib.rs` with module stubs.
- Modify: `src-tauri/Cargo.toml` to depend on the new crate.

- [ ] **Step 1: Root workspace `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/marklig-sync-core"]
```

(`src-tauri/Cargo.toml` becomes a workspace member automatically once the root file exists.)

- [ ] **Step 2: Crate `Cargo.toml`**

```toml
[package]
name = "marklig-sync-core"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"
license = "MIT"

[lib]
name = "marklig_sync_core"

[dependencies]
snow = "0.10"
chacha20poly1305 = "0.10"
hkdf = "0.12"
sha2 = "0.10"
serde = { version = "1", features = ["derive"] }
serde_bytes = "0.11"
thiserror = "2"
rand_core = "0.6"
getrandom = "0.2"
base64 = "0.22"

[dev-dependencies]
hex = "0.4"
serde_json = "1"
```

- [ ] **Step 3: `src/lib.rs`**

```rust
//! marklig-sync-core: E2E-encrypted pairing + envelope + sync op log.
//! See docs/superpowers/specs/2026-05-17-mobile-companion-design.md.

pub mod envelope;
pub mod ops;
pub mod pair;

pub use envelope::{seal, open, EnvelopeError};
pub use ops::{Op, OpKind};
pub use pair::{PairKey, PairId, QrPayload, HandshakeInitiator, HandshakeResponder};
```

- [ ] **Step 4: Wire as a path dep in `src-tauri/Cargo.toml`**

```toml
marklig-sync-core = { path = "../crates/marklig-sync-core" }
```

This unconditional dependency is fine: the crate is `no_std`-compatible-ish (all deps work on Android targets) and pulls into mobile too. Keep it unconditional so a future mobile-side sync engine can use it without re-wiring.

- [ ] **Step 5: Build gate**

```bash
cargo check --workspace
```

Must pass. No code yet other than module stubs — failures at this stage mean dependency-resolution issues, not implementation bugs.

**Commit:** `jj desc -m "Scaffold marklig-sync-core workspace crate"`, then `jj new`.

---

## Task 2: `pair` module — Noise XK + QR payload

**Files:**
- Create / modify: `crates/marklig-sync-core/src/pair.rs`.
- Create: `crates/marklig-sync-core/tests/pair.rs`.

- [ ] **Step 1: Public types**

```rust
use serde::{Deserialize, Serialize};

/// 32-byte symmetric pair key derived after a successful handshake.
/// Stored in the OS keychain on desktop and Android Keystore on phone.
/// Never crosses the FFI boundary as raw bytes — wrap in opaque handles.
#[derive(Clone)]
pub struct PairKey(pub [u8; 32]);

/// 16-byte stable identifier for the pair. Derived from the pair key via
/// HKDF so a fresh handshake between the same two static keys produces
/// the same pair id (idempotent re-pair).
#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug, Serialize, Deserialize)]
pub struct PairId(pub [u8; 16]);

/// QR-encoded payload the desktop displays for the phone to scan.
/// Format:
///   marklig-pair://v1/<base64url(responder_static_pubkey || mdns_instance_name_utf8 || expiry_unix_le_u64)>
#[derive(Debug, Clone)]
pub struct QrPayload {
    pub responder_static_pubkey: [u8; 32],
    pub mdns_instance_name: String,
    pub expiry_unix: u64,
}
```

- [ ] **Step 2: QR codec**

```rust
impl QrPayload {
    pub fn encode(&self) -> String {
        let mut buf = Vec::with_capacity(32 + self.mdns_instance_name.len() + 8);
        buf.extend_from_slice(&self.responder_static_pubkey);
        let name_bytes = self.mdns_instance_name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);
        buf.extend_from_slice(&self.expiry_unix.to_le_bytes());
        format!(
            "marklig-pair://v1/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf)
        )
    }

    pub fn decode(s: &str) -> Result<Self, PairError> { /* … */ }
}
```

Tests: round-trip a constructed payload, reject malformed URIs, reject the wrong scheme prefix.

- [ ] **Step 3: Noise XK handshake**

Use `snow::Builder` with `"Noise_XK_25519_ChaChaPoly_BLAKE2s"`. Two structs:

```rust
pub struct HandshakeInitiator { state: snow::HandshakeState }
pub struct HandshakeResponder { state: snow::HandshakeState }

impl HandshakeInitiator {
    pub fn new(local_static: &[u8; 32], remote_static: &[u8; 32]) -> Result<Self, PairError>;
    pub fn write_message(&mut self, out: &mut Vec<u8>) -> Result<(), PairError>;
    pub fn read_message(&mut self, msg: &[u8]) -> Result<(), PairError>;
    pub fn finish(self) -> Result<TransportPair, PairError>;
}

impl HandshakeResponder {
    pub fn new(local_static: &[u8; 32]) -> Result<Self, PairError>;
    pub fn read_message(&mut self, msg: &[u8]) -> Result<(), PairError>;
    pub fn write_message(&mut self, out: &mut Vec<u8>) -> Result<(), PairError>;
    pub fn finish(self) -> Result<TransportPair, PairError>;
}

pub struct TransportPair {
    pub pair_key: PairKey,
    pub pair_id: PairId,
    /// Optional snow TransportState for future per-message confidentiality
    /// over the established channel. The pair_key alone is enough for the
    /// envelope module; the transport state is for live-channel ops.
    pub transport: snow::TransportState,
}
```

- [ ] **Step 4: Pair-key derivation**

After handshake completes, derive the long-term pair key:

```rust
let h = state.get_handshake_hash(); // BLAKE2s-256 of the handshake transcript
let pair_key = hkdf_extract_then_expand(salt = b"marklig-pair-v1", ikm = h, info = b"pair-key", out_len = 32);
let pair_id  = hkdf_extract_then_expand(salt = b"marklig-pair-v1", ikm = h, info = b"pair-id",  out_len = 16);
```

Use the `hkdf` crate (`Hkdf::<Sha256>::new(...).expand(...)`). Document why we use SHA-256 for HKDF even though Noise picked BLAKE2s — HKDF is a separate KDF; consistency-with-Noise isn't required.

- [ ] **Step 5: Tests**

```rust
#[test]
fn handshake_roundtrip_yields_equal_pair_keys() {
    let init_static = snow::Builder::new(noise_pattern()).generate_keypair().unwrap();
    let resp_static = snow::Builder::new(noise_pattern()).generate_keypair().unwrap();

    let mut initiator = HandshakeInitiator::new(&init_static.private.try_into().unwrap(), &resp_static.public.try_into().unwrap()).unwrap();
    let mut responder = HandshakeResponder::new(&resp_static.private.try_into().unwrap()).unwrap();

    // XK is a 3-message handshake: e, ee, s, es / s, se / …
    let mut buf = Vec::new();
    initiator.write_message(&mut buf).unwrap(); responder.read_message(&buf).unwrap(); buf.clear();
    responder.write_message(&mut buf).unwrap(); initiator.read_message(&buf).unwrap(); buf.clear();
    initiator.write_message(&mut buf).unwrap(); responder.read_message(&buf).unwrap();

    let it = initiator.finish().unwrap();
    let rt = responder.finish().unwrap();
    assert_eq!(it.pair_key.0, rt.pair_key.0);
    assert_eq!(it.pair_id,    rt.pair_id);
}

#[test]
fn handshake_rejects_wrong_responder_pubkey() { /* … */ }

#[test]
fn qr_codec_roundtrip() { /* … */ }
```

**Commit:** `jj desc -m "Noise XK pairing handshake + QR payload codec"`, then `jj new`.

---

## Task 3: `envelope` module — ChaCha20-Poly1305 + HKDF per-file keys

**Files:**
- Create: `crates/marklig-sync-core/src/envelope.rs`.
- Create: `crates/marklig-sync-core/tests/envelope.rs`.

- [ ] **Step 1: Envelope format**

```
[12-byte random nonce] [ChaCha20-Poly1305 ciphertext] [16-byte tag]
```

Concatenated. No AAD in v2.0 — the per-file key is already bound to `folder_id || relpath` via HKDF info, so AAD would be redundant. If we later add length-prefixing for storage-side framing, AAD will hold that prefix.

- [ ] **Step 2: API**

```rust
use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};

pub fn derive_file_key(pair_key: &PairKey, folder_id: &PairId, relpath: &str) -> [u8; 32] {
    let info = {
        let mut v = Vec::with_capacity(b"file:".len() + 16 + relpath.len());
        v.extend_from_slice(b"file:");
        v.extend_from_slice(&folder_id.0);
        v.extend_from_slice(relpath.as_bytes());
        v
    };
    hkdf_expand(&pair_key.0, &info)
}

pub fn seal(file_key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let cipher = ChaCha20Poly1305::new(file_key.into());
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce)?;
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plaintext)?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend(ct);
    Ok(out)
}

pub fn open(file_key: &[u8; 32], wire: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    if wire.len() < 12 + 16 { return Err(EnvelopeError::Truncated); }
    let (nonce, rest) = wire.split_at(12);
    let cipher = ChaCha20Poly1305::new(file_key.into());
    cipher.decrypt(Nonce::from_slice(nonce), rest).map_err(|_| EnvelopeError::AuthFailed)
}
```

- [ ] **Step 3: Tests**

```rust
#[test]
fn seal_open_roundtrip() {
    let key = [7u8; 32];
    let pt = b"hello, m\xc3\xa4rklig";
    let wire = seal(&key, pt).unwrap();
    let dec = open(&key, &wire).unwrap();
    assert_eq!(&dec, pt);
}

#[test]
fn tampering_with_ciphertext_fails_auth() {
    let key = [7u8; 32];
    let mut wire = seal(&key, b"x").unwrap();
    wire[wire.len() - 1] ^= 1; // flip a tag bit
    assert!(matches!(open(&key, &wire), Err(EnvelopeError::AuthFailed)));
}

#[test]
fn distinct_per_file_keys() {
    let pk = PairKey([3u8; 32]);
    let fid = PairId([9u8; 16]);
    let k1 = derive_file_key(&pk, &fid, "a.md");
    let k2 = derive_file_key(&pk, &fid, "b.md");
    assert_ne!(k1, k2);
}

#[test]
fn rfc_test_vector_compat() {
    // RFC 8439 §2.6.2 test vector for ChaCha20-Poly1305 to sanity-check
    // that we're using the same primitive specification.
}
```

**Commit:** `jj desc -m "Per-file ChaCha20-Poly1305 envelope with HKDF-derived keys"`, then `jj new`.

---

## Task 4: `ops` module — sync op log

**Files:**
- Create: `crates/marklig-sync-core/src/ops.rs`.
- Create: `crates/marklig-sync-core/tests/ops.rs`.

- [ ] **Step 1: Op format**

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Op {
    pub kind: OpKind,
    pub relpath: String,
    pub hash: [u8; 32],
    pub mtime_logical: u64,
    pub ciphertext_ref: Option<[u8; 16]>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpKind { Put, Delete }
```

- [ ] **Step 2: Lamport clock helper**

```rust
pub struct LamportClock(u64);

impl LamportClock {
    pub fn new() -> Self { LamportClock(0) }
    pub fn observe(&mut self, peer_mtime: u64) {
        self.0 = self.0.max(peer_mtime);
    }
    pub fn tick(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}
```

Per spec §7: `mtime_logical` is a Lamport-style counter per side, not wall-clock.

- [ ] **Step 3: Conflict resolution function**

Deterministic resolution per spec §7: `(higher mtime_logical, lexicographically larger hash)`.

```rust
pub fn resolve(a: &Op, b: &Op) -> &Op { /* … */ }
```

- [ ] **Step 4: Tests**

Serde round-trip, Lamport monotonicity, conflict resolver determinism (sample table of cases).

**Commit:** `jj desc -m "Sync op log + Lamport clock + deterministic conflict resolution"`, then `jj new`.

---

## Task 5: `pair_cli` binary — two-process loopback

**Files:**
- Create: `crates/marklig-sync-core/src/bin/pair_cli.rs`.

- [ ] **Step 1: CLI shape**

```
pair_cli generate-keys                       → prints two base64 static keypairs
pair_cli responder --key <priv-b64>          → prints QR payload, reads/writes handshake bytes via stdin/stdout (length-prefixed frames)
pair_cli initiator --qr <payload> --key …    → ditto, completes the handshake
```

The two processes can be wired with `mkfifo` or with a shell script using socat. This is for the human-friendly verification; the actual handshake unit test in `tests/pair.rs` uses in-memory loopback.

**Commit:** `jj desc -m "pair_cli: two-process handshake driver"`, then `jj new`.

---

## Task 6: Integration — `cargo check --workspace` + `cargo test`

**Files:** none

- [ ] **Step 1: Run the full workspace test**

```bash
cargo test --workspace
```

Expected: marklig-sync-core's tests pass; src-tauri's existing tests (none currently) don't regress.

- [ ] **Step 2: Frontend untouched**

`npx tsc -b --noEmit` and `npm test` continue to pass.

- [ ] **Step 3: Mobile build sanity**

```bash
NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | tail -1)" \
  cargo check --target aarch64-linux-android -p marklig-sync-core
```

The crate must compile for Android too — verifies our dependency choices (snow, chacha20poly1305, hkdf) all support `aarch64-linux-android`. If any dep is gated, swap it.

**Commit:** None (verification only).

---

## Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: CLAUDE.md note**

Add a short paragraph under "Rust shell" pointing at the new workspace crate:

```markdown
### Sync crypto (workspace crate)

`crates/marklig-sync-core` holds the E2E-encrypted pairing handshake,
the per-file envelope, and the sync op log format. Pure Rust; no
dependency on Tauri. Loopback-tested via cargo test. Wired into
src-tauri as a path dep. Eventually exposed to the JS shell via Tauri
commands (step 5+) and to a phone-side caller via the FFI / Kotlin
bridge (step 7).
```

- [ ] **Step 2: ROADMAP step 4 → ✅**

**Commit:** `jj desc -m "Document marklig-sync-core"`, then `jj new`.

---

## Final checks

- [ ] All seven tasks committed on `issue-70-mobile-step4`.
- [ ] `cargo test --workspace` passes.
- [ ] `cargo check --target aarch64-linux-android -p marklig-sync-core` passes.
- [ ] Desktop UI build passes (`npm run tauri:build -- --bundles app`).
- [ ] PR opened against `trunk` (or stacked on whatever step-3 lands on).

## What this plan does NOT deliver

- Any **transport** (LAN, WebRTC, or otherwise) — step 6.
- Any **UI** for pairing — step 5 (desktop) and step 7 (phone).
- Relay-server interaction — v2.1+.
- Cross-device replay-attack guards beyond what Noise XK forward secrecy gives.
- Key rotation. v2.0 uses a single long-lived pair key. Rotation is a v2.x concern.

## Risks

- **Noise XK familiarity.** snow's API is small but easy to misuse around handshake-state ownership. Compensate by leaning on the test vectors and the upstream example.
- **`getrandom` on Android.** Must use the `getrandom` crate's Android path (works out of the box on aarch64-linux-android; verified by Task 6 Step 3).
- **Public ABI stability.** Once a phone is in the wild with a derived pair key, changing the HKDF info strings invalidates every paired device. Mark those strings explicitly as a stability boundary in the code comments.
