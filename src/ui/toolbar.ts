import type { EditorView } from "@codemirror/view";

import { setMode } from "../editor/editor";
import type { Mode, ModeExtensions } from "../editor/editor";

export interface ToolbarOptions {
  view: EditorView;
  modeExtensions: { reading: ModeExtensions; edit: ModeExtensions };
  initialMode: Mode;
  onModeChange?: (mode: Mode) => void;
  onSidebarToggle?: () => void;
}

export interface ToolbarHandle {
  setDirty: (dirty: boolean) => void;
  setMode: (mode: Mode) => void;
}

export function mountToolbar(parent: HTMLElement, opts: ToolbarOptions): ToolbarHandle {
  const bar = document.createElement("div");
  bar.className = "viewer-toolbar";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "viewer-toolbar-btn";

  let mode: Mode = opts.initialMode;
  applyButtonLabel();

  toggle.addEventListener("click", () => {
    mode = mode === "reading" ? "edit" : "reading";
    setMode(opts.view, mode, opts.modeExtensions[mode]);
    applyButtonLabel();
    opts.onModeChange?.(mode);
  });

  const sidebar = document.createElement("button");
  sidebar.type = "button";
  sidebar.className = "viewer-toolbar-btn";
  sidebar.textContent = "TOC";
  sidebar.title = "Toggle table of contents";
  sidebar.addEventListener("click", () => opts.onSidebarToggle?.());

  const dirty = document.createElement("span");
  dirty.className = "viewer-dirty-indicator";
  dirty.textContent = "";

  bar.append(toggle, sidebar, dirty);
  parent.prepend(bar);

  function applyButtonLabel(): void {
    toggle.textContent = mode === "reading" ? "Edit" : "Read";
    toggle.title = mode === "reading"
      ? "Switch to edit mode (Cmd/Ctrl+E)"
      : "Switch to reading mode (Cmd/Ctrl+E)";
  }

  return {
    setDirty(d) { dirty.textContent = d ? "•" : ""; },
    setMode(m) {
      mode = m;
      applyButtonLabel();
    },
  };
}
