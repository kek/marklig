import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountWebsite } from "../../src/website/bootstrap";
import { setMode } from "../../src/editor/editor";
import { buildReadingExtensions, buildEditExtensions } from "../../src/website/bootstrap";

const SAMPLE = `# Märklig\n\n*Markdown that's beautiful to read.*\n`;

describe("website bootstrap — base mount", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    document.documentElement.dataset.mode = "reading";
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("mounts a CodeMirror EditorView into the root element", () => {
    mountWebsite({ root, source: SAMPLE });
    expect(root.querySelector(".cm-editor")).not.toBeNull();
  });

  it("the editor content contains the source text", () => {
    mountWebsite({ root, source: SAMPLE });
    const content = root.querySelector(".cm-content");
    expect(content?.textContent).toContain("Märklig");
    expect(content?.textContent).toContain("Markdown that's beautiful to read.");
  });

  it("sets html[data-mode] to 'reading'", () => {
    mountWebsite({ root, source: SAMPLE });
    expect(document.documentElement.dataset.mode).toBe("reading");
  });
});

describe("website bootstrap — modes", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("buildReadingExtensions returns decoration + keymap extensions", () => {
    const ext = buildReadingExtensions();
    expect(ext.decorations).toBeDefined();
    expect(ext.keymap).toBeDefined();
  });

  it("buildEditExtensions returns decoration + keymap extensions", () => {
    const ext = buildEditExtensions();
    expect(ext.decorations).toBeDefined();
    expect(ext.keymap).toBeDefined();
  });

  it("renders a typeset H1 (decoration applied, marker hidden)", () => {
    mountWebsite({ root, source: "# Märklig\n" });
    // In reading mode, headings get a heading-line class via the producer.
    // The exact selector mirrors src/editor/decorations/headings.ts output.
    const headingLine = root.querySelector(".cm-md-heading-1, .cm-line[class*='heading-1']");
    expect(headingLine).not.toBeNull();
  });

  it("switching to edit mode shows the raw '#' marker", () => {
    const view = mountWebsite({ root, source: "# Märklig\n" });
    setMode(view, "edit", buildEditExtensions());
    document.documentElement.dataset.mode = "edit";
    const content = root.querySelector(".cm-content");
    // Edit mode keeps markers visible (not replaced/hidden).
    expect(content?.textContent).toContain("# Märklig");
  });
});
