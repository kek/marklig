import { Decoration, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  override toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-reading-image";
    img.loading = "lazy";
    img.decoding = "async";
    return img;
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
}

class LineElideWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-elide-line";
    return span;
  }
  override eq(): boolean { return true; }
}

const ELIDE_INLINE = Decoration.replace({ class: "cm-md-reading-elide" });
const ELIDE_LINE = Decoration.replace({
  widget: new LineElideWidget(),
  block: true,
  class: "cm-md-reading-elide-line",
});

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)]*)\)/g;
const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n/;

// Inline marker elision. These run over the source and skip ranges inside code blocks.
const HEADING_PREFIX_RE = /^(#{1,6}) /gm;
const BLOCKQUOTE_PREFIX_RE = /^(> )+/gm;
const BULLET_LIST_RE = /^[ \t]*([-*+]) /gm;
const ORDERED_LIST_RE = /^[ \t]*(\d+\.) /gm;
const STRONG_RE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
const EM_RE = /(?<![*_])(\*|_)(?=\S)([^*_\n]+?)\1(?![*_])/g;
const STRIKE_RE = /~~(?=\S)([\s\S]*?\S)~~/g;
const INLINE_CODE_RE = /`([^`\n]+?)`/g;

export const readingWidgetsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);
  const codeRanges: Array<[number, number]> = [];

  // Front matter: replace each line with a block elide.
  const fm = FRONT_MATTER_RE.exec(source);
  if (fm && fm.index === 0) {
    let p = 0;
    while (p < fm[0].length) {
      const nl = source.indexOf("\n", p);
      if (nl < 0) break;
      ranges.push(ELIDE_LINE.range(p, nl + 1));
      p = nl + 1;
    }
    codeRanges.push([0, fm[0].length]);
  }

  // Code fence open/close: replace those lines. Track full fence range so
  // marker-elision regexes below skip any markup that happens to live inside.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const openTo = lineStarts[t.map[0] + 1] ?? source.length;
    const closeFrom = lineStarts[t.map[1] - 1];
    ranges.push(ELIDE_LINE.range(blockStart, openTo));
    ranges.push(ELIDE_LINE.range(closeFrom, blockEnd));
    codeRanges.push([blockStart, blockEnd]);
  }

  const inCode = (offset: number): boolean =>
    codeRanges.some(([s, e]) => offset >= s && offset < e);

  // Images: replace ![alt](url) with an <img>.
  for (const match of source.matchAll(IMAGE_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const alt = match[1];
    const src = match[2];
    ranges.push(
      Decoration.replace({ widget: new ImageWidget(src, alt) })
        .range(match.index, match.index + match[0].length),
    );
  }

  // Links: hide [ before, ](url) after.
  for (const match of source.matchAll(LINK_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const openBracket = match.index;
    const closeBracket = match.index + 1 + match[1].length;
    const closeParen = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(openBracket, openBracket + 1));
    ranges.push(ELIDE_INLINE.range(closeBracket, closeParen));
  }

  // Block-level prefix markers (start of line).
  for (const match of source.matchAll(HEADING_PREFIX_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    ranges.push(ELIDE_INLINE.range(match.index, match.index + match[0].length));
  }
  for (const match of source.matchAll(BLOCKQUOTE_PREFIX_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    ranges.push(ELIDE_INLINE.range(match.index, match.index + match[0].length));
  }
  for (const match of source.matchAll(BULLET_LIST_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    // Elide just the bullet character and trailing space, keep leading indent
    const bulletStart = match.index + match[0].indexOf(match[1]);
    ranges.push(ELIDE_INLINE.range(bulletStart, bulletStart + match[1].length + 1));
  }
  for (const match of source.matchAll(ORDERED_LIST_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const numStart = match.index + match[0].indexOf(match[1]);
    ranges.push(ELIDE_INLINE.range(numStart, numStart + match[1].length + 1));
  }

  // Inline emphasis markers: hide just the marker pairs, keep the text.
  for (const match of source.matchAll(STRONG_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const open = match.index;
    const close = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(open, open + 2));
    ranges.push(ELIDE_INLINE.range(close - 2, close));
  }
  for (const match of source.matchAll(EM_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const open = match.index;
    const close = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(open, open + 1));
    ranges.push(ELIDE_INLINE.range(close - 1, close));
  }
  for (const match of source.matchAll(STRIKE_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const open = match.index;
    const close = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(open, open + 2));
    ranges.push(ELIDE_INLINE.range(close - 2, close));
  }
  for (const match of source.matchAll(INLINE_CODE_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const open = match.index;
    const close = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(open, open + 1));
    ranges.push(ELIDE_INLINE.range(close - 1, close));
  }

  // Deduplicate overlapping inline ranges (e.g., a regex matching inside another).
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const dedup: Range<Decoration>[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    // Block elides can overlap inline elides spatially — keep both since they target
    // different decoration sides. Only dedupe exact-duplicate inline ranges.
    const isBlock = (r.value.spec as { block?: boolean }).block === true;
    if (!isBlock && r.from < lastEnd) continue;
    dedup.push(r);
    if (!isBlock) lastEnd = r.to;
  }
  return Decoration.set(dedup, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
