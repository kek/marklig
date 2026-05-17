//! Per-file ChaCha20-Poly1305 envelope with HKDF-derived per-file keys.
//!
//! Wire format:
//! ```text
//! [12-byte random nonce] [ciphertext + 16-byte Poly1305 tag]
//! ```
//!
//! No AAD: the per-file key is already bound to `(folder_id, relpath)` via
//! HKDF info, so AAD would be redundant. If we later add length-prefixing
//! for storage-side framing, AAD will hold that prefix.
//!
//! **Stability boundary:** the HKDF info string format (`b"file:" ||
//! folder_id || relpath`) is part of the wire ABI. Changing it
//! invalidates every existing ciphertext blob. Don't.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use thiserror::Error;

use crate::pair::{PairId, PairKey};

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("ciphertext is shorter than nonce + tag")]
    Truncated,
    #[error("AEAD authentication failed — ciphertext tampered or wrong key")]
    AuthFailed,
    #[error("random number generator failed")]
    Rng,
}

impl From<getrandom::Error> for EnvelopeError {
    fn from(_: getrandom::Error) -> Self {
        EnvelopeError::Rng
    }
}

/// Derive a per-file symmetric key from the pair key, the folder identifier,
/// and the file's path within the folder. Deterministic — same inputs
/// always produce the same key.
pub fn derive_file_key(pair_key: &PairKey, folder_id: &PairId, relpath: &str) -> [u8; 32] {
    let mut info = Vec::with_capacity(b"file:".len() + folder_id.0.len() + relpath.len());
    info.extend_from_slice(b"file:");
    info.extend_from_slice(&folder_id.0);
    info.extend_from_slice(relpath.as_bytes());

    let hk = Hkdf::<Sha256>::new(Some(b"marklig-file-v1"), &pair_key.0);
    let mut out = [0u8; 32];
    hk.expand(&info, &mut out)
        .expect("HKDF expand to 32 bytes always succeeds");
    out
}

/// Encrypt `plaintext` under `file_key`. Returns a fresh blob with a
/// random nonce prepended. Caller stores or transmits the result as
/// opaque bytes.
pub fn seal(file_key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(file_key));
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| EnvelopeError::AuthFailed)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend(ct);
    Ok(out)
}

/// Decrypt a `seal()`-produced blob. Returns the original plaintext, or
/// an [`EnvelopeError::AuthFailed`] if anything (nonce, ciphertext, tag)
/// was modified.
pub fn open(file_key: &[u8; 32], wire: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    if wire.len() < NONCE_LEN + TAG_LEN {
        return Err(EnvelopeError::Truncated);
    }
    let (nonce, rest) = wire.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(file_key));
    cipher
        .decrypt(Nonce::from_slice(nonce), rest)
        .map_err(|_| EnvelopeError::AuthFailed)
}
