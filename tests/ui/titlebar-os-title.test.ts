// The OS window title is a separate surface from the custom titlebar DOM: on
// macOS the drawn title is hidden (`hiddenTitle: true`), so nothing on screen
// reveals whether `setTitle` actually landed — but Mission Control, the Dock's
// window list and the Window menu all read it. It was stuck at each window's
// creation value for exactly that reason (issue #159): the call needs the
// `core:window:allow-set-title` capability, and without it the rejection was
// caught and treated as "no Tauri here".
//
// These tests need `@tauri-apps/api/window` to be *present*, so they live in
// their own file — `titlebar.test.ts` deliberately runs against the real
// (unmockable-in-jsdom) module to cover the API-absent fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

const setTitle = vi.fn<(title: string) => Promise<void>>();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "window-2", setTitle }),
}));

import { setWindowTitle } from "../../src/ui/titlebar";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html></html>");
  globalThis.document = dom.window.document;
  setTitle.mockReset();
  setTitle.mockResolvedValue(undefined);
});

describe("setWindowTitle against a live Tauri window", () => {
  it("pushes the document and its project root to the OS title", async () => {
    await setWindowTitle("/repos/viewer/README.md", false, "/repos/viewer");
    expect(setTitle).toHaveBeenCalledWith("README.md — viewer");
  });

  it("pushes the project root alone when no document is open", async () => {
    await setWindowTitle(null, false, "/repos/viewer");
    expect(setTitle).toHaveBeenCalledWith("viewer");
  });

  it("marks a dirty buffer in the OS title", async () => {
    await setWindowTitle("/repos/viewer/README.md", true, "/repos/viewer");
    expect(setTitle).toHaveBeenCalledWith("• README.md — viewer");
  });

  it("warns rather than failing silently when the call is rejected", async () => {
    setTitle.mockRejectedValue(new Error("window.set_title not allowed"));
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await setWindowTitle("/repos/viewer/README.md", false, "/repos/viewer");
    } finally {
      console.warn = originalWarn;
    }
    // The composed title still reaches document.title, and the failure is
    // reported instead of vanishing.
    expect(document.title).toBe("README.md — viewer");
    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain("window title");
  });
});
