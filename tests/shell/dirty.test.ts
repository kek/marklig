import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createDirtyTracker } from "../../src/shell/dirty";

let host: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  host = dom.window.document.getElementById("host")!;
});

describe("createDirtyTracker", () => {
  it("starts clean", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello" }),
      parent: host,
    });
    const t = createDirtyTracker(view);
    expect(t.isDirty()).toBe(false);
  });

  it("becomes dirty after a doc change and clean after reset", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello" }),
      parent: host,
    });
    const t = createDirtyTracker(view);
    view.dispatch({ changes: { from: 5, insert: "!" } });
    // Wait two animation frames for the rAF poll to pick up the change.
    await new Promise((r) => setTimeout(r, 50));
    expect(t.isDirty()).toBe(true);
    t.reset();
    expect(t.isDirty()).toBe(false);
  });

  it("subscribers fire on change and on reset", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "x" }),
      parent: host,
    });
    const t = createDirtyTracker(view);
    const seen: boolean[] = [];
    const unsub = t.subscribe((d) => seen.push(d));
    expect(seen).toEqual([false]); // immediate fire on subscribe
    view.dispatch({ changes: { from: 1, insert: "!" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([false, true]);
    t.reset();
    expect(seen).toEqual([false, true, false]);
    unsub();
  });
});
