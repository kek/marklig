import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock the store helpers used by SyncClient
const storeData: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: vi.fn(async (key: string) => storeData[key] ?? null),
  setValue: vi.fn(async (key: string, val: unknown) => {
    storeData[key] = val;
  }),
}));

// Mock the mDNS wrapper so the resolve/fallback rule can be driven directly.
// What a trustworthy reply looks like is covered by tests/shell/mdns.test.ts.
const resolvePeerAddress = vi.fn<
  (instanceName: string, timeoutMs?: number) => Promise<{ host: string; port: number } | null>
>();
vi.mock("../../src/shell/mdns", () => ({
  resolvePeerAddress: (instanceName: string, timeoutMs?: number) =>
    resolvePeerAddress(instanceName, timeoutMs),
}));

// Capture CustomEvents dispatched on window
const dispatchedEvents: CustomEvent[] = [];
const origDispatch = window.dispatchEvent.bind(window);
window.dispatchEvent = (e: Event) => {
  if (e instanceof CustomEvent) dispatchedEvents.push(e);
  return origDispatch(e);
};

// Minimal WebSocket mock
let lastWsInstance: MockWs | null = null;
class MockWs {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    lastWsInstance = this;
  }
  send(msg: string) {
    this.sent.push(msg);
  }
  close() {
    this.onclose?.();
  }
  simulateOpen() {
    this.onopen?.();
  }
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
  simulateError() {
    this.onerror?.();
  }
}
vi.stubGlobal("WebSocket", MockWs);

import { SyncClient, LIVE_OP_EVENT, CAUGHT_UP_EVENT } from "../../src/shell/mobile-sync-client";
import { invoke } from "@tauri-apps/api/core";

/** Flush enough microtask ticks for connect()'s async chain to complete. */
async function flushConnect() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const PAIR: { pair_id_hex: string; friendly_name: string; verification_fingerprint: string; paired_at_unix: number; last_seen_at_unix: number; last_host: string } = {
  pair_id_hex: "aa".repeat(16),
  friendly_name: "Test Phone",
  verification_fingerprint: "AA-BB-CC",
  paired_at_unix: 0,
  last_seen_at_unix: 0,
  last_host: "192.168.1.1",
};

beforeEach(() => {
  resolvePeerAddress.mockReset();
  resolvePeerAddress.mockResolvedValue(null);
  lastWsInstance = null;
  dispatchedEvents.length = 0;
  vi.mocked(invoke).mockClear();
  Object.keys(storeData).forEach((k) => delete storeData[k]);
});

describe("SyncClient.start()", () => {
  it("connects when visible and sends subscribe frame", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();

    expect(lastWsInstance).not.toBeNull();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    expect(lastWsInstance!.sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(lastWsInstance!.sent[0]);
    expect(msg.type).toBe("subscribe");
    expect(msg.pair_id).toBe(PAIR.pair_id_hex);
    expect(msg.cursors).toBeDefined();

    client.stop();
  });
});

describe("apply op_put", () => {
  it("invokes mobile_apply_sync_op and dispatches LIVE_OP_EVENT", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const putFrame = JSON.stringify({
      type: "op_put",
      folder_id_hex: "bb".repeat(16),
      relpath: "notes/a.md",
      mtime_logical: 5,
      ciphertext_b64: "dGVzdA==",
    });
    lastWsInstance!.simulateMessage(putFrame);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      "mobile_apply_sync_op",
      expect.objectContaining({ relpath: "notes/a.md", kind: "put" })
    );
    const liveEv = dispatchedEvents.find((e) => e.type === LIVE_OP_EVENT);
    expect(liveEv).toBeDefined();
    expect((liveEv!.detail as Record<string, string>).kind).toBe("put");

    client.stop();
  });
});

