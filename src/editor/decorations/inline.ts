import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

export const inlineProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = absoluteOffsetOfLine(source, t.map[0]);
    const lineStarts = computeLineStarts(source);
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);
    walkInline(t.children, blockStart, blockSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, /* sort */ true);
};

function walkInline(
  children: Token[],
  lineStart: number,
  lineSource: string,
  ranges: Range<Decoration>[],
): void {
  let cursor = 0;
  type OpenSpan = { className: string; openIdx: number; openLen: number };
  const stack: OpenSpan[] = [];

  for (let i = 0; i < children.length; i++) {
    const t = children[i];
    if (t.type === "text" || t.type === "html_inline") {
      const idx = lineSource.indexOf(t.content, cursor);
      if (idx >= 0) cursor = idx + t.content.length;
    } else if (t.type === "code_inline") {
      const literal = "`" + t.content + "`";
      const idx = lineSource.indexOf(literal, cursor);
      if (idx >= 0) {
        ranges.push(
          Decoration.mark({ class: "cm-md-code-inline" })
            .range(lineStart + idx, lineStart + idx + literal.length),
        );
        cursor = idx + literal.length;
      }
    } else if (t.type === "strong_open" || t.type === "em_open" || t.type === "s_open") {
      const className =
        t.type === "strong_open" ? "cm-md-strong" :
        t.type === "em_open"     ? "cm-md-em" :
                                   "cm-md-strike";
      const markerLen = t.markup.length; // e.g. "**" or "_" or "~~"
      const idx = lineSource.indexOf(t.markup, cursor);
      stack.push({ className, openIdx: idx, openLen: markerLen });
      if (idx >= 0) cursor = idx + markerLen;
    } else if (t.type === "strong_close" || t.type === "em_close" || t.type === "s_close") {
      const open = stack.pop();
      if (!open || open.openIdx < 0) continue;
      const closeMarker = t.markup;
      const closeIdx = lineSource.indexOf(closeMarker, cursor);
      if (closeIdx < 0) continue;
      const from = lineStart + open.openIdx;
      const to = lineStart + closeIdx + closeMarker.length;
      ranges.push(Decoration.mark({ class: open.className }).range(from, to));
      cursor = closeIdx + closeMarker.length;
    }
  }
}

function absoluteOffsetOfLine(source: string, lineIndex: number): number {
  let i = 0;
  let line = 0;
  while (line < lineIndex && i < source.length) {
    if (source.charCodeAt(i) === 10) line++;
    i++;
  }
  return i;
}
