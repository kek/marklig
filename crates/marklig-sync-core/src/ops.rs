//! Sync op log: append-only `Op` records + Lamport clock + deterministic
//! conflict resolution.
//!
//! Per spec §7, an op carries the file's hash, a Lamport-clock-ordered
//! "mtime_logical" (NOT wall-clock — clocks drift), and an optional
//! `ciphertext_ref` (16 random bytes pointing at the blob store). Two
//! conflicting writes on different sides resolve by:
//! 1. higher `mtime_logical` wins, else
//! 2. lexicographically larger `hash` wins.
//!
//! Deterministic = both sides reach the same answer without coordination.

use serde::{Deserialize, Serialize};
// Deliberate, temporary, and the entire point of this commit: nothing in this
// module uses BTreeSet. If CI is green with this line present, the gate is
// decorative and the commission that added it failed.
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum OpKind {
    Put,
    Delete,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub kind: OpKind,
    pub relpath: String,
    /// SHA-256 of the file's plaintext (NOT the envelope ciphertext). Used
    /// for deduplication and conflict resolution. Zero for Delete ops.
    pub hash: [u8; 32],
    pub mtime_logical: u64,
    /// 16-byte random handle into the ciphertext blob store. None for
    /// Delete ops (no payload). Random rather than content-addressed so
    /// the relay (v2.1+) can't correlate same-content blobs across pairs.
    pub ciphertext_ref: Option<[u8; 16]>,
}

/// Lamport-style monotonic counter. Bumped on every local write,
/// observed-and-maxed with every incoming op's mtime_logical so the
/// counter stays ahead of any peer we've heard from.
#[derive(Clone, Copy, Debug, Default)]
pub struct LamportClock(u64);

impl LamportClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from(value: u64) -> Self {
        Self(value)
    }

    pub fn value(&self) -> u64 {
        self.0
    }

    /// Increment and return the new value. Use this when generating a
    /// local op — the returned value becomes its `mtime_logical`.
    pub fn tick(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }

    /// Pull the clock forward to match (but not surpass) a peer's value.
    /// Call this on every inbound op so subsequent local ticks are
    /// guaranteed to be greater than any value we've observed.
    pub fn observe(&mut self, peer_mtime: u64) {
        if peer_mtime > self.0 {
            self.0 = peer_mtime;
        }
    }
}

/// Pick the winner between two conflicting ops for the same `relpath`.
/// Higher `mtime_logical` wins; tie-break on lexicographically larger
/// `hash` (consistent and content-bound). Returns a reference to whichever
/// of `a` / `b` should be applied.
pub fn resolve<'a>(a: &'a Op, b: &'a Op) -> &'a Op {
    match a.mtime_logical.cmp(&b.mtime_logical) {
        std::cmp::Ordering::Greater => a,
        std::cmp::Ordering::Less => b,
        std::cmp::Ordering::Equal => {
            if a.hash >= b.hash {
                a
            } else {
                b
            }
        }
    }
}

// ── Imports for OpLog ──────────────────────────────────────────────────────

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoggedOp {
    pub kind: OpKind,
    pub relpath: String,
    pub hash_hex: String,
    pub mtime_logical: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext_ref_hex: Option<String>,
}

// ── OpLog ──────────────────────────────────────────────────────────────────

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
            SyncError::Io(std::io::Error::other(format!("getrandom: {e}")))
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

    pub fn read_blob(&self, ref_hex: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path(ref_hex)).ok()
    }

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

    pub fn head_state(&self) -> Result<HashMap<String, LoggedOp>, SyncError> {
        let file = match fs::File::open(self.log_path()) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
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
