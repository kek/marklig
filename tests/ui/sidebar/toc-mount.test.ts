import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

vi.mock("../../../src/shell/store", () => ({
  getValue: async () => undefined,
  setValue: async () => {},
  deleteValue: async () => {},
  listKeys: async () => [],
}));

import { createEditor } from "../../../src/editor/editor";
import { mountTocSidebar } from "../../../src/ui/sidebar/toc";
import { setTocSectionOpen } from "../../../src/shell/settings";

describe("mountTocSidebar — heading + collapsible behavior", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    // CodeMirror reads `window` indirectly via the element's ownerDocument,
    // so the host's defaultView already points at the JSDOM window.
    host = dom.window.document.getElementById("host")!;
    setTocSectionOpen(true);
  });

  it("renders the document basename (no .md) as the section heading", () => {
    const view = createEditor({ parent: host, source: "# A\n\n## B\n" });
    const handle = mountTocSidebar({
      view,
      parent: host,
      initiallyVisible: true,
      initialDocumentPath: "/Users/ke/notes/Plan.md",
      onActivate: () => {},
    });
    const heading = handle.element.querySelector<HTMLButtonElement>(".viewer-toc-heading")!;
    expect(heading.textContent).toContain("Plan");
    expect(heading.textContent).not.toContain(".md");
    // ARIA: button with aria-expanded + aria-controls referencing the body.
    expect(heading.tagName).toBe("BUTTON");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("setDocumentTitle updates the heading on the fly", () => {
    const view = createEditor({ parent: host, source: "# Hi" });
    const handle = mountTocSidebar({
      view,
      parent: host,
      initiallyVisible: true,
      initialDocumentPath: null,
      onActivate: () => {},
    });
    const heading = handle.element.querySelector<HTMLButtonElement>(".viewer-toc-heading")!;
    expect(heading.textContent).toContain("Untitled");

    handle.setDocumentTitle("/x/Notes.md");
    expect(heading.textContent).toContain("Notes");

    handle.setDocumentTitle(null);
    expect(heading.textContent).toContain("Untitled");
  });

  it("clicking the heading collapses the body", () => {
    const view = createEditor({ parent: host, source: "# A\n## B\n" });
    const handle = mountTocSidebar({
      view,
      parent: host,
      initiallyVisible: true,
      initialDocumentPath: "/x/y.md",
      onActivate: () => {},
    });
    const heading = handle.element.querySelector<HTMLButtonElement>(".viewer-toc-heading")!;
    const body = handle.element.querySelector<HTMLElement>(".viewer-toc-body")!;
    expect(body.hidden).toBe(false);
    heading.click();
    expect(body.hidden).toBe(true);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    heading.click();
    expect(body.hidden).toBe(false);
  });
});
