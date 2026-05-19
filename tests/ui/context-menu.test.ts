// Unit tests for the editor context menu (issue #103). The list-builder
// is pure data — tests exercise it without booting CodeMirror. The DOM
// side is exercised via mountContextMenu against a tiny mock view.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildContextMenuItems,
  collapseSeparators,
  mountContextMenu,
  type ContextMenuHandlers,
  type ContextMenuState,
  type ContextMenuItem,
} from "../../src/ui/context-menu";

// A handler set whose every function is a vi.fn(), so tests can assert
// which handler the menu wired up without caring about the others.
function noopHandlers(): ContextMenuHandlers {
  return {
    copy: vi.fn(),
    copyAsHtml: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    openFind: vi.fn(),
    revealInFileManager: vi.fn(),
    toggleMode: vi.fn(),
  };
}

function ids(items: ContextMenuItem[]): string[] {
  return items.map((i) => (i.kind === "separator" ? "---" : i.id));
}

describe("buildContextMenuItems — reading mode", () => {
  it("no selection, has path: Find, Reveal, Switch to Edit (no clipboard items)", () => {
    const state: ContextMenuState = {
      mode: "reading",
      hasSelection: false,
      hasPath: true,
      canUndo: false,
      canRedo: false,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual(["find", "---", "revealInFileManager", "toggleMode"]);
  });

  it("WITH selection: adds Copy + Copy as HTML, drops Reveal", () => {
    const state: ContextMenuState = {
      mode: "reading",
      hasSelection: true,
      hasPath: true,
      canUndo: false,
      canRedo: false,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual([
      "copy",
      "copyAsHtml",
      "---",
      "find",
      "---",
      "toggleMode",
    ]);
  });

  it("no path: Reveal omitted", () => {
    const state: ContextMenuState = {
      mode: "reading",
      hasSelection: false,
      hasPath: false,
      canUndo: false,
      canRedo: false,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual(["find", "---", "toggleMode"]);
  });
});

describe("buildContextMenuItems — edit mode", () => {
  it("no selection, no history, has path: Paste, Find, Reveal, Switch", () => {
    const state: ContextMenuState = {
      mode: "edit",
      hasSelection: false,
      hasPath: true,
      canUndo: false,
      canRedo: false,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual([
      "paste",
      "---",
      "find",
      "---",
      "revealInFileManager",
      "toggleMode",
    ]);
  });

  it("full state: Cut + Copy + Paste + Undo + Redo + Find + Reveal + Switch", () => {
    const state: ContextMenuState = {
      mode: "edit",
      hasSelection: true,
      hasPath: true,
      canUndo: true,
      canRedo: true,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual([
      "cut",
      "copy",
      "paste",
      "---",
      "undo",
      "redo",
      "---",
      "find",
      "---",
      "revealInFileManager",
      "toggleMode",
    ]);
  });

  it("no path: Reveal omitted from edit mode", () => {
    const state: ContextMenuState = {
      mode: "edit",
      hasSelection: false,
      hasPath: false,
      canUndo: false,
      canRedo: false,
    };
    const items = buildContextMenuItems(state, noopHandlers());
    expect(ids(items)).toEqual(["paste", "---", "find", "---", "toggleMode"]);
  });
});

describe("collapseSeparators", () => {
  it("drops adjacent and trailing separators", () => {
    const input: ContextMenuItem[] = [
      { kind: "separator" },
      { kind: "command", id: "a", label: "A", run: () => {} },
      { kind: "separator" },
      { kind: "separator" },
      { kind: "command", id: "b", label: "B", run: () => {} },
      { kind: "separator" },
    ];
    expect(ids(collapseSeparators(input))).toEqual(["a", "---", "b"]);
  });

  it("returns empty for a separator-only list", () => {
    const input: ContextMenuItem[] = [
      { kind: "separator" },
      { kind: "separator" },
    ];
    expect(collapseSeparators(input)).toEqual([]);
  });
});

// ─── DOM-side tests ─────────────────────────────────────────────────────

// A minimal CM-view stub. The context menu reads `view.state.selection.main`,
// undoDepth / redoDepth via @codemirror/commands, and calls view.focus() on
// command activation. We need a real EditorView for undoDepth — build one.
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history } from "@codemirror/commands";

function makeView(opts: { selected?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: "hello world",
      extensions: [history()],
    }),
    parent,
  });
  if (opts.selected) {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
  }
  return view;
}

function rightClick(target: Element, x = 100, y = 100): Event {
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 2,
  });
  target.dispatchEvent(ev);
  return ev;
}

function getPopup(): HTMLElement | null {
  return document.body.querySelector(".viewer-context-menu");
}

