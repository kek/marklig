import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "window-2",
    outerSize: async () => ({ width: 1800, height: 1200 }),
    outerPosition: async () => ({ x: 100, y: 200 }),
    scaleFactor: async () => 2,
  }),
}));

import {
  claimMenu,
  forgetWindow,
  installSessionReporting,
  requestOpen,
} from "../../src/shell/session-client";

describe("session-client", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  it("reports logical pixels, converting from physical via scaleFactor", async () => {
    const stop = installSessionReporting({
      currentPath: () => "/proj/a.md",
      folder: () => "/proj",
      dirty: () => false,
      scrollTop: () => 42.5,
      mode: () => "reading",
      sidebarVisible: () => true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe("session_report");
    expect(args).toMatchObject({
      label: "window-2",
      folder: "/proj",
      path: "/proj/a.md",
      dirty: false,
      x: 50,
      y: 100,
      width: 900,
      height: 600,
      scrollTop: 42.5,
      mode: "reading",
      sidebarVisible: true,
    });
    stop();
  });

  it("keeps reporting on a tick so a Cmd-Q teardown has fresh state", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    const initial = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(invoke.mock.calls.length).toBeGreaterThan(initial);
    stop();
  });

  it("stops reporting once unsubscribed", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const after = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke.mock.calls.length).toBe(after);
  });

  it("clamps a negative scrollTop to zero", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => -20,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls[0][1]).toMatchObject({ scrollTop: 0 });
    stop();
  });

  it("never rejects when the command fails", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await expect(vi.advanceTimersByTimeAsync(1500)).resolves.not.toThrow();
    stop();
  });

  it("forgetWindow calls session_forget with the label", async () => {
    await forgetWindow("window-3");
    expect(invoke).toHaveBeenCalledWith("session_forget", { label: "window-3" });
  });

  it("requestOpen forwards paths and the requesting label", async () => {
    await requestOpen(["/proj"], "window-2");
    expect(invoke).toHaveBeenCalledWith("session_open_paths", {
      paths: ["/proj"],
      requesting: "window-2",
    });
  });

  it("requestOpen sends a null requester for an external request", async () => {
    await requestOpen(["/proj"]);
    expect(invoke).toHaveBeenCalledWith("session_open_paths", {
      paths: ["/proj"],
      requesting: null,
    });
  });

  it("stays silent until the window has applied the state Rust gave it", async () => {
    // Rust seeds this window's registry entry synchronously when it creates
    // the window. Reporting before `currentFolder` has been assigned would
    // replace that with `folder: null` — which reads as a blank, adoptable
    // window and lets an external open request wipe the restored project.
    let ready = false;
    const stop = installSessionReporting({
      ready: () => ready,
      currentPath: () => null,
      folder: () => (ready ? "/proj" : null),
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(invoke).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(invoke.mock.calls[0][1]).toMatchObject({ folder: "/proj" });
    stop();
  });

  it("reports by default when no readiness getter is supplied", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalled();
    stop();
  });

  it("claimMenu asks Rust and passes the answer through", async () => {
    invoke.mockResolvedValue(true);
    await expect(claimMenu("window-2")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("session_claim_menu", { label: "window-2" });

    invoke.mockResolvedValue(false);
    await expect(claimMenu("window-3")).resolves.toBe(false);
  });

  it("claimMenu builds the menu rather than none when the backend is absent", async () => {
    // A browser-only `npm run dev` session or an e2e stub has no answer; a
    // window with no menu at all is the worse failure, so only an explicit
    // `false` withholds it.
    invoke.mockRejectedValue(new Error("no tauri"));
    await expect(claimMenu("window-2")).resolves.toBe(true);
    invoke.mockResolvedValue(undefined);
    await expect(claimMenu("window-2")).resolves.toBe(true);
  });
});
