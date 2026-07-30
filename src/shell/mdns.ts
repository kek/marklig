// Peer discovery over mDNS/DNS-SD (`_marklig-sync._tcp`), the frontend side
// of `src-tauri/src/mdns.rs`. The desktop announces itself by name while its
// pairing server is armed; this is how the phone turns that name back into a
// current address instead of trusting one frozen in at pair time.

import { invoke } from "@tauri-apps/api/core";

/** One resolved peer, as `mdns::DiscoveredPeer` serializes. */
export interface DiscoveredPeer {
  instance_name: string;
  hostname: string;
  port: number;
  addresses: string[];
  /** TXT `proto`. `null` from an announcer that predates the record. */
  proto: string | null;
}

/** The only value of TXT `proto` this client can dial. */
const PROTO_WS = "ws";

/** A host and port ready to be substituted into a `ws://` URL. */
export interface DialTarget {
  host: string;
  port: number;
}

/** Resolve one announced instance name to something dialable, or `null` when
 *  nothing trustworthy answers.
 *
 *  Every `null` here is a fallback, not a failure to report: the caller still
 *  has the stored address to try. What must never happen is a `DialTarget`
 *  built from a peer we did not ask about — the Rust resolver browses the
 *  whole service type, so this side checks the identity of what came back
 *  rather than assuming the filter upstream held. */
export async function resolvePeerAddress(
  instanceName: string,
  timeoutMs?: number,
): Promise<DialTarget | null> {
  // No name means nothing to ask for. Querying anyway would hand back
  // whichever desktop answered first.
  if (!instanceName) return null;

  let peer: DiscoveredPeer | null;
  try {
    peer = await invoke<DiscoveredPeer | null>("mdns_resolve_instance", {
      instanceName,
      timeoutMs,
    });
  } catch {
    // No mDNS on this platform, multicast blocked, or an older build without
    // the command. Indistinguishable from "nobody answered", and handled the
    // same way.
    return null;
  }

  if (!peer || peer.instance_name !== instanceName) return null;
  if (peer.proto != null && peer.proto !== PROTO_WS) return null;
  if (peer.port <= 0) return null;

  const host = dialableAddress(peer.addresses);
  return host === null ? null : { host, port: peer.port };
}

/** Pick the address to dial. IPv4 first: the addresses a peer announces can
 *  include a link-local IPv6 one, which needs a zone index the WebView does
 *  not give us, so it would build a URL that cannot connect. An IPv6-only
 *  peer still gets a well-formed URL via the bracket form. */
function dialableAddress(addresses: string[]): string | null {
  const v4 = addresses.find((a) => !a.includes(":"));
  if (v4) return v4;
  const v6 = addresses[0];
  return v6 ? `[${v6}]` : null;
}
