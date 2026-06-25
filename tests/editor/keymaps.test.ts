import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import { readingKeymap, editKeymap } from "../../src/editor/keymaps";

let host: HTMLElement;

/** Synthesize the keydown that the OS would produce for the "Mod-a" binding and
 * run it through the editor's keymap scope. CodeMirror builds "Mod" to the
 * platform modifier; jsdom reports a non-mac platform, so that's Ctrl here. */
function pressSelectAll(view: EditorView): boolean {
  const event = new view.dom.ownerDocument.defaultView!.KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
  });
  return runScopeHandlers(view, event, "editor");
}

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  host = dom.window.document.getElementById("host")!;
});

describe("keymaps", () => {
  it("readingKeymap is a defined extension", () => {
    expect(readingKeymap).toBeDefined();
  });

  it("editKeymap is defined and distinct from readingKeymap", () => {
    expect(editKeymap).toBeDefined();
    expect(editKeymap).not.toBe(readingKeymap);
  });

  it("both keymaps can be applied to an editor without throwing", () => {
    const reading = new EditorView({
      state: EditorState.create({ doc: "hello", extensions: [readingKeymap] }),
      parent: host,
    });
    expect(reading.state.doc.toString()).toBe("hello");
    reading.destroy();

    const editing = new EditorView({
      state: EditorState.create({ doc: "world", extensions: [editKeymap] }),
      parent: host,
    });
    expect(editing.state.doc.toString()).toBe("world");
    editing.destroy();
  });

  // Reading mode disables drawSelection() and relies on the browser's native
  // selection. A native "Select All" can only reach DOM-rendered lines, so on
  // a long, viewport-virtualized document it selects only the visible part
  // (issue #165). Binding Mod-a to CodeMirror's selectAll makes it operate on
  // the document model, so a subsequent Copy yields the whole document.
  it("Cmd/Ctrl+A selects the entire document in reading mode", () => {
    const doc = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [EditorState.readOnly.of(true), readingKeymap],
      }),
      parent: host,
    });

    const handled = pressSelectAll(view);

    expect(handled).toBe(true);
    const sel = view.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(view.state.doc.length);
    view.destroy();
  });

  it("Cmd/Ctrl+A selects the entire document in edit mode", () => {
    const doc = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [editKeymap] }),
      parent: host,
    });

    const handled = pressSelectAll(view);

    expect(handled).toBe(true);
    const sel = view.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(view.state.doc.length);
    view.destroy();
  });
});
