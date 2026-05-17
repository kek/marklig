# Mobile companion — Step 5: Desktop pairing UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new desktop surfaces that drive the pairing flow end-to-end on the desktop side:

1. A **pairing modal** showing the QR code from `marklig-sync-core::pair::QrPayload`.
2. A **Settings → Pairings** pane listing paired phones (verification fingerprint, per-folder sync state, unpair button).
3. A **per-folder "Sync this folder to phone…" menu action** in the folder-tree sidebar context menu.

Together they let a user say "share this folder of notes with my phone" without leaving the desktop app. The actual handshake speaker (LAN transport) is step 6; here we wire the UI to `marklig-sync-core` via Tauri commands and stub the network leg with an in-memory `Pin<Box<dyn AsyncRead + AsyncWrite>>` until step 6.

**Architecture:** New Tauri commands (`pairing_start`, `pairing_continue`, `pairing_complete`, `pairing_list`, `pairing_unpair`, `folder_sync_enable`, `folder_sync_disable`) drive a desktop-side state machine that owns `marklig-sync-core` handshake state and a `tauri-plugin-store`-backed registry of pairs and folder bindings. UI in the existing decorated-source / vanilla DOM style — no new framework.

**Tech stack additions:**
- `qrcode` crate (desktop-only) to render the QR payload as an SVG that the frontend embeds.
- `tokio` for the future async transport (already in scope via `tauri`; the channel mock for step 5 uses `tokio::sync::mpsc`).

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §6.1 (pairing protocol), §8 (desktop changes), §10 (library wireframe alignment).

**VCS note:** jj repo — see prior plans.

---

## Scope boundaries

In scope:
- Desktop UI for: showing the QR, listing pairings, per-folder sync toggle.
- Tauri commands wrapping `marklig-sync-core`.
- A persistent registry (in `tauri-plugin-store`) keyed by `PairId` storing `{pair_id, pair_key_handle, paired_at, last_seen_at, friendly_name, synced_folders: [folder_path]}`. The `pair_key_handle` is an OS keychain identifier on macOS (Keychain Services); Windows / Linux store the key bytes encrypted at rest via `tauri-plugin-stronghold` *or* a small local-encrypted-blob shim (deferred decision — flag for review).
- An in-memory "fake transport" for unit-testing the pairing state machine without network.

Out of scope (later):
- LAN discovery / TCP / WebRTC — step 6.
- Sync engine that consumes the registry to push files — step 6 / 7.
- Phone-side pairing UI — step 7.
- Relay — v2.1+.

---

## File structure

```
viewer/
├── src-tauri/src/
│   ├── pairing/                              (NEW module)
│   │   ├── mod.rs
│   │   ├── state.rs                          ← PairingMachine + registry
│   │   ├── store.rs                          ← persistent registry helpers
│   │   ├── keychain.rs                       ← per-OS pair-key storage
│   │   └── commands.rs                       ← Tauri commands
│   ├── lib.rs                                (mod) register pairing module, gate on cfg(desktop)
│   └── Cargo.toml                            (mod) add qrcode crate
├── src/
│   ├── ui/
│   │   ├── pairing-modal.ts                  (NEW) QR + verification fingerprint + cancel
│   │   ├── pairings-pane.ts                  (NEW) Settings → Pairings list / unpair
│   │   └── sidebar/folder.ts                 (mod) "Sync this folder to phone…" context-menu item
│   ├── shell/
│   │   └── pairings.ts                       (NEW) JS shape over the Tauri commands
│   └── i18n/strings.ts                       (mod) pairing keys
├── tests/
│   └── shell/
│       └── pairings.test.ts                  (NEW) unit tests for the JS shape (mock Tauri)
├── CLAUDE.md                                 (mod)
├── ROADMAP.md                                (mod)
└── docs/images/desktop-pairing-modal.png     (NEW) screenshot for the PR
```

---

## Task 1: Pair-key persistence

**Files:** `src-tauri/src/pairing/keychain.rs`.

- [ ] **Step 1: Pick a strategy per OS**

| OS | Strategy | Crate |
|---|---|---|
| macOS | Keychain Services (login keychain, generic password item with service=`se.karleklund.marklig`, account=`pair:<pair_id_hex>`) | `security-framework` |
| Windows | Credential Manager (`CRED_TYPE_GENERIC`) | `windows-credentials` or `wincred` |
| Linux | libsecret via D-Bus | `secret-service` |

Each backend stores 32 raw bytes. The pairing state holds a `PairKeyHandle` (OS-specific opaque) that resolves to bytes on demand.

- [ ] **Step 2: Trait + impls**

```rust
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;

pub trait PairKeyStore: Send + Sync {
    fn put(&self, pair_id: &PairId, key: &PairKey) -> Result<(), KeyStoreError>;
    fn get(&self, pair_id: &PairId) -> Result<PairKey, KeyStoreError>;
    fn delete(&self, pair_id: &PairId) -> Result<(), KeyStoreError>;
}
```

