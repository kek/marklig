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

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceInfo};

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
    // between two machines the differing A records do that, but two
    // `SyncAnnouncer`s announce the same addresses, so the port stands in for
    // them. That makes this a test of a conflict on *SRV* rdata, which is why
    // it stays even though
    // `differing_addresses_from_two_hosts_rename_us_and_the_qr_follows` below
    // now covers the address axis for real — a different record, and a rename
    // that takes one probe round rather than two.
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

// ---------------------------------------------------------------------------
// The differing-A-records axis: two *hosts* claiming one name with different
// addresses.
//
// `a_conflict_rename_is_adopted_so_the_qr_follows_it` above has to make its
// conflict by differing the SRV *port*, because two announcements that
// `SyncAnnouncer` builds inside one process carry identical rdata, and RFC 6762
// §9 calls only *differing* rdata a conflict. The port therefore stands in for
// what two real machines actually differ by — their A records — and that axis
// was left to "check it on two Macs", which is a test nobody runs.
//
// It does not need two machines. Production never states an address (`()` plus
// `enable_addr_auto`), but `ServiceInfo::new` takes one, so a *test* can
// hand-build a neighbour that claims an address this machine does not hold and
// get a real §9 conflict on differing A records from a single bench.
//
// Everything else about that neighbour matches what `SyncAnnouncer` puts on the
// wire — same host label, same TXT, and deliberately the *same port* — so the
// addresses are the only rdata that differs, and therefore the only thing that
// can be causing the conflict.
//
// What mdns-sd then does is a two-step chain, which is why this reaches the
// instance name at all: the differing A records collide on the *host* name and
// rename it (`<name>.local.` -> `<name>-2.local.`), which rewrites the SRV
// record's target and re-probes it, and *that* probe finds a differing SRV
// rdata and renames the service instance. Only the second half is a
// `NameChange` our `adopt_rename` accepts — it rejects host renames on purpose
// — so the whole chain has to run for the QR to follow.
// ---------------------------------------------------------------------------

/// A stand-in for a second machine: an announcement of `instance` on `port`
/// that claims `addresses` *explicitly*.
///
/// **TEST-ONLY. The explicit address must not be lifted into production.**
/// `mdns::SyncAnnouncer::start` passes `()` with `.enable_addr_auto()` on
/// purpose, so the daemon keeps the address list current by itself; pinning an
/// address there would put back exactly the staleness `src-tauri/src/mdns.rs`
/// exists to remove (the frozen `QrPayload::host` of v2.0-alpha — see that
/// module's header). The fabrication below is legitimate only because its whole
/// job is to be *wrong*: an address the announcing machine does not have, so
/// that one process can put two differing A records for one name on the wire.
struct FabricatedNeighbour {
    daemon: ServiceDaemon,
    /// The name as registered, for the reason `Announcement` documents in the
    /// module under test: mdns-sd keys its service table by the name the caller
    /// passed, so `unregister` has to name the original.
    registered_fullname: String,
}

