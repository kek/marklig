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
const spellcheckCompartment = new Compartment();

function spellcheckExtension(enabled: boolean): Extension {
  return EditorView.contentAttributes.of({ spellcheck: enabled ? "true" : "false" });
}

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
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of([]),
      keymapCompartment.of(keymap.of(defaultKeymap)),
      selectionCompartment.of(readingModeSelection),
      spellcheckCompartment.of(spellcheckExtension(false)),
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
  view.dispatch({ effects });
}

export const compartments = {
  readOnly: readOnlyCompartment,
  decorations: decorationsCompartment,
  keymap: keymapCompartment,
  selection: selectionCompartment,
};

// CodeMirror writes the spellcheck attribute on .cm-content from its
// contentAttributes facet on every view update — a direct DOM property write
// gets overwritten. Reconfiguring a Compartment is the supported path.
export function applySpellcheckToView(view: EditorView, enabled: boolean): void {
  view.dispatch({
    effects: spellcheckCompartment.reconfigure(spellcheckExtension(enabled)),
  });
}
