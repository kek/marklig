use marklig_sync_core::ops::{resolve, LamportClock, Op, OpKind};

fn put(relpath: &str, mtime: u64, hash_byte: u8) -> Op {
    Op {
        kind: OpKind::Put,
        relpath: relpath.to_string(),
        hash: [hash_byte; 32],
        mtime_logical: mtime,
        ciphertext_ref: Some([0u8; 16]),
    }
}

#[test]
fn lamport_starts_at_zero_and_ticks_monotonically() {
    let mut c = LamportClock::new();
    assert_eq!(c.value(), 0);
    assert_eq!(c.tick(), 1);
    assert_eq!(c.tick(), 2);
    assert_eq!(c.value(), 2);
}

#[test]
fn lamport_observe_pulls_forward() {
    let mut c = LamportClock::new();
    c.observe(10);
    assert_eq!(c.value(), 10);
    assert_eq!(c.tick(), 11);
}

#[test]
fn lamport_observe_doesnt_go_backwards() {
    let mut c = LamportClock::from(20);
    c.observe(5);
    assert_eq!(c.value(), 20);
}

#[test]
fn resolve_higher_mtime_wins() {
    let a = put("x.md", 3, 0xaa);
    let b = put("x.md", 7, 0x11);
    assert_eq!(resolve(&a, &b).hash, [0x11; 32]);
}

#[test]
fn resolve_equal_mtime_breaks_on_lexicographically_larger_hash() {
    let a = put("x.md", 5, 0xff);
    let b = put("x.md", 5, 0x00);
    assert_eq!(resolve(&a, &b).hash, [0xff; 32]);
    assert_eq!(resolve(&b, &a).hash, [0xff; 32]); // commutative
}

#[test]
fn resolve_is_idempotent_on_identical_ops() {
    let a = put("x.md", 5, 0x42);
    let b = put("x.md", 5, 0x42);
    let winner = resolve(&a, &b);
    assert_eq!(winner.hash, a.hash);
    assert_eq!(winner.relpath, "x.md");
}

#[test]
fn op_serde_roundtrip_json() {
    let op = put("docs/intro.md", 99, 0xab);
    let s = serde_json::to_string(&op).unwrap();
    let back: Op = serde_json::from_str(&s).unwrap();
    assert_eq!(op, back);
}

#[test]
fn delete_op_serde_with_no_ciphertext_ref() {
    let op = Op {
        kind: OpKind::Delete,
        relpath: "doomed.md".to_string(),
        hash: [0u8; 32],
        mtime_logical: 17,
        ciphertext_ref: None,
    };
    let s = serde_json::to_string(&op).unwrap();
    let back: Op = serde_json::from_str(&s).unwrap();
    assert_eq!(op, back);
    assert!(back.ciphertext_ref.is_none());
}
