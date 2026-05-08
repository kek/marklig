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

export const readingWidgetsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

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
  }

  // Code fence open/close: replace those lines.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const openFrom = lineStarts[t.map[0]];
    const openTo = lineStarts[t.map[0] + 1] ?? source.length;
    ranges.push(ELIDE_LINE.range(openFrom, openTo));
    const closeFrom = lineStarts[t.map[1] - 1];
    const closeTo = lineStarts[t.map[1]] ?? source.length;
    ranges.push(ELIDE_LINE.range(closeFrom, closeTo));
  }

  // Images: replace ![alt](url) with an <img>.
  for (const match of source.matchAll(IMAGE_RE)) {
    if (match.index === undefined) continue;
    const alt = match[1];
    const src = match[2];
    ranges.push(
      Decoration.replace({ widget: new ImageWidget(src, alt) })
        .range(match.index, match.index + match[0].length),
    );
  }

  // Links: hide [ before, ](url) after.
  for (const match of source.matchAll(LINK_RE)) {
    if (match.index === undefined) continue;
    const openBracket = match.index;
    const closeBracket = match.index + 1 + match[1].length;
    const closeParen = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(openBracket, openBracket + 1));
    ranges.push(ELIDE_INLINE.range(closeBracket, closeParen));
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
