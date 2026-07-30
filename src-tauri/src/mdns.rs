//! Zero-config sync discovery over mDNS/DNS-SD (`_marklig-sync._tcp`).
//!
//! v2.0-alpha shipped the pairing transport as a WebSocket server on a
//! fixed port with the desktop's LAN address frozen into the QR payload
//! (`pairing_ws.rs`, `QrPayload::host`). That breaks on any DHCP change:
//! the phone reconnects to an address the desktop no longer holds. This
//! module is the v2.x fix — the desktop announces itself by *name*, and a
//! peer resolves that name to a current address instead of trusting a
//! stored one.
//!
//! Two halves, deliberately separate:
//!
//! - [`SyncAnnouncer`] owns the announcement. Its lifetime is the sync
//!   server's: [`announce_listening`] puts it on the wire once
//!   [`crate::pairing_ws::spawn_server`] has bound its listener, and it
//!   stays up for the rest of the app session — nothing during a session
//!   takes it down. An unanswerable announcement is worse than none, so a
//!   bind that *failed* announces nothing; see `announce_listening`, and
//!   see `Drop` for why quit needs no explicit goodbye.
//! - [`resolve_instance`] and [`browse_peers`] are the discovery side,
//!   exposed to the frontend as commands. Each call runs on its own
//!   short-lived [`ServiceDaemon`]: a fresh daemon has an empty record
//!   cache, so a result means something answered *now* rather than
//!   "answered at some point this session". That property is what makes
//!   the discovery tests meaningful.
//!
//! ## Why this is not gated on the pairing modal
//!
//! Until this change the announcement was armed and disarmed in lockstep
//! with `pairing_start` / `pairing_cancel`, on the principle that a
//! *pairing* service which answers while no pairing is possible is a lie.
//! The principle is right; the fact it was applied to was the wrong one.
//!
//! What a peer resolves this name for is **reconnecting an existing
//! pairing** — `mobile-sync-client.ts`'s `dialTarget()` resolves the
//! `mdns_instance_name` stored in its pairing record after a dial to the
//! stored address fails. It is not pairing; it is asking "where is the
//! desktop I am already paired with?". The answer to that is yes whenever
//! `pairing_ws`'s listener is bound, because the `subscribe` and
//! `sync_request` frame paths do not consult the pairing arm state at all
//! — only the Noise-handshake path does. Gating the announcement on the
//! modal therefore withheld an answer the desktop could give, which is
//! what left reconnect-after-DHCP-change broken.
//!
//! Pairing openness is deliberately **not** advertised here, by TXT flag
//! or by a second service type:
//!
//! - Nothing needs it. A phone about to pair reads the host *and* the
//!   instance name off the QR code, which is only on screen while pairing
//!   is armed — an out-of-band channel that already carries the fact, and
//!   the one the Noise XK authentication rests on. `browse_peers` has no
//!   caller that offers a pairing target.
//! - A flag that flipped would cost a re-registration on every
//!   `pairing_start`, and mdns-sd re-probes a name it re-registers. The
//!   name is not resolvable during that probe, so a changing flag would
//!   punch holes in exactly the reconnect path this module exists to fix.
//!
//! So the record states a *capability* (`proto=ws`, `txtvers=2`) that is
//! true for as long as it is on the wire, and says nothing about pairing.

use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};

/// The DNS-SD service type, fully qualified. Matches the name reserved
/// for it in the v2 mobile spec and carried in `QrPayload`'s
/// `mdns_instance_name` since v2.0-alpha.
pub const SERVICE_TYPE: &str = "_marklig-sync._tcp.local.";

/// TXT key advertising which protocol the SRV port speaks. Present so a
/// peer that finds us can tell a v2.x WebSocket desktop from the raw-TCP
/// transport the original step-6 plan described — the port number alone
/// is not self-describing.
const TXT_PROTO: &str = "proto";
const TXT_PROTO_WS: &str = "ws";

/// TXT key for the pairing wire version, so a future desktop can change
/// the handshake without a peer mistaking it for this one.
const TXT_VERSION: &str = "txtvers";
const TXT_VERSION_V2: &str = "2";

#[derive(Debug, thiserror::Error)]
pub enum MdnsError {
    #[error("mdns daemon: {0}")]
    Daemon(String),
    #[error("mdns registration: {0}")]
    Register(String),
    #[error("instance name {0:?} is not usable as a DNS-SD instance name")]
    BadInstanceName(String),
}

