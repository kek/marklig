import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

export const tablesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "table_open" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    for (let line = startLine; line < endLine; line++) {
      let cls = "cm-md-table";
      if (line === startLine) cls += " cm-md-table-header";
      if (line === startLine + 1) cls += " cm-md-table-separator";
      ranges.push(Decoration.line({ class: cls }).range(lineStarts[line]));
    }
  }

  return Decoration.set(ranges, true);
};
