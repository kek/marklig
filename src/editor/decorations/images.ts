import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

const IMAGE_REGEX = /!\[[^\]]*\]\([^)]*\)/g;

export const imagesProducer: DecorationProducer = ({ source }) => {
  const ranges: Range<Decoration>[] = [];
  for (const match of source.matchAll(IMAGE_REGEX)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    ranges.push(Decoration.mark({ class: "cm-md-image" }).range(from, to));
  }
  return Decoration.set(ranges, true);
};
