//! Shape of the record the phone keeps for one paired desktop.
//!
//! Split out of [`crate::commands::mobile_pairing`] — which is `#[cfg(mobile)]`
//! and so is never compiled, let alone tested, on a development machine — so
//! the contents of the stored record are covered by `cargo test` here. The
//! frontend reads these fields back as `MobilePairing`
//! (`src/shell/mobile-pairings.ts`).

use serde_json::{json, Value};

/// One pairing as the phone stores it under `mobile.pairings`.
pub struct PhonePairing<'a> {
    pub pair_id_hex: &'a str,
    pub friendly_name: &'a str,
    pub verification_fingerprint: &'a str,
    pub pair_key_hex: &'a str,
    /// The address the handshake was made over. A starting point for the next
    /// connect, not a lasting truth — DHCP moves it.
    pub last_host: &'a str,
    /// `QrPayload::mdns_instance_name`: the name the desktop announces itself
    /// under, which is what lets the phone find it again after `last_host`
    /// goes stale. Empty when the desktop sent none.
    pub mdns_instance_name: &'a str,
    pub now_unix: u64,
}

impl PhonePairing<'_> {
    pub fn to_json(&self) -> Value {
        let mut record = json!({
            "pair_id_hex": self.pair_id_hex,
            "friendly_name": self.friendly_name,
            "verification_fingerprint": self.verification_fingerprint,
            "paired_at_unix": self.now_unix,
            "last_seen_at_unix": self.now_unix,
            "pair_key": self.pair_key_hex,
            "last_host": self.last_host,
        });
        // Omitted rather than stored empty, so the frontend's "is there a name
        // to resolve?" check is a plain presence test — and a record written
        // by an older build looks the same as one from a desktop that sent no
        // name, which is the truth in both cases.
        if !self.mdns_instance_name.is_empty() {
            record["mdns_instance_name"] = json!(self.mdns_instance_name);
        }
        record
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample<'a>(instance: &'a str) -> PhonePairing<'a> {
        PhonePairing {
            pair_id_hex: "aa",
            friendly_name: "Pixel",
            verification_fingerprint: "AB-CD-EF-01",
            pair_key_hex: "cc",
            last_host: "192.168.1.42",
            mdns_instance_name: instance,
            now_unix: 1_700_000_000,
        }
    }

    #[test]
    fn the_instance_name_from_the_qr_is_stored() {
        // Without this the phone can only ever dial `last_host`, and a DHCP
        // lease change is permanent.
        let record = sample("marklig-laptop").to_json();
        assert_eq!(
            record["mdns_instance_name"].as_str(),
            Some("marklig-laptop")
        );
    }

    #[test]
    fn an_empty_instance_name_is_left_out() {
        // `SyncAnnouncer::start` refuses an empty name, so nothing can ever
        // answer for one. Storing `""` would have the phone spend a resolve
        // timeout on every reconnect for a name that cannot exist.
        let record = sample("").to_json();
        assert!(
            record.get("mdns_instance_name").is_none(),
            "stored an unannounceable instance name: {record}"
        );
    }

    #[test]
    fn the_address_fallback_is_still_stored() {
        // The instance name does not replace `last_host`: it is what the
        // client falls back to when nothing answers the resolve.
        let record = sample("marklig-laptop").to_json();
        assert_eq!(record["last_host"].as_str(), Some("192.168.1.42"));
    }

    #[test]
    fn the_pair_key_is_kept() {
        let record = sample("marklig-laptop").to_json();
        assert_eq!(record["pair_key"].as_str(), Some("cc"));
    }
}