impl serde::Serialize for MdnsError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The instance name this desktop announces itself under, and the same
/// string `QrPayload::mdns_instance_name` carries to the phone.
///
/// Single source of truth on purpose: the announcement is started from
/// `pairing_ws::spawn_server` at startup and the QR is built later in
/// `pairing_start`, so two independent derivations of the name could
/// disagree and print a QR naming something nobody announces.
///
/// KNOWN DEFECT (queued separately, do not fix here): neither `HOSTNAME`
/// nor `HOST` is set for a macOS app launched from Finder or the Dock, so
/// this falls back to `marklig-marklig` on the very launches Karl
/// actually uses. Two Märklig desktops on one LAN then collide, mdns-sd
/// re-probes and renames one, and the renamed instance no longer matches
/// the name in its own QR.
pub fn instance_name() -> String {
    // Hostname-derived, sanitized to mDNS-safe ASCII.
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "marklig".to_string());
    let mut out = String::new();
    for ch in host.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
        }
    }
    if out.is_empty() {
        out.push_str("marklig");
    }
    format!("marklig-{}", out)
}

/// One resolved `_marklig-sync._tcp` peer, flattened for the IPC boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    /// The DNS-SD instance name, with the service type stripped — the same
    /// string the desktop puts in `QrPayload::mdns_instance_name`.
    pub instance_name: String,
    /// The announced host name (`something.local.`). Kept for diagnostics;
    /// `addresses` is what a caller should dial, since resolving a
    /// `.local.` name again would mean a second mDNS round trip.
    pub hostname: String,
    /// SRV port — the desktop's `WS_PORT`.
    pub port: u16,
    /// Every address the peer announced, sorted so the caller's "first
    /// one" is stable across resolves rather than a hash-order accident.
    pub addresses: Vec<String>,
    /// TXT `proto`, if the peer advertised one. `Some("ws")` for a v2.x
    /// desktop; `None` from an announcer that predates the TXT record.
    pub proto: Option<String>,
}

/// Holds the announcement for as long as the sync server is listening.
///
/// `start` is idempotent in the way callers need: calling it twice without
/// an intervening `stop` must not leave the first instance name
/// resolvable.
pub struct SyncAnnouncer {
    /// `None` while nothing is announced. Each start gets a fresh daemon so
    /// `stop` can tear the responder down completely rather than leaving a
    /// daemon holding stale records.
    active: Option<Announcement>,
}

struct Announcement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl SyncAnnouncer {
    pub fn new() -> Self {
        Self { active: None }
    }

    /// True while an announcement is on the wire.
    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// The fullname currently announced, if any.
    pub fn fullname(&self) -> Option<&str> {
        self.active.as_ref().map(|a| a.fullname.as_str())
    }

    /// Announce `instance` on `port` and return the resulting fullname
    /// (`<instance>.<SERVICE_TYPE>`). Any previous announcement from this
    /// announcer is withdrawn first.
    pub fn start(&mut self, instance: &str, port: u16) -> Result<String, MdnsError> {
        if instance.is_empty() || instance.contains('.') {
            // A dot would be read as a label separator and silently
            // reshape the fullname, so the caller's instance name would
            // no longer be the one a peer resolves.
            return Err(MdnsError::BadInstanceName(instance.to_string()));
        }
        // Withdraw first: two registrations of the same service type from
        // one daemon would both stay resolvable.
        self.stop()?;

        let daemon = ServiceDaemon::new().map_err(|e| MdnsError::Daemon(e.to_string()))?;
        // `<instance>.local.` as the host name, with `enable_addr_auto` so
        // the daemon fills in (and keeps updating) the interface addresses
        // itself. Hard-coding an address here would reintroduce exactly the
        // staleness this module exists to remove.
        let host_name = format!("{instance}.local.");
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            instance,
            &host_name,
            (),
            port,
            &[(TXT_VERSION, TXT_VERSION_V2), (TXT_PROTO, TXT_PROTO_WS)][..],
        )
        .map_err(|e| MdnsError::Register(e.to_string()))?
        .enable_addr_auto();

        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| MdnsError::Register(e.to_string()))?;

        self.active = Some(Announcement {
            daemon,
            fullname: fullname.clone(),
        });
        Ok(fullname)
    }

    /// Withdraw the announcement. Sends the DNS-SD goodbye and waits
    /// briefly for the daemon to confirm it went out, so a peer that
    /// resolves immediately afterwards sees us gone rather than racing a
    /// still-queued packet. No-op when nothing is announced.
    pub fn stop(&mut self) -> Result<(), MdnsError> {
        let Some(active) = self.active.take() else {
            return Ok(());
        };
        // Best-effort on both steps: a daemon that has already died takes
        // its records with it, which is the outcome we wanted anyway.
        if let Ok(rx) = active.daemon.unregister(&active.fullname) {
            let _ = rx.recv_timeout(GOODBYE_TIMEOUT);
        }
        if let Ok(rx) = active.daemon.shutdown() {
            let _ = rx.recv_timeout(GOODBYE_TIMEOUT);
        }
        Ok(())
    }
}

