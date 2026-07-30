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

use marklig_lib::mdns::{
    self, announce_listening, announce_this_desktop, SyncAnnouncer, SERVICE_TYPE,
};

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
    let mut announcer = SyncAnnouncer::new();
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
    let mut announcer = SyncAnnouncer::new();
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
    let mut announcer = SyncAnnouncer::new();
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
    // `start` can be called twice without an intervening `stop`. The second
    // must not leave the first instance name resolvable.
    let first = unique_instance("first");
    let second = unique_instance("second");
    let mut announcer = SyncAnnouncer::new();

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

// ---------------------------------------------------------------------------
// The announcement's lifetime is the sync server's listener, not the pairing
// modal's. These are the cases that motivated the change.
// ---------------------------------------------------------------------------

#[test]
fn resolves_with_no_pairing_ever_armed() {
    // THE regression test. Before this change `SyncAnnouncer::start` had a
    // single call site inside `pairing_start`, so a desktop that was merely
    // running announced nothing and a phone whose stored address had gone
    // stale could not find it — Karl had to open the pairing modal for his
    // phone to reconnect.
    //
    // Nothing here arms a pairing: no `PairingState`, no `pairing_ws::arm`,
    // no QR. The only thing that happened is that a listener came up, which
    // is what `spawn_server` reports via `announce_listening`. That alone
    // must make the desktop resolvable.
    let instance = unique_instance("idle-desktop");
    let mut announcer = SyncAnnouncer::new();

    let fullname = announce_listening(&mut announcer, Some(14_200), &instance)
        .expect("announcing a bound listener does not error")
        .expect("a bound listener must be announced");
    assert_eq!(fullname, format!("{instance}.{SERVICE_TYPE}"));

    let peer = mdns::resolve_instance(&instance, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("an idle desktop with a listening sync server must be discoverable");

    assert_eq!(peer.instance_name, instance);
    assert_eq!(
        peer.port, 14_200,
        "the SRV port must be the one the listener bound"
    );
    assert!(
        !peer.addresses.is_empty(),
        "a resolved peer must carry a current address to dial, got {peer:?}"
    );

    announcer.stop().expect("announcement stops");
}

#[test]
fn a_desktop_whose_bind_failed_does_not_advertise() {
    // The negative half of the same rule. `listening: None` is what
    // `spawn_server` passes when `TcpListener::bind` lost the port — a
    // second Märklig instance, or anything else on WS_PORT. Announcing then
    // would publish an address whose port refuses every connection, and a
    // phone that resolved it would abandon a stored address that still
    // worked. Answerability, not mere liveness, is what may be advertised.
    let instance = unique_instance("bind-failed");
    let mut announcer = SyncAnnouncer::new();

    let announced = announce_listening(&mut announcer, None, &instance)
        .expect("declining to announce is not an error");
    assert!(
        announced.is_none(),
        "a failed bind reported a fullname: {announced:?}"
    );
    assert!(
        !announcer.is_active(),
        "a desktop that cannot answer must not have an announcement on the wire"
    );

    let found = mdns::resolve_instance(&instance, Duration::from_secs(2))
        .expect("resolve does not error");
    assert!(
        found.is_none(),
        "a desktop that could not bind its port was still discoverable: {found:?}"
    );
}

#[test]
fn losing_the_listener_withdraws_the_announcement() {
    // Same function, transition rather than initial state: whatever put the
    // announcement up, reporting the listener gone must take it down. This
    // is the assertion that bites if `announce_listening`'s `None` arm ever
    // becomes a no-op that leaves `active` in place.
    let instance = unique_instance("listener-lost");
    let mut announcer = SyncAnnouncer::new();

    announce_listening(&mut announcer, Some(14_200), &instance)
        .expect("announce does not error")
        .expect("precondition: a bound listener is announced");
    assert!(
        mdns::resolve_instance(&instance, RESOLVE_TIMEOUT)
            .expect("resolve does not error")
            .is_some(),
        "precondition: the announced desktop is discoverable"
    );

    announce_listening(&mut announcer, None, &instance).expect("withdrawal does not error");
    assert!(!announcer.is_active());

    // A fresh resolver daemon has an empty cache, so a Some here would mean
    // something genuinely still answers under this name.
    let after = mdns::resolve_instance(&instance, Duration::from_secs(2))
        .expect("resolve does not error");
    assert!(
        after.is_none(),
        "the desktop stayed resolvable after its listener went away: {after:?}"
    );
}

#[test]
fn the_name_the_qr_would_carry_is_the_one_on_the_wire() {
    // `pairing_ws::spawn_server` announces this desktop at startup and
    // `pairing_start` builds the QR much later. The QR does not re-derive the
    // name: it reads `announced_instance_name()`, the value this asserts
    // against reality by resolving it over real multicast.
    //
    // This runs the *real* derivation — whatever this machine is called,
    // `gethostname(2)` and the sanitizer have to produce something
    // announceable, which is the half that had never been exercised.
    let mut announcer = SyncAnnouncer::new();

    announce_this_desktop(&mut announcer, Some(14_200))
        .expect("this machine's own name must be announceable")
        .expect("a bound listener must be announced");

    let for_the_qr = announcer
        .announced_instance_name()
        .expect("an active announcement must be able to name itself");
    assert_eq!(
        announcer.fullname().as_deref(),
        Some(format!("{for_the_qr}.{SERVICE_TYPE}").as_str()),
        "the name offered to the QR must be the instance half of the fullname on the wire"
    );

    // The assertion that would fail if the QR named something nobody
    // announces: a fresh resolver daemon, an empty cache, and the only string
    // `pairing_start` can reach.
    let peer = mdns::resolve_instance(&for_the_qr, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("the name the QR would carry must resolve to this desktop");
    assert_eq!(peer.instance_name, for_the_qr);
    assert_eq!(peer.port, 14_200);

    announcer.stop().expect("announcement stops");
    assert_eq!(
        announcer.announced_instance_name(),
        None,
        "a withdrawn announcement must offer the QR no name at all"
    );
}

#[test]
fn a_conflict_rename_is_adopted_so_the_qr_follows_it() {
    // Two desktops that want the same name — the steady state Karl hit once
    // the announcement stopped being gated on the pairing modal. mdns-sd
    // resolves it per RFC 6762 §9 by renaming the *second* announcement, and
    // from that moment the name the second one proposed resolves to the
    // *first* machine. The property under test is that the second desktop's
    // `announced_instance_name()` — the only string its QR can carry — moves
    // to the renamed one, so its QR keeps naming itself.
    //
    // Both announcers own independent `ServiceDaemon`s, so the conflict is
    // detected over real multicast. The two announce different SRV ports
    // because RFC 6762 §9 only calls it a conflict when the rdata *differs*:
    // between two machines the differing A records do that, but inside one
    // process every address is the same, so the port stands in for them.
    let wanted = unique_instance("collide");
    const FIRST_PORT: u16 = 14_200;
    const SECOND_PORT: u16 = 14_201;

    let mut first = SyncAnnouncer::new();
    first.start(&wanted, FIRST_PORT).expect("first announcement");
    // Let the first finish probing, so the second's probe is what conflicts.
    assert!(
        mdns::resolve_instance(&wanted, RESOLVE_TIMEOUT)
            .expect("resolve does not error")
            .is_some(),
        "precondition: the first desktop holds the name"
    );

    let mut second = SyncAnnouncer::new();
    second
        .start(&wanted, SECOND_PORT)
        .expect("second announcement");

    // Conflict resolution runs while the second daemon probes; poll for the
    // adoption rather than sleeping a fixed amount, and fail loudly with the
    // name that would have gone into the QR if it never happens.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let renamed = loop {
        let name = second
            .announced_instance_name()
            .expect("an active announcement must be able to name itself");
        if name != wanted {
            break name;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the second desktop never adopted a rename; its QR still offers \
             {name:?}, which resolves to the first desktop"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        renamed.starts_with(&wanted),
        "a rename must stay recognizably ours, got {renamed:?}"
    );

    // The point of the whole exercise: the name the second desktop's QR would
    // carry resolves to the second desktop, not to the neighbour that won the
    // name. The SRV port is what tells them apart.
    let mine = mdns::resolve_instance(&renamed, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("the renamed announcement must be resolvable");
    assert_eq!(
        mine.port, SECOND_PORT,
        "the name the QR would carry resolved to the wrong desktop: {mine:?}"
    );

    // Deliberately *not* asserted: that the contested name now resolves to
    // the first desktop. It usually does, but the renamed daemon can keep
    // answering the name it probed under until that record expires, and which
    // of the two answers a query first is mdns-sd's conflict-resolution
    // timing rather than anything this module guarantees. The invariant here
    // is only that our QR names us.

    second.stop().expect("second announcement stops");
    first.stop().expect("first announcement stops");
}
