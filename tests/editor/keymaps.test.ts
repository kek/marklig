import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { readingKeymap, editKeymap } from "../../src/editor/keymaps";

let host: HTMLElement;

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
});
