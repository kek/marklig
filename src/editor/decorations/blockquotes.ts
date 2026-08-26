import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { scanCallouts } from "./callouts";

export const blockquotesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  // A GitHub alert (`> [!WARNING]`) is a blockquote to markdown-it but not a
  // quotation to the reader. `callouts.ts` owns those lines — decorating them
  // here too would merge `role="blockquote"` with the callout's `role="note"`
  // and paint the quotation's left rule under the callout's own.
  const calloutLines = new Set<number>();
  for (const callout of scanCallouts(source, tokens)) {
    for (let line = callout.fromLine; line < callout.toLine; line++) {
      const start = lineStarts[line];
      if (start !== undefined) calloutLines.add(start);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "blockquote_open" && t.map) {
      for (let line = t.map[0]; line < t.map[1]; line++) {
        const lineStart = lineStarts[line];
        const lineEnd = lineStarts[line + 1] ?? source.length;
        const lineText = source.slice(lineStart, lineEnd).trimStart();

        // Only mark lines that actually start with >
        if (lineText.startsWith(">") && !calloutLines.has(lineStart)) {
          ranges.push(
            Decoration.line({
              class: "cm-md-blockquote",
              attributes: { role: "blockquote" },
            }).range(lineStart),
          );
        }
      }
    }
  }

  // Deduplicate (nested blockquotes can yield same line twice)
  ranges.sort((a, b) => a.from - b.from);
  const seen = new Set<number>();
  const dedup = ranges.filter((r) => {
    if (seen.has(r.from)) return false;
    seen.add(r.from);
    return true;
  });
  return Decoration.set(dedup, true);
};
