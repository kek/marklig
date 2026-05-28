import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";

import { createEditor, setMode } from "../../src/editor/editor";
import { readingKeymap, editKeymap } from "../../src/editor/keymaps";
import { SPOTLIGHT_ACTIVE_CLASS } from "../../src/editor/search-spotlight";

let host: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: "http://localhost" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  host = dom.window.document.getElementById("host")!;
});

describe("search spotlight", () => {
  it("does not mark the editor while the search panel is closed", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("adds the spotlight class when the search panel opens", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    openSearchPanel(view);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
  });

  it("removes the spotlight class when the search panel closes", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
    closeSearchPanel(view);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("engages in edit mode too (shared EditorView, mode-independent)", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    setMode(view, "edit", { decorations: [], keymap: editKeymap });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
    closeSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("re-applies cleanly across a reading keymap reconfigure", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    setMode(view, "reading", { decorations: [], keymap: readingKeymap });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
  });
});
