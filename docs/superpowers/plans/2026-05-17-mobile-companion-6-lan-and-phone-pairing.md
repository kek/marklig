# Mobile companion — Steps 6+7: LAN transport + phone pairing UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a pair of (desktop, phone) actually sync over the LAN. Steps 6 and 7 are coupled — the transport (step 6) is meaningless without a phone side that drives it (step 7), and vice versa. Combining them avoids hand-rolling a fake-phone shim just to test step 6 in isolation. End-to-end: open the pairing modal on desktop → scan QR on phone → confirm fingerprint on both → folder appears in phone's library and re-renders each time you save a `.md` on desktop.

**Architecture:**

- **mDNS service `_marklig-sync._tcp`.** Desktop advertises an instance with the same name embedded in the QR payload (§6.1 of spec). Phone resolves the instance and connects.
- **Transport: direct TCP** with framed messages (`u32 length || payload`). WebRTC data channel is a v2.x fallback for AP-isolated LANs (kept explicitly deferred — the AP-isolation note in §12 of the spec acknowledged this).
- **Per-message confidentiality:** the `snow::TransportState` carried out of the pairing handshake — every frame on the channel is sealed with the next nonce in the Noise transport keys. File ciphertext from the envelope is still its own AEAD seal, so the channel layer doesn't need its own AAD on top.
- **Sync model:** on connection establishment, both sides exchange their current op log heads; whichever is behind requests + applies the missing ops. Phone is read-only in v2.0, so only desktop pushes ops — but the framing accepts ops in either direction for future bidirectionality.
- **Live updates:** desktop watches each synced folder (existing `tauri-plugin-fs-watch`) and pushes `Op::Put` / `Op::Delete` as files change.

**Tech stack additions:**
- `mdns-sd` crate (Rust) — desktop discovery + advertise.
- `tokio` already in scope.
- Phone-side mDNS via `android.net.nsd.NsdManager` through a small Kotlin bridge.

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §6.2 (transport), §7 (sync engine).

**VCS note:** jj repo.

---

## Scope boundaries

In scope:
- mDNS advertise (desktop) and resolve (phone).
- TCP connection establishment, length-prefixed framing.
- Channel layer: `snow::TransportState` for in-channel confidentiality.
- Sync wire protocol: handshake frames + op-log exchange.
- Phone-side pairing modal that scans QR + drives the handshake.
- Desktop-side per-folder watcher → push ops.
- Phone-side op-log consumption: decrypt + write to app-private storage, update library.

Out of scope (later):
- WebRTC fallback (deferred to v2.x).
- Relay (v2.1+).
- Bidirectional sync — phone is read-only in v2.0.
- iOS — v2.1+.
- Reconciliation UI when content diverges — phone is read-only so this can't happen v2.0.

---

## File structure

```
viewer/
├── crates/marklig-sync-core/src/
│   └── wire.rs                                (NEW) frame codec + op-log exchange protocol types
├── src-tauri/src/
│   ├── pairing/
│   │   ├── transport.rs                       (NEW desktop) mDNS + TCP server + channel
│   │   └── sync_engine.rs                     (NEW desktop) folder watcher → push ops
│   ├── gen/android/app/src/main/java/se/karleklund/marklig/
│   │   ├── MdnsBridge.kt                      (NEW) NsdManager-backed discovery
│   │   ├── TcpBridge.kt                       (NEW) framed-message TCP client
│   │   └── PairingBridge.kt                   (NEW) drives Noise XK from JS side
│   └── src/commands/mobile_sync.rs            (NEW mobile) bridge to Kotlin
├── src/
│   ├── shell/
│   │   ├── mobile-pairing.ts                  (NEW) phone-side pairing JS shape
│   │   └── mobile-sync.ts                     (NEW) phone-side synced-folder state
│   └── ui/
│       ├── mobile-pair-scanner.ts             (NEW) QR scan view (uses WebRTC getUserMedia)
│       └── mobile-pair-confirm.ts             (NEW) fingerprint verification
├── tests/                                     (NEW Rust integration)
│   └── pairing_lan_loopback.rs                Two-tokio-task end-to-end handshake + op exchange
└── docs/images/                               (NEW screenshots)
    ├── desktop-paired-folder.png
    └── android-paired-library.png
```

---

## Task 1: Wire protocol

**Files:** `crates/marklig-sync-core/src/wire.rs`.

- [ ] **Step 1: Frame format**

```
u32 length (big-endian)
payload bytes  ← Noise-encrypted on the established channel; pre-handshake frames are plaintext
```

