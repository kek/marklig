# Live / push sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot pull sync with a persistent op-log-backed push sync: the desktop watches synced folders and streams `op_put`/`op_delete` frames over a long-lived WebSocket; the phone holds a reconnecting foreground-only session that applies ops live and keeps a per-folder cursor for gap-free replay.

**Architecture:** An append-only `OpLog` (JSONL + flat blob store) lives in `<app_data>/sync/<pair>/<folder>/` and is maintained by a `notify-debouncer-full` watcher that fans out new ops to a `SyncSessionRegistry` (tokio mpsc per session). The phone's `SyncClient` (TypeScript) subscribes with cursors, receives a replay then live ops, and applies put/delete via a new Rust command. Legacy `sync_request` clients continue to get a one-shot snapshot.

**Tech Stack:**
- Rust: `marklig-sync-core` (new `OpLog`), `serde_json` (JSONL), `getrandom` (blob ref), `notify-debouncer-full` (watcher), `tokio::sync::mpsc` (session fan-out)
- TypeScript: native browser `WebSocket`, `tauri-plugin-store` via `getValue`/`setValue`
- Tests: `cargo test --workspace`, `npm test`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `crates/marklig-sync-core/Cargo.toml` | modify | move `serde_json` to regular deps |
| `crates/marklig-sync-core/src/ops.rs` | modify | add `LoggedOp`, `SyncError`, `OpLog` |
| `crates/marklig-sync-core/src/lib.rs` | modify | re-export `OpLog`, `LoggedOp`, `SyncError` |
| `crates/marklig-sync-core/tests/oplog.rs` | create | unit tests for `OpLog` |
| `src-tauri/src/pairing_ws.rs` | modify | make `walk_markdown`, `pair_id_from_folder_hex` `pub(crate)`; add `handle_subscribe`; dispatch on frame type |
| `src-tauri/src/sync_log.rs` | create | `seed_folder`, `reconcile_folder`, `sync_dir` helpers |
| `src-tauri/src/sync_watcher.rs` | create | `SyncWatcherState`: one watcher per folder path, fan-out to op log + session registry |
| `src-tauri/src/sync_session.rs` | create | `SyncSessionRegistry`: mpsc sender map; `push` |
| `src-tauri/src/commands/mobile_sync.rs` | modify | add `mobile_apply_sync_op`, `sync_compact` commands |
| `src-tauri/src/pairing.rs` | modify | call `seed_folder` in `folder_sync_enable`; teardown in `folder_sync_disable`/`pairing_unpair` |
| `src-tauri/src/lib.rs` | modify | manage `SyncSessionRegistry` + `SyncWatcherState`; run `reconcile_folder` on setup; register new commands |
| `src/shell/mobile-sync-client.ts` | create | `SyncClient`: connect/reconnect, subscribe, apply ops, cursor |
| `src/shell/mobile-pairings.ts` | modify | start/stop `SyncClient` on `visibilitychange` |
| `src/ui/mobile-synced-view.ts` | modify | listen for `sync:live-op` → reload open doc or show orphan notice; `sync:caught-up` → update UI |
| `src/i18n/strings.ts` | modify | add `"sync.file_deleted_on_desktop"` key |
| `tests/shell/mobile-sync-client.test.ts` | create | Vitest: connect, subscribe, apply put/delete, cursor advance, reconnect |

---

## Task 1: `OpLog` in `marklig-sync-core`

**Files:**
- Modify: `crates/marklig-sync-core/Cargo.toml`
- Modify: `crates/marklig-sync-core/src/ops.rs`
- Modify: `crates/marklig-sync-core/src/lib.rs`
- Create: `crates/marklig-sync-core/tests/oplog.rs`

### Step 1.1: Move `serde_json` to regular deps

- [ ] In `crates/marklig-sync-core/Cargo.toml`, move `serde_json = "1"` from `[dev-dependencies]` to `[dependencies]`.

### Step 1.2: Write failing tests

- [ ] Create `crates/marklig-sync-core/tests/oplog.rs`:

```rust
use marklig_sync_core::ops::{LamportClock, OpKind, OpLog};

fn file_key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

#[test]
fn append_put_returns_op_and_ops_since_returns_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    let op = log.append_put("a.md", b"hello", &file_key(1), &mut clock).unwrap();
    assert!(op.is_some());
    let op = op.unwrap();
    assert_eq!(op.mtime_logical, 1);
    assert_eq!(op.relpath, "a.md");
    assert_eq!(op.kind, OpKind::Put);
    assert!(op.ciphertext_ref_hex.is_some());

    let since = log.ops_since(0).unwrap();
    assert_eq!(since.len(), 1);

    let since_after = log.ops_since(1).unwrap();
    assert!(since_after.is_empty());
}

#[test]
fn dedup_skips_identical_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    log.append_put("b.md", b"same", &file_key(2), &mut clock).unwrap();
    let dup = log.append_put("b.md", b"same", &file_key(2), &mut clock).unwrap();
    assert!(dup.is_none());
    assert_eq!(log.ops_since(0).unwrap().len(), 1);
    assert_eq!(clock.value(), 1); // clock only ticked once
}

#[test]
fn changed_content_generates_new_op() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    log.append_put("c.md", b"v1", &file_key(3), &mut clock).unwrap();
    let op2 = log.append_put("c.md", b"v2", &file_key(3), &mut clock).unwrap();
    assert!(op2.is_some());
    assert_eq!(log.ops_since(0).unwrap().len(), 2);
}

#[test]
fn delete_op_has_no_blob() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    let op = log.append_delete("gone.md", &mut clock).unwrap();
    assert_eq!(op.kind, OpKind::Delete);
    assert!(op.ciphertext_ref_hex.is_none());
    assert!(op.hash_hex.is_empty());
}

#[test]
fn head_state_keeps_latest_per_relpath() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    log.append_put("d.md", b"v1", &file_key(4), &mut clock).unwrap();
    log.append_put("d.md", b"v2", &file_key(4), &mut clock).unwrap();
    log.append_put("e.md", b"only", &file_key(4), &mut clock).unwrap();

    let head = log.head_state().unwrap();
    assert_eq!(head.len(), 2);
    assert_eq!(head["d.md"].mtime_logical, 2);
    assert_eq!(head["e.md"].mtime_logical, 3);
}

#[test]
fn compact_removes_superseded_ops_and_orphan_blobs() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();

    log.append_put("f.md", b"v1", &file_key(5), &mut clock).unwrap();
    log.append_put("f.md", b"v2", &file_key(5), &mut clock).unwrap();

    let (ops_removed, blobs_removed) = log.compact().unwrap();
    assert_eq!(ops_removed, 1);
    assert_eq!(blobs_removed, 1);
    assert_eq!(log.ops_since(0).unwrap().len(), 1);
}

#[test]
fn read_blob_round_trips_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = OpLog::open(dir.path()).unwrap();
    let mut clock = LamportClock::new();
    let key = file_key(6);

    let op = log.append_put("g.md", b"blob content", &key, &mut clock)
        .unwrap()
        .unwrap();
    let ref_hex = op.ciphertext_ref_hex.unwrap();
    let ct = log.read_blob(&ref_hex).unwrap();
    let pt = marklig_sync_core::open(&key, &ct).unwrap();
    assert_eq!(pt, b"blob content");
}

#[test]
fn ops_since_on_empty_log_returns_empty() {
    let dir = tempfile::tempdir().unwrap();
    let log = OpLog::open(dir.path()).unwrap();
    assert!(log.ops_since(0).unwrap().is_empty());
    assert!(log.head_state().unwrap().is_empty());
}
```

### Step 1.3: Confirm tests fail

- [ ] Run `cargo test -p marklig-sync-core 2>&1 | head -30`
- Expected: compile errors (types not yet defined)