impl FabricatedNeighbour {
    fn announce(instance: &str, port: u16, addresses: &str) -> Self {
        let daemon = ServiceDaemon::new().expect("the neighbour's daemon starts");
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            instance,
            &format!("{instance}.local."),
            addresses,
            port,
            // The same TXT `SyncAnnouncer` announces. Differing TXT rdata would
            // itself be a §9 conflict and would rename us for the wrong reason.
            &[("txtvers", "2"), ("proto", "ws")][..],
        )
        .expect("the neighbour's ServiceInfo is well-formed");
        let registered_fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .expect("the neighbour's announcement registers");
        Self {
            daemon,
            registered_fullname,
        }
    }

    fn stop(self) {
        if let Ok(rx) = self.daemon.unregister(&self.registered_fullname) {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
        if let Ok(rx) = self.daemon.shutdown() {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

/// Every IPv4 address this machine holds.
///
/// Enumerated from the interfaces rather than learned off the wire, and that is
/// not a stylistic choice: `resolve_instance` returns as soon as one answer
/// arrives, so the address set it reports is whatever happened to be cached at
/// that instant. A first version of this test derived the neighbour's addresses
/// from a resolve of our own announcement and was flaky for exactly that
/// reason — one run saw only `127.0.0.1`. The conflict has to differ from *all*
/// of our addresses, so the set has to be complete.
///
/// IPv4 only: a link-local IPv6 address carries a scope id that makes "same
/// subnet, different host" a much less crisp claim, and one differing A record
/// is all §9 needs.
fn this_machines_ipv4_addresses() -> Vec<Ipv4Addr> {
    local_ip_address::list_afinet_netifas()
        .expect("the interface list is readable on any host that can run this")
        .into_iter()
        .filter_map(|(_name, ip)| match ip {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .collect()
}

/// IPv4 addresses on this machine's own subnets that are *not* this machine's —
/// the rdata a second host would carry.
///
/// Derived rather than hardcoded, and that is the whole difficulty of doing this
/// from one bench: mdns-sd only announces an address on an interface whose
/// subnet contains it (`valid_ip_on_intf`), so an invented `10.99.99.99` is
/// filtered off every interface, the neighbour announces no A record at all,
/// and the test would pass while proving nothing. Each address here is one of
/// ours with the last octet moved, which stays inside the same subnet for any
/// realistic netmask while naming a host we are not. Nothing binds it — it is
/// rdata in a record, not a socket, so it does not have to be assignable.
fn addresses_this_machine_does_not_hold(ours: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let mut fabricated: Vec<Ipv4Addr> = Vec::new();
    for real in ours {
        let o = real.octets();
        // Kept clear of 0 and 255 so the result reads as a host address rather
        // than a network or broadcast one.
        let last = if o[3] < 253 { o[3] + 1 } else { o[3] - 1 };
        let candidate = Ipv4Addr::new(o[0], o[1], o[2], last);
        // Never one of ours: identical rdata is not a conflict at all, which is
        // the trap this whole test exists to get out of.
        if !ours.contains(&candidate) && !fabricated.contains(&candidate) {
            fabricated.push(candidate);
        }
    }
    fabricated
}

#[test]
fn differing_addresses_from_two_hosts_rename_us_and_the_qr_follows() {
    // One port for both announcements, unlike the SRV-port test above: here
    // nothing but the A records can be the conflicting rdata.
    const SHARED_PORT: u16 = 14_200;

    let ours = this_machines_ipv4_addresses();
    let fabricated = addresses_this_machine_does_not_hold(&ours);
    assert!(
        !fabricated.is_empty(),
        "this machine holds no IPv4 address ({ours:?}), so a neighbour address \
         cannot be placed on a subnet mdns-sd would announce it on, and the \
         differing-A-records axis is not reachable from this host"
    );
    let fabricated_strings: Vec<String> = fabricated.iter().map(Ipv4Addr::to_string).collect();

    let wanted = unique_instance("addr-collide");

    // The neighbour goes first, so it wins the name and *our* announcement is
    // the one §9 renames — the adoption is what is under test.
    let neighbour =
        FabricatedNeighbour::announce(&wanted, SHARED_PORT, &fabricated_strings.join(","));

    // Before anything is asserted about a conflict, prove the fabrication
    // reached the wire. If mdns-sd declined an address, or filtered it off every
    // interface, it shows here — and a conflict assertion that passed afterwards
    // would be measuring nothing.
    let theirs = mdns::resolve_instance(&wanted, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("the fabricated neighbour must hold the contested name");
    assert_eq!(theirs.port, SHARED_PORT);
    for addr in &theirs.addresses {
        assert!(
            fabricated_strings.contains(addr),
            "the neighbour answered with {addr}, which is not one of the \
             fabricated {fabricated_strings:?}; the explicit address did not \
             reach the wire, so there are no differing A records to conflict"
        );
    }

    // Now this desktop, under the name the neighbour already holds.
    let mut announcer = SyncAnnouncer::new();
    announcer
        .start(&wanted, SHARED_PORT)
        .expect("our announcement starts");

    // Conflict resolution runs while our daemon probes, and here it takes two
    // probe rounds (host, then the SRV whose target the host rename moved). Poll
    // for the adoption rather than sleeping a fixed amount, and fail naming the
    // string that would have gone into the QR.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let renamed = loop {
        let name = announcer
            .announced_instance_name()
            .expect("an active announcement must be able to name itself");
        if name != wanted {
            break name;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "two differing A records for {wanted:?} ({fabricated_strings:?} from \
             the neighbour, {ours:?} from us) did not rename us: the QR still \
             offers {name:?}, which resolves to the neighbour"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        renamed.starts_with(&wanted),
        "a rename must stay recognizably ours, got {renamed:?}"
    );

    // The property the port test proves, proved through the address path: the
    // only name our QR can carry resolves to *us*. A fresh resolver daemon has
    // an empty cache, so this answer was given now rather than remembered.
    let mine = mdns::resolve_instance(&renamed, RESOLVE_TIMEOUT)
        .expect("resolve does not error")
        .expect("the renamed announcement must be resolvable");
    assert_eq!(mine.instance_name, renamed);
    assert_eq!(
        mine.port, SHARED_PORT,
        "both announcements carry this port, so it is not what tells them \
         apart here: {mine:?}"
    );
    // With the port identical the addresses are the discriminator, and none of
    // them may be the neighbour's. `collect_peers` discards a resolution that
    // carries no address at all, so this cannot pass vacuously.
    for addr in &mine.addresses {
        assert!(
            !fabricated_strings.contains(addr),
            "the name our QR would carry resolved to the fabricated neighbour \
             (address {addr}): {mine:?}"
        );
    }
    // And these are two distinct announcements rather than one record seen
    // twice: only ours was renamed, so only ours answers under a new host name.
    assert_ne!(
        mine.hostname, theirs.hostname,
        "the renamed announcement answers under the neighbour's host name, so \
         it is the neighbour: {mine:?}"
    );

    announcer.stop().expect("our announcement stops");
    neighbour.stop();
}
