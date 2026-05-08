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

const PAGE_OVERLAP_LINES = 3;

function pageScroll(view: EditorView, direction: 1 | -1): boolean {
  const scroller = view.scrollDOM;
  const lineHeight = view.defaultLineHeight;
  const pageHeight = scroller.clientHeight - PAGE_OVERLAP_LINES * lineHeight;
  scroller.scrollBy({
    top: direction * Math.max(pageHeight, lineHeight),
    behavior: "smooth",
  });
  return true;
}

function scrollToTop(view: EditorView): boolean {
  view.scrollDOM.scrollTo({ top: 0, behavior: "smooth" });
  return true;
}

function scrollToBottom(view: EditorView): boolean {
  view.scrollDOM.scrollTo({ top: view.scrollDOM.scrollHeight, behavior: "smooth" });
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

export const readingKeymap = keymap.of([modeToggleBinding, ...readingBindings]);

export const editKeymap = [
  history(),
  keymap.of([
    modeToggleBinding,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    indentWithTab,
  ]),
];
