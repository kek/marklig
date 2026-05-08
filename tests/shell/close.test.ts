import { describe, it, expect, vi } from "vitest";

// Mock Tauri modules — not available in jsdom; the real interaction is covered by e2e.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(undefined),
}));

describe("close.ts", () => {
  it("exports installCloseHandler", async () => {
    const mod = await import("../../src/shell/close");
    expect(typeof mod.installCloseHandler).toBe("function");
  });
});
