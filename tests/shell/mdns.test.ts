import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { resolvePeerAddress } from "../../src/shell/mdns";
import { invoke } from "@tauri-apps/api/core";
import type { DiscoveredPeer } from "../../src/shell/mdns";

const mockInvoke = vi.mocked(invoke);

/** A well-formed reply for `instance`, as `DiscoveredPeer` serializes. */
function peer(instance: string, over: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    instance_name: instance,
    hostname: `${instance}.local.`,
    port: 14_200,
    addresses: ["192.168.1.42"],
    proto: "ws",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- The negative cases: a resolve that cannot be trusted must not dial. ---

describe("resolvePeerAddress refuses what it cannot trust", () => {
  it("does not even ask when there is no instance name", async () => {
    // A pairing made before the QR carried an instance name has nothing to
    // resolve. Browsing for "" would ask "who is at no name?", and the
    // first desktop to answer would be dialed as if it were ours.
    expect(await resolvePeerAddress("")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns null when nothing is announcing the name", async () => {
    mockInvoke.mockResolvedValue(null);
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });

  it("rejects a reply for a different instance name", async () => {
    // The resolver browses the whole service type, so a bug (or a peer
    // answering out of turn) can hand back an unrelated machine. Dialing it
    // would send this phone's pair id to someone else's desktop.
    mockInvoke.mockResolvedValue(peer("someone-elses-desktop"));
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });

  it("rejects a peer that announced no address", async () => {
    mockInvoke.mockResolvedValue(peer("marklig-laptop", { addresses: [] }));
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });

  it("rejects a peer whose port speaks a protocol we don't", async () => {
    // TXT `proto` exists precisely because the port number is not
    // self-describing; a raw-TCP transport would reject our WS upgrade.
    mockInvoke.mockResolvedValue(peer("marklig-laptop", { proto: "tcp" }));
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });

  it("rejects a peer with no usable port", async () => {
    mockInvoke.mockResolvedValue(peer("marklig-laptop", { port: 0 }));
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });

  it("returns null when the command is unavailable or mDNS is blocked", async () => {
    mockInvoke.mockRejectedValue("mdns daemon: no usable interface");
    expect(await resolvePeerAddress("marklig-laptop")).toBeNull();
  });
});

// --- The positive cases. ---

describe("resolvePeerAddress on a good reply", () => {
  it("returns the announced address and SRV port", async () => {
    mockInvoke.mockResolvedValue(peer("marklig-laptop"));
    expect(await resolvePeerAddress("marklig-laptop")).toEqual({
      host: "192.168.1.42",
      port: 14_200,
    });
    expect(mockInvoke).toHaveBeenCalledWith("mdns_resolve_instance", {
      instanceName: "marklig-laptop",
      timeoutMs: undefined,
    });
  });

  it("passes an explicit timeout through", async () => {
    mockInvoke.mockResolvedValue(peer("marklig-laptop"));
    await resolvePeerAddress("marklig-laptop", 1_500);
    expect(mockInvoke).toHaveBeenCalledWith("mdns_resolve_instance", {
      instanceName: "marklig-laptop",
      timeoutMs: 1_500,
    });
  });

  it("accepts a peer that predates the proto TXT record", async () => {
    mockInvoke.mockResolvedValue(peer("marklig-laptop", { proto: null }));
    expect(await resolvePeerAddress("marklig-laptop")).toEqual({
      host: "192.168.1.42",
      port: 14_200,
    });
  });

  it("prefers IPv4 over a link-local IPv6 address", async () => {
    // Addresses arrive sorted, and a bare link-local v6 needs a zone index
    // we don't have — it would build a URL that cannot connect.
    mockInvoke.mockResolvedValue(
      peer("marklig-laptop", { addresses: ["192.168.1.42", "fe80::1"] }),
    );
    expect((await resolvePeerAddress("marklig-laptop"))?.host).toBe("192.168.1.42");
  });

  it("brackets an IPv6-only address so the URL is well formed", async () => {
    mockInvoke.mockResolvedValue(
      peer("marklig-laptop", { addresses: ["2001:db8::5"] }),
    );
    expect((await resolvePeerAddress("marklig-laptop"))?.host).toBe("[2001:db8::5]");
  });
});
