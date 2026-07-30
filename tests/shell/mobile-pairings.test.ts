import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const storeData: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: vi.fn(async (key: string) => storeData[key] ?? null),
  setValue: vi.fn(async (key: string, val: unknown) => {
    storeData[key] = val;
  }),
}));

import { listMobilePairings } from "../../src/shell/mobile-pairings";

/** A record as `mobile_pairing_start` writes it (see
 *  `src-tauri/src/mobile_pairing_record.rs`). */
function stored(over: Record<string, unknown> = {}) {
  return {
    pair_id_hex: "aa".repeat(16),
    friendly_name: "Karl's Desktop",
    verification_fingerprint: "AA-BB-CC-DD",
    paired_at_unix: 1_700_000_000,
    last_seen_at_unix: 1_700_000_000,
    pair_key: "cc".repeat(32),
    last_host: "192.168.1.42",
    ...over,
  };
}

beforeEach(() => {
  Object.keys(storeData).forEach((k) => delete storeData[k]);
});

describe("listMobilePairings", () => {
  it("carries the desktop's mDNS instance name through to the pairing", async () => {
    // The name is what `SyncClient` resolves when `last_host` goes stale; if
    // this read drops it, the phone is back to dialing a frozen address.
    storeData["mobile.pairings"] = {
      [stored().pair_id_hex]: stored({ mdns_instance_name: "marklig-laptop" }),
    };

    const [pairing] = await listMobilePairings();
    expect(pairing.mdns_instance_name).toBe("marklig-laptop");
    expect(pairing.last_host).toBe("192.168.1.42");
  });

  it("keeps a pairing that predates the instance name", async () => {
    // Backward compatibility: a phone paired before this change must still
    // appear in the library and still sync over its stored address.
    storeData["mobile.pairings"] = { [stored().pair_id_hex]: stored() };

    const [pairing] = await listMobilePairings();
    expect(pairing.mdns_instance_name).toBeUndefined();
    expect(pairing.last_host).toBe("192.168.1.42");
  });
});