impl Default for SyncAnnouncer {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SyncAnnouncer {
    fn drop(&mut self) {
        // Don't leave an announcement pointing at a process that is going
        // away — a peer would dial a port nobody is listening on.
        //
        // This covers the paths where the announcer is genuinely dropped.
        // It does NOT cover app quit: Tauri's `app.exit` ends in
        // `process::exit`, which runs no destructors, so a quitting desktop
        // sends no DNS-SD goodbye. That is safe rather than merely
        // tolerated — `collect_peers` gives every resolve a brand-new
        // daemon with an empty cache, so a desktop that has exited cannot
        // be resolved from a stale record; it just fails to answer.
        let _ = self.stop();
    }
}

/// Bring the announcement in line with whether the sync server is actually
/// listening.
///
/// `listening` is `Some(port)` once `pairing_ws`'s `TcpListener` is bound,
/// and `None` when the bind failed. The `None` arm withdraws rather than
/// announcing, and that is the whole point of routing through one
/// function: the bind is the only thing that makes this desktop
/// answerable, so a desktop whose bind lost the port (a second Märklig
/// instance, or anything else already on `WS_PORT`) must stay silent. It
/// would otherwise publish an address whose port refuses every connection,
/// and a phone that resolved it would abandon a stored address that still
/// worked.
///
/// Returns the announced fullname, or `None` when nothing is announced.
pub fn announce_listening(
    announcer: &mut SyncAnnouncer,
    listening: Option<u16>,
    instance: &str,
) -> Result<Option<String>, MdnsError> {
    match listening {
        Some(port) => announcer.start(instance, port).map(Some),
        None => {
            announcer.stop()?;
            Ok(None)
        }
    }
}

/// How long to wait for the daemon to acknowledge unregister/shutdown.
const GOODBYE_TIMEOUT: Duration = Duration::from_secs(2);

/// Resolve one instance name to a dialable peer, or `None` if nothing
/// answers within `timeout`.
///
/// Runs its own daemon, so this never reports a peer from a cache warmed
/// earlier in the process — a `Some` means the peer answered a query
/// issued by this call.
pub fn resolve_instance(
    instance: &str,
    timeout: Duration,
) -> Result<Option<DiscoveredPeer>, MdnsError> {
    let wanted = instance.to_string();
    let found = collect_peers(timeout, |peer| peer.instance_name == wanted, true)?;
    Ok(found.into_iter().next())
}

/// List every `_marklig-sync._tcp` peer that answers within `timeout`.
///
/// Always spends the full `timeout`: unlike a resolve there is no
/// "found it" condition that would let us stop early, since a second
/// desktop may answer later than the first.
pub fn browse_peers(timeout: Duration) -> Result<Vec<DiscoveredPeer>, MdnsError> {
    collect_peers(timeout, |_| true, false)
}

/// Browse the service type, keeping every resolved peer that `accept`
/// approves and discarding the rest.
///
/// `accept` is a filter, not merely an early-exit hint: anything it rejects
/// must never reach the caller. A resolve asks for one specific instance
/// name, but the browse it runs on hears *every* desktop on the LAN, so
/// letting a rejected peer through would answer "who is at this name?" with
/// an unrelated machine.
///
/// With `stop_on_first_match` the browse returns as soon as one peer is
/// accepted; otherwise it runs the full `timeout`, since a second desktop
/// may answer later than the first.
fn collect_peers(
    timeout: Duration,
    accept: impl Fn(&DiscoveredPeer) -> bool,
    stop_on_first_match: bool,
) -> Result<Vec<DiscoveredPeer>, MdnsError> {
    let daemon = ServiceDaemon::new().map_err(|e| MdnsError::Daemon(e.to_string()))?;
    let rx = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| MdnsError::Daemon(e.to_string()))?;

