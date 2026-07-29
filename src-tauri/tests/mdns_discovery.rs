//! Integration test for `_marklig-sync._tcp` discovery. We bypass the Tauri
//! command layer (which needs a running app context) and drive the announcer
//! and the resolver directly — the command layer is a thin wrapper.
//!
//! These tests are real multicast, not a shared-state shortcut: the announcer
//! and the resolver each own an independent `ServiceDaemon`, so a query has to
//! leave one socket and arrive at the other over the loopback multicast path.
//! If discovery were faked in-process, `resolve_finds_nothing_when_silent`
//! would still pass while `announced_service_resolves_by_instance_name` did —
//! the pair only both pass when packets genuinely flow.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use std::time::Duration;

use marklig_lib::mdns::{self, PairingAnnouncer, SERVICE_TYPE};

/// Generous enough for probing (mdns-sd probes a fresh name for ~750ms before
/// announcing) plus a query/response round trip, without being a "sleep until
/// it works" retry loop.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// A distinct instance name per test run, so a stale record from an earlier
/// run (or a concurrent one) can never satisfy the assertion.
fn unique_instance(label: &str) -> String {
    format!(
        "marklig-test-{}-{}-{}",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    )
}

#[test]
fn announced_service_resolves_by_instance_name() {
    let instance = unique_instance("resolve");
    let mut announcer = PairingAnnouncer::new();
    let fullname = announcer
        .start(&instance, 14_200)
        .expect("announcement starts");
    assert_eq!(fullname, format!("{instance}.{SERVICE_TYPE}"));

    let peer = mdns::resolve_instance(&instance, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("the service we are announcing must be discoverable");

    assert_eq!(peer.instance_name, instance);
    assert_eq!(peer.port, 14_200, "SRV port must carry WS_PORT");
    assert!(
        !peer.addresses.is_empty(),
        "a resolved peer must carry at least one address to dial, got {peer:?}"
    );
    assert_eq!(
        peer.proto.as_deref(),
        Some("ws"),
        "the TXT record must tell the peer this port speaks WebSocket"
    );

    announcer.stop().expect("announcement stops");
}

#[test]
fn resolve_finds_nothing_when_silent() {
    // Nothing is announced under this name, so a resolve must come back empty
    // rather than inventing a peer. This is the guard that makes the positive
    // test meaningful.
    let instance = unique_instance("silent");

    let found = mdns::resolve_instance(&instance, Duration::from_secs(2))
        .expect("resolve does not error");

    assert!(
        found.is_none(),
        "resolved a peer nobody is announcing: {found:?}"
    );
}

#[test]
fn stopping_the_announcement_makes_the_peer_unresolvable() {
    let instance = unique_instance("stop");
    let mut announcer = PairingAnnouncer::new();
    announcer
        .start(&instance, 14_200)
        .expect("announcement starts");

    assert!(
        mdns::resolve_instance(&instance, RESOLVE_TIMEOUT)
            .expect("resolve does not error")
            .is_some(),
        "precondition: the armed announcement is discoverable"
    );

    announcer.stop().expect("announcement stops");

    // A fresh resolver daemon has an empty cache, so this can only succeed if
    // something actually answers the query — and after `stop` nothing does.
    let after = mdns::resolve_instance(&instance, Duration::from_secs(2))
        .expect("resolve does not error");
    assert!(
        after.is_none(),
        "the peer stayed resolvable after the announcement stopped: {after:?}"
    );
}

#[test]
fn browse_lists_the_announced_instance() {
    let instance = unique_instance("browse");
    let mut announcer = PairingAnnouncer::new();
    announcer
        .start(&instance, 14_200)
        .expect("announcement starts");

    let peers = mdns::browse_peers(RESOLVE_TIMEOUT).expect("browse does not error");

    assert!(
        peers.iter().any(|p| p.instance_name == instance),
        "browse missed the instance we are announcing; saw {:?}",
        peers.iter().map(|p| &p.instance_name).collect::<Vec<_>>()
    );

    announcer.stop().expect("announcement stops");
}

#[test]
fn restarting_replaces_the_previous_announcement() {
    // `pairing_start` can be called twice without an intervening cancel. The
    // second arm must not leave the first instance name resolvable.
    let first = unique_instance("first");
    let second = unique_instance("second");
    let mut announcer = PairingAnnouncer::new();

    announcer.start(&first, 14_200).expect("first announcement");
    announcer.start(&second, 14_200).expect("second announcement");

    assert!(
        mdns::resolve_instance(&second, RESOLVE_TIMEOUT)
            .expect("resolve does not error")
            .is_some(),
        "the current instance name must be resolvable"
    );
    let stale = mdns::resolve_instance(&first, Duration::from_secs(2))
        .expect("resolve does not error");
    assert!(
        stale.is_none(),
        "the superseded instance name stayed resolvable: {stale:?}"
    );

    announcer.stop().expect("announcement stops");
}
