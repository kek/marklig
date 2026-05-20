// Custom context menu for the editor (issue #103).
//
// Why custom rather than the native WKWebView / WebView2 / GTK menu:
// the platform context menus include items we can't act on inside a CM6
// editor (Look Up / Speech / Translate make sense for selected text in a
// browser, but inside our decoration layer they often hit widgets and
// do nothing). Rather than ship a menu with no-op items, we render a
// short, mode-aware menu of commands the app already implements.
//
// Trade-off: right-click loses access to Look Up / Speech / Translate /
// Services inside the editor. They remain reachable via the macOS app
// menu and the standard system shortcuts (e.g. ⌃⌘D for Look Up).
//
// The list-builder (`buildContextMenuItems`) is pure data and exported
// for unit tests so we can verify omission rules without booting a DOM
// harness. `mountContextMenu` is the DOM side: a listener that
// preventDefaults the native event and renders the items.

import type { EditorView } from "@codemirror/view";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { t } from "../i18n/strings";

export type Mode = "reading" | "edit";

/** Snapshot of state used to decide which items appear. Passed in so the
 * builder is pure (no globals, no view introspection) and easy to test. */
export interface ContextMenuState {
  mode: Mode;
  hasSelection: boolean;
  hasPath: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** Commands the menu can fire. Each is the user-facing label key and a
 * `run` handler the renderer wires to clicks / Enter. */
export interface ContextMenuHandlers {
  copy: () => void;
  copyAsHtml: () => void | Promise<void>;
  cut: () => void;
  paste: () => void;
  undo: () => void;
  redo: () => void;
  openFind: () => void;
  revealInFileManager: () => void | Promise<void>;
  toggleMode: () => void;
}

export type ContextMenuItem =
  | { kind: "command"; id: string; label: string; run: () => void | Promise<void> }
  | { kind: "separator" };

/** Build the list of items for the current state. Items that don't apply
 * are omitted entirely (not disabled) — matches the project's
 * "no loose ends" stance. Separators are collapsed so the result never
 * contains two adjacent separators or a leading / trailing one. */
export function buildContextMenuItems(
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (state.mode === "reading") {
    // Clipboard group (selection-gated).
    if (state.hasSelection) {
      items.push({ kind: "command", id: "copy", label: t("contextMenu.copy"), run: handlers.copy });
      items.push({ kind: "command", id: "copyAsHtml", label: t("contextMenu.copyAsHtml"), run: handlers.copyAsHtml });
    }
    items.push({ kind: "separator" });
    items.push({ kind: "command", id: "find", label: t("contextMenu.find"), run: handlers.openFind });
    items.push({ kind: "separator" });
    // Reveal in Finder is offered when there's a path AND no selection —
    // the menu becomes mostly clipboard-y when text is selected, and we
    // shouldn't mix navigation in there.
    if (state.hasPath && !state.hasSelection) {
      items.push({
        kind: "command",
        id: "revealInFileManager",
        label: revealLabel(),
        run: handlers.revealInFileManager,
      });
    }
    items.push({
      kind: "command",
      id: "toggleMode",
      label: t("contextMenu.switchToEdit"),
      run: handlers.toggleMode,
    });
  } else {
    // Edit mode.
    if (state.hasSelection) {
      items.push({ kind: "command", id: "cut", label: t("contextMenu.cut"), run: handlers.cut });
      items.push({ kind: "command", id: "copy", label: t("contextMenu.copy"), run: handlers.copy });
    }
    // Paste is always offered in edit mode — pre-checking the clipboard
    // would need an async clipboard read and a permission round-trip on
    // some platforms. An empty paste is a harmless no-op.
    items.push({ kind: "command", id: "paste", label: t("contextMenu.paste"), run: handlers.paste });
    items.push({ kind: "separator" });
    if (state.canUndo) {
      items.push({ kind: "command", id: "undo", label: t("contextMenu.undo"), run: handlers.undo });
    }
    if (state.canRedo) {
      items.push({ kind: "command", id: "redo", label: t("contextMenu.redo"), run: handlers.redo });
    }
    items.push({ kind: "separator" });
    items.push({ kind: "command", id: "find", label: t("contextMenu.find"), run: handlers.openFind });
    items.push({ kind: "separator" });
    if (state.hasPath) {
      items.push({
        kind: "command",
        id: "revealInFileManager",
        label: revealLabel(),
        run: handlers.revealInFileManager,
      });
    }
    items.push({
      kind: "command",
      id: "toggleMode",
      label: t("contextMenu.switchToReading"),
      run: handlers.toggleMode,
    });
  }

  return collapseSeparators(items);
}

/** Drop leading / trailing separators and merge adjacent ones. Without
 * this the omission rules above produce stretches of useless rules.
 * Exported (in addition to being used internally) so the unit tests can
 * exercise it directly. */
export function collapseSeparators(items: ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const it of items) {
    if (it.kind === "separator") {
      if (out.length === 0) continue;
      if (out[out.length - 1].kind === "separator") continue;
      out.push(it);
    } else {
      out.push(it);
    }
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

function revealLabel(): string {
  if (typeof navigator === "undefined") return t("contextMenu.revealLinux");
  const platform = navigator.platform || "";
  if (/Mac/i.test(platform)) return t("contextMenu.revealMac");
  if (/Win/i.test(platform)) return t("contextMenu.revealWindows");
  return t("contextMenu.revealLinux");
}

// ─── DOM side ───────────────────────────────────────────────────────────

export interface MountContextMenuOptions {
  view: EditorView;
  /** App-level handlers the menu can invoke. Same shape as the app menu's
   * subset that the context menu needs. */
  handlers: Pick<ContextMenuHandlers, "copyAsHtml" | "openFind" | "revealInFileManager" | "toggleMode">;
  getCurrentPath: () => string | null;
  getMode: () => Mode;
}

export interface ContextMenuHandle {
  destroy: () => void;
}

/** Attach a `contextmenu` listener to `view.dom`. Right-click pops up the
 * custom menu and suppresses the native one. Returns a handle whose
 * `destroy()` removes the listener and tears down any open popup. */
export function mountContextMenu(opts: MountContextMenuOptions): ContextMenuHandle {
  let openPopup: { close: () => void } | null = null;

  const onContextMenu = (event: Event): void => {
    const mode = opts.getMode();

    // Only override the native menu in reading mode. In edit mode the
    // native menu's items (spelling suggestions, Look Up, Make Uppercase,
    // etc.) all actually work against a writable buffer — replacing it
    // with our custom list would be a downgrade. The bug we were
    // chasing in #103 was specifically reading-mode no-ops.
    if (mode !== "reading") return;

    event.preventDefault();

    const me = event as MouseEvent;

    // Close any prior popup before opening a fresh one.
    openPopup?.close();

    const view = opts.view;
    const state: ContextMenuState = {
      mode,
      hasSelection: view.state.selection.main.empty === false,
      hasPath: opts.getCurrentPath() !== null,
      canUndo: undoDepth(view.state) > 0,
      canRedo: redoDepth(view.state) > 0,
    };

    const handlers = makeRuntimeHandlers(view, opts.handlers);
    const items = buildContextMenuItems(state, handlers);
    if (items.length === 0) return;

    openPopup = renderContextMenu({
      items,
      x: me.clientX,
      y: me.clientY,
      onClose: () => { openPopup = null; },
    });
  };

  opts.view.dom.addEventListener("contextmenu", onContextMenu);

  return {
    destroy: () => {
      opts.view.dom.removeEventListener("contextmenu", onContextMenu);
      openPopup?.close();
      openPopup = null;
    },
  };
}

/** Wire each menu command to the actual implementation. Clipboard items
 * use `document.execCommand` against the CM content element: CM6 doesn't
 * expose Cut/Copy/Paste as named commands, and execCommand-on-DOM is the
 * portable path Tauri's WebView supports. Undo / Redo use CM's commands
 * directly so they participate in the same history extension as the
 * Cmd-Z keymap. */
function makeRuntimeHandlers(
  view: EditorView,
  app: MountContextMenuOptions["handlers"],
): ContextMenuHandlers {
  return {
    copy: () => {
      view.focus();
      try { document.execCommand("copy"); } catch { /* WebView may refuse */ }
    },
    cut: () => {
      view.focus();
      try { document.execCommand("cut"); } catch { /* ignore */ }
    },
    paste: () => {
      view.focus();
      try { document.execCommand("paste"); } catch { /* ignore */ }
    },
    copyAsHtml: () => app.copyAsHtml(),
    undo: () => { undo(view); view.focus(); },
    redo: () => { redo(view); view.focus(); },
    openFind: () => { openSearchPanel(view); },
    revealInFileManager: () => app.revealInFileManager(),
    toggleMode: () => app.toggleMode(),
  };
}

interface RenderOpts {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

interface RenderedPopup {
  close: () => void;
}

function renderContextMenu(opts: RenderOpts): RenderedPopup {
  const root = document.createElement("div");
  root.className = "viewer-context-menu";
  root.setAttribute("role", "menu");

  const commandItems: HTMLElement[] = [];
  let focusIndex = -1;

  for (const item of opts.items) {
    if (item.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "viewer-context-menu-separator";
      sep.setAttribute("role", "separator");
      root.append(sep);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "viewer-context-menu-item";
    row.setAttribute("role", "menuitem");
    row.dataset.id = item.id;
    row.textContent = item.label;
    row.addEventListener("click", () => {
      // Resolve close BEFORE running so a handler that itself focuses
      // somewhere doesn't fight the popup teardown's focus restore.
      close();
      void item.run();
    });
    row.addEventListener("mouseenter", () => {
      const i = commandItems.indexOf(row);
      if (i >= 0) setFocus(i);
    });
    commandItems.push(row);
    root.append(row);
  }

  document.body.append(root);

  // Position. Clamp so the popup stays inside the viewport — if the
  // click was near the bottom-right of the window, flip the anchor
  // edge so the menu opens up / left of the cursor.
  const rect = root.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 4;
  let left = opts.x;
  let top = opts.y;
  if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
  if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  // Initial focus: first command item, so ↑/↓/Enter just work.
  if (commandItems.length > 0) setFocus(0);

  function setFocus(i: number): void {
    if (i < 0 || i >= commandItems.length) return;
    if (focusIndex >= 0 && focusIndex < commandItems.length) {
      commandItems[focusIndex].classList.remove("is-focused");
    }
    focusIndex = i;
    commandItems[i].classList.add("is-focused");
    commandItems[i].focus();
  }

  function moveFocus(delta: 1 | -1): void {
    if (commandItems.length === 0) return;
    let next = focusIndex + delta;
    if (next < 0) next = commandItems.length - 1;
    if (next >= commandItems.length) next = 0;
    setFocus(next);
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusIndex >= 0) commandItems[focusIndex].click();
      return;
    }
  };
  // Capture so we beat any other handler on the page (search panel etc.).
  document.addEventListener("keydown", onKey, true);

  const onPointerDown = (e: Event): void => {
    if (e.target instanceof Node && root.contains(e.target)) return;
    close();
  };
  // Defer attachment so the contextmenu event that opened us doesn't
  // immediately close on the same tick (some browsers fire mousedown
  // before contextmenu, others after — be safe either way).
  const attachAwayTimer = window.setTimeout(() => {
    document.addEventListener("mousedown", onPointerDown, true);
  }, 0);

  const onContextMenu = (e: Event): void => {
    // A right-click somewhere else should dismiss us; the new menu (if
    // any) will be opened by its own contextmenu handler afterwards.
    if (e.target instanceof Node && root.contains(e.target)) return;
    close();
  };
  document.addEventListener("contextmenu", onContextMenu, true);

  const onBlur = (): void => close();
  window.addEventListener("blur", onBlur);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    window.clearTimeout(attachAwayTimer);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("blur", onBlur);
    root.remove();
    opts.onClose();
  }

  return { close };
}