### Step 1.4: Add `SyncError`, `LoggedOp`, and `OpLog` to `ops.rs`

- [ ] Append to `crates/marklig-sync-core/src/ops.rs` (after the existing imports and types):

```rust
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

// ── Error ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("envelope: {0}")]
    Envelope(String),
}

impl From<crate::envelope::EnvelopeError> for SyncError {
    fn from(e: crate::envelope::EnvelopeError) -> Self {
        SyncError::Envelope(e.to_string())
    }
}

// ── LoggedOp ───────────────────────────────────────────────────────────────

/// One entry in the on-disk op log. `ciphertext_ref_hex` is the hex name of
/// the blob file under `blobs/`; absent for Delete ops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoggedOp {
    pub kind: OpKind,
    pub relpath: String,
    /// Hex-encoded SHA-256 of the plaintext. Empty string for Delete ops.
    pub hash_hex: String,
    pub mtime_logical: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext_ref_hex: Option<String>,
}

// ── OpLog ──────────────────────────────────────────────────────────────────

/// Append-only op log for one `(pair_id, folder_id)` tuple.
///
/// On-disk layout under `dir/`:
///   oplog.jsonl    — one JSON line per `LoggedOp`, append-only
///   blobs/<hex>    — sealed ciphertext, named by `ciphertext_ref_hex`
pub struct OpLog {
    dir: PathBuf,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

impl OpLog {
    /// Open (or create) an op log rooted at `dir`.
    pub fn open(dir: &Path) -> Result<Self, SyncError> {
        fs::create_dir_all(dir)?;
        fs::create_dir_all(dir.join("blobs"))?;
        Ok(Self { dir: dir.to_path_buf() })
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("oplog.jsonl")
    }

    fn blob_path(&self, ref_hex: &str) -> PathBuf {
        self.dir.join("blobs").join(ref_hex)
    }

    fn append_line(&self, op: &LoggedOp) -> Result<(), SyncError> {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())?;
        let mut line = serde_json::to_string(op)?;
        line.push('\n');
        f.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Append a Put op. Returns `None` if the content hash matches the
    /// current head-state entry (dedup — no op written).
    pub fn append_put(
        &mut self,
        relpath: &str,
        plaintext: &[u8],
        file_key: &[u8; 32],
        clock: &mut LamportClock,
    ) -> Result<Option<LoggedOp>, SyncError> {
        use sha2::{Digest, Sha256};
        let hash_hex = hex_encode(&Sha256::digest(plaintext));

        let head = self.head_state()?;
        if let Some(existing) = head.get(relpath) {
            if existing.kind == OpKind::Put && existing.hash_hex == hash_hex {
                return Ok(None);
            }
        }

        let mut ref_bytes = [0u8; 16];
        getrandom::getrandom(&mut ref_bytes).map_err(|e| {
            SyncError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("getrandom: {e}"),
            ))
        })?;
        let ref_hex = hex_encode(&ref_bytes);

        let sealed = crate::envelope::seal(file_key, plaintext)?;
        fs::write(self.blob_path(&ref_hex), &sealed)?;

        let op = LoggedOp {
            kind: OpKind::Put,
            relpath: relpath.to_string(),
            hash_hex,
            mtime_logical: clock.tick(),
            ciphertext_ref_hex: Some(ref_hex),
        };
        self.append_line(&op)?;
        Ok(Some(op))
    }

    /// Append a Delete op.
    pub fn append_delete(
        &mut self,
        relpath: &str,
        clock: &mut LamportClock,
    ) -> Result<LoggedOp, SyncError> {
        let op = LoggedOp {
            kind: OpKind::Delete,
            relpath: relpath.to_string(),
            hash_hex: String::new(),
            mtime_logical: clock.tick(),
            ciphertext_ref_hex: None,
        };
        self.append_line(&op)?;
        Ok(op)
    }

    /// Read the sealed ciphertext for a blob reference.
    pub fn read_blob(&self, ref_hex: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path(ref_hex)).ok()
    }

    /// All ops with `mtime_logical > cursor`, in log order.
    pub fn ops_since(&self, cursor: u64) -> Result<Vec<LoggedOp>, SyncError> {
        let file = match fs::File::open(self.log_path()) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let op: LoggedOp = serde_json::from_str(&line)?;
            if op.mtime_logical > cursor {
                out.push(op);
            }
        }
        Ok(out)
    }

    /// Latest op per relpath across the entire log.
    pub fn head_state(&self) -> Result<HashMap<String, LoggedOp>, SyncError> {
        let file = match fs::File::open(self.log_path()) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HashMap::new())
            }
            Err(e) => return Err(e.into()),
        };
        let mut map = HashMap::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let op: LoggedOp = serde_json::from_str(&line)?;
            map.insert(op.relpath.clone(), op);
        }
        Ok(map)
    }

    /// Max `mtime_logical` across all log entries. Used to seed a
    /// `LamportClock` at startup without loading the whole head state.
    pub fn max_mtime(&self) -> Result<u64, SyncError> {
        let file = match fs::File::open(self.log_path()) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let mut max = 0u64;
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let op: LoggedOp = serde_json::from_str(&line)?;
            if op.mtime_logical > max {
                max = op.mtime_logical;
            }
        }
        Ok(max)
    }

    /// Rewrite the log keeping only the latest op per relpath; sweep orphan
    /// blobs. Returns `(ops_removed, blobs_removed)`.
    pub fn compact(&mut self) -> Result<(usize, usize), SyncError> {
        let head = self.head_state()?;
        let orig = self.count_lines()?;

        let tmp = self.log_path().with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            for op in head.values() {
                let mut line = serde_json::to_string(op)?;
                line.push('\n');
                f.write_all(line.as_bytes())?;
            }
        }
        fs::rename(&tmp, self.log_path())?;

        let live: std::collections::HashSet<String> = head
            .values()
            .filter_map(|op| op.ciphertext_ref_hex.clone())
            .collect();
        let mut blobs_removed = 0usize;
        if let Ok(entries) = fs::read_dir(self.dir.join("blobs")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !live.contains(&name) && fs::remove_file(entry.path()).is_ok() {
                    blobs_removed += 1;
                }
            }
        }

        Ok((orig.saturating_sub(head.len()), blobs_removed))
    }

    fn count_lines(&self) -> Result<usize, SyncError> {
        let file = match fs::File::open(self.log_path()) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        Ok(BufReader::new(file)
            .lines()
            .filter(|l| l.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false))
            .count())
    }
}
```

### Step 1.5: Re-export from `lib.rs`

- [ ] In `crates/marklig-sync-core/src/lib.rs`, add to the `pub use ops::` line:

```rust
pub use ops::{LamportClock, LoggedOp, Op, OpKind, OpLog, SyncError, resolve};
```

### Step 1.6: Run tests

- [ ] `cargo test -p marklig-sync-core 2>&1`
- Expected: all 8 new `oplog` tests pass; existing tests unchanged.

### Step 1.7: Commit

- [ ] `jj desc -m "marklig-sync-core: add OpLog (JSONL + blob store) with dedup and compaction"` then `jj new`

---

## Task 2: Desktop — seed + reconcile + `pub(crate)` helpers

**Files:**
- Modify: `src-tauri/src/pairing_ws.rs`
- Create: `src-tauri/src/sync_log.rs`
- Modify: `src-tauri/src/pairing.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 2.1: Make `walk_markdown` and `pair_id_from_folder_hex` accessible

- [ ] In `src-tauri/src/pairing_ws.rs`, change both function signatures:

```rust
// Before:
fn walk_markdown(root: &str) -> Vec<(String, String)>
fn pair_id_from_folder_hex(pair_id_hex: &str, folder: &str) -> String

