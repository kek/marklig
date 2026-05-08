// Polyfill requestAnimationFrame/cancelAnimationFrame on every JSDOM window.
// @codemirror/view resolves `win` as `dom.ownerDocument.defaultView`, which
// is a per-instance JSDOM Window that lacks these APIs.
import { vi } from "vitest";

vi.mock("jsdom", async (importOriginal) => {
  const mod = await importOriginal<typeof import("jsdom")>();
  const OriginalJSDOM = mod.JSDOM;

  function patchWindow(win: Record<string, unknown>): void {
    if (typeof win["requestAnimationFrame"] !== "function") {
      win["requestAnimationFrame"] = (cb: FrameRequestCallback): number =>
        setTimeout(() => cb(Date.now()), 0) as unknown as number;
      win["cancelAnimationFrame"] = (id: number): void => clearTimeout(id);
    }
  }

  class PatchedJSDOM extends OriginalJSDOM {
    constructor(...args: ConstructorParameters<typeof OriginalJSDOM>) {
      super(...args);
      patchWindow(this.window as unknown as Record<string, unknown>);
    }
  }

  return { ...mod, JSDOM: PatchedJSDOM };
});