    let deadline = Instant::now() + timeout;
    let mut peers: Vec<DiscoveredPeer> = Vec::new();

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        // A recv timeout (or a dead channel) is the normal way out, not an
        // error: it means nothing more answered in the window.
        let Ok(event) = rx.recv_timeout(remaining) else {
            break;
        };
        match event {
            ServiceEvent::ServiceResolved(resolved) => {
                let peer = peer_from_resolved(&resolved);
                // A peer mid-probe can resolve without addresses; it isn't
                // dialable yet, so treat it as not-yet-found and let the
                // browse keep running.
                if peer.addresses.is_empty() {
                    continue;
                }
                // Reject first — a peer the caller didn't ask about must not
                // be recorded at all, however the loop ends.
                if !accept(&peer) {
                    continue;
                }
                if !peers.iter().any(|p| p.instance_name == peer.instance_name) {
                    peers.push(peer);
                }
                if stop_on_first_match {
                    break;
                }
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                // A goodbye that lands mid-browse retracts the peer, so we
                // don't hand back an address that just went away.
                if let Some(name) = instance_name_of(&fullname) {
                    peers.retain(|p| p.instance_name != name);
                }
            }
            _ => {}
        }
    }

    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();

    Ok(peers)
}

fn peer_from_resolved(resolved: &mdns_sd::ResolvedService) -> DiscoveredPeer {
    let mut addresses: Vec<String> = resolved
        .get_addresses()
        .iter()
        .map(|a| a.to_ip_addr().to_string())
        .collect();
    addresses.sort();

    DiscoveredPeer {
        instance_name: instance_name_of(resolved.get_fullname())
            .unwrap_or_else(|| resolved.get_fullname().to_string()),
        hostname: resolved.get_hostname().to_string(),
        port: resolved.get_port(),
        addresses,
        proto: resolved.get_property_val_str(TXT_PROTO).map(str::to_string),
    }
}

/// Strip the service type from a fullname, yielding the instance name.
/// `None` when the fullname isn't one of ours.
fn instance_name_of(fullname: &str) -> Option<String> {
    fullname
        .strip_suffix(SERVICE_TYPE)
        .and_then(|s| s.strip_suffix('.'))
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Default discovery window. Long enough for a peer that is still probing
/// its name (~750ms) to finish and answer, short enough that a UI can
/// block on it.
const DEFAULT_DISCOVERY_MS: u64 = 3_000;

/// Find a desktop by the instance name from its QR payload. `None` means
/// nothing is announcing that name on this LAN right now — which, since
/// the announcement tracks the sync server's listener rather than the
/// pairing modal, means the desktop is not running (or never got its
/// port). A desktop that is merely idle, with no pairing modal open, does
/// answer.
#[tauri::command]
pub fn mdns_resolve_instance(
    instance_name: String,
    timeout_ms: Option<u64>,
) -> Result<Option<DiscoveredPeer>, MdnsError> {
    resolve_instance(
        &instance_name,
        Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_DISCOVERY_MS)),
    )
}

/// List every desktop currently announcing a reachable sync server.
#[tauri::command]
pub fn mdns_browse_peers(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredPeer>, MdnsError> {
    browse_peers(Duration::from_millis(
        timeout_ms.unwrap_or(DEFAULT_DISCOVERY_MS),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_name_round_trips_through_the_fullname() {
        let fullname = format!("marklig-laptop.{SERVICE_TYPE}");
        assert_eq!(
            instance_name_of(&fullname).as_deref(),
            Some("marklig-laptop")
        );
    }

    #[test]
    fn foreign_service_types_are_not_ours() {
        assert_eq!(instance_name_of("printer._ipp._tcp.local."), None);
    }

    #[test]
    fn a_dotted_instance_name_is_refused() {
        // Silently accepting this would announce a different name than the
        // one the QR payload tells the phone to look for.
        let mut announcer = SyncAnnouncer::new();
        assert!(matches!(
            announcer.start("marklig.laptop", 14_200),
            Err(MdnsError::BadInstanceName(_))
        ));
        assert!(!announcer.is_active());
    }

    #[test]
    fn instance_name_is_a_usable_dns_sd_label() {
        // Whatever the environment, the announced name has to survive
        // `start`'s validation — otherwise the desktop silently never
        // announces on exactly the launches where `$HOSTNAME` is unset.
        let name = instance_name();
        assert!(!name.is_empty());
        assert!(!name.contains('.'), "{name} would reshape the fullname");
        assert!(
            name.starts_with("marklig-"),
            "{name} must be recognizable as ours"
        );
    }
}
