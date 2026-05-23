import { describe, it, expect, vi } from "vitest";
import { createTypstDriver, type CompileResult } from "../../src/format/typst-driver";

vi.mock("@tauri-apps/api/core", () => {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "typst_open") return "session-123";
    if (cmd === "typst_compile") {
      return {
        pages: [`<svg data-source="${String(args.source)}"></svg>`],
        diagnostics: [],
        elapsed_ms: 5,
      } satisfies CompileResult;
    }
    if (cmd === "typst_close") return undefined;
    throw new Error("unhandled " + cmd);
  });
  return { invoke };
});

describe("typst driver", () => {
  it("open returns a session id, compile returns pages", async () => {
    const driver = createTypstDriver();
    await driver.open("/tmp/x.typ");
    expect(driver.sessionId()).toBe("session-123");
    const res = await driver.compile("hello");
    expect(res.pages[0]).toContain("hello");
  });

  it("close clears the session — subsequent compile rejects", async () => {
    const driver = createTypstDriver();
    await driver.open("/tmp/x.typ");
    await driver.close();
    expect(driver.sessionId()).toBeNull();
    await expect(driver.compile("anything")).rejects.toThrow(/no session/);
  });

  it("open replaces a prior session", async () => {
    const driver = createTypstDriver();
    await driver.open("/tmp/a.typ");
    await driver.open("/tmp/b.typ");
    // Still has a session after a second open.
    expect(driver.sessionId()).toBe("session-123");
    // close() no-ops cleanly afterwards.
    await driver.close();
    expect(driver.sessionId()).toBeNull();
  });
});
