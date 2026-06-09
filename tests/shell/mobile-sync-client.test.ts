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
  lastWsInstance = null;
  dispatchedEvents.length = 0;
  vi.clearAllMocks();
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
