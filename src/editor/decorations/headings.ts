import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

export const headingsProducer: DecorationProducer = ({ source, tokens }) => {
  const lines = computeLineStarts(source);
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
        attributes: { role: "heading", "aria-level": String(level) },
      }).range(from),
    );
  }

  return Decoration.set(ranges, /* sort */ true);
};
