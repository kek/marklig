import { describe, it, expect, beforeEach } from "vitest";
import { mountPreviewPane } from "../../src/ui/preview-pane";

describe("preview pane", () => {
  let parent: HTMLElement;
  beforeEach(() => {
    parent = document.createElement("div");
    document.body.append(parent);
  });

  it("mounts hidden by default and shows on setVisible(true)", () => {
    const handle = mountPreviewPane({ parent });
    expect(handle.element.hidden).toBe(true);
    handle.setVisible(true);
    expect(handle.element.hidden).toBe(false);
  });

  it("setPages wraps each SVG in a .typst-page and sanitizes them", () => {
    const handle = mountPreviewPane({ parent });
    handle.setPages([
      `<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>`,
    ]);
    expect(handle.body.querySelectorAll(".typst-page").length).toBe(2);
    expect(handle.body.querySelector("script")).toBeNull();
  });

  it("setPages([]) leaves prior content alone", () => {
    const handle = mountPreviewPane({ parent });
    handle.setPages([`<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`]);
    const before = handle.body.innerHTML;
    handle.setPages([]);
    expect(handle.body.innerHTML).toBe(before);
  });

  it("setStatus updates the header line", () => {
    const handle = mountPreviewPane({ parent });
    handle.setStatus("Compiling…");
    expect(handle.element.textContent).toContain("Compiling…");
  });

  it("setPages preserves scroll position across re-renders", () => {
    const handle = mountPreviewPane({ parent });
    handle.setPages([`<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`]);
    // jsdom doesn't compute layout, so direct scrollTop assignment is the
    // only way to fake a scrolled position. The implementation reads-then-
    // writes; the round-trip is what we're testing.
    Object.defineProperty(handle.body, "scrollTop", {
      configurable: true,
      get: function () { return (this as { __st?: number }).__st ?? 0; },
      set: function (v: number) { (this as { __st?: number }).__st = v; },
    });
    handle.body.scrollTop = 240;
    handle.setPages([`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`]);
    expect(handle.body.scrollTop).toBe(240);
  });
});
