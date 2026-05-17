use marklig_sync_core::envelope::{derive_file_key, open, seal, EnvelopeError};
use marklig_sync_core::pair::{PairId, PairKey};

#[test]
fn seal_open_roundtrip() {
    let key = [7u8; 32];
    let pt = "hello, märklig på telefonen".as_bytes();
    let wire = seal(&key, pt).unwrap();
    // Ciphertext must differ from plaintext.
    assert_ne!(&wire[12..], pt);
    // open() recovers the original bytes.
    let dec = open(&key, &wire).unwrap();
    assert_eq!(dec, pt);
}

#[test]
fn tampering_with_tag_fails_auth() {
    let key = [3u8; 32];
    let mut wire = seal(&key, b"sensitive").unwrap();
    let last = wire.len() - 1;
    wire[last] ^= 0x01;
    assert!(matches!(open(&key, &wire), Err(EnvelopeError::AuthFailed)));
}

#[test]
fn tampering_with_ciphertext_fails_auth() {
    let key = [3u8; 32];
    let mut wire = seal(&key, b"sensitive content").unwrap();
    // Flip a byte in the middle of the ciphertext (post-nonce, pre-tag).
    let mid = wire.len() / 2;
    wire[mid] ^= 0x80;
    assert!(matches!(open(&key, &wire), Err(EnvelopeError::AuthFailed)));
}

#[test]
fn tampering_with_nonce_fails_auth() {
    let key = [3u8; 32];
    let mut wire = seal(&key, b"sensitive").unwrap();
    wire[0] ^= 1;
    assert!(matches!(open(&key, &wire), Err(EnvelopeError::AuthFailed)));
}

#[test]
fn truncated_ciphertext_rejected() {
    let key = [3u8; 32];
    // Less than nonce + tag.
    assert!(matches!(
        open(&key, &[0u8; 20]),
        Err(EnvelopeError::Truncated)
    ));
}

#[test]
fn fresh_nonces_each_seal() {
    // Same plaintext + key should produce different wire blobs because the
    // nonce is random per seal().
    let key = [9u8; 32];
    let a = seal(&key, b"abc").unwrap();
    let b = seal(&key, b"abc").unwrap();
    assert_ne!(a, b);
    // But both decrypt to the original.
    assert_eq!(open(&key, &a).unwrap(), b"abc");
    assert_eq!(open(&key, &b).unwrap(), b"abc");
}

#[test]
fn distinct_per_file_keys() {
    let pk = PairKey([3u8; 32]);
    let fid = PairId([9u8; 16]);
    let k1 = derive_file_key(&pk, &fid, "a.md");
    let k2 = derive_file_key(&pk, &fid, "b.md");
    let k3 = derive_file_key(&pk, &fid, "subdir/a.md");
    assert_ne!(k1, k2);
    assert_ne!(k1, k3);
    assert_ne!(k2, k3);
}

#[test]
fn distinct_per_folder_keys() {
    let pk = PairKey([3u8; 32]);
    let fid_a = PairId([1u8; 16]);
    let fid_b = PairId([2u8; 16]);
    let k1 = derive_file_key(&pk, &fid_a, "x.md");
    let k2 = derive_file_key(&pk, &fid_b, "x.md");
    assert_ne!(k1, k2);
}

#[test]
fn file_key_derivation_is_deterministic() {
    let pk = PairKey([5u8; 32]);
    let fid = PairId([6u8; 16]);
    let k1 = derive_file_key(&pk, &fid, "deterministic.md");
    let k2 = derive_file_key(&pk, &fid, "deterministic.md");
    assert_eq!(k1, k2);
}

#[test]
fn wrong_key_fails_auth() {
    let k1 = [1u8; 32];
    let k2 = [2u8; 32];
    let wire = seal(&k1, b"secret").unwrap();
    assert!(matches!(open(&k2, &wire), Err(EnvelopeError::AuthFailed)));
}
