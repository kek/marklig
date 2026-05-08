// src/editor/decorations/index.ts
import { StateField } from "@codemirror/state";
import type { Extension, EditorState, Range } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import { parseMarkdown, type MdToken } from "../parser";

export interface DecorationContext {
  source: string;
  tokens: MdToken[];
}

export type DecorationProducer = (ctx: DecorationContext) => DecorationSet;

export function buildDecorationField(
  producers: DecorationProducer[],
): Extension {
  const compute = (state: EditorState): DecorationSet => {
    const source = state.doc.toString();
    const tokens = parseMarkdown(source);
    const ctx: DecorationContext = { source, tokens };
    const allRanges: Range<Decoration>[] = [];
    for (const producer of producers) {
      const set = producer(ctx);
      const cursor = set.iter();
      while (cursor.value) {
        allRanges.push(cursor.value.range(cursor.from, cursor.to));
        cursor.next();
      }
    }
    allRanges.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(allRanges, true);
  };

  return StateField.define<DecorationSet>({
    create: compute,
    update(prev, tr) {
      if (!tr.docChanged) return prev;
      return compute(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export type { DecorationSet };
export { Decoration };
