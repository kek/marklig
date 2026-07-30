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
//! ## One name, derived once and read back from the wire
//!
//! `instance_name()` derives the name from `gethostname(2)` exactly once per
//! launch, and it is **private to this module** — the compiler is what keeps
//! it that way. `pairing_ws` announces through [`announce_this_desktop`],
//! which derives internally; everything that later needs to *name* this
//! desktop — `pairing_start`, building the QR — can only read
//! [`SyncAnnouncer::announced_instance_name`], because no second derivation
//! is reachable from outside this file.
//!
//! That is not tidiness. The two values can genuinely differ: mdns-sd
//! implements RFC 6762 §9 conflict resolution, so a name another desktop
//! already holds gets *ours* renamed to `<name> (2)`, and the string we
//! proposed now resolves to the neighbour. A QR built from a second
//! derivation would print that neighbour's name, and the phone would dial
//! the wrong desktop — a mis-pairing, not merely a missed discovery. See
//! [`AnnouncedInstance`].
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

use std::ffi::OsStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceEvent, ServiceInfo};
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

/// Prefix on every name this app announces, so one of our records is
/// recognizable in a browse listing that also carries printers and TVs.
const INSTANCE_PREFIX: &str = "marklig-";

/// Host label of last resort, used only when the OS hands us nothing
/// usable at all.
///
/// Deliberately a constant and not randomized: the phone stores the
/// instance name in its pairing record and resolves *that string* on every
/// later reconnect, so a name that changed per launch would break the one
/// path announcing-by-name exists for. Two hostname-less desktops on one
/// LAN therefore still want the same name — which is now a rename rather
/// than a mis-pairing, see [`AnnouncedInstance`].
const FALLBACK_HOST_LABEL: &str = "marklig";

/// Longest single DNS label (RFC 1035 §2.3.4). Binding here rather than in
/// DNS-SD's more generous instance-name rules because [`SyncAnnouncer::start`]
/// also uses this string as the announced host label (`<instance>.local.`).
const MAX_LABEL_LEN: usize = 63;

/// The instance name derived from *this machine's* hostname.
///
/// Private on purpose, and the only caller is [`announce_this_desktop`]:
/// with no way to reach this from another module, a second derivation of the
/// name — the thing that let a renamed desktop print a QR naming its
/// neighbour — cannot be written outside this file. Whatever needs to *name*
/// the announcement afterwards reads
/// [`SyncAnnouncer::announced_instance_name`]; see [`AnnouncedInstance`] for
/// why that is not merely tidier.
///
/// `gethostname(2)` via the `hostname` crate, not `$HOSTNAME`: neither
/// `HOSTNAME` nor `HOST` is exported to a macOS app launched from Finder or
/// the Dock, which is how this desktop is normally started, so the
/// environment route gave every such desktop the same name.
fn instance_name() -> String {
    match hostname::get() {
        Ok(raw) => instance_name_from_hostname(&raw),
        Err(e) => {
            // Vanishingly unlikely (POSIX gives gethostname almost no way
            // to fail) but it is an `io::Result`, so it gets an arm rather
            // than an `unwrap` that would take the app down at startup.
            eprintln!("mdns: gethostname failed ({e}); using the fallback instance name");
            instance_name_from_hostname(OsStr::new(""))
        }
    }
}

