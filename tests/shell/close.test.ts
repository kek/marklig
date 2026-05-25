import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri mocks. jsdom doesn't have these globals; we drive the close handler
// by capturing the registered callbacks and invoking them with synthetic
// events. The shape mirrors what Tauri 2's onCloseRequested / event.listen
// resolve to.
let closeCallback: ((e: { preventDefault: () => void }) => void | Promise<void>) | null = null;
let beforeQuitCallback: ((e: unknown) => void | Promise<void>) | null = null;
const destroy = vi.fn().mockResolvedValue(undefined);
const emit = vi.fn().mockResolvedValue(undefined);
const removeWindowSessionEntry = vi.fn().mockResolvedValue(undefined);
const markUserClosingThisWindow = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    destroy,
    onCloseRequested: (cb: typeof closeCallback) => {
      closeCallback = cb;
      return Promise.resolve(() => {
        closeCallback = null;
      });
    },
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: unknown) => void) => {
    if (event === "viewer:before-quit") {
      beforeQuitCallback = cb;
    }
    return Promise.resolve(() => {
      if (event === "viewer:before-quit") beforeQuitCallback = null;
    });
  },
  emit,
}));

vi.mock("../../src/shell/window-session", () => ({
  removeWindowSessionEntry,
  markUserClosingThisWindow,
}));

beforeEach(() => {
  closeCallback = null;
  beforeQuitCallback = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("installCloseHandler", () => {
  it("force-saves a dirty buffer on close and then destroys", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockResolvedValue(undefined);
    const stop = await installCloseHandler({
      isDirty: () => true,
      forceSave,
    });

    expect(closeCallback).toBeTruthy();
    const event = { preventDefault: vi.fn() };
    await closeCallback!(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(markUserClosingThisWindow).toHaveBeenCalled();
    expect(forceSave).toHaveBeenCalledTimes(1);
    expect(removeWindowSessionEntry).toHaveBeenCalledWith("main");
    expect(destroy).toHaveBeenCalled();
    stop();
  });

  it("skips force-save when the buffer is clean", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockResolvedValue(undefined);
    const stop = await installCloseHandler({
      isDirty: () => false,
      forceSave,
    });

    const event = { preventDefault: vi.fn() };
    await closeCallback!(event);

    expect(forceSave).not.toHaveBeenCalled();
    expect(removeWindowSessionEntry).toHaveBeenCalledWith("main");
    expect(destroy).toHaveBeenCalled();
    stop();
  });

  it("still removes the session entry and destroys when forceSave throws", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const stop = await installCloseHandler({
      isDirty: () => true,
      forceSave,
    });

    const event = { preventDefault: vi.fn() };
    await closeCallback!(event);

    expect(forceSave).toHaveBeenCalled();
    // Failure must NOT block close — otherwise the user can't quit the app.
    expect(removeWindowSessionEntry).toHaveBeenCalledWith("main");
    expect(destroy).toHaveBeenCalled();
    stop();
  });

  it("ignores re-entrant close requests", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockResolvedValue(undefined);
    const stop = await installCloseHandler({
      isDirty: () => true,
      forceSave,
    });

    const ev1 = { preventDefault: vi.fn() };
    const ev2 = { preventDefault: vi.fn() };
    await Promise.all([closeCallback!(ev1), closeCallback!(ev2)]);

    // First invocation runs the flush; second sees closing=true and bails out.
    expect(forceSave).toHaveBeenCalledTimes(1);
    expect(removeWindowSessionEntry).toHaveBeenCalledTimes(1);
    stop();
  });

  it("flushes a dirty buffer and acks on viewer:before-quit", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockResolvedValue(undefined);
    const stop = await installCloseHandler({
      isDirty: () => true,
      forceSave,
    });

    expect(beforeQuitCallback).toBeTruthy();
    await beforeQuitCallback!({});

    expect(forceSave).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("viewer:before-quit-ack", { label: "main" });
    // App-quit must NOT call destroy or remove the session entry — Rust owns
    // the exit, and Cmd-Q preserves the session set for next-launch restore.
    expect(destroy).not.toHaveBeenCalled();
    expect(removeWindowSessionEntry).not.toHaveBeenCalled();
    stop();
  });

  it("acks before-quit even when the buffer is clean", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockResolvedValue(undefined);
    const stop = await installCloseHandler({
      isDirty: () => false,
      forceSave,
    });

    await beforeQuitCallback!({});

    expect(forceSave).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("viewer:before-quit-ack", { label: "main" });
    stop();
  });

  it("acks before-quit even when force-save throws", async () => {
    const { installCloseHandler } = await import("../../src/shell/close");
    const forceSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const stop = await installCloseHandler({
      isDirty: () => true,
      forceSave,
    });

    await beforeQuitCallback!({});

    expect(forceSave).toHaveBeenCalled();
    // App-quit must not hang on a broken disk — ack anyway so Rust's
    // timeout-bounded wait can release the exit.
    expect(emit).toHaveBeenCalledWith("viewer:before-quit-ack", { label: "main" });
    stop();
  });
});