describe("apply op_delete", () => {
  it("invokes mobile_apply_sync_op with kind=delete and dispatches LIVE_OP_EVENT", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const deleteFrame = JSON.stringify({
      type: "op_delete",
      folder_id_hex: "cc".repeat(16),
      relpath: "notes/b.md",
      mtime_logical: 7,
    });
    lastWsInstance!.simulateMessage(deleteFrame);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      "mobile_apply_sync_op",
      expect.objectContaining({ relpath: "notes/b.md", kind: "delete" })
    );
    const liveEv = dispatchedEvents.find((e) => e.type === LIVE_OP_EVENT);
    expect(liveEv).toBeDefined();
    expect((liveEv!.detail as Record<string, string>).kind).toBe("delete");

    client.stop();
  });
});

describe("cursor advances after op", () => {
  it("stores mtime_logical in sync_cursors", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    const folder = "dd".repeat(16);
    lastWsInstance!.simulateMessage(
      JSON.stringify({
        type: "op_put",
        folder_id_hex: folder,
        relpath: "x.md",
        mtime_logical: 42,
        ciphertext_b64: "dA==",
      })
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const cursors = storeData["mobile.sync_cursors"] as Record<string, Record<string, number>>;
    expect(cursors?.[PAIR.pair_id_hex]?.[folder]).toBe(42);

    client.stop();
  });
});

describe("caught_up dispatches event", () => {
  it("dispatches CAUGHT_UP_EVENT on caught_up frame", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    lastWsInstance!.simulateMessage(JSON.stringify({ type: "caught_up" }));
    await Promise.resolve();

    const ev = dispatchedEvents.find((e) => e.type === CAUGHT_UP_EVENT);
    expect(ev).toBeDefined();

    client.stop();
  });
});

