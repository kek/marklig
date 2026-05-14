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

  it("sets the contentDOM spellcheck property to false (default-OFF case)", () => {
    const view = createEditor({ parent: host, source: "hello wrold" });
    applySpellcheckToView(view, false);
    expect(view.contentDOM.spellcheck).toBe(false);
    // The reflected HTML attribute is what the OS / webview actually reads —
    // for the OFF case it must be the literal string "false".
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
  });

  it("flips the property live without re-creating the view", () => {
    const view = createEditor({ parent: host, source: "x" });
    applySpellcheckToView(view, false);
    const beforeDom = view.contentDOM;
    applySpellcheckToView(view, true);
    // Same node, not re-mounted — the toggle is a pure DOM-property write.
    expect(view.contentDOM).toBe(beforeDom);
    expect(view.contentDOM.spellcheck).toBe(true);
  });
});
