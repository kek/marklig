import { Decoration, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { getRemoteImagePolicy, shouldRenderImage } from "../../shell/settings";

class TableWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  override toDOM(): HTMLElement {
    const tbl = document.createElement("table");
    tbl.className = "cm-md-reading-table";
    const lines = this.source.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) return tbl;

    const cellsOf = (line: string): string[] => {
      let trimmed = line.trim();
      if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
      if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
      return trimmed.split("|").map((c) => c.trim());
    };

    const headerCells = cellsOf(lines[0]);
    // lines[1] is the separator like |---|---|
    const bodyLines = lines.slice(2);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const c of headerCells) {
      const th = document.createElement("th");
      th.textContent = c;
      headRow.append(th);
    }
    thead.append(headRow);
    tbl.append(thead);

    const tbody = document.createElement("tbody");
    for (const bl of bodyLines) {
      const cells = cellsOf(bl);
      const tr = document.createElement("tr");
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.append(td);
      }
      tbody.append(tr);
    }
    tbl.append(tbody);

    return tbl;
  }
  override eq(other: TableWidget): boolean { return other.source === this.source; }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  override toDOM(): HTMLElement {
    const policy = getRemoteImagePolicy();
    if (!shouldRenderImage(this.src, policy)) {
      return makeRemoteImagePlaceholder(this.src, this.alt, policy);
    }
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-reading-image";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      const broken = makeBrokenImagePlaceholder(this.src, this.alt);
      img.replaceWith(broken);
    });
    return img;
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
}

function makeRemoteImagePlaceholder(src: string, alt: string, policy: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder";
  wrap.dataset.policy = policy;
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Remote image: ${alt}` : "Remote image";
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  wrap.append(label, url);
  return wrap;
}

function makeBrokenImagePlaceholder(src: string, alt: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder cm-md-reading-image-broken";
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Broken image: ${alt}` : "Broken image";
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  wrap.append(label, url);
  return wrap;
}

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-bullet";
    span.textContent = "•"; // •
    return span;
  }
  override eq(): boolean { return true; }
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
  // Bullet lists: replace the marker char (-/*/+) with a real bullet glyph,
  // keep the trailing space so the existing line indent reads naturally.
  // Ordered lists: leave the number visible — it carries semantic meaning.
  for (const match of source.matchAll(BULLET_LIST_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const bulletStart = match.index + match[0].indexOf(match[1]);
    ranges.push(
      Decoration.replace({ widget: new BulletWidget() })
        .range(bulletStart, bulletStart + match[1].length),
    );
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

  // Tables: replace the entire table source with a rendered <table>.
  const lineStartsAll = computeLineStarts(source);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "table_open" || !t.map) continue;
    const tableFrom = lineStartsAll[t.map[0]];
    const tableTo = lineStartsAll[t.map[1]] ?? source.length;
    const tableSource = source.slice(tableFrom, tableTo);
    ranges.push(
      Decoration.replace({ widget: new TableWidget(tableSource), block: true })
        .range(tableFrom, tableTo),
    );
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
