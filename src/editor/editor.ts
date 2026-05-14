import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";

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

// Two layers have to agree for spell-check to actually surface underlines:
//   1. The HTML `spellcheck` attribute on .cm-content. CodeMirror writes this
//      from its contentAttributes facet on every view update, so a direct DOM
//      property write gets clobbered — we reconfigure a Compartment instead.
//   2. The native WebView's continuous-spell-checking flag. On macOS,
//      WKWebView ships with it OFF, so the HTML attribute alone produces
//      nothing until the user manually ticks "Check Spelling While Typing"
//      from the contextual menu. Flip the platform flag via a Tauri command.
export function applySpellcheckToView(view: EditorView, enabled: boolean): void {
  view.dispatch({
    effects: spellcheckCompartment.reconfigure(spellcheckExtension(enabled)),
  });
  // Fire-and-forget; in non-Tauri test environments (jsdom) the invoke shim
  // resolves harmlessly. macOS does the real work, other platforms are no-ops.
  void invoke("set_continuous_spell_checking", { enabled }).catch(() => {});
}
