import { Decoration, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import katex from "katex";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { sanitizeHtml } from "../../export/sanitize";

class InlineMathWidget extends WidgetType {
  constructor(readonly expr: string) { super(); }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-math-inline";
    try {
      span.innerHTML = sanitizeHtml(katex.renderToString(this.expr, {
        displayMode: false,
        throwOnError: false,
        output: "html",
      }));
    } catch {
      span.textContent = `$${this.expr}$`;
      span.classList.add("cm-md-math-error");
    }
    return span;
  }
  override eq(other: InlineMathWidget): boolean { return other.expr === this.expr; }
}

class BlockMathWidget extends WidgetType {
  constructor(readonly expr: string) { super(); }
  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-md-math-block";
    try {
      div.innerHTML = sanitizeHtml(katex.renderToString(this.expr, {
        displayMode: true,
        throwOnError: false,
        output: "html",
      }));
    } catch {
      div.textContent = `$$${this.expr}$$`;
      div.classList.add("cm-md-math-error");
    }
    return div;
  }
  override eq(other: BlockMathWidget): boolean { return other.expr === this.expr; }
}

const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
// Inline: non-space inside, no embedded `$` or newline. Negative lookbehinds
// guard against currency (`$5`) and `$$` block delimiters mis-tokenized as inline.
const INLINE_MATH_RE = /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g;

export const mathProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);
  const codeRanges: Array<[number, number]> = [];

  // Skip math detection inside fenced code blocks.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    codeRanges.push([blockStart, blockEnd]);
  }

  // Block math first — its ranges become exclusion zones for the inline scan,
  // otherwise inline regex would tokenize `$$x$$` as `$` empty `$` empty `$`.
  const mathBlocks: Array<[number, number]> = [];
  for (const match of source.matchAll(BLOCK_MATH_RE)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = from + match[0].length;
    if (codeRanges.some(([s, e]) => from >= s && from < e)) continue;
    const expr = match[1].trim();
    ranges.push(
      Decoration.replace({ widget: new BlockMathWidget(expr), block: true })
        .range(from, to),
    );
    mathBlocks.push([from, to]);
  }

  // Inline math.
  for (const match of source.matchAll(INLINE_MATH_RE)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = from + match[0].length;
    if (codeRanges.some(([s, e]) => from >= s && from < e)) continue;
    if (mathBlocks.some(([s, e]) => from >= s && from < e)) continue;
    const expr = match[1];
    ranges.push(
      Decoration.replace({ widget: new InlineMathWidget(expr) }).range(from, to),
    );
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};