Tests stub this with an in-memory `HashMap<PairId, PairKey>` for the state-machine tests in Task 2.

**Commit:** `jj desc -m "Pair-key keychain backends (macOS / Windows / Linux)"`, then `jj new`.

---

## Task 2: `PairingMachine` state machine

**Files:** `src-tauri/src/pairing/state.rs`.

- [ ] **Step 1: States**

```
Idle
  → start() → Awaiting(transport, responder_state, payload)
Awaiting(...)
  → on incoming msg → Handshaking(... initiator messages incoming)
Handshaking(...)
  → handshake completes → Verifying(fingerprint)
Verifying(...)
  → user confirms → Established(pair_id, pair_key)
Verifying(...)
  → user cancels → Idle
```

The state machine owns:
- `snow::HandshakeState` (responder).
- The static key for this desktop (loaded from keychain at first run; persisted as `desktop_static_key` under a stable handle).
- A channel pair (the "transport" — for step 5 this is a `tokio::sync::mpsc` mock; step 6 replaces it with a TCP socket).

- [ ] **Step 2: Tests**

Drive a full handshake using two `PairingMachine` instances back-to-back (one as initiator, one as responder, communicating via in-memory channels). Assert both reach `Established` with equal `pair_id` and `pair_key`.

**Commit:** `jj desc -m "PairingMachine state machine + in-memory transport tests"`, then `jj new`.

---

## Task 3: Persistent registry

**Files:** `src-tauri/src/pairing/store.rs`.

- [ ] **Step 1: Schema**

Stored in `tauri-plugin-store` (or a sibling JSON if isolating from the UI store is desirable). Schema:

```json
{
  "pairings": {
    "<pair_id_hex>": {
      "pair_id_hex": "...",
      "friendly_name": "Pixel 8 Pro",
      "paired_at_unix": 1715900000,
      "last_seen_at_unix": 1715900100,
      "verification_fingerprint": "AB-12-3C",
      "synced_folders": ["/Users/ke/Notes", "/Users/ke/Work"]
    }
  }
}
```

`friendly_name` is read from the phone during the handshake (a small extension to the Noise prologue — declare a 1-byte length prefix + UTF-8 string).

- [ ] **Step 2: API**

```rust
pub fn list_pairings(app: &AppHandle) -> Result<Vec<PairingMeta>, _>;
pub fn add_pairing(app: &AppHandle, meta: PairingMeta) -> Result<(), _>;
pub fn remove_pairing(app: &AppHandle, pair_id: &PairId) -> Result<(), _>;
pub fn add_synced_folder(app: &AppHandle, pair_id: &PairId, folder: &Path) -> Result<(), _>;
pub fn remove_synced_folder(app: &AppHandle, pair_id: &PairId, folder: &Path) -> Result<(), _>;
```

`remove_pairing` also deletes the keychain entry.

**Commit:** `jj desc -m "Persistent pairing registry"`, then `jj new`.

---

## Task 4: Tauri commands

**Files:** `src-tauri/src/pairing/commands.rs`, `src-tauri/src/lib.rs`.

- [ ] **Step 1: Commands**

```rust
#[tauri::command]
pub async fn pairing_start(app: AppHandle) -> Result<PairingStarted, _>;
//   Returns { qr_payload: String, qr_svg: String, verification_fingerprint: String }

#[tauri::command]
pub async fn pairing_complete(app: AppHandle, confirm: bool) -> Result<Option<PairingMeta>, _>;

#[tauri::command]
pub fn pairing_list(app: AppHandle) -> Result<Vec<PairingMeta>, _>;

#[tauri::command]
pub fn pairing_unpair(app: AppHandle, pair_id_hex: String) -> Result<(), _>;

#[tauri::command]
pub fn folder_sync_enable(app: AppHandle, pair_id_hex: String, folder: String) -> Result<(), _>;

#[tauri::command]
pub fn folder_sync_disable(app: AppHandle, pair_id_hex: String, folder: String) -> Result<(), _>;
```

Gated on `cfg(desktop)`. Register in `lib.rs`'s desktop-only invoke handler.

- [ ] **Step 2: Events**

Emit `pairing:state-changed` from the machine so the modal can update without polling.

**Commit:** `jj desc -m "Pairing Tauri commands + state-change events"`, then `jj new`.

---

## Task 5: Pairing modal UI

**Files:** `src/ui/pairing-modal.ts`, `src/shell/pairings.ts`, `src/i18n/strings.ts`.

- [ ] **Step 1: i18n keys**

```ts
"pairing.modal.title": "Pair with a phone",
"pairing.modal.scan_hint": "Open Märklig on your phone and scan this QR code.",
"pairing.modal.verification_hint": "Read this code aloud and confirm it matches on your phone:",
"pairing.modal.confirm": "Confirm pairing",
"pairing.modal.cancel": "Cancel",
"pairing.modal.success": "Paired with {name}.",
"pairing.modal.failed": "Pairing failed: {reason}",
```