// After:
pub(crate) fn walk_markdown(root: &str) -> Vec<(String, String)>
pub(crate) fn pair_id_from_folder_hex(pair_id_hex: &str, folder: &str) -> String
pub(crate) fn pair_id_from_folder(pair_id_hex: &str, folder: &str) -> [u8; 16]
```

Also add a helper that `sync_log.rs` needs:

```rust
pub(crate) fn read_markdown_file(root: &str, relpath: &str) -> Option<String> {
    let path = std::path::Path::new(root).join(relpath);
    std::fs::read_to_string(path).ok()
}
```

### Step 2.2: Create `src-tauri/src/sync_log.rs`

- [ ] Create the file:

```rust
//! Desktop-side helpers for maintaining an `OpLog` per synced folder.
//! Wraps `marklig_sync_core::ops::OpLog` with Tauri-AppHandle context.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use marklig_sync_core::ops::{LamportClock, OpLog, SyncError};

use crate::pairing::{load_pair_key, load_pairing};

/// `<app_data>/sync/<pair_id_hex>/<folder_id_hex>/`
pub fn sync_dir<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder_id_hex: &str,
) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data.join("sync").join(pair_id_hex).join(folder_id_hex))
}

/// Seed a newly-enabled folder: walk all `.md` files and append Put ops.
/// Returns the number of ops written.
pub fn seed_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<u64, String> {
    let pair_key = load_pair_key(app, pair_id_hex)?
        .ok_or_else(|| format!("no pair key for {pair_id_hex}"))?;
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let folder_id = hex_to_16(&folder_id_hex)
        .ok_or_else(|| "folder_id malformed".to_string())?;
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    let mut log = OpLog::open(&dir).map_err(|e: SyncError| e.to_string())?;
    let max = log.max_mtime().map_err(|e: SyncError| e.to_string())?;
    let mut clock = LamportClock::from(max);
    let mut count = 0u64;

    for (relpath, contents) in crate::pairing_ws::walk_markdown(folder) {
        let file_key = marklig_sync_core::derive_file_key(
            &marklig_sync_core::pair::PairKey(pair_key),
            &marklig_sync_core::pair::PairId(folder_id),
            &relpath,
        );
        if log
            .append_put(&relpath, contents.as_bytes(), &file_key, &mut clock)
            .map_err(|e: SyncError| e.to_string())?
            .is_some()
        {
            count += 1;
        }
    }
    Ok(count)
}

/// Startup drift reconciliation: diff current FS against the log's
/// head-state. Appends Put for new/changed files and Delete for removed
/// files. Returns `(puts, deletes)`.
pub fn reconcile_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<(u64, u64), String> {
    use sha2::{Digest, Sha256};

    let pair_key = load_pair_key(app, pair_id_hex)?
        .ok_or_else(|| format!("no pair key for {pair_id_hex}"))?;
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let folder_id = hex_to_16(&folder_id_hex)
        .ok_or_else(|| "folder_id malformed".to_string())?;
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    let mut log = OpLog::open(&dir).map_err(|e: SyncError| e.to_string())?;
    let max = log.max_mtime().map_err(|e: SyncError| e.to_string())?;
    let mut clock = LamportClock::from(max);
    let head = log.head_state().map_err(|e: SyncError| e.to_string())?;

    // Walk current FS
    let fs_files: std::collections::HashMap<String, String> =
        crate::pairing_ws::walk_markdown(folder).into_iter().collect();

    let mut puts = 0u64;
    let mut deletes = 0u64;

    // New or changed
    for (relpath, contents) in &fs_files {
        let hash_hex = format!("{:x}", Sha256::digest(contents.as_bytes()));
        let needs_put = match head.get(relpath) {
            Some(op) if op.kind == marklig_sync_core::ops::OpKind::Put => {
                op.hash_hex != hash_hex
            }
            _ => true,
        };
        if needs_put {
            let file_key = marklig_sync_core::derive_file_key(
                &marklig_sync_core::pair::PairKey(pair_key),
                &marklig_sync_core::pair::PairId(folder_id),
                relpath,
            );
            if log
                .append_put(relpath, contents.as_bytes(), &file_key, &mut clock)
                .map_err(|e: SyncError| e.to_string())?
                .is_some()
            {
                puts += 1;
            }
        }
    }

    // Removed
    for (relpath, op) in &head {
        if op.kind == marklig_sync_core::ops::OpKind::Put
            && !fs_files.contains_key(relpath)
        {
            log.append_delete(relpath, &mut clock)
                .map_err(|e: SyncError| e.to_string())?;
            deletes += 1;
        }
    }

    Ok((puts, deletes))
}

/// Delete the op log and blob store for one `(pair_id, folder)` tuple.
pub fn teardown_folder<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
) -> Result<(), String> {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let dir = sync_dir(app, pair_id_hex, &folder_id_hex)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("teardown {dir:?}: {e}")),
    }
}

fn hex_to_16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
```

### Step 2.3: Call `seed_folder` on `folder_sync_enable`

- [ ] In `src-tauri/src/pairing.rs`, find the `folder_sync_enable` command. After writing the updated registry to the store, add:

```rust
// Seed the op log for the newly-enabled folder.
if let Err(e) = crate::sync_log::seed_folder(&app, &pair_id_hex, &folder) {
    eprintln!("sync seed {folder}: {e}");
}
```

### Step 2.4: Call `teardown_folder` on `folder_sync_disable` and `pairing_unpair`

- [ ] In `src-tauri/src/pairing.rs`, in the `folder_sync_disable` command, after updating the store:

```rust
let _ = crate::sync_log::teardown_folder(&app, &pair_id_hex, &folder);
```

- [ ] In the `pairing_unpair` command, after removing each folder from `synced_folders`, add a call to `teardown_folder` for each:

```rust
for folder in &meta.synced_folders {
    let _ = crate::sync_log::teardown_folder(&app, &pair_id_hex, folder);
}
```

### Step 2.5: Run reconcile on startup in `lib.rs`

- [ ] In `src-tauri/src/lib.rs`, add the module declaration near the other `#[cfg(desktop)]` mods:

```rust
#[cfg(desktop)]
mod sync_log;
```

- [ ] In the desktop `setup` closure, after `pairing_ws::spawn_server(...)`, add:

```rust
// Reconcile sync logs: catch drift from while the app was closed.
{
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let pairings = crate::pairing::list_all_pairings(&app_handle)
            .unwrap_or_default();
        for meta in pairings {
            for folder in &meta.synced_folders {
                if let Err(e) = crate::sync_log::reconcile_folder(
                    &app_handle,
                    &meta.pair_id_hex,
                    folder,
                ) {
                    eprintln!("sync reconcile {folder}: {e}");
                }
            }
        }
    });
}
```

### Step 2.6: Add `list_all_pairings` helper to `pairing.rs`

`list_all_pairings` is needed by the reconcile loop. Add it after the existing `load_pairing`:

- [ ] In `src-tauri/src/pairing.rs`, add:

```rust
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
```

### Step 2.7: `cargo check`

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
- Expected: no errors.

### Step 2.8: Commit

- [ ] `jj desc -m "Desktop: seed/reconcile op log on folder enable/startup"` then `jj new`

---

## Task 3: Desktop — `SyncWatcherState` (per-folder watcher + fan-out)

**Files:**
- Create: `src-tauri/src/sync_watcher.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 3.1: Create `src-tauri/src/sync_watcher.rs`

- [ ] Create the file:

```rust
//! Per-folder watcher for synced folders. One `notify-debouncer-full`
//! watcher per distinct folder path (shared across pairs); on events it
//! appends an op to each interested pair's OpLog and fans the serialised
//! frame out to `SyncSessionRegistry`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use tauri::{AppHandle, Manager, Runtime};

use marklig_sync_core::ops::{LamportClock, OpLog, SyncError};

use crate::sync_session::SyncSessionRegistry;

/// Which pairs are interested in a folder.
struct FolderEntry {
    pair_ids: Vec<String>,
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::FileIdMap,
    >,
}

