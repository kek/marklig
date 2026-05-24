import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountWebsite } from "../../src/website/bootstrap";

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
