import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n(\1)\r?\n/;

export const frontmatterProducer: DecorationProducer = ({ source }) => {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match || match.index !== 0) return Decoration.set([]);

  const ranges: Range<Decoration>[] = [];
  // Keep only line starts inside the front matter block.
  const usable = computeLineStarts(source).filter((s) => s < match[0].length);
  for (const start of usable) {
    ranges.push(Decoration.line({ class: "cm-md-frontmatter" }).range(start));
  }
  return Decoration.set(ranges, true);
};