pub struct SyncWatcherState {
    inner: Mutex<HashMap<String, FolderEntry>>,
}

impl SyncWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Start watching `folder` for `pair_id_hex`, or register the pair
    /// on an already-running watcher.
    pub fn register<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pair_id_hex: &str,
        folder: &str,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;

        if let Some(entry) = guard.get_mut(folder) {
            if !entry.pair_ids.contains(&pair_id_hex.to_string()) {
                entry.pair_ids.push(pair_id_hex.to_string());
            }
            return Ok(());
        }

        let app_clone = app.clone();
        let folder_str = folder.to_string();
        let pair_id = pair_id_hex.to_string();

        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                let events = match result {
                    Ok(e) => e,
                    Err(_) => return,
                };
                let guard = match app_clone
                    .try_state::<Arc<SyncWatcherState>>()
                    .map(|s| s.inner.lock().ok())
                    .flatten()
                {
                    Some(g) => g,
                    None => return,
                };
                let pair_ids = match guard.get(&folder_str) {
                    Some(e) => e.pair_ids.clone(),
                    None => return,
                };
                drop(guard);

                for ev in &events {
                    for path in &ev.paths {
                        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
                            continue;
                        };
                        if !matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "md" | "markdown" | "mdx" | "mdown"
                        ) {
                            continue;
                        }
                        let Some(relpath) = path
                            .strip_prefix(&folder_str)
                            .ok()
                            .and_then(|p| p.to_str())
                            .map(|s| s.to_string())
                        else {
                            continue;
                        };

                        let is_remove = matches!(
                            ev.kind,
                            notify::EventKind::Remove(_)
                        );

                        for pid in &pair_ids {
                            handle_file_event(
                                &app_clone,
                                pid,
                                &folder_str,
                                &relpath,
                                is_remove,
                            );
                        }
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;

        debouncer
            .watcher()
            .watch(&PathBuf::from(folder), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        guard.insert(
            folder.to_string(),
            FolderEntry {
                pair_ids: vec![pair_id_hex.to_string()],
                _debouncer: debouncer,
            },
        );
        Ok(())
    }

    /// Remove a pair from a folder's watcher. Stops the watcher if no
    /// pairs remain.
    pub fn unregister(&self, pair_id_hex: &str, folder: &str) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(entry) = guard.get_mut(folder) {
            entry.pair_ids.retain(|p| p != pair_id_hex);
            if entry.pair_ids.is_empty() {
                guard.remove(folder);
            }
        }
    }
}

impl Default for SyncWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

fn handle_file_event<R: Runtime>(
    app: &AppHandle<R>,
    pair_id_hex: &str,
    folder: &str,
    relpath: &str,
    is_remove: bool,
) {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(pair_id_hex, folder);
    let Ok(dir) = crate::sync_log::sync_dir(app, pair_id_hex, &folder_id_hex) else {
        return;
    };
    let Ok(mut log) = OpLog::open(&dir) else {
        return;
    };
    let Ok(max) = log.max_mtime() else {
        return;
    };
    let mut clock = LamportClock::from(max);

    let frame = if is_remove {
        match log.append_delete(relpath, &mut clock) {
            Ok(op) => serde_json::json!({
                "type": "op_delete",
                "folder_id_hex": folder_id_hex,
                "relpath": op.relpath,
                "mtime_logical": op.mtime_logical,
            }),
            Err(_) => return,
        }
    } else {
        let Some(pair_key) = crate::pairing::load_pair_key(app, pair_id_hex)
            .ok()
            .flatten()
        else {
            return;
        };
        let Some(folder_id) = hex_to_16(&folder_id_hex) else {
            return;
        };
        let Some(contents) = crate::pairing_ws::read_markdown_file(folder, relpath) else {
            return;
        };
        let file_key = marklig_sync_core::derive_file_key(
            &marklig_sync_core::pair::PairKey(pair_key),
            &marklig_sync_core::pair::PairId(folder_id),
            relpath,
        );
        match log.append_put(relpath, contents.as_bytes(), &file_key, &mut clock) {
            Ok(Some(op)) => {
                let Some(ref_hex) = &op.ciphertext_ref_hex else {
                    return;
                };
                let Some(ct) = log.read_blob(ref_hex) else {
                    return;
                };
                serde_json::json!({
                    "type": "op_put",
                    "folder_id_hex": folder_id_hex,
                    "relpath": op.relpath,
                    "mtime_logical": op.mtime_logical,
                    "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ct),
                })
            }
            Ok(None) => return, // dedup
            Err(_) => return,
        }
    };

    // Fan out to connected sessions for this pair.
    if let Some(registry) = app.try_state::<Arc<SyncSessionRegistry>>() {
        registry.push(pair_id_hex, frame);
    }
}

fn hex_to_16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
```

### Step 3.2: Register the watcher on `folder_sync_enable`

- [ ] In `src-tauri/src/pairing.rs`, in `folder_sync_enable`, after `seed_folder`:

```rust
if let Some(watcher_state) = app.try_state::<Arc<crate::sync_watcher::SyncWatcherState>>() {
    let _ = watcher_state.register(&app, &pair_id_hex, &folder);
}
```

### Step 3.3: Unregister the watcher on disable/unpair

- [ ] In `folder_sync_disable`, after `teardown_folder`:

```rust
if let Some(watcher_state) = app.try_state::<Arc<crate::sync_watcher::SyncWatcherState>>() {
    watcher_state.unregister(&pair_id_hex, &folder);
}
```

- [ ] In `pairing_unpair`, after the per-folder teardown loop:

```rust
if let Some(watcher_state) = app.try_state::<Arc<crate::sync_watcher::SyncWatcherState>>() {
    for folder in &meta.synced_folders {
        watcher_state.unregister(&pair_id_hex, folder);
    }
}
```

### Step 3.4: Add module + manage in `lib.rs`

- [ ] In `src-tauri/src/lib.rs`, add:

```rust
#[cfg(desktop)]
mod sync_watcher;
```

- [ ] In the desktop `let builder = builder.manage(...)` chain, add:

```rust
.manage(std::sync::Arc::new(sync_watcher::SyncWatcherState::new()))
```

- [ ] In the `setup` closure, after the reconcile loop spawn, start watchers for all registered pairs:

```rust
{
    let app_handle_w = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let pairings = crate::pairing::list_all_pairings(&app_handle_w)
            .unwrap_or_default();
        if let Some(watcher_state) =
            app_handle_w.try_state::<std::sync::Arc<crate::sync_watcher::SyncWatcherState>>()
        {
            for meta in pairings {
                for folder in &meta.synced_folders {
                    let _ = watcher_state.register(
                        &app_handle_w,
                        &meta.pair_id_hex,
                        folder,
                    );
                }
            }
        }
    });
}
```

### Step 3.5: `cargo check`

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
- Expected: no errors.

### Step 3.6: Commit

- [ ] `jj desc -m "Desktop: SyncWatcherState — per-folder watcher fan-out to op log + sessions"` then `jj new`

---

## Task 4: Desktop — `SyncSessionRegistry` + persistent WS subscribe

**Files:**
- Create: `src-tauri/src/sync_session.rs`
- Modify: `src-tauri/src/pairing_ws.rs`
- Modify: `src-tauri/src/commands/mobile_sync.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 4.1: Create `src-tauri/src/sync_session.rs`

- [ ] Create the file:

