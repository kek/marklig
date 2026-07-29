//! Zero-config pairing discovery over mDNS/DNS-SD (`_marklig-sync._tcp`).
//!
//! v2.0-alpha shipped the pairing transport as a WebSocket server on a
//! fixed port with the desktop's LAN address frozen into the QR payload
//! (`pairing_ws.rs`, `QrPayload::host`). That breaks on any DHCP change:
//! the phone reconnects to an address the desktop no longer holds. This
//! module is the v2.x fix — the desktop announces itself by *name* while
//! the pairing server is armed, and a peer resolves that name to a
//! current address instead of trusting a stored one.
//!
//! Two halves, deliberately separate:
//!
//! - [`PairingAnnouncer`] owns the announcement. It is armed and disarmed
//!   in lockstep with [`crate::pairing_ws::arm`] / `disarm`, so the
//!   service is only visible while the desktop will actually accept a
//!   handshake. An unanswerable announcement is worse than none.
//! - [`resolve_instance`] and [`browse_peers`] are the discovery side,
//!   exposed to the frontend as commands. Each call runs on its own
//!   short-lived [`ServiceDaemon`]: a fresh daemon has an empty record
//!   cache, so a result means something answered *now* rather than
//!   "answered at some point this session". That property is what makes
//!   the discovery tests meaningful.
//!
//! Scope note: only the desktop half lives here. The phone still dials
//! `QrPayload::host` (`src/shell/mobile-sync-client.ts`); switching it to
//! resolve the instance name needs the Android mDNS path and a device to
//! prove it on.

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

/// Holds the announcement for as long as the pairing server is armed.
///
/// `start` is idempotent in the way the pairing UI needs: the frontend can
/// call `pairing_start` twice without an intervening `pairing_cancel`, and
/// the second call must not leave the first instance name resolvable.
pub struct PairingAnnouncer {
    /// `None` while disarmed. Each arm gets a fresh daemon so `stop` can
    /// tear the responder down completely rather than leaving a daemon
    /// holding stale records.
    active: Option<Announcement>,
}

struct Announcement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl PairingAnnouncer {
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
    /// still-queued packet. No-op when already disarmed.
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

impl Default for PairingAnnouncer {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PairingAnnouncer {
    fn drop(&mut self) {
        // Don't leave an announcement pointing at a process that is going
        // away — a peer would dial a port nobody is listening on.
        let _ = self.stop();
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
/// nothing is announcing that name on this LAN right now — which is also
/// the answer when the desktop is running but its pairing server is not
/// armed, since the announcement tracks the arm state.
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

/// List every desktop currently announcing itself for pairing.
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
        let mut announcer = PairingAnnouncer::new();
        assert!(matches!(
            announcer.start("marklig.laptop", 14_200),
            Err(MdnsError::BadInstanceName(_))
        ));
        assert!(!announcer.is_active());
    }
}
