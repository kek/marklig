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