```rust
//! Registry of live sync sessions keyed by pair_id_hex. The watcher
//! fan-out pushes JSON frames to all registered senders; the session
//! task forwards them to the WS client.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;

pub struct SyncSessionRegistry {
    senders: Mutex<HashMap<String, Vec<(usize, mpsc::Sender<serde_json::Value>)>>>,
    next_id: Mutex<usize>,
}

impl SyncSessionRegistry {
    pub fn new() -> Self {
        Self {
            senders: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    /// Register a sender; returns a session ID for later unregistration.
    pub fn register(
        &self,
        pair_id_hex: &str,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> usize {
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let v = *n;
            *n += 1;
            v
        };
        self.senders
            .lock()
            .unwrap()
            .entry(pair_id_hex.to_string())
            .or_default()
            .push((id, tx));
        id
    }

    pub fn unregister(&self, pair_id_hex: &str, session_id: usize) {
        let mut guard = self.senders.lock().unwrap();
        if let Some(vec) = guard.get_mut(pair_id_hex) {
            vec.retain(|(id, _)| *id != session_id);
        }
    }

    /// Push a frame to all sessions for this pair. Dead senders are
    /// pruned automatically.
    pub fn push(&self, pair_id_hex: &str, frame: serde_json::Value) {
        let mut guard = self.senders.lock().unwrap();
        if let Some(vec) = guard.get_mut(pair_id_hex) {
            vec.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
        }
    }
}

impl Default for SyncSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}
```

### Step 4.2: Add `handle_subscribe` to `pairing_ws.rs`

- [ ] Add after `handle_sync_request` in `src-tauri/src/pairing_ws.rs`:

```rust
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
    use std::sync::Arc;
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

    // Auth
    let meta = match crate::pairing::load_pairing(&app, &pair_id_hex)? {
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

    // Replay ops since cursor
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    for folder in &meta.synced_folders {
        let folder_id_hex = pair_id_from_folder_hex(&pair_id_hex, folder);
        let cursor = cursors.get(&folder_id_hex).copied().unwrap_or(0);
        let sync_dir = data_dir
            .join("sync")
            .join(&pair_id_hex)
            .join(&folder_id_hex);

        if let Ok(log) = marklig_sync_core::ops::OpLog::open(&sync_dir) {
            let ops = log.ops_since(cursor)?;
            for op in ops {
                let frame = match op.kind {
                    marklig_sync_core::ops::OpKind::Put => {
                        let ref_hex = match &op.ciphertext_ref_hex {
                            Some(r) => r,
                            None => continue,
                        };
                        let ct = match log.read_blob(ref_hex) {
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
        .try_state::<Arc<crate::sync_session::SyncSessionRegistry>>()
        .ok_or("SyncSessionRegistry not mounted")?;
    let session_id = registry.register(&pair_id_hex, chan_tx);

    // Forward loop + heartbeat
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pong_due_by: Option<tokio::time::Instant> = None;

    loop {
        // Check pong deadline before selecting
        if let Some(dl) = pong_due_by {
            if tokio::time::Instant::now() > dl {
                break; // client gone
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
                    None => break, // registry dropped
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
```

### Step 4.3: Dispatch `subscribe` vs `sync_request` in `handle_connection`

- [ ] In `handle_connection` in `pairing_ws.rs`, change the text-frame dispatch to:

```rust
FirstFrame::Text(text) => {
    // Route on frame type. Legacy "sync_request" phones get a
    // one-shot snapshot; new "subscribe" phones get a live session.
    let frame_type = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string));
    match frame_type.as_deref() {
        Some("subscribe") => handle_subscribe(app, tx, rx, text).await,
        _ => handle_sync_request(app, tx, rx, text).await,
    }
}
```

### Step 4.4: Add `mobile_apply_sync_op` and `sync_compact` commands

- [ ] In `src-tauri/src/commands/mobile_sync.rs`, add these two commands (append at the end):

```rust
/// Apply a single live-sync op from the desktop to phone-side storage.
/// Called by the phone's `SyncClient` for each incoming `op_put` /
/// `op_delete` frame.
#[tauri::command]
pub async fn mobile_apply_sync_op<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder_id_hex: String,
    relpath: String,
    mtime_logical: u64,
    ciphertext_b64: Option<String>,
    kind: String,
) -> Result<(), String> {
    // Validate IDs and relpath (mirrors mobile_read_synced_file checks).
    if !pair_id_hex.chars().all(|c| c.is_ascii_hexdigit()) || pair_id_hex.len() != 32 {
        return Err("invalid pair_id_hex".into());
    }
    if !folder_id_hex.chars().all(|c| c.is_ascii_hexdigit()) || folder_id_hex.len() != 32 {
        return Err("invalid folder_id_hex".into());
    }
    for part in relpath.split('/') {
        if part == ".." || part.is_empty() {
            return Err("relpath contains forbidden component".into());
        }
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let synced_root = app_data
        .join("synced")
        .join(&pair_id_hex)
        .join(&folder_id_hex);
    let store = tauri_plugin_store::StoreExt::store(&app, "viewer.store.json")
        .map_err(|e| e.to_string())?;

    match kind.as_str() {
        "put" => {
            let ct_b64 =
                ciphertext_b64.ok_or_else(|| "put op requires ciphertext_b64".to_string())?;
            let ct = base64::engine::general_purpose::STANDARD
                .decode(&ct_b64)
                .map_err(|e| format!("b64 decode: {e}"))?;

            let pairings = store
                .get("mobile.pairings")
                .and_then(|v| v.as_object().cloned())
                .ok_or_else(|| "no pairings stored".to_string())?;
            let entry = pairings
                .get(&pair_id_hex)
                .cloned()
                .ok_or_else(|| format!("no such pair_id: {pair_id_hex}"))?;
            let pair_key_hex = entry
                .get("pair_key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "stored pairing missing pair_key".to_string())?
                .to_string();
            let pair_key = hex_to_32(&pair_key_hex)
                .ok_or_else(|| "stored pair_key malformed".to_string())?;
            let folder_id = hex_to_16(&folder_id_hex)
                .ok_or_else(|| format!("folder_id_hex malformed: {folder_id_hex}"))?;

            let file_key = marklig_sync_core::envelope::derive_file_key(
                &marklig_sync_core::pair::PairKey(pair_key),
                &marklig_sync_core::pair::PairId(folder_id),
                &relpath,
            );
            let plaintext = marklig_sync_core::envelope::open(&file_key, &ct)
                .map_err(|e| format!("envelope open: {e}"))?;

            std::fs::create_dir_all(&synced_root).map_err(|e| e.to_string())?;
            let target = synced_root.join(&relpath);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, &plaintext)
                .map_err(|e| format!("write {target:?}: {e}"))?;

            // Update synced_files index
            let mut idx = store
                .get("mobile.synced_files")
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            let scoped = idx
                .entry(pair_id_hex.clone())
                .or_insert_with(|| serde_json::Value::Array(vec![]));
            let mut files: Vec<serde_json::Value> =
                scoped.as_array().cloned().unwrap_or_default();
            files.retain(|f| {
                !(f.get("folder_id_hex").and_then(|v| v.as_str()) == Some(&folder_id_hex)
                    && f.get("relpath").and_then(|v| v.as_str()) == Some(&relpath))
            });
            files.push(serde_json::json!({
                "pair_id_hex": pair_id_hex,
                "folder_id_hex": folder_id_hex,
                "relpath": relpath,
                "abs_path": target.to_string_lossy(),
                "synced_at_unix": now_unix(),
            }));
            *scoped = serde_json::Value::Array(files);
            store.set("mobile.synced_files", serde_json::Value::Object(idx));
            store.save().map_err(|e| e.to_string())?;
        }
        "delete" => {
            let target = synced_root.join(&relpath);
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove {target:?}: {e}")),
            }

            // Update synced_files index
            let mut idx = store
                .get("mobile.synced_files")
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            if let Some(scoped) = idx.get_mut(&pair_id_hex) {
                if let Some(files) = scoped.as_array_mut() {
                    files.retain(|f| {
                        !(f.get("folder_id_hex").and_then(|v| v.as_str())
                            == Some(&folder_id_hex)
                            && f.get("relpath").and_then(|v| v.as_str()) == Some(&relpath))
                    });
                }
            }
            store.set("mobile.synced_files", serde_json::Value::Object(idx));
            store.save().map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("unknown op kind: {kind}")),
    }

    let _ = mtime_logical; // cursor advance is done in JS
    Ok(())
}

/// Compact the op log for a single `(pair_id, folder)` — desktop-side
/// maintenance command exposed for the settings UI or CLI.
#[tauri::command]
pub async fn sync_compact<R: Runtime>(
    app: AppHandle<R>,
    pair_id_hex: String,
    folder: String,
) -> Result<(u64, u64), String> {
    let folder_id_hex = crate::pairing_ws::pair_id_from_folder_hex(&pair_id_hex, &folder);
    let dir = crate::sync_log::sync_dir(&app, &pair_id_hex, &folder_id_hex)?;
    let mut log = marklig_sync_core::ops::OpLog::open(&dir)
        .map_err(|e: marklig_sync_core::ops::SyncError| e.to_string())?;
    let (ops, blobs) = log
        .compact()
        .map_err(|e: marklig_sync_core::ops::SyncError| e.to_string())?;
    Ok((ops as u64, blobs as u64))
}
```

