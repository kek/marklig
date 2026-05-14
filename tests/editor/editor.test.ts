import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { createEditor, setMode, applySpellcheckToView } from "../../src/editor/editor";

describe("createEditor", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    host = dom.window.document.getElementById("host")!;
  });

  it("creates a read-only editor seeded with source", () => {
    const view = createEditor({ parent: host, source: "# Hello" });
    expect(view.state.doc.toString()).toBe("# Hello");
    expect(view.state.readOnly).toBe(true);
  });

  it("setMode('edit') flips readOnly to false", () => {
    const view = createEditor({ parent: host, source: "x" });
    setMode(view, "edit");
    expect(view.state.readOnly).toBe(false);
  });

  it("setMode('reading') flips readOnly back to true", () => {
    const view = createEditor({ parent: host, source: "x" });
    setMode(view, "edit");
    setMode(view, "reading");
    expect(view.state.readOnly).toBe(true);
  });
});

describe("applySpellcheckToView", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    host = dom.window.document.getElementById("host")!;
  });

  it("sets the spellcheck attribute to 'false' (default-OFF case)", () => {
    const view = createEditor({ parent: host, source: "hello wrold" });
    applySpellcheckToView(view, false);
    // The attribute is what the OS / webview actually reads, and what
    // CodeMirror's contentAttributes facet renders on .cm-content.
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
  });

  it("flips the attribute live without re-creating the view", () => {
    const view = createEditor({ parent: host, source: "x" });
    applySpellcheckToView(view, false);
    const beforeDom = view.contentDOM;
    applySpellcheckToView(view, true);
    expect(view.contentDOM).toBe(beforeDom);
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });
});
