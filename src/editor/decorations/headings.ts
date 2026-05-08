import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

export const headingsProducer: DecorationProducer = ({ source, tokens }) => {
  const lines = lineStarts(source);
  const ranges: Range<Decoration>[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || !t.map) continue;
    const level = Number(t.tag.replace("h", "")); // h1 → 1
    const lineIndex = t.map[0];
    const from = lines[lineIndex];
    ranges.push(
      Decoration.line({
        class: `cm-md-heading cm-md-heading-${level}`,
      }).range(from),
    );
  }

  return Decoration.set(ranges, /* sort */ true);
};

function lineStarts(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) out.push(i + 1);
  }
  return out;
}