### Step 4.5: Add modules + manage + register commands in `lib.rs`

- [ ] In `src-tauri/src/lib.rs`, add module declarations:

```rust
#[cfg(desktop)]
mod sync_session;
```

- [ ] Add to the desktop `.manage()` chain:

```rust
.manage(std::sync::Arc::new(sync_session::SyncSessionRegistry::new()))
```

- [ ] Add to the desktop `invoke_handler!`:

```rust
commands::mobile_sync::sync_compact,
```

- [ ] Add to the **mobile** `invoke_handler!`:

```rust
commands::mobile_sync::mobile_apply_sync_op,
```

### Step 4.6: `cargo check`

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
- Expected: no errors.

### Step 4.7: Commit

- [ ] `jj desc -m "Desktop: SyncSessionRegistry + persistent WS subscribe with replay and heartbeat"` then `jj new`

---

## Task 5: Phone — `SyncClient` (TypeScript)

**Files:**
- Create: `src/shell/mobile-sync-client.ts`
- Modify: `src/shell/mobile-pairings.ts`
- Modify: `src/ui/mobile-synced-view.ts`
- Modify: `src/i18n/strings.ts`
- Create: `tests/shell/mobile-sync-client.test.ts`

### Step 5.1: Write failing tests first

- [ ] Create `tests/shell/mobile-sync-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock the store helpers used by SyncClient
const storeData: Record<string, unknown> = {};
vi.mock("../src/shell/store", () => ({
  getValue: vi.fn(async (key: string) => storeData[key] ?? null),
  setValue: vi.fn(async (key: string, val: unknown) => {
    storeData[key] = val;
  }),
}));

// Capture CustomEvents dispatched on window
const dispatchedEvents: CustomEvent[] = [];
const origDispatch = window.dispatchEvent.bind(window);
window.dispatchEvent = (e: Event) => {
  if (e instanceof CustomEvent) dispatchedEvents.push(e);
  return origDispatch(e);
};

// Minimal WebSocket mock
let lastWsInstance: MockWs | null = null;
class MockWs {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    lastWsInstance = this;
  }
  send(msg: string) {
    this.sent.push(msg);
  }
  close() {
    this.onclose?.();
  }
  simulateOpen() {
    this.onopen?.();
  }
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
  simulateError() {
    this.onerror?.();
  }
}
vi.stubGlobal("WebSocket", MockWs);

import { SyncClient, LIVE_OP_EVENT, CAUGHT_UP_EVENT } from "../src/shell/mobile-sync-client";
import { invoke } from "@tauri-apps/api/core";
import { getValue } from "../src/shell/store";

const PAIR: { pair_id_hex: string; friendly_name: string; verification_fingerprint: string; paired_at_unix: number; last_seen_at_unix: number; last_host: string } = {
  pair_id_hex: "aa".repeat(16),
  friendly_name: "Test Phone",
  verification_fingerprint: "AA-BB-CC",
  paired_at_unix: 0,
  last_seen_at_unix: 0,
  last_host: "192.168.1.1",
};

beforeEach(() => {
  lastWsInstance = null;
  dispatchedEvents.length = 0;
  vi.clearAllMocks();
  Object.keys(storeData).forEach((k) => delete storeData[k]);
});

describe("SyncClient.start()", () => {
  it("connects when visible and sends subscribe frame", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();

    expect(lastWsInstance).not.toBeNull();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    expect(lastWsInstance!.sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(lastWsInstance!.sent[0]);
    expect(msg.type).toBe("subscribe");
    expect(msg.pair_id).toBe(PAIR.pair_id_hex);
    expect(msg.cursors).toBeDefined();

    client.stop();
  });
});

describe("apply op_put", () => {
  it("invokes mobile_apply_sync_op and dispatches LIVE_OP_EVENT", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const putFrame = JSON.stringify({
      type: "op_put",
      folder_id_hex: "bb".repeat(16),
      relpath: "notes/a.md",
      mtime_logical: 5,
      ciphertext_b64: "dGVzdA==",
    });
    lastWsInstance!.simulateMessage(putFrame);
    await Promise.resolve();
    await Promise.resolve(); // two ticks for async in handleFrame

    expect(invoke).toHaveBeenCalledWith(
      "mobile_apply_sync_op",
      expect.objectContaining({ relpath: "notes/a.md", kind: "put" })
    );
    const liveEv = dispatchedEvents.find((e) => e.type === LIVE_OP_EVENT);
    expect(liveEv).toBeDefined();
    expect((liveEv!.detail as Record<string, string>).kind).toBe("put");

    client.stop();
  });
});

describe("apply op_delete", () => {
  it("invokes mobile_apply_sync_op with kind=delete and dispatches LIVE_OP_EVENT", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const deleteFrame = JSON.stringify({
      type: "op_delete",
      folder_id_hex: "cc".repeat(16),
      relpath: "notes/b.md",
      mtime_logical: 7,
    });
    lastWsInstance!.simulateMessage(deleteFrame);
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      "mobile_apply_sync_op",
      expect.objectContaining({ relpath: "notes/b.md", kind: "delete" })
    );
    const liveEv = dispatchedEvents.find((e) => e.type === LIVE_OP_EVENT);
    expect(liveEv).toBeDefined();
    expect((liveEv!.detail as Record<string, string>).kind).toBe("delete");

    client.stop();
  });
});

describe("cursor advances after op", () => {
  it("stores mtime_logical in sync_cursors", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const folder = "dd".repeat(16);
    lastWsInstance!.simulateMessage(
      JSON.stringify({
        type: "op_put",
        folder_id_hex: folder,
        relpath: "x.md",
        mtime_logical: 42,
        ciphertext_b64: "dA==",
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // cursor write is also async

    const cursors = storeData["mobile.sync_cursors"] as Record<string, Record<string, number>>;
    expect(cursors?.[PAIR.pair_id_hex]?.[folder]).toBe(42);

    client.stop();
  });
});

describe("caught_up dispatches event", () => {
  it("dispatches CAUGHT_UP_EVENT on caught_up frame", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    lastWsInstance!.simulateMessage(JSON.stringify({ type: "caught_up" }));
    await Promise.resolve();

    const ev = dispatchedEvents.find((e) => e.type === CAUGHT_UP_EVENT);
    expect(ev).toBeDefined();

    client.stop();
  });
});

describe("reconnect on error", () => {
  it("schedules a reconnect when the socket errors", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await Promise.resolve();
    const firstWs = lastWsInstance!;
    firstWs.simulateOpen();
    await Promise.resolve();

    firstWs.simulateError();
    await Promise.resolve();

    // No immediate reconnect
    expect(lastWsInstance).toBe(firstWs);

    // After initial backoff (2 s) a new WS is created
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastWsInstance).not.toBe(firstWs);

    client.stop();
    vi.useRealTimers();
  });
});
```

