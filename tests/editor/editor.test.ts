import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { createEditor, setMode } from "../../src/editor/editor";

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