- [ ] **Step 2: Message types**

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    /// Sent by both sides on connection establishment.
    Hello { protocol_version: u32, friendly_name: String },
    /// Inventory exchange: list the latest op's mtime_logical per folder_id.
    Heads { heads: Vec<(PairId, u64)> },
    /// Ask for ops > given mtime_logical for a folder.
    Request { folder_id: PairId, since: u64, limit: u32 },
    /// Op batch with ciphertext blobs attached out-of-band.
    Ops { folder_id: PairId, ops: Vec<Op>, blobs: HashMap<[u8;16], Vec<u8>> },
    /// Heartbeat to keep idle TCP connections alive.
    Ping { ts: u64 },
}
```

Tests: round-trip each variant through CBOR (or JSON if simpler).

**Commit:** `jj desc -m "Wire-format message types for sync"`, then `jj new`.

---

## Task 2: Desktop mDNS + TCP server

**Files:** `src-tauri/src/pairing/transport.rs`.

- [ ] **Step 1: Advertise**

On app start (if any paired phones exist):

```rust
let mdns = ServiceDaemon::new()?;
let info = ServiceInfo::new(
    "_marklig-sync._tcp.local.",
    /* instance */ &mdns_instance_name,
    /* host */ &hostname,
    /* ip */ ip,
    port,
    Some(&[("fingerprint", &fingerprint_hex)]),
)?;
mdns.register(info)?;
```

The instance name is whatever was embedded in the QR for the most recent unfinished pairing; once paired, switch to a per-phone deterministic name based on `PairId`.

- [ ] **Step 2: TCP listener**

`tokio::net::TcpListener::bind("0.0.0.0:0")` — system-assigned port, returned in the mDNS announcement. Accept loop spawns a tokio task per connection that drives:

1. Read `Hello` from peer.
2. Match peer's static-key fingerprint against the registry; reject unknowns unless we're mid-pairing.
3. Drive Noise XK responder (or transition into a sync session if already paired).
4. Run the op-log exchange loop.

**Commit:** `jj desc -m "Desktop mDNS advertise + TCP listener for sync"`, then `jj new`.

---

## Task 3: Desktop sync engine

**Files:** `src-tauri/src/pairing/sync_engine.rs`.

- [ ] **Step 1: Watcher per synced folder**

Already have `notify-debouncer-full` for the existing single-folder watch — reuse the pattern, one watcher per `(pair_id, folder_path)` tuple from the registry.

- [ ] **Step 2: Op generation**

On file event:
- `Put`: hash the file (`sha256`), seal contents via `envelope::seal`, store the ciphertext blob under a random `ciphertext_ref`, append `Op::Put` to the per-folder op log.
- `Delete`: append `Op::Delete`.
- Bump the Lamport clock for this folder; persist clock state to the registry.

- [ ] **Step 3: Push to connected peers**

If a phone is connected for this `pair_id`, push the new op (`Message::Ops { folder_id, ops: vec![op], blobs: {ref => ciphertext} }`).

**Commit:** `jj desc -m "Desktop sync engine: watcher -> op log -> peer push"`, then `jj new`.

---

## Task 4: Phone-side Kotlin bridges

**Files:** `MdnsBridge.kt`, `TcpBridge.kt`, `PairingBridge.kt` under the Android scaffolding.

- [ ] **Step 1: `MdnsBridge.kt`**

Uses `android.net.nsd.NsdManager`. Two flows:
- **Discover** — registers a `DiscoveryListener`, returns a Kotlin flow of `(instance_name, host, port, fingerprint)` events.
- **Resolve by instance name** — for the post-QR path, given the name from the QR payload.

- [ ] **Step 2: `TcpBridge.kt`**

Frame codec: u32-length + payload. Backed by `java.net.Socket` for v2.0 simplicity (background thread; no Netty). Exposes:
- `connect(host, port): Long` (returns a handle).
- `send(handle, bytes)`.
- `recv(handle): bytes` (blocking, callable on a background thread).
- `close(handle)`.

- [ ] **Step 3: `PairingBridge.kt`**

Owns the JS-driven handshake state machine. Receives Noise messages from JS, returns the next Noise message to send, signals when the handshake is complete (with the derived pair-key bytes for storage).

The Noise XK math itself runs in Rust via `marklig-sync-core` — the Kotlin bridge is just transport / framing.

**Commit:** `jj desc -m "Android Kotlin bridges for mDNS, TCP, and pairing"`, then `jj new`.

---

## Task 5: Phone-side Tauri commands

**Files:** `src-tauri/src/commands/mobile_sync.rs` (cfg(mobile)).

- [ ] **Step 1: Commands**

```rust
#[tauri::command] pub async fn mobile_discover_peer(name: String) -> Result<PeerInfo, _>;
#[tauri::command] pub async fn mobile_pairing_start(qr_payload: String) -> Result<PairingState, _>;
#[tauri::command] pub async fn mobile_pairing_confirm(confirm: bool) -> Result<Option<PairingMeta>, _>;
#[tauri::command] pub async fn mobile_list_synced_folders() -> Result<Vec<FolderMeta>, _>;
#[tauri::command] pub async fn mobile_list_files_in_folder(folder_id_hex: String) -> Result<Vec<FileMeta>, _>;
#[tauri::command] pub async fn mobile_read_synced_file(folder_id_hex: String, relpath: String) -> Result<String, _>;
```

Storage on the phone for synced content: `Context.getFilesDir() / synced / <pair_id_hex> / <folder_id_hex> / <relpath>` — sandboxed, persistent.

**Commit:** `jj desc -m "Phone-side sync Tauri commands"`, then `jj new`.

---

## Task 6: Phone-side UI

**Files:** `src/ui/mobile-pair-scanner.ts`, `src/ui/mobile-pair-confirm.ts`, `src/ui/mobile-library.ts` (mod), `src/shell/mobile-pairing.ts`, `src/shell/mobile-sync.ts`.

- [ ] **Step 1: QR scanner**

Uses `getUserMedia({ video: { facingMode: "environment" } })` + the BarcodeDetector API (Chrome on Android has shipped this) with a polyfill (`@zxing/browser`) for older WebViews. Pure-web — no native Kotlin needed.

- [ ] **Step 2: Confirm modal**

Shows the fingerprint that both sides must read aloud. Tap **Confirm** → `mobile_pairing_confirm(true)` → adds the pair to the recents store + adds the synced folders to the library.

- [ ] **Step 3: Library extension**

The library home (step-3) gets a new section above Recents: **Synced folders**. Each row is `<folder name>` + an icon for the originating desktop. Tapping a folder opens a folder view (a third route: `{ kind: "folder"; folder_id }`) that lists `.md` files inside.

- [ ] **Step 4: Folder view → file**

The folder view uses `mobile_list_files_in_folder` to populate. Tapping a file opens the document route, reading via `mobile_read_synced_file`.

**Commit (one per UI piece):** `jj desc -m "..."`, then `jj new`.

---

## Task 7: End-to-end loopback integration test

**Files:** `tests/pairing_lan_loopback.rs` (new in workspace root or under `crates/marklig-sync-core/tests/`).

- [ ] Two tokio tasks bind to `127.0.0.1`, advertise/resolve via mDNS *or* short-circuit through a shared mpsc channel; run a full pairing → op-log exchange → file decryption. Asserts: both sides agree on the pair, decrypted bytes equal the original.

**Commit:** `jj desc -m "End-to-end pairing + LAN sync loopback test"`, then `jj new`.

---

## Task 8: On-device smoke + screenshots

**Files:** `docs/images/desktop-paired-folder.png`, `docs/images/android-paired-library.png`.

- Desktop: `npm run tauri:dev` → open pair modal → run phone-side pairing → see the pair appear in Settings → choose a folder → "Sync to phone". Screenshot.
- Phone: same flow from the phone side — scan QR, confirm, see the synced folder appear in the library. Screenshot.

**Commit:** `jj desc -m "On-device smoke: paired folder sync"`, then `jj new`.

---

## Task 9: Docs

- `CLAUDE.md`: a new section under "Sync crypto" describing transport + sync-engine layout.
- `ROADMAP.md`: steps 6+7 → ✅.

**Commit:** `jj desc -m "Document LAN sync architecture"`, then `jj new`.

---

## Final checks

- [ ] All tasks committed on `issue-70-mobile-step6-7`.
- [ ] `cargo test --workspace` passes (including the loopback test).
- [ ] `npm test` passes.
- [ ] On-device flow verified on the Pixel + the dev desktop.
- [ ] PR opened.

## What this plan does NOT deliver

- WebRTC fallback for AP-isolated LANs.
- Bidirectional sync (phone-edits-back).
- Relay path.
- iOS.
- Sync conflict reconciliation UI (irrelevant since phone is read-only).
- Multi-device pairing UX (one desktop with two phones works at the data level, but UI is single-pair-focused).

## Risks

- **mDNS reliability on Android.** Some OEMs (older Samsungs, certain Wi-Fi calling stacks) drop mDNS in doze. The spec §12 already calls this out. v2.0 ships a manual-IP fallback in the pair modal; if mDNS fails for >2s after a QR scan, show "Couldn't find the desktop — enter its IP manually."
- **TCP NAT'd Wi-Fi.** Some guest VLANs / AP-isolation modes block peer-to-peer connections on the same SSID. Same fallback hint as above; WebRTC fallback in a later version.
- **Tokio + Tauri lifecycle.** The desktop sync engine must release watchers / sockets cleanly on app quit. Tie to Tauri's `RunEvent::ExitRequested`.
- **Phone WebView's `BarcodeDetector` API support** is shipped on modern Android Chrome (115+). Polyfill via `@zxing/browser` for older OEM WebViews.
- **Large files.** v2.0 caps single-file size at e.g. 16 MB on the wire (avoid OOM on the phone). Files > cap are skipped with a logged warning until a streaming envelope variant is added.
