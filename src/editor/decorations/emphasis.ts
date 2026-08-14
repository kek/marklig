import type Token from "markdown-it/lib/token.mjs";

import type { MdToken } from "../parser";
import { computeLineStarts } from "./index";

export type InlineSpanKind = "strong" | "em" | "strike" | "code";

/** One inline construct located in the document, with its delimiters called
 * out separately from the whole span. Edit mode styles [openFrom, closeTo);
 * reading mode hides [openFrom, openTo) and [closeFrom, closeTo) and leaves
 * the text between them alone. */
export interface InlineSpan {
  kind: InlineSpanKind;
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

/**
 * Locate inline emphasis / code spans using markdown-it's own tokens.
 *
 * Reading mode used to find the delimiters with source regexes, which drifted
 * from what the parser had actually decided was emphasis: a `*…*` span broken
 * by a soft line break, or one holding an `_`, was italicised (the mark below
 * is token-driven) while its asterisks stayed on screen. Both surfaces read
 * from this one scan now, so a delimiter is hidden exactly when the parser
 * treated it as a delimiter.
 */
export function scanInlineSpans(source: string, tokens: MdToken[]): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);
    walkInline(t.children, blockStart, blockSource, spans);
  }

  spans.sort((a, b) => a.openFrom - b.openFrom || a.closeTo - b.closeTo);
  return spans;
}

function walkInline(
  children: Token[],
  lineStart: number,
  lineSource: string,
  spans: InlineSpan[],
): void {
  let cursor = 0;
  type OpenSpan = { kind: InlineSpanKind; openIdx: number; openLen: number };
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
        spans.push({
          kind: "code",
          openFrom: lineStart + idx,
          openTo: lineStart + idx + 1,
          closeFrom: lineStart + idx + literal.length - 1,
          closeTo: lineStart + idx + literal.length,
        });
        cursor = idx + literal.length;
      }
    } else if (t.type === "strong_open" || t.type === "em_open" || t.type === "s_open") {
      const kind: InlineSpanKind =
        t.type === "strong_open" ? "strong" :
        t.type === "em_open"     ? "em" :
                                   "strike";
      const markerLen = t.markup.length; // e.g. "**" or "_" or "~~"
      const idx = lineSource.indexOf(t.markup, cursor);
      stack.push({ kind, openIdx: idx, openLen: markerLen });
      if (idx >= 0) cursor = idx + markerLen;
    } else if (t.type === "strong_close" || t.type === "em_close" || t.type === "s_close") {
      const open = stack.pop();
      if (!open || open.openIdx < 0) continue;
      const closeMarker = t.markup;
      const closeIdx = lineSource.indexOf(closeMarker, cursor);
      if (closeIdx < 0) continue;
      spans.push({
        kind: open.kind,
        openFrom: lineStart + open.openIdx,
        openTo: lineStart + open.openIdx + open.openLen,
        closeFrom: lineStart + closeIdx,
        closeTo: lineStart + closeIdx + closeMarker.length,
      });
      cursor = closeIdx + closeMarker.length;
    }
  }
}
