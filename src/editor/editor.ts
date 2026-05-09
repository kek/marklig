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

export function createEditor(opts: CreateEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.source,
    extensions: [
      EditorView.lineWrapping,
      // drawSelection paints .cm-selectionBackground based on the logical
      // selection range, so a Cmd+A followed by scrolling continues to show
      // the selection in newly-rendered viewport. Without it the browser's
      // native selection only paints DOM that existed at select-time.
      drawSelection(),
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of([]),
      keymapCompartment.of(keymap.of(defaultKeymap)),
    ],
  });
  return new EditorView({ state, parent: opts.parent });
}

export function setMode(view: EditorView, mode: Mode, ext?: ModeExtensions): void {
  const effects = [
    readOnlyCompartment.reconfigure(EditorState.readOnly.of(mode === "reading")),
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
};
