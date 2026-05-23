import { keymap, EditorView } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";

let modeToggleHandler: () => void = () => {};
export function setModeToggleHandler(handler: () => void): void {
  modeToggleHandler = handler;
}

const modeToggleBinding: KeyBinding = {
  key: "Mod-e",
  preventDefault: true,
  run: () => {
    modeToggleHandler();
    return true;
  },
};

let saveHandler: () => void = () => {};
export function setSaveHandler(handler: () => void): void {
  saveHandler = handler;
}

const saveBinding: KeyBinding = {
  key: "Mod-s",
  preventDefault: true,
  run: () => { saveHandler(); return true; },
};

let zoomInHandler: () => void = () => {};
let zoomOutHandler: () => void = () => {};
let zoomResetHandler: () => void = () => {};
export function setZoomHandlers(handlers: { in: () => void; out: () => void; reset: () => void }): void {
  zoomInHandler = handlers.in;
  zoomOutHandler = handlers.out;
  zoomResetHandler = handlers.reset;
}

/** Optional alternate route for Cmd-+/-/0 — when set and the predicate
 * returns true, the alternate handlers fire instead of the editor zoom.
 * Used by the Typst preview pane: when focus is inside the pane we zoom
 * the pane's rendered pages rather than the editor source. */
interface ZoomRoute {
  match: () => boolean;
  in: () => void;
  out: () => void;
  reset: () => void;
}
let altZoomRoute: ZoomRoute | null = null;
export function setAltZoomRoute(route: ZoomRoute | null): void {
  altZoomRoute = route;
}

/** Layout-independent zoom keystroke matcher. CM6's keymap parser and the
 * Tauri menu accelerator both interpret `+` as "Shift + the US `=` key" —
 * which fails on layouts where `+` is unshifted (Swedish, German, etc.).
 * Match by event.key directly so the actual character produced wins. */
export function installZoomKeyHandler(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    // Alternate route (Typst preview pane focus) — branch before defaulting
    // to editor zoom so Cmd-+ in the pane scales pages, not source text.
    const useAlt = altZoomRoute !== null && altZoomRoute.match();
    if (e.key === "+" || (e.key === "=" && e.shiftKey)) {
      e.preventDefault();
      if (useAlt) altZoomRoute!.in(); else zoomInHandler();
    } else if (e.key === "-" || e.key === "−") {
      e.preventDefault();
      if (useAlt) altZoomRoute!.out(); else zoomOutHandler();
    } else if (e.key === "0") {
      e.preventDefault();
      if (useAlt) altZoomRoute!.reset(); else zoomResetHandler();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

// NOTE: Cmd-T (sidebar) and Cmd-Shift-T (preview pane) are NOT bound
// here. main.ts installs window-level keydown handlers (capture phase)
// so the shortcuts work regardless of focus. CM6's defaultKeymap doesn't
// bind Mod-t or Shift-Mod-t, so there's no conflict either way; the
// rationale matches Cmd-J above.

// NOTE: Cmd-J is NOT bound here. main.ts installs a window-level keydown
// handler (capture phase) so the shortcut works regardless of focus —
// including when the pane itself or the sidebar has focus. A second
// binding inside CM6 would risk double-firing the toggle (since
// stopPropagation from window-capture does not always stop the editor's
// own keydown listener in WebKit). One source of truth keeps the
// behavior predictable.

const zoomBindings: KeyBinding[] = [
  { key: "Mod-=", preventDefault: true, run: () => { zoomInHandler(); return true; } },
  { key: "Mod-+", preventDefault: true, run: () => { zoomInHandler(); return true; } },
  { key: "Mod--", preventDefault: true, run: () => { zoomOutHandler(); return true; } },
  { key: "Mod-0", preventDefault: true, run: () => { zoomResetHandler(); return true; } },
];

const PAGE_OVERLAP_LINES = 3;

/** Honor the OS's reduced-motion preference for scroll animations. Returns
 * "auto" (instant) when the user has reduced-motion set, "smooth" otherwise. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function pageScroll(view: EditorView, direction: 1 | -1): boolean {
  const scroller = view.scrollDOM;
  const lineHeight = view.defaultLineHeight;
  const pageHeight = scroller.clientHeight - PAGE_OVERLAP_LINES * lineHeight;
  scroller.scrollBy({
    top: direction * Math.max(pageHeight, lineHeight),
    behavior: scrollBehavior(),
  });
  return true;
}

function scrollToTop(view: EditorView): boolean {
  view.scrollDOM.scrollTo({ top: 0, behavior: scrollBehavior() });
  return true;
}

function scrollToBottom(view: EditorView): boolean {
  view.scrollDOM.scrollTo({ top: view.scrollDOM.scrollHeight, behavior: scrollBehavior() });
  return true;
}

const readingBindings: KeyBinding[] = [
  { key: " ",             run: (v) => pageScroll(v, 1),  preventDefault: true },
  { key: "Shift- ",       run: (v) => pageScroll(v, -1), preventDefault: true },
  { key: "PageDown",      run: (v) => pageScroll(v, 1),  preventDefault: true },
  { key: "PageUp",        run: (v) => pageScroll(v, -1), preventDefault: true },
  { key: "Home",          run: scrollToTop,               preventDefault: true },
  { key: "End",           run: scrollToBottom,            preventDefault: true },
  { key: "Mod-ArrowUp",   run: scrollToTop,               preventDefault: true },
  { key: "Mod-ArrowDown", run: scrollToBottom,            preventDefault: true },
  {
    key: "ArrowDown",
    run: (v) => { v.scrollDOM.scrollBy({ top: v.defaultLineHeight, behavior: "auto" }); return true; },
    preventDefault: true,
  },
  {
    key: "ArrowUp",
    run: (v) => { v.scrollDOM.scrollBy({ top: -v.defaultLineHeight, behavior: "auto" }); return true; },
    preventDefault: true,
  },
];

export const readingKeymap = keymap.of([
  modeToggleBinding,
  saveBinding,
  ...zoomBindings,
  ...searchKeymap,
  ...readingBindings,
]);

export const editKeymap = [
  history(),
  keymap.of([
    modeToggleBinding,
    saveBinding,
      ...zoomBindings,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    indentWithTab,
  ]),
];
