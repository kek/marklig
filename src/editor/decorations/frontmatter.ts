import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n(\1)\r?\n/;

export const frontmatterProducer: DecorationProducer = ({ source }) => {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match || match.index !== 0) return Decoration.set([]);

  const ranges: Range<Decoration>[] = [];
  const lineStarts = [0];
  for (let i = 0; i < match[0].length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  // Drop the trailing entry from the final newline (it points past the FM)
  const usable = lineStarts.slice(0, -1);
  for (const start of usable) {
    ranges.push(Decoration.line({ class: "cm-md-frontmatter" }).range(start));
  }
  return Decoration.set(ranges, true);
};
