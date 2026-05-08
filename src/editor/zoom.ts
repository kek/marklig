import type { EditorView } from "@codemirror/view";

const DEFAULT_FONT_PX = 16;
const STEP = 1;
const MIN = 10;
const MAX = 32;

let currentSize = DEFAULT_FONT_PX;

function apply(view: EditorView): void {
  view.scrollDOM.style.fontSize = `${currentSize}px`;
}

export function zoomBy(view: EditorView, direction: 1 | -1): void {
  currentSize = Math.min(MAX, Math.max(MIN, currentSize + direction * STEP));
  apply(view);
}

export function zoomReset(view: EditorView): void {
  currentSize = DEFAULT_FONT_PX;
  apply(view);
}

export function getZoomSize(): number {
  return currentSize;
}