describe("reconnect on error", () => {
  it("schedules a reconnect when the socket errors", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const client = new SyncClient(PAIR);
    client.start();
    await flushConnect();
    const firstWs = lastWsInstance!;
    firstWs.simulateOpen();
    await Promise.resolve();

    firstWs.simulateError();
    await Promise.resolve();

    // No immediate reconnect
    expect(lastWsInstance).toBe(firstWs);

    // After initial backoff (2 s) a new WS is created
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastWsInstance).not.toBe(firstWs);

    client.stop();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Resolve-then-dial. The stored address is tried until it lets us down; only
// then is the instance name resolved, so a working reconnect costs no mDNS
// round trip and a DHCP lease change stops being fatal.
// ---------------------------------------------------------------------------

const PAIR_MDNS = { ...PAIR, mdns_instance_name: "marklig-laptop" };

/** The phone's stored pairing record, including the field the TS interface
 *  does not name — a host rewrite must not drop the pair key. */
function seedStoredPairing(instanceName?: string) {
  storeData["mobile.pairings"] = {
    [PAIR.pair_id_hex]: {
      pair_id_hex: PAIR.pair_id_hex,
      friendly_name: PAIR.friendly_name,
      verification_fingerprint: PAIR.verification_fingerprint,
      paired_at_unix: 0,
      last_seen_at_unix: 0,
      pair_key: "cc".repeat(32),
      last_host: PAIR.last_host,
      ...(instanceName === undefined ? {} : { mdns_instance_name: instanceName }),
    },
  };
}

function beVisible() {
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
}

describe("falling back when discovery cannot help", () => {
  it("dials the stored host again when nothing is announcing the name", async () => {
    // The guard that makes the positive case meaningful: a resolve that finds
    // nothing must not leave the client with no address to try.
    vi.useFakeTimers();
    beVisible();
    seedStoredPairing("marklig-laptop");
    resolvePeerAddress.mockResolvedValue(null);

    const client = new SyncClient({ ...PAIR_MDNS });
    client.start();
    await flushConnect();
    const first = lastWsInstance!;
    expect(first.url).toBe("ws://192.168.1.1:14200");

    // Failed before ever opening — the stored address is now suspect.
    first.simulateError();
    await vi.advanceTimersByTimeAsync(2100);

    expect(resolvePeerAddress).toHaveBeenCalledWith("marklig-laptop", undefined);
    expect(lastWsInstance).not.toBe(first);
    expect(lastWsInstance!.url).toBe("ws://192.168.1.1:14200");

    client.stop();
    vi.useRealTimers();
  });

  it("never resolves for a pairing made before the QR carried a name", async () => {
    // Resolving "" would ask "who is at no name?" and dial whichever desktop
    // answered — someone else's. Such a pairing keeps the v2.0-alpha
    // behaviour: the stored address, retried under backoff.
    vi.useFakeTimers();
    beVisible();
    seedStoredPairing(undefined);

    const client = new SyncClient({ ...PAIR });
    client.start();
    await flushConnect();
    const first = lastWsInstance!;
    first.simulateError();
    await vi.advanceTimersByTimeAsync(2100);

    expect(resolvePeerAddress).not.toHaveBeenCalled();
    expect(lastWsInstance).not.toBe(first);
    expect(lastWsInstance!.url).toBe("ws://192.168.1.1:14200");

    client.stop();
    vi.useRealTimers();
  });
});

describe("resolving after the stored host fails", () => {
  it("dials the resolved address and remembers it", async () => {
    vi.useFakeTimers();
    beVisible();
    seedStoredPairing("marklig-laptop");
    resolvePeerAddress.mockResolvedValue({ host: "192.168.1.77", port: 14_200 });

    const client = new SyncClient({ ...PAIR_MDNS });
    client.start();
    await flushConnect();
    const first = lastWsInstance!;
    expect(first.url).toBe("ws://192.168.1.1:14200");

    first.simulateError();
    await vi.advanceTimersByTimeAsync(2100);

    expect(lastWsInstance!.url).toBe("ws://192.168.1.77:14200");

    // Written back, so the next connect takes the fast path straight to the
    // address that worked — and the pair key survives the rewrite.
    const stored = (storeData["mobile.pairings"] as Record<string, Record<string, unknown>>)[
      PAIR.pair_id_hex
    ];
    expect(stored.last_host).toBe("192.168.1.77");
    expect(stored.pair_key).toBe("cc".repeat(32));

    client.stop();
    vi.useRealTimers();
  });

  it("dials the SRV port the peer announced, not a hardcoded one", async () => {
    vi.useFakeTimers();
    beVisible();
    seedStoredPairing("marklig-laptop");
    resolvePeerAddress.mockResolvedValue({ host: "192.168.1.77", port: 14_321 });

    const client = new SyncClient({ ...PAIR_MDNS });
    client.start();
    await flushConnect();
    lastWsInstance!.simulateError();
    await vi.advanceTimersByTimeAsync(2100);

    expect(lastWsInstance!.url).toBe("ws://192.168.1.77:14321");

    client.stop();
    vi.useRealTimers();
  });
});

describe("the fast path stays fast", () => {
  it("does not resolve while the stored host connects", async () => {
    beVisible();
    seedStoredPairing("marklig-laptop");

    const client = new SyncClient({ ...PAIR_MDNS });
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();

    expect(lastWsInstance!.url).toBe("ws://192.168.1.1:14200");
    expect(resolvePeerAddress).not.toHaveBeenCalled();

    client.stop();
  });

  it("gives a host that had been working one more chance after a drop", async () => {
    // A socket that opened and then closed says the desktop went away, not
    // that its address moved. Re-resolving every drop would spend the resolve
    // timeout on every transient blip; if the retry also fails to open, the
    // attempt after that does resolve.
    vi.useFakeTimers();
    beVisible();
    seedStoredPairing("marklig-laptop");
    resolvePeerAddress.mockResolvedValue({ host: "192.168.1.77", port: 14_200 });

    const client = new SyncClient({ ...PAIR_MDNS });
    client.start();
    await flushConnect();
    lastWsInstance!.simulateOpen();
    await Promise.resolve();
    lastWsInstance!.simulateError();

    await vi.advanceTimersByTimeAsync(2100);
    expect(resolvePeerAddress).not.toHaveBeenCalled();
    expect(lastWsInstance!.url).toBe("ws://192.168.1.1:14200");

    // That retry never opened, so the next one resolves.
    lastWsInstance!.simulateError();
    await vi.advanceTimersByTimeAsync(4100);
    expect(resolvePeerAddress).toHaveBeenCalledWith("marklig-laptop", undefined);
    expect(lastWsInstance!.url).toBe("ws://192.168.1.77:14200");

    client.stop();
    vi.useRealTimers();
  });
});
