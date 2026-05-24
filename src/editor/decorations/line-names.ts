import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

// Every line gets a stable `view-transition-name` keyed by line index. The
// same producer runs in both reading- and edit-mode producer sets, so during
// a mode swap the browser sees an element with the same name in old and new
// snapshots and morphs it in place (size, padding, marker visibility) instead
// of fading across. Line index is stable across the mode swap because the
// document text doesn't change; it is *not* stable across edits, but the
// View Transitions API is only consulted at the moment of the swap.
export const lineNamesProducer: DecorationProducer = ({ source }) => {
  const lineStarts = computeLineStarts(source);
  const ranges: Range<Decoration>[] = [];
  for (let i = 0; i < lineStarts.length; i++) {
    ranges.push(
      Decoration.line({
        attributes: { style: `view-transition-name: md-line-${i}` },
      }).range(lineStarts[i]),
    );
  }
  return Decoration.set(ranges, true);
};
