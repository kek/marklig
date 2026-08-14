import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { scanInlineSpans, type InlineSpanKind } from "./emphasis";

const CLASS_OF: Record<InlineSpanKind, string> = {
  strong: "cm-md-strong",
  em: "cm-md-em",
  strike: "cm-md-strike",
  code: "cm-md-code-inline",
};

export const inlineProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];

  // Edit mode styles the whole construct, delimiters included — markers stay
  // visible here, muted but styled. Reading mode hides them; see
  // reading-widgets.ts, which reads the same spans.
  for (const span of scanInlineSpans(source, tokens)) {
    ranges.push(
      Decoration.mark({ class: CLASS_OF[span.kind] }).range(span.openFrom, span.closeTo),
    );
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, /* sort */ true);
};