function getItems(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".viewer-context-menu-item"),
  );
}

describe("mountContextMenu — DOM integration", () => {
  let view: EditorView;
  const handlers = {
    copyAsHtml: vi.fn(),
    openFind: vi.fn(),
    revealInFileManager: vi.fn(),
    toggleMode: vi.fn(),
  };

  beforeEach(() => {
    handlers.copyAsHtml.mockReset();
    handlers.openFind.mockReset();
    handlers.revealInFileManager.mockReset();
    handlers.toggleMode.mockReset();
  });

  afterEach(() => {
    view?.destroy();
    document.body.innerHTML = "";
  });

  it("preventDefaults the native contextmenu event and renders a popup", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    const ev = rightClick(view.dom);
    expect(ev.defaultPrevented).toBe(true);
    expect(getPopup()).not.toBeNull();
    handle.destroy();
  });

  it("Esc closes the popup", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    rightClick(view.dom);
    expect(getPopup()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(getPopup()).toBeNull();
    handle.destroy();
  });

  it("click-away closes the popup", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    rightClick(view.dom);
    expect(getPopup()).not.toBeNull();
    // Click-away listener is attached on the next tick to avoid being fed
    // the same event that opened the popup.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        document.body.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true }),
        );
        expect(getPopup()).toBeNull();
        handle.destroy();
        resolve();
      }, 5);
    });
  });

  it("clicking a command runs its handler exactly once and closes", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    rightClick(view.dom);
    const switchItem = getItems().find((el) => el.dataset.id === "toggleMode");
    expect(switchItem).toBeTruthy();
    switchItem!.click();
    expect(handlers.toggleMode).toHaveBeenCalledTimes(1);
    expect(getPopup()).toBeNull();
    handle.destroy();
  });

  it("reading mode with no selection: Find, Reveal, Switch to Edit", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    rightClick(view.dom);
    const renderedIds = getItems().map((el) => el.dataset.id);
    expect(renderedIds).toEqual(["find", "revealInFileManager", "toggleMode"]);
    handle.destroy();
  });

  it("reading mode WITH selection: Copy, Copy as HTML, Find, Switch (no Reveal)", () => {
    view = makeView({ selected: true });
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    rightClick(view.dom);
    const renderedIds = getItems().map((el) => el.dataset.id);
    expect(renderedIds).toEqual(["copy", "copyAsHtml", "find", "toggleMode"]);
    handle.destroy();
  });

  it("edit mode with empty history: Paste, Find, Reveal, Switch — no Undo/Redo", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "edit",
    });
    rightClick(view.dom);
    const renderedIds = getItems().map((el) => el.dataset.id);
    expect(renderedIds).toEqual([
      "paste",
      "find",
      "revealInFileManager",
      "toggleMode",
    ]);
    handle.destroy();
  });

  it("edit mode with undoable history: Undo appears", () => {
    view = makeView();
    // Trigger an edit so undoDepth > 0.
    view.dispatch({ changes: { from: 0, insert: "X" } });
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "edit",
    });
    rightClick(view.dom);
    const renderedIds = getItems().map((el) => el.dataset.id);
    expect(renderedIds).toContain("undo");
    handle.destroy();
  });

  it("no currentPath: Reveal in Finder is omitted", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => null,
      getMode: () => "edit",
    });
    rightClick(view.dom);
    const renderedIds = getItems().map((el) => el.dataset.id);
    expect(renderedIds).not.toContain("revealInFileManager");
    handle.destroy();
  });

  it("destroy() removes the listener so further right-clicks do not pop up a menu", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      getCurrentPath: () => "/tmp/foo.md",
      getMode: () => "reading",
    });
    handle.destroy();
    const ev = rightClick(view.dom);
    expect(ev.defaultPrevented).toBe(false);
    expect(getPopup()).toBeNull();
  });

  it("separator-collapse: no two consecutive separators rendered in the DOM", () => {
    view = makeView();
    const handle = mountContextMenu({
      view,
      handlers,
      // No path → in reading mode this drops Reveal from the group between
      // the two surrounding separators. Verify no double-rule appears.
      getCurrentPath: () => null,
      getMode: () => "reading",
    });
    rightClick(view.dom);
    const popup = getPopup();
    expect(popup).not.toBeNull();
    const children = Array.from(popup!.children);
    for (let i = 1; i < children.length; i++) {
      const a = children[i - 1].classList.contains(
        "viewer-context-menu-separator",
      );
      const b = children[i].classList.contains(
        "viewer-context-menu-separator",
      );
      expect(a && b).toBe(false);
    }
    handle.destroy();
  });
});