/// The pure half of the derivation: a raw OS hostname in, a name that is
/// legal both as a DNS-SD instance label and as a `.local.` host label out.
///
/// Split out from [`instance_name`] so the rules below can be tested
/// without an environment: `std::env::set_var` is process-global and would
/// race every other test in this binary, which is exactly how the old
/// env-var derivation shipped unexercised.
///
/// Total function — every input yields an announceable name, because the
/// alternative is a desktop that silently never announces:
///
/// - not UTF-8: read lossily, since a partially-legible hostname still says
///   which machine this is better than the fallback does;
/// - `Karls-Mac.local` / a full FQDN: only the first label identifies the
///   machine, and a `.` cannot appear in a label at all;
/// - characters that are illegal in a label (spaces, apostrophes,
///   non-ASCII): one `-` each, collapsed, and trimmed off the ends — a
///   label may not begin or end with `-`;
/// - longer than a DNS label allows: truncated, prefix included;
/// - nothing left: [`FALLBACK_HOST_LABEL`].
fn instance_name_from_hostname(raw: &OsStr) -> String {
    let lossy = raw.to_string_lossy();
    let label = lossy.trim().split('.').next().unwrap_or("");

    let mut host = String::with_capacity(label.len());
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            // Lower-cased so the value is stable: mDNS compares names
            // case-insensitively, but `resolve_instance` filters peers by
            // byte equality against the string from the QR.
            host.push(ch.to_ascii_lowercase());
        } else if !host.is_empty() && !host.ends_with('-') {
            host.push('-');
        }
    }
    // ASCII-only by construction, so byte slicing below cannot split a char.
    let room = MAX_LABEL_LEN - INSTANCE_PREFIX.len();
    let truncated = if host.len() > room { &host[..room] } else { &host[..] };
    let host = truncated.trim_end_matches('-');

    if host.is_empty() {
        format!("{INSTANCE_PREFIX}{FALLBACK_HOST_LABEL}")
    } else {
        format!("{INSTANCE_PREFIX}{host}")
    }
}

/// The name this desktop is announcing *right now*, and the only source for
/// the string `QrPayload::mdns_instance_name` carries to the phone.
///
/// A cell read back from the announcement rather than a recomputation,
/// because the name on the wire is not always the name that was passed to
/// [`SyncAnnouncer::start`]:
///
/// - mdns-sd implements RFC 6762 §9 conflict resolution. If another desktop
///   already holds our name, the daemon renames *ours* to `<name> (2)` and
///   reports it as [`DaemonEvent::NameChange`]. From then on the string we
///   proposed resolves to the *other* machine.
/// - Nothing is announced at all when the sync listener never bound.
///
/// `pairing_start` therefore reads this instead of deriving a name of its
/// own. Two derivations were how a renamed desktop came to print a QR whose
/// instance name resolved to its neighbour — worse than a missed
/// discovery, because the phone would then dial the wrong desktop and pair
/// with a stranger. There is no code path that puts a name in a QR without
/// reading it back from here, and `None` (no announcement) yields no name
/// rather than a guess: `QrPayload.host` is the fallback the phone already
/// handles, and `MobilePairingRecord` omits an empty instance name.
#[derive(Clone, Debug)]
pub struct AnnouncedInstance {
    /// The registered fullname, `<instance>.<SERVICE_TYPE>`. Shared with the
    /// monitor thread that adopts conflict renames.
    fullname: Arc<Mutex<String>>,
}

impl AnnouncedInstance {
    fn new(fullname: String) -> Self {
        Self {
            fullname: Arc::new(Mutex::new(fullname)),
        }
    }

    /// The fullname on the wire.
    pub fn fullname(&self) -> Option<String> {
        self.fullname.lock().ok().map(|f| f.clone())
    }

    /// The instance name on the wire, service type stripped — what the QR
    /// must carry.
    pub fn instance_name(&self) -> Option<String> {
        self.fullname.lock().ok().and_then(|f| instance_name_of(&f))
    }