- [ ] **Step 2: Modal layout**

```
┌──────────────────────────────────────┐
│ Pair with a phone           [×]      │
├──────────────────────────────────────┤
│                                      │
│        [    QR CODE 256x256    ]     │
│                                      │
│ Open Märklig on your phone and scan  │
│ this QR code.                        │
│                                      │
│ Read aloud:    AB-12-3C              │
│                                      │
│       [Cancel]   [Confirm pairing]   │
└──────────────────────────────────────┘
```

Live state: while the handshake is in progress, the QR animates to a dimmed state; once the phone has scanned (the state machine emits `verifying`), the verification fingerprint appears in large monospace.

- [ ] **Step 3: JS shape**

```ts
// src/shell/pairings.ts
export async function startPairing(): Promise<PairingStarted> { /* invoke */ }
export async function completePairing(confirm: boolean): Promise<PairingMeta | null> { /* invoke */ }
export async function listPairings(): Promise<PairingMeta[]> { /* invoke */ }
export async function unpair(pairIdHex: string): Promise<void> { /* invoke */ }
```

**Commit:** `jj desc -m "Pairing modal UI + JS shape over Tauri commands"`, then `jj new`.

---

## Task 6: Settings → Pairings pane

**Files:** `src/ui/pairings-pane.ts`, `src/ui/preferences.ts` (extend the existing prefs window).

- [ ] **Step 1: Pane layout**

```
Pairings
─────────────────────────────────────────
[ + Pair with a new phone ]

Pixel 8 Pro                  paired May 17
  Verification: AB-12-3C
  Synced folders:
    • ~/Notes                  [×]
    • ~/Work                   [×]
  [ + Add a folder ]
  [ Unpair this phone ]
─────────────────────────────────────────
```

`+ Add a folder` opens a folder picker (existing dialog); the chosen folder is path-validated and added via `folder_sync_enable`.

**Commit:** `jj desc -m "Settings -> Pairings pane"`, then `jj new`.

---

## Task 7: Per-folder context-menu item

**Files:** `src/ui/sidebar/folder.ts`.

- [ ] **Step 1: Add the menu item**

When the user right-clicks a folder in the sidebar's folder tree, the existing context menu gets a new item: **"Sync this folder to phone…"**. If no pairing exists yet, the item opens the pairing modal (and on completion, adds the folder to that new pair). If pairings exist, it shows a submenu — one item per paired phone — so the user picks which phone.

- [ ] **Step 2: i18n**

```ts
"folder.context.sync_to_phone": "Sync this folder to phone…",
"folder.context.sync_to_phone_choose": "Sync this folder to…",
```

**Commit:** `jj desc -m "Folder sidebar: Sync this folder to phone context menu"`, then `jj new`.

---

## Task 8: Tests

- [ ] **Step 1: Vitest for JS shapes**

`tests/shell/pairings.test.ts` mocks the underlying Tauri commands and validates the JS API surface.

- [ ] **Step 2: Rust integration tests**

`src-tauri/tests/pairing.rs` (new): drives a two-machine handshake, asserts the registry persists correctly across simulated app restarts.

- [ ] **Step 3: e2e smoke (Playwright)**

The Tauri-driven Playwright tests can't easily run a two-instance handshake. Skip a true e2e here; rely on the Rust tests + on-device step-7 verification.

**Commit:** `jj desc -m "Pairing tests (vitest + Rust integration)"`, then `jj new`.

---

## Task 9: Docs + screenshot

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`
- Create: `docs/images/desktop-pairing-modal.png`

Run desktop dev (`npm run tauri:dev`), open File → Pair with a phone (or the new sidebar context menu) — screenshot the modal showing a QR. Attach to the PR.

**Commit:** `jj desc -m "Document desktop pairing UX"`, then `jj new`.

---

## Final checks

- [ ] All tasks committed on `issue-70-mobile-step5`.
- [ ] `cargo test --workspace` passes.
- [ ] `npm test` + `tsc -b --noEmit` clean.
- [ ] PR opened against `trunk` (or stacked).
- [ ] Modal screenshot in PR description.

## What this plan does NOT deliver

- LAN transport — step 6 plugs into the mocked channel slot left in `PairingMachine::transport`.
- Phone-side pairing UI — step 7.
- Cross-device file sync — step 6 / 7 builds on this registry.

## Risks

- **Keychain unification across OSes is the biggest variability.** macOS Keychain via `security-framework` works well; Windows / Linux are less battle-tested in our codebase. If integration on Windows or Linux drags, fall back to encrypted-at-rest blob via `tauri-plugin-stronghold` and re-attack OS-keychain later.
- **QR scanning needs the right error-correction level on Android.** Use ECC level `L` only if the payload would otherwise overflow ~7000 bits; default to `M` for resilience against camera noise.
- **The friendly-name prologue extension** drifts subtly from a plain Noise XK. Pin it in the spec doc and protect with a version byte at the start of the prologue.
