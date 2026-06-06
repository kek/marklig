# Live / push sync — design spec

**Issue:** #97  
**Scope:** Desktop-to-phone live sync via persistent op log + long-lived WebSocket session.  
**Relation to prior work:** Extends the one-shot pull flow shipped in steps 6–7 (PR #88–#93). Reuses `marklig-sync-core::ops`, the WS server in `pairing_ws.rs`, and the `notify-debouncer-full` watcher pattern from `folder_watcher.rs`.

---

## 1. Motivation

Today's sync is a full-snapshot pull: the phone triggers `mobile_sync_now`, which opens a WS, receives every `.md` in every synced folder, closes the socket, and returns. Problems this creates:

- Files deleted on the desktop never disappear from the phone.
- The phone only gets new content when the user manually pulls (or the 5-min auto-timer fires).
- The Lamport-ordered `Op` log and `ciphertext_ref` blob pointer in `marklig-sync-core::ops` exist in code but are unused on the wire.

This spec upgrades to **continuous push**: the desktop maintains an append-only op log per folder pair, a long-lived WS session replays ops since the phone's cursor and then streams new ops as files change, and the phone holds a reconnecting foreground-only session that applies ops live.

---

## 2. Architecture overview

```
Desktop                          Phone
──────────────────────────────   ─────────────────────────────
OpLog (jsonl) ──────────────────►  cursor per (pair, folder)
BlobStore (flat files)           tauri-plugin-store
     ▲                                    │
FolderWatcher (notify)                    ▼
     │                           WS client (reconnecting)
     ▼                                    │
SyncSessionRegistry ──── WS ────►  applyOp()
(mpsc per session)               ├─ put  → write file, advance cursor
                                 ├─ delete → rm file, advance cursor
                                 └─ open-doc reload / orphan notice
```

---

## 3. Op log and blob store

### 3.1 On-disk layout

```
<app_data>/
  sync/
    <pair_id_hex>/
      <folder_id_hex>/
        oplog.jsonl          ← append-only, one JSON line per Op
        blobs/
          <ref_hex>          ← sealed ciphertext, named by ciphertext_ref
```

One directory per `(pair_id, folder_id)` tuple. `folder_id` is already computed deterministically by `pair_id_from_folder()` in `pairing_ws.rs` — that function moves to `pairing.rs` (shared).

### 3.2 Op log format

Each line is a JSON-serialised `LoggedOp`:

```json
{
  "kind": "Put",
  "relpath": "notes/foo.md",
  "hash_hex": "abc123...",
  "mtime_logical": 42,
  "ciphertext_ref_hex": "deadbeef..."
}
```

`ciphertext_ref_hex` is present for Put ops, absent for Delete. The 16 bytes are drawn from `rand::random::<[u8;16]>()` — random, not content-addressed — so a future relay cannot correlate same-content blobs across pairs (spec §7 property).

Deduplication: before appending a new Put, compare the candidate `hash` against the log's current head-state for that relpath. If the hash is unchanged, no op or blob is written (content is identical).

### 3.3 `OpLog` API (in `marklig-sync-core::ops`)

```rust
pub struct OpLog {
    dir: PathBuf,  // <app_data>/sync/<pair_id>/<folder_id>/
}

impl OpLog {
    pub fn open(dir: &Path) -> Result<Self, SyncError>;
    /// Append a Put op. Writes blob first, then the log line.
    pub fn append_put(
        &mut self,
        relpath: &str,
        plaintext: &[u8],
        file_key: &[u8; 32],   // from envelope::derive_file_key
        clock: &mut LamportClock,
    ) -> Result<LoggedOp, SyncError>;
    /// Append a Delete op.
    pub fn append_delete(
        &mut self,
        relpath: &str,
        clock: &mut LamportClock,
    ) -> Result<LoggedOp, SyncError>;
    /// Read the ciphertext for a given ref. Returns None if blob missing.
    pub fn read_blob(&self, ciphertext_ref: &[u8; 16]) -> Option<Vec<u8>>;
    /// Iterate ops with mtime_logical > cursor, in append order.
    pub fn ops_since(&self, cursor: u64) -> impl Iterator<Item = Result<LoggedOp, SyncError>> + '_;
    /// Latest op per relpath (head-state). Used to check for dedup and
    /// to seed compaction.
    pub fn head_state(&self) -> Result<HashMap<String, LoggedOp>, SyncError>;
    /// Compact: rewrite oplog to contain only the latest op per relpath
    /// (plus tombstones for relpath not present in FS). Sweep blobs not
    /// referenced by any surviving op. Returns (ops_removed, blobs_removed).
    pub fn compact(&mut self) -> Result<(usize, usize), SyncError>;
}
```

`OpLog` is pure Rust; it does not depend on Tauri. Tests live in `crates/marklig-sync-core/tests/oplog.rs`.

### 3.4 Compaction

Compaction keeps the latest op per relpath and deletes all prior ones, then sweeps the `blobs/` directory for refs no longer referenced by any surviving op. Triggered:
- Automatically after `folder_sync_disable` (log for that folder is deleted entirely — no compaction needed, just `rm -rf`).
- On-demand via a new Tauri command `sync_compact` (desktop-only, for diagnostics/settings).
- Opportunistically at app startup, if the log for a folder exceeds 1 000 ops.

---

## 4. Maintaining the op log

### 4.1 Seed on `folder_sync_enable`

When the user enables sync for a folder:
1. Create the `<app_data>/sync/<pair_id>/<folder_id>/` directory.
2. Walk the folder (reusing `walk_markdown` from `pairing_ws.rs`).
3. For each `.md`: `oplog.append_put(relpath, contents, file_key, clock)`.
4. Persist the Lamport clock value in the pairing registry alongside the folder entry.

### 4.2 Drift reconciliation on startup

At desktop startup, for each registered `(pair_id, folder_id)`:
1. Load `head_state()` from the op log.
2. Walk the current FS.
3. For each FS file not in head-state **or** whose SHA-256 differs from the logged hash → `append_put`.
4. For each relpath in head-state (Put) not present on FS → `append_delete`.

This catches any changes that occurred while the app was not running.

### 4.3 Live watcher

One `notify-debouncer-full` watcher per **distinct folder path** (not per pair — the same folder may be shared with multiple pairs). Stored in a new `SyncWatcherState` (mirrors `FolderWatcherState`).

On debounced events for a path under `root`:
1. Identify the relpath.
2. For each pair that syncs this folder:
   a. Compute `file_key` for `(pair_id, folder_id, relpath)`.
   b. `oplog.append_put` or `oplog.append_delete` depending on event kind.
   c. Fan-out the `LoggedOp` to `SyncSessionRegistry::push(pair_id, op)`.

The watcher ignores hidden dirs, `node_modules`, and non-markdown files (same filter as `walk_markdown`).

---

## 5. Persistent WS session

### 5.1 Subscribe frame (replaces `sync_request`)

The phone sends a single opening text frame:

```json
{
  "type": "subscribe",
  "pair_id": "<pair_id_hex>",
  "cursors": {
    "<folder_id_hex>": 42,
    "<folder_id_hex2>": 0
  }
}
```

`cursor = 0` means "I have nothing; send full state." Old phones sending `{"type":"sync_request",...}` continue to get the legacy one-shot snapshot (the existing `handle_sync_request` path is kept as a fallback, gated on the `type` field).

### 5.2 Replay + live stream

On `subscribe`:
1. Authenticate `pair_id` against the registry (same as today).
2. For each folder in `cursors`:
   - Iterate `oplog.ops_since(cursor)`.
   - Send each op as `op_put` or `op_delete` (see §5.3).
3. Send `{"type":"caught_up"}` — the phone's cursor is now current.
4. Register this `(pair_id, sender)` in `SyncSessionRegistry`.
5. Keep the socket open. The watcher fan-out (§4.3) delivers new ops via the channel; the session task forwards them to the phone.
6. Heartbeat: send `{"type":"ping"}` every 30 s; expect `{"type":"pong"}` within 10 s or tear down.

### 5.3 Wire frames

```json
// Put
{
  "type": "op_put",
  "folder_id_hex": "...",
  "relpath": "notes/foo.md",
  "mtime_logical": 43,
  "ciphertext_b64": "..."
}

// Delete
{
  "type": "op_delete",
  "folder_id_hex": "...",
  "relpath": "notes/foo.md",
  "mtime_logical": 44
}

// Caught up
{ "type": "caught_up" }

// Ping/pong
{ "type": "ping" }
{ "type": "pong" }
```

`ciphertext_b64` is read from the blob store by `ciphertext_ref`. If the blob is missing (corruption/compaction race), the op is skipped and `{"type":"error","reason":"blob missing","relpath":"..."}` is sent; the phone tolerates this and requests a full resync at next connect (cursor → 0 for that folder).

### 5.4 `SyncSessionRegistry`

```rust
pub struct SyncSessionRegistry {
    sessions: Mutex<HashMap<String, Vec<mpsc::Sender<LoggedOp>>>>,
    // keyed by pair_id_hex; multiple sessions (future: multi-device) supported
}

impl SyncSessionRegistry {
    pub fn register(&self, pair_id_hex: &str, tx: mpsc::Sender<LoggedOp>);
    pub fn unregister(&self, pair_id_hex: &str, tx_id: usize);
    pub fn push(&self, pair_id_hex: &str, op: &LoggedOp);
}
```

`push` fans out to all registered senders for that pair; drops dead senders (closed channels) automatically.

---

## 6. Phone client

### 6.1 Connection policy

**Foreground-only**: connect when `document.visibilityState` becomes `"visible"` (via `visibilitychange` event — the same hook `mobile-synced-view.ts` uses for auto-sync today); disconnect when it becomes `"hidden"`. Avoids keeping a mobile radio active in the background.

**Reconnect**: capped exponential backoff starting at 2 s, doubling up to 60 s. Off-LAN or desktop unreachable → connect fails → backoff; once the user is back on LAN, the next backoff tick connects and replays from cursor.

### 6.2 Cursor persistence

Per-folder cursors stored in `tauri-plugin-store` under `mobile.sync_cursors`:

```json
{
  "<pair_id_hex>": {
    "<folder_id_hex>": 42
  }
}
```

Cursor advances to the received op's `mtime_logical` after a successful write. Cursor is **not** advanced speculatively (before the write).

On connect, the phone sends `cursors` for every folder of this pair. Folder cursors not present on the phone (e.g. a new folder enabled on the desktop after last sync) default to 0.

### 6.3 Applying ops

**`op_put`**:
1. Decrypt via `envelope::open(file_key, ciphertext)`.
2. Write plaintext to `<app_data>/synced/<pair_id>/<folder_id>/<relpath>` (same path convention as today).
3. Update `mobile.synced_files` index entry for this file.
4. Advance cursor for `folder_id`.
5. **Open-doc reload**: if this is the currently displayed file, reload content preserving scroll position (same behaviour as desktop clean-buffer reconcile in `watcher.ts`).

**`op_delete`**:
1. Delete `<app_data>/synced/<pair_id>/<folder_id>/<relpath>`.
2. Remove from `mobile.synced_files` index.
3. Advance cursor.
4. **Orphan notice**: if this is the currently displayed file, show an orphan notice ("Removed on desktop") and navigate back to the library after a short delay.

**`caught_up`**: emit `sync:caught-up` Tauri event (JS can update a "last synced" timestamp in the UI).

**`error`** (blob-missing): reset the affected folder's cursor to 0 in the store; it will replay the full state at next connect.

### 6.4 `SyncClient` (TypeScript, `src/shell/mobile-sync-client.ts`)

```ts
export class SyncClient {
  constructor(pair: MobilePairing);
  start(): void;   // begin connect/reconnect loop
  stop(): void;    // disconnect + cancel backoff
}
```

`start()` is called from `mobile-bootstrap.ts` when the app enters foreground with a paired desktop configured. `stop()` on background. The class owns the reconnect timer and the WebSocket lifecycle.

---

## 7. `folder_sync_disable` and `unpair` teardown

- `folder_sync_disable(pair_id, folder)`:
  1. Tear down the session (send `{type:"unsubscribed"}` frame if still connected).
  2. Remove the folder from `SyncWatcherState` (stop watching if no other pair uses it).
  3. Delete `<app_data>/sync/<pair_id>/<folder_id>/` (log + blobs).
  4. Update the pairing registry.

- `unpair(pair_id)`:
  - Iterate all folders for this pair; run the above per folder.
  - Drop all sessions from `SyncSessionRegistry`.

---

## 8. Security model (no change to prior spec)

The WS channel remains plaintext; op metadata (relpaths, timestamps) is visible to a LAN observer, but content is sealed via ChaCha20-Poly1305. Per-file keys are derived from `(pair_key, folder_id, relpath)`. Auth is still `pair_id`-over-LAN (see `pairing_ws.rs` comment); the v2.1 relay spec tightens this with mutual Noise transport-phase auth.

---

## 9. Backwards compatibility

Old phones (sending `{"type":"sync_request","pair_id":"..."}`) continue to receive a one-shot snapshot from the legacy path in `handle_sync_request`. They do not benefit from live push. No breaking change to the pairing protocol.

---

## 10. Testing

| Layer | Test | Location |
|---|---|---|
| `OpLog` append/replay/compaction | Unit tests, pure Rust | `crates/marklig-sync-core/tests/oplog.rs` |
| Dedup (same hash → no op) | Unit test | same |
| Lamport clock advancement | Unit test | same |
| Desktop: seed + reconcile | Integration test; stubs `AppHandle` store | `src-tauri/tests/sync_log.rs` |
| Desktop: watcher fan-out → session push | Integration test with in-process mpsc | same |
| Phone: cursor advance, `op_put`/`op_delete`, open-doc reload | Vitest with mock WS and mock store | `tests/shell/mobile-sync-client.test.ts` |
| E2E two-device full round-trip | On-device verification only (no Playwright) | — |

---

## 11. File structure

```
crates/marklig-sync-core/src/
  ops.rs                   ← add OpLog, LoggedOp, SyncError (extends existing)
  lib.rs                   ← re-export OpLog

src-tauri/src/
  commands/
    mobile_sync.rs         ← add reconcile_folder, sync_compact commands; keep legacy mobile_sync_now
  pairing_ws.rs            ← replace handle_sync_request with subscribe path; keep legacy fallback
  sync_session.rs          (NEW) SyncSessionRegistry + session task
  sync_watcher.rs          (NEW) SyncWatcherState + watcher startup
  lib.rs                   ← manage SyncSessionRegistry + SyncWatcherState; run reconcile on startup

src/
  shell/
    mobile-sync-client.ts  (NEW) SyncClient (reconnecting WS + cursor + apply)
    mobile-pairings.ts     ← start/stop SyncClient on foreground/background
  ui/
    mobile-synced-view.ts  ← handle sync:caught-up event; open-doc reload on live op
  i18n/strings.ts          ← add "sync.orphan_deleted" key

tests/
  shell/
    mobile-sync-client.test.ts  (NEW)

crates/marklig-sync-core/tests/
  oplog.rs                 (NEW)

src-tauri/tests/
  sync_log.rs              (NEW)
```

---

## 12. Decisions recorded

- **Blob keyed by random `ciphertext_ref`**, not content hash: preserves relay anti-correlation property from spec §7. Within-pair dedup is by op-level `hash` comparison before writing.
- **Foreground-only phone connection**: avoids mobile radio cost; off-LAN gaps are healed by cursor replay on reconnect.
- **One watcher per folder path, not per pair**: folders shared across pairs fan out to all pairs' logs from one watcher.
- **Legacy `sync_request` path kept intact**: old phones get a snapshot, no breakage.
- **Compaction threshold of 1 000 ops**: arbitrary but safe; markdown trees are small. Revisit if real-world logs exceed this routinely.
- **Blob-missing → cursor reset to 0**: simple and correct. A smarter gap-fill (re-request single op) is not worth the complexity for the LAN case.