    /// Adopt a rename that conflict resolution performed on us. Returns
    /// whether the change was ours to adopt.
    ///
    /// Both names are checked against our service type: mdns-sd also renames
    /// the *host* record (`marklig-x.local.` -> `marklig-x-2.local.`) and
    /// reports every name it defends, and adopting one of those would put a
    /// string that is not an instance name of ours into the QR. Our
    /// announcing daemon registers exactly one service of this type and
    /// browses nothing, so a change on this type is unambiguously ours.
    pub fn adopt_rename(&self, original: &str, new_fullname: &str) -> bool {
        if instance_name_of(original).is_none() || instance_name_of(new_fullname).is_none() {
            return false;
        }
        match self.fullname.lock() {
            Ok(mut current) => {
                *current = new_fullname.to_string();
                true
            }
            // A poisoned lock means the QR falls back to `host` rather than
            // naming something that may since have been renamed.
            Err(_) => false,
        }
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
    /// The fullname as *registered*. Keep it: mdns-sd keys its service table
    /// by the name the caller passed (the rename lives in the daemon's DNS
    /// registry, not in the `ServiceInfo`), so `unregister` after a conflict
    /// rename still has to name the original or it reports `NotFound` and no
    /// goodbye goes out.
    registered_fullname: String,
    /// The name actually on the wire, in a cell the monitor thread can move
    /// when conflict resolution renames us. Read by
    /// [`SyncAnnouncer::announced_instance_name`], which is what the QR uses.
    announced: AnnouncedInstance,
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
    pub fn fullname(&self) -> Option<String> {
        self.active.as_ref().and_then(|a| a.announced.fullname())
    }

    /// The instance name currently on the wire — the value, and the only
    /// value, that may go into a QR payload. `None` when nothing is
    /// announced.
    ///
    /// This is a read-back, not a re-derivation: it reports the name mdns-sd
    /// is actually defending, including one it renamed under RFC 6762 §9.
    pub fn announced_instance_name(&self) -> Option<String> {
        self.active
            .as_ref()
            .and_then(|a| a.announced.instance_name())
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
        let announced = AnnouncedInstance::new(fullname.clone());

        // Monitor *before* registering: the rename happens while the daemon
        // probes the name (~750ms after `register`), and a monitor attached
        // afterwards could miss the event and leave the QR naming the
        // instance the neighbour won.
        match daemon.monitor() {
            Ok(events) => {
                let announced = announced.clone();
                std::thread::spawn(move || {
                    // Ends when the daemon shuts down, i.e. in `stop` — so
                    // the thread cannot outlive its announcement and write
                    // into a later one.
                    while let Ok(event) = events.recv() {
                        if let DaemonEvent::NameChange(change) = event {
                            if announced.adopt_rename(&change.original, &change.new_name) {
                                eprintln!(
                                    "mdns: conflict resolution renamed us, now announcing {}",
                                    change.new_name
                                );
                            }
                        }
                    }
                });
            }
            // Not fatal, but it is the guarantee the QR rests on, so it is
            // loud: without it a renamed desktop would print a QR naming its
            // neighbour.
            Err(e) => eprintln!(
                "mdns: cannot watch {fullname} for conflict renames ({e}); \
                 a name collision would go unnoticed"
            ),
        }

        daemon
            .register(info)
            .map_err(|e| MdnsError::Register(e.to_string()))?;

        self.active = Some(Announcement {
            daemon,
            registered_fullname: fullname.clone(),
            announced,
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
        if let Ok(rx) = active.daemon.unregister(&active.registered_fullname) {
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

/// Announce *this desktop* — the whole startup path, name included.
///
/// The name is derived here, from `gethostname(2)`, and nowhere else: this is
/// the seam that makes the single-source rule a compile-time property rather
/// than a convention, since `instance_name` is private to this module. A
/// caller that later needs the name asks
/// [`SyncAnnouncer::announced_instance_name`] for the one on the wire.
///
/// `listening` carries the same meaning as in [`announce_listening`], which
/// this delegates to.
pub fn announce_this_desktop(
    announcer: &mut SyncAnnouncer,
    listening: Option<u16>,
) -> Result<Option<String>, MdnsError> {
    announce_listening(announcer, listening, &instance_name())
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

    // -----------------------------------------------------------------
    // The name derivation. Pinned over the raw hostname as an *argument*:
    // the defect these replace survived because the derivation read
    // `$HOSTNAME`, and a test of that would have to `set_var`, which is
    // process-global and races every other test in this binary. Nothing
    // below touches the environment.
    // -----------------------------------------------------------------

    fn derive(raw: &str) -> String {
        instance_name_from_hostname(OsStr::new(raw))
    }

    #[test]
    fn a_plain_hostname_becomes_the_instance_name() {
        assert_eq!(derive("kalle"), "marklig-kalle");
        assert_eq!(derive("Karls-MacBook-Pro"), "marklig-karls-macbook-pro");
    }

    #[test]
    fn only_the_machine_label_of_a_dotted_hostname_is_used() {
        // `gethostname` answers `<name>.local` on a stock macOS desktop, and
        // an FQDN on a managed one. A dot is a label separator: `start`
        // refuses one outright, and letting it through would reshape the
        // fullname a peer resolves.
        assert_eq!(
            derive("Karls-MacBook-Pro.local"),
            "marklig-karls-macbook-pro"
        );
        assert_eq!(
            derive("Karls-MacBook-Pro.local."),
            "marklig-karls-macbook-pro"
        );
        assert_eq!(derive("laptop.corp.example.com"), "marklig-laptop");
    }

    #[test]
    fn a_hostname_with_nothing_usable_in_it_falls_back() {
        // The fallback still exists — it just is not reached by a normal
        // launch any more, which is the whole point of `gethostname(2)`.
        for raw in ["", "   ", ".", ".local", "!!!", "-"] {
            assert_eq!(derive(raw), "marklig-marklig", "for {raw:?}");
        }
    }

    #[test]
    fn characters_illegal_in_a_label_become_single_separators() {
        assert_eq!(derive("Karl's Mac"), "marklig-karl-s-mac");
        assert_eq!(derive("Märklig_Skrivbord"), "marklig-m-rklig-skrivbord");
        assert_eq!(derive("--karl--"), "marklig-karl");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_hostname_still_names_the_machine() {
        use std::os::unix::ffi::OsStrExt;
        // `gethostname` hands back bytes, not a `str`. Reading this with
        // `to_str()` would yield `None` and send a perfectly identifiable
        // machine to the colliding fallback.
        assert_eq!(
            instance_name_from_hostname(OsStr::from_bytes(b"ka\xffle")),
            "marklig-ka-le"
        );
    }

    #[test]
    fn a_hostname_longer_than_a_dns_label_is_truncated() {
        let name = derive(&"a".repeat(200));
        assert_eq!(name.len(), MAX_LABEL_LEN);
        assert!(name.starts_with("marklig-a"));
    }

    #[test]
    fn every_derived_name_is_announceable() {
        // The rule the old derivation had no test for: whatever this machine
        // is called, the result must survive `start`'s validation and be
        // legal as both a DNS-SD instance label and the `<instance>.local.`
        // host label. Otherwise the desktop silently announces nothing.
        let long = "z".repeat(200);
        for raw in [
            "",
            "   ",
            "Karls-MacBook-Pro.local",
            "Karl's Mac",
            "Märklig",
            "9",
            "-",
            long.as_str(),
        ] {
            let name = instance_name_from_hostname(OsStr::new(raw));
            assert!(!name.is_empty(), "{raw:?} produced an empty name");
            assert!(!name.contains('.'), "{name} would reshape the fullname");
            assert!(
                !name.starts_with('-') && !name.ends_with('-'),
                "{name} is not a legal DNS label"
            );
            assert!(name.len() <= MAX_LABEL_LEN, "{name} is too long for a label");
            assert!(
                name.starts_with(INSTANCE_PREFIX),
                "{name} must be recognizable as ours"
            );
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{name} carries a character a host label may not"
            );

            let mut announcer = SyncAnnouncer::new();
            // Reaches the validation and returns before any daemon is built.
            assert!(
                !matches!(
                    announcer.start(&name, 14_200),
                    Err(MdnsError::BadInstanceName(_))
                ),
                "{name} would be refused by start()"
            );
            let _ = announcer.stop();
        }
    }

    #[test]
    fn the_real_machine_derives_from_gethostname_not_the_environment() {
        // Environment-independent in the sense that matters: `gethostname(2)`
        // answers for a Finder- or Dock-launched app exactly as it does here,
        // which `$HOSTNAME` did not. A machine that reached the fallback
        // would be one whose kernel hostname is empty.
        let raw = hostname::get().expect("gethostname answers on any host that can run this");
        assert_eq!(instance_name(), instance_name_from_hostname(&raw));
        assert_ne!(
            instance_name(),
            format!("{INSTANCE_PREFIX}{FALLBACK_HOST_LABEL}"),
            "gethostname answered {raw:?} and we still fell back to the colliding name"
        );
    }

    // -----------------------------------------------------------------
    // One name: what the QR carries is read back from the announcement,
    // so it cannot drift from what is on the wire.
    // -----------------------------------------------------------------

    #[test]
    fn the_announced_name_is_read_back_not_recomputed() {
        // The cell holds whatever the daemon registered. Here that is
        // deliberately *not* what this machine's hostname derives to, which
        // is the situation after a conflict rename: a reader that recomputed
        // would answer with the name the neighbour now holds.
        let announced =
            AnnouncedInstance::new(format!("marklig-someone-else.{SERVICE_TYPE}"));
        assert_eq!(
            announced.instance_name().as_deref(),
            Some("marklig-someone-else")
        );
        assert_ne!(
            announced.instance_name(),
            Some(instance_name()),
            "the test would prove nothing if the two agreed by accident"
        );
    }

    #[test]
    fn a_conflict_rename_moves_the_name_the_qr_will_carry() {
        // What mdns-sd does when another desktop already holds our name
        // (RFC 6762 §9): it renames *ours* and reports `NameChange`. From
        // that moment the name we proposed resolves to the other machine, so
        // the QR has to follow the rename or the phone dials the neighbour.
        let original = format!("marklig-karls-mac.{SERVICE_TYPE}");
        let renamed = format!("marklig-karls-mac (2).{SERVICE_TYPE}");
        let announced = AnnouncedInstance::new(original.clone());

        assert!(announced.adopt_rename(&original, &renamed));
        assert_eq!(
            announced.instance_name().as_deref(),
            Some("marklig-karls-mac (2)")
        );
        assert_eq!(announced.fullname().as_deref(), Some(renamed.as_str()));

        // Renamed a second time, as happens with three desktops.
        let again = format!("marklig-karls-mac (3).{SERVICE_TYPE}");
        assert!(announced.adopt_rename(&original, &again));
        assert_eq!(
            announced.instance_name().as_deref(),
            Some("marklig-karls-mac (3)")
        );
    }

    #[test]
    fn a_rename_of_something_that_is_not_our_service_is_ignored() {
        let original = format!("marklig-karls-mac.{SERVICE_TYPE}");
        let announced = AnnouncedInstance::new(original.clone());

        // mdns-sd renames the *host* record too (`x.local.` → `x-2.local.`).
        // Adopting that would put a host name where an instance name belongs
        // and the QR would name nothing that exists.
        assert!(!announced.adopt_rename("marklig-karls-mac.local.", "marklig-karls-mac-2.local."));
        // And a change on a service type that is not ours says nothing about
        // the name we announce.
        assert!(!announced.adopt_rename("printer._ipp._tcp.local.", "printer (2)._ipp._tcp.local."));

        assert_eq!(announced.fullname().as_deref(), Some(original.as_str()));
    }

    #[test]
    fn nothing_announced_yields_no_name_for_the_qr() {
        // `pairing_start` puts this in the payload as an empty string, and
        // `MobilePairingRecord` omits an empty name so the phone falls back
        // to `host`. Guessing instead would print the very name a second
        // Märklig desktop is announcing — the usual reason our bind failed.
        let announcer = SyncAnnouncer::new();
        assert!(!announcer.is_active());
        assert_eq!(announcer.announced_instance_name(), None);
        assert_eq!(announcer.fullname(), None);
    }
}
