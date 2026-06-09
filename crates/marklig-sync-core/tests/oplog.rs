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