### Step 5.2: Run tests (expect failures)

- [ ] `npm test -- tests/shell/mobile-sync-client.test.ts 2>&1 | tail -20`
- Expected: import errors (module not yet created)

### Step 5.3: Create `src/shell/mobile-sync-client.ts`

- [ ] Create the file:

```typescript
// Reconnecting WebSocket client for live sync. Foreground-only (connects
// on visibilitychange → visible, drops on hidden). Subscribes with
// per-folder cursors and applies ops via the mobile_apply_sync_op command.

import { invoke } from "@tauri-apps/api/core";
import { getValue, setValue } from "./store";
import type { MobilePairing } from "./mobile-pairings";

const WS_PORT = 14_200;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/** Window CustomEvent name emitted when a live op is applied. */
export const LIVE_OP_EVENT = "sync:live-op";
/** Window CustomEvent name emitted when replay is complete. */
export const CAUGHT_UP_EVENT = "sync:caught-up";

type SyncCursors = Record<string, number>;

export class SyncClient {
  private pairing: MobilePairing;
  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private boundVisibility: () => void;

  constructor(pairing: MobilePairing) {
    this.pairing = pairing;
    this.boundVisibility = () => {
      if (document.visibilityState === "visible") {
        void this.connect();
      } else {
        this.disconnect();
      }
    };
  }

  start(): void {
    this.stopped = false;
    document.addEventListener("visibilitychange", this.boundVisibility);
    if (document.visibilityState === "visible") {
      void this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.boundVisibility);
    this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.ws || this.stopped) return;
    const host = this.pairing.last_host;
    if (!host) return;

    try {
      const cursors = await this.loadCursors();
      const ws = new WebSocket(`ws://${host}:${WS_PORT}`);
      this.ws = ws;

      ws.onopen = () => {
        this.backoffMs = BACKOFF_INITIAL_MS;
        ws.send(
          JSON.stringify({
            type: "subscribe",
            pair_id: this.pairing.pair_id_hex,
            cursors,
          }),
        );
        this.startPing();
      };

      ws.onmessage = (e) => {
        void this.handleFrame(e.data as string);
      };

      ws.onerror = () => {
        this.handleDisconnect();
      };

      ws.onclose = () => {
        this.handleDisconnect();
      };
    } catch {
      this.handleDisconnect();
    }
  }

  private disconnect(): void {
    this.clearTimers();
    this.clearReconnect();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.clearTimers();
    if (!this.stopped && document.visibilityState === "visible") {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ type: "ping" }));
      this.pongTimer = setTimeout(() => {
        this.handleDisconnect();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private async handleFrame(text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type as string) {
      case "op_put":
        await this.applyPut(msg);
        break;
      case "op_delete":
        await this.applyDelete(msg);
        break;
      case "caught_up":
        window.dispatchEvent(
          new CustomEvent(CAUGHT_UP_EVENT, {
            detail: { pairIdHex: this.pairing.pair_id_hex },
          }),
        );
        break;
      case "pong":
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        break;
      case "error":
        if (
          typeof msg.reason === "string" &&
          msg.reason.includes("blob missing") &&
          typeof msg.folder_id_hex === "string"
        ) {
          await this.resetCursor(msg.folder_id_hex);
        }
        break;
    }
  }

  private async applyPut(msg: Record<string, unknown>): Promise<void> {
    const folderIdHex = msg.folder_id_hex as string;
    const relpath = msg.relpath as string;
    const mtimeLogical = msg.mtime_logical as number;

    await invoke("mobile_apply_sync_op", {
      pairIdHex: this.pairing.pair_id_hex,
      folderIdHex,
      relpath,
      mtimeLogical,
      ciphertextB64: msg.ciphertext_b64 as string,
      kind: "put",
    });

    await this.advanceCursor(folderIdHex, mtimeLogical);

    window.dispatchEvent(
      new CustomEvent(LIVE_OP_EVENT, {
        detail: {
          pairIdHex: this.pairing.pair_id_hex,
          folderIdHex,
          relpath,
          kind: "put",
        },
      }),
    );
  }

  private async applyDelete(msg: Record<string, unknown>): Promise<void> {
    const folderIdHex = msg.folder_id_hex as string;
    const relpath = msg.relpath as string;
    const mtimeLogical = msg.mtime_logical as number;

    await invoke("mobile_apply_sync_op", {
      pairIdHex: this.pairing.pair_id_hex,
      folderIdHex,
      relpath,
      mtimeLogical,
      ciphertextB64: null,
      kind: "delete",
    });

    await this.advanceCursor(folderIdHex, mtimeLogical);

    window.dispatchEvent(
      new CustomEvent(LIVE_OP_EVENT, {
        detail: {
          pairIdHex: this.pairing.pair_id_hex,
          folderIdHex,
          relpath,
          kind: "delete",
        },
      }),
    );
  }

  private async loadCursors(): Promise<SyncCursors> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    return all[this.pairing.pair_id_hex] ?? {};
  }

  private async advanceCursor(
    folderIdHex: string,
    mtime: number,
  ): Promise<void> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    const pair = all[this.pairing.pair_id_hex] ?? {};
    if (mtime > (pair[folderIdHex] ?? 0)) {
      pair[folderIdHex] = mtime;
      all[this.pairing.pair_id_hex] = pair;
      await setValue("mobile.sync_cursors", all);
    }
  }

  private async resetCursor(folderIdHex: string): Promise<void> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    const pair = all[this.pairing.pair_id_hex] ?? {};
    pair[folderIdHex] = 0;
    all[this.pairing.pair_id_hex] = pair;
    await setValue("mobile.sync_cursors", all);
  }
}
```

### Step 5.4: Run tests — should pass

- [ ] `npm test -- tests/shell/mobile-sync-client.test.ts 2>&1 | tail -20`
- Expected: all tests pass.

### Step 5.5: Add i18n key

- [ ] In `src/i18n/strings.ts`, add to the English strings object:

```typescript
"sync.file_deleted_on_desktop": "Removed on desktop",
```

### Step 5.6: Start/stop `SyncClient` from `mobile-pairings.ts`

- [ ] In `src/shell/mobile-pairings.ts`, add an import at the top:

```typescript
import { SyncClient } from "./mobile-sync-client";
```

- [ ] Add a module-level map to hold active clients:

```typescript
const activeSyncClients = new Map<string, SyncClient>();
```

- [ ] Export two new functions:

```typescript
export function startSyncClient(pairing: MobilePairing): void {
  if (activeSyncClients.has(pairing.pair_id_hex)) return;
  const client = new SyncClient(pairing);
  activeSyncClients.set(pairing.pair_id_hex, client);
  client.start();
}

export function stopSyncClient(pairIdHex: string): void {
  const client = activeSyncClients.get(pairIdHex);
  if (client) {
    client.stop();
    activeSyncClients.delete(pairIdHex);
  }
}
```

### Step 5.7: Wire `startSyncClient` in `mobile-bootstrap.ts`

- [ ] In `src/mobile-bootstrap.ts`, add the import at the top:

```typescript
import { startSyncClient, stopSyncClient } from "./shell/mobile-pairings";
```

- [ ] In the `if (route.kind === "synced")` block (around line 197), replace the teardown push:

```typescript
// Before (existing):
viewCleanups.push(teardown);

