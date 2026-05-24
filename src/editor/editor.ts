import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

export type Mode = "reading" | "edit";

export interface CreateEditorOptions {
  parent: HTMLElement;
  source: string;
}

export interface ModeExtensions {
  decorations: Extension;
  keymap: Extension;
}

const readOnlyCompartment = new Compartment();
const decorationsCompartment = new Compartment();
const keymapCompartment = new Compartment();
const selectionCompartment = new Compartment();

// drawSelection() paints CM6's own .cm-selectionBackground rectangles based on
// the logical selection range — the right call in EDIT mode, where it survives
// viewport virtualization and gives us a visible drawn caret. In READING mode
// the same extension paints solid rectangles over widget-heavy layout (elided
// markup, <hr> widgets, heading padding), which looks blocky; native browser
// selection handles those gaps gracefully and is fine for select-and-copy.
const editModeSelection: Extension = drawSelection();
const readingModeSelection: Extension = [];

export function createEditor(opts: CreateEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.source,
    extensions: [
      EditorView.lineWrapping,
      // CodeMirror defaults spellcheck="false" on .cm-content (sensible for
      // code editors). This is a Markdown editor — prose-shaped content —
      // so flip the attribute so the OS-level "Check Spelling While Typing"
      // toggle (right-click menu on macOS) can actually drive underlines.
      // Off-by-default at the underline layer still holds: WKWebView ships
      // with continuous spell-checking OFF, and the right-click state is
      // persisted across launches by the OS.
      EditorView.contentAttributes.of({ spellcheck: "true" }),
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of([]),
      keymapCompartment.of(keymap.of(defaultKeymap)),
      selectionCompartment.of(readingModeSelection),
    ],
  });
  return new EditorView({ state, parent: opts.parent });
}

export function setMode(view: EditorView, mode: Mode, ext?: ModeExtensions): void {
  const effects = [
    readOnlyCompartment.reconfigure(EditorState.readOnly.of(mode === "reading")),
    selectionCompartment.reconfigure(
      mode === "edit" ? editModeSelection : readingModeSelection,
    ),
  ];
  if (ext) {
    effects.push(decorationsCompartment.reconfigure(ext.decorations));
    effects.push(keymapCompartment.reconfigure(ext.keymap));
  }
  const apply = () => view.dispatch({ effects });
  // View Transitions API gives a free cross-fade of the editor between
  // decoration sets, and per-line `view-transition-name`s (see
  // decorations/headings.ts) upgrade that to a morph for heading lines.
  // Fall back to a plain dispatch where unsupported (older webviews / jsdom).
  const startVT = (document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  }).startViewTransition;
  if (typeof startVT === "function") {
    startVT.call(document, apply);
  } else {
    apply();
  }
}

export const compartments = {
  readOnly: readOnlyCompartment,
  decorations: decorationsCompartment,
  keymap: keymapCompartment,
  selection: selectionCompartment,
};