// After:
viewCleanups.push(() => {
  teardown();
  stopSyncClient(route.pairing.pair_id_hex);
});
startSyncClient(route.pairing);
```

### Step 5.8: Library list refresh in `mobile-synced-view.ts`

The library view (`mountMobileSynced`) handles the file list. The document view is a separate route in `mobile-bootstrap.ts` and is handled in Step 5.9.

- [ ] Add the import at the top of `src/ui/mobile-synced-view.ts`:

```typescript
import { LIVE_OP_EVENT, CAUGHT_UP_EVENT } from "../shell/mobile-sync-client";
```

- [ ] Inside `mountMobileSynced`, after `const cleanups: Array<() => void> = [];`, add:

```typescript
const onLiveOp = (e: Event) => {
  const ev = e as CustomEvent<{ pairIdHex: string }>;
  if (ev.detail.pairIdHex !== pairing.pair_id_hex) return;
  void refresh(); // re-render file list
};
const onCaughtUp = (e: Event) => {
  const ev = e as CustomEvent<{ pairIdHex: string }>;
  if (ev.detail.pairIdHex !== pairing.pair_id_hex) return;
  const now = Date.now();
  lastDisplayedSuccessMs = now;
  renderRelativeStatus();
};
window.addEventListener(LIVE_OP_EVENT, onLiveOp);
window.addEventListener(CAUGHT_UP_EVENT, onCaughtUp);
cleanups.push(() => {
  window.removeEventListener(LIVE_OP_EVENT, onLiveOp);
  window.removeEventListener(CAUGHT_UP_EVENT, onCaughtUp);
});
```

### Step 5.9: Open-doc reload in `mobile-bootstrap.ts`

The document view's `currentView` (CodeMirror) lives in the `renderRoute` closure in `mobile-bootstrap.ts`. Add tracking of the open synced file there.

- [ ] Add a module-level variable above `renderRoute` in `src/mobile-bootstrap.ts`:

```typescript
// Tracks the synced file currently open in the document view, if any.
// Used by the live-op handler to reload or orphan-notice on push.
let currentSyncedFile: {
  pairIdHex: string;
  folderIdHex: string;
  relpath: string;
} | null = null;
```

- [ ] In the `if (route.kind === "synced")` `onOpenFile` handler, set `currentSyncedFile` before `renderRoute`:

```typescript
onOpenFile: async (file) => {
  try {
    const source = await readSyncedFile(
      file.pair_id_hex,
      file.folder_id_hex,
      file.relpath,
    );
    currentSyncedFile = {    // ← add this
      pairIdHex: file.pair_id_hex,
      folderIdHex: file.folder_id_hex,
      relpath: file.relpath,
    };
    await renderRoute({ kind: "document", source });
  } catch (err) {
    console.error("failed to open synced file", file, err);
  }
},
```

- [ ] Clear `currentSyncedFile` in the `onBack` and `onUnpaired` handlers:

```typescript
onBack: () => {
  currentSyncedFile = null;   // ← add
  void renderRoute({ kind: "library" });
},
onUnpaired: () => {
  currentSyncedFile = null;   // ← add
  void renderRoute({ kind: "library" });
},
```

- [ ] Add the live-op listener at module level in `mobile-bootstrap.ts` (after `renderRoute` is defined). Import `LIVE_OP_EVENT`:

```typescript
import { LIVE_OP_EVENT } from "./shell/mobile-sync-client";
import { readSyncedFile } from "./shell/mobile-pairings";
import { t } from "./i18n/strings";
```

```typescript
window.addEventListener(LIVE_OP_EVENT, (e) => {
  const ev = e as CustomEvent<{
    pairIdHex: string;
    folderIdHex: string;
    relpath: string;
    kind: "put" | "delete";
  }>;
  const f = currentSyncedFile;
  if (
    !f ||
    f.pairIdHex !== ev.detail.pairIdHex ||
    f.folderIdHex !== ev.detail.folderIdHex ||
    f.relpath !== ev.detail.relpath
  ) {
    return;
  }
  if (ev.detail.kind === "put") {
    // Reload the open document in place (preserves back-stack state).
    void (async () => {
      try {
        const source = await readSyncedFile(
          f.pairIdHex,
          f.folderIdHex,
          f.relpath,
        );
        // Replace doc in the live view without a full route re-render.
        if (currentView) {
          const { EditorSelection } = await import("@codemirror/state");
          const scrollTop = currentView.scrollDOM.scrollTop;
          currentView.dispatch({
            changes: {
              from: 0,
              to: currentView.state.doc.length,
              insert: source,
            },
            selection: EditorSelection.cursor(0),
          });
          currentView.scrollDOM.scrollTop = scrollTop;
        }
      } catch {
        // Read failed — file may have been deleted between the event
        // and the read. Fall through to the delete notice.
        void renderRoute({ kind: "library" });
        currentSyncedFile = null;
      }
    })();
  } else {
    // File deleted — show notice and return to library.
    void renderRoute({ kind: "library" });
    currentSyncedFile = null;
    // Brief toast / status line is handled by the library view on mount.
  }
});
```

### Step 5.9: `npm test` + `tsc`

- [ ] `npm test 2>&1 | tail -20`
- Expected: all tests pass including new `mobile-sync-client` suite.
- [ ] `npx tsc -b --noEmit 2>&1 | tail -20`
- Expected: no errors.

### Step 5.10: Commit

- [ ] `jj desc -m "Phone: SyncClient live push (subscribe, ops, cursors, reconnect)"` then `jj new`

---

## Task 6: Delete cursor on `mobile_unpair`

**Files:**
- Modify: `src-tauri/src/commands/mobile_sync.rs`

### Step 6.1: Clear sync cursors when unpairing

- [ ] In `mobile_unpair`, after clearing `mobile.synced_folder_labels`, add:

```rust
for key in [
    "mobile.pairings",
    "mobile.synced_files",
    "mobile.synced_folder_labels",
    "mobile.sync_cursors",   // ← add this line
] {
```

### Step 6.2: `cargo check`

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
- Expected: no errors.

### Step 6.3: Commit

- [ ] `jj desc -m "Clear sync cursors on mobile unpair"` then `jj new`

---

## Task 7: Update ROADMAP + CLAUDE.md

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CLAUDE.md`

### Step 7.1: Mark issue #97 in progress in `ROADMAP.md`

- [ ] Find the `## v2: Mobile companion` section. Change step 8 to reflect that issue #97 (live push sync) is now implemented, and update the op-log description under step 4 to note it is now used on the wire:

```markdown
- [x] **Step 8 — Live push sync (issue #97).** Desktop watches synced
  folders via `notify-debouncer-full`; op log is maintained per
  `(pair_id, folder_id)` under `<app_data>/sync/`; phone holds a
  long-lived subscribe session and applies ops live. Cursor-based replay
  on reconnect. PR #_.
```

### Step 7.2: Update CLAUDE.md sync description

- [ ] In the `### Sync crypto (workspace crate)` section, note that `ops.rs` now includes `OpLog`:

Replace:
```
Three modules:
...
- `ops`: append-only sync op log + Lamport clock + deterministic
  conflict resolution.
```

With:
```
Three modules:
...
- `ops`: append-only sync op log (`OpLog` — JSONL + flat blob store under
  `<app_data>/sync/<pair>/<folder>/`) + Lamport clock + deterministic
  conflict resolution. Used on the wire since the live-push-sync
  implementation (issue #97).
```

### Step 7.3: Commit

- [ ] `jj desc -m "Update ROADMAP and CLAUDE.md for live push sync"` then `jj new`

---

## Final verification

- [ ] `cargo test --workspace 2>&1 | tail -30` — all Rust tests pass
- [ ] `npm test 2>&1 | tail -20` — all Vitest tests pass
- [ ] `npx tsc -b --noEmit 2>&1 | tail -10` — no type errors
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10` — clean
- [ ] Open PR against `trunk` referencing issue #97

---

## What this plan does NOT deliver

- mDNS zero-config discovery (still manual IP entry) — v2.x
- Phone-to-desktop edit sync (phone is still read-only) — future spec
- Off-LAN relay path — v2.1+
- Compaction UI in Settings pane — `sync_compact` command is wired but not surfaced in UI; add as a follow-up
