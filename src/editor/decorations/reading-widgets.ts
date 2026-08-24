import { Decoration, WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { scanInlineSpans } from "./emphasis";
import { dispatchLinkClick, linkHandlersFacet } from "../link-clicks";
import { getRemoteImagePolicy, shouldRenderImage } from "../../shell/settings";
import { classifyImageSrc, localImageCache } from "./local-images";
import { sanitizeHtml } from "../../export/sanitize";
import { calloutIcon, calloutLabel, scanCallouts, type CalloutKind } from "./callouts";
import { t, tA11y } from "../../i18n/strings";

/** Minimal inline-markdown renderer for table cells. Markdown-it's full
 * pipeline runs at document level on whole lines; tables in our reading-mode
 * widget reconstruct cells from the raw source string, which loses inline
 * styling. Rather than re-invoking markdown-it for every cell, render the
 * common inline constructs here. The output is run through sanitizeHtml
 * before injection so any user-supplied `<...>` in the cell stays escaped.
 *
 * Backslash escapes, code spans and links are stashed as NUL-delimited
 * placeholders before the emphasis passes run, so `_`/`*` inside a URL, code
 * text, or a `\*` escape can't be mangled; NUL can't appear in the source line
 * and survives escapeHtml untouched. */
function renderInlineMarkdown(source: string): string {
  // 1. Backslash escapes and code spans, resolved in one left-to-right scan
  // over the raw source. They have to share a pass because each can suppress
  // the other and the winner is whichever starts first: `\`` is an escaped
  // backtick that never opens a span, while a backslash *inside* a span is
  // literal content (CommonMark: `` `a \* b` `` keeps its backslash). Both are
  // stashed as placeholders — escapes so the emphasis passes below can't see
  // the `*` in `\*`, code so its content is never reprocessed at all.
  const codeSpans: string[] = [];
  const escapes: string[] = [];
  let skeleton = "";
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    // `includes("")` is true, so the end-of-input case needs its own guard —
    // a source-final backslash escapes nothing and stays literal.
    if (ch === "\\" && i + 1 < source.length && ASCII_PUNCTUATION.includes(source[i + 1])) {
      skeleton += `\x00ESC${escapes.length}\x00`;
      escapes.push(escapeHtml(source[i + 1]));
      i += 2;
      continue;
    }
    // A backslash before anything else is not an escape and stays literal.
    if (ch === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        skeleton += `\x00CODE${codeSpans.length}\x00`;
        codeSpans.push(`<code>${escapeHtml(source.slice(i + 1, close))}</code>`);
        i = close + 1;
        continue;
      }
    }
    skeleton += ch;
    i++;
  }
  // 2. HTML-escape so any literal angle brackets stay literal. Placeholders are
  // NUL-delimited and survive this untouched.
  let s = escapeHtml(skeleton);
  // 3. Inline links [text](url). The whole <a> is stashed as a placeholder so
  // the emphasis passes below can't mangle the href (URLs legitimately contain
  // `_` and `*`); the label still gets emphasis treatment. Images
  // (`![alt](src)`) are excluded by the lookbehind and stay literal. A quoted
  // title after the URL is dropped — the href is the first whitespace-delimited
  // token. The href arrives already escaped by step 2 (attribute-context
  // escaping); sanitizeHtml then drops any javascript:/data: href smuggled in.
  const linkSpans: string[] = [];
  s = s.replace(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g, (_, label: string, dest: string) => {
    const i = linkSpans.length;
    const href = dest.trim().split(/\s+/)[0] ?? "";
    linkSpans.push(
      `<a href="${href}" class="cm-md-reading-link">${renderEmphasis(label)}</a>`,
    );
    return `\x00LINK${i}\x00`;
  });
  // 4. Emphasis on the remaining (non-link, non-code, non-escaped) text.
  s = renderEmphasis(s);
  // 5. Restore placeholders — links first, since a link label may itself hold
  // a CODE placeholder that the second loop then restores. Escapes go last, so
  // the character they stand for is never seen by the emphasis passes; they are
  // restored across the whole string, which covers labels and hrefs alike.
  // Each replacement is a function so a stashed `$&` or `$'` can't be read as a
  // replacement pattern and corrupt the output.
  for (let i = 0; i < linkSpans.length; i++) {
    s = s.replace(`\x00LINK${i}\x00`, () => linkSpans[i]);
  }
  for (let i = 0; i < codeSpans.length; i++) {
    s = s.replace(`\x00CODE${i}\x00`, () => codeSpans[i]);
  }
  for (let i = 0; i < escapes.length; i++) {
    s = s.replace(`\x00ESC${i}\x00`, () => escapes[i]);
  }
  return s;
}

/** The ASCII punctuation set CommonMark allows a backslash to escape. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** Bold / italic / strike-through passes, shared by cell text and link labels.
 * Bold (**...**) runs before italic (* / _) so a run of '**...**' isn't
 * tokenized as two separate emphasis spans. */
function renderEmphasis(s: string): string {
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  s = s.replace(/(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  return s;
}

/** Split one table row into cells on unescaped `|` only.
 *
 * A `\|` is a literal pipe in a GFM cell, not a delimiter, so the naive
 * `line.split("|")` this replaced tore rows like
 * `| flags | 0xa = NHSYNC \| NVSYNC |` into extra columns and left the
 * backslash stranded in the text. GFM resolves `\|` to `|` at row-split
 * time — *before* inline parsing — which is why the pipe also survives
 * inside a code span; the backslash is dropped here for the same reason.
 *
 * This mirrors markdown-it's own `escapedSplit` (rules_block/table.js),
 * deliberately: markdown-it renders the export and copy-as-HTML paths, and
 * a second, subtly different splitter here is how reading view and export
 * would drift apart on the same document. Outer pipes are dropped as empty
 * first/last entries rather than sliced off the string, so a row ending in
 * `\|` doesn't lose its final character. An entry that is empty only after
 * trimming is a real (blank) cell and is kept. */
function splitTableRow(line: string): string[] {
  const row = line.trim();
  const cells: string[] = [];
  let current = "";
  let lastPos = 0;
  let isEscaped = false;
  for (let pos = 0; pos < row.length; pos++) {
    if (row[pos] === "|") {
      if (isEscaped) {
        // `\|` — keep the pipe, drop the backslash just before it.
        current += row.slice(lastPos, pos - 1);
        lastPos = pos;
      } else {
        cells.push(current + row.slice(lastPos, pos));
        current = "";
        lastPos = pos + 1;
      }
    }
    isEscaped = row[pos] === "\\";
  }
  cells.push(current + row.slice(lastPos));
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells.map((c) => c.trim());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  override toDOM(view: EditorView): HTMLElement {
    // Wrapper carries vertical padding so CM's heightmap measures it
    // (margin on the table itself would not be measured).
    const wrap = document.createElement("div");
    wrap.className = "cm-md-reading-table-wrap";
    // Cell links live in sanitized innerHTML, so per-anchor listeners can't be
    // attached at creation — delegate from the wrapper instead. Clicks route
    // through the same handlers as positional links (linkHandlersFacet); the
    // position-based click handler can't reach them because the whole table is
    // widget DOM. Without installed handlers (edit-only contexts, tests) the
    // anchor is inert rather than navigating the webview.
    wrap.addEventListener("mousedown", (e) => {
      // CM treats mousedown in content as selection/caret intent; swallow it
      // on anchors so a plain click reads as activation (same as reading-links).
      if ((e.target as HTMLElement).closest?.("a[href]")) e.stopPropagation();
    });
    wrap.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const handlers = view.state.facet(linkHandlersFacet);
      if (!handlers) return;
      void dispatchLinkClick(a.getAttribute("href") ?? "", handlers);
    });
    const tbl = document.createElement("table");
    tbl.className = "cm-md-reading-table";
    wrap.append(tbl);
    const lines = this.source.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) return wrap;

    const headerCells = splitTableRow(lines[0]);
    // lines[1] is the separator like |---|---|
    const bodyLines = lines.slice(2);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const c of headerCells) {
      const th = document.createElement("th");
      th.innerHTML = sanitizeHtml(renderInlineMarkdown(c));
      headRow.append(th);
    }
    thead.append(headRow);
    tbl.append(thead);

    const tbody = document.createElement("tbody");
    for (const bl of bodyLines) {
      const cells = splitTableRow(bl);
      const tr = document.createElement("tr");
      for (const c of cells) {
        const td = document.createElement("td");
        td.innerHTML = sanitizeHtml(renderInlineMarkdown(c));
        tr.append(td);
      }
      tbody.append(tr);
    }
    tbl.append(tbody);

    return wrap;
  }
  override eq(other: TableWidget): boolean { return other.source === this.source; }
}

class ImageWidget extends WidgetType {
  readonly kind: ReturnType<typeof classifyImageSrc>;
  // Capture the local-image cache state at construction so widget equality
  // distinguishes a loading widget from a loaded one (same pattern as
  // MermaidWidget) — otherwise CM reuses the loading DOM after the disk read
  // lands. Only meaningful for `local` images; remote/data resolve inline.
  readonly entry: ReturnType<typeof localImageCache.get>;
  constructor(readonly src: string, readonly alt: string) {
    super();
    this.kind = classifyImageSrc(src);
    this.entry = this.kind === "local" ? localImageCache.get(src) : undefined;
  }
  override toDOM(): HTMLElement {
    if (this.kind === "local") return this.renderLocal();
    const policy = getRemoteImagePolicy();
    if (this.kind === "remote" && !shouldRenderImage(this.src, policy)) {
      return makeRemoteImagePlaceholder(this.src, this.alt, policy);
    }
    return this.makeImg(this.src);
  }
  /** Local files can't be assigned to `<img src>` directly (webview origin is
   * tauri://localhost). Route through the disk-reading object-URL cache. */
  private renderLocal(): HTMLElement {
    const entry = this.entry;
    if (!entry) {
      localImageCache.request(this.src);
      return makeLoadingImagePlaceholder(this.alt);
    }
    if (entry.status === "ok" && entry.url) return this.makeImg(entry.url);
    return makeBrokenImagePlaceholder(this.src, this.alt);
  }
  private makeImg(src: string): HTMLImageElement {
    const img = document.createElement("img");
    img.src = src;
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
    return other.src === this.src
      && other.alt === this.alt
      && other.entry === this.entry;
  }
}

function makeLoadingImagePlaceholder(alt: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder cm-md-reading-image-loading";
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    alt ? tA11y("a11y.loadingImageWithAlt", { alt }) : t("a11y.loadingImage"),
  );
  wrap.setAttribute("aria-live", "polite");
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Loading image: ${alt}` : "Loading image…";
  label.setAttribute("aria-hidden", "true");
  wrap.append(label);
  return wrap;
}

function makeRemoteImagePlaceholder(src: string, alt: string, policy: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder";
  wrap.dataset.policy = policy;
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    alt ? tA11y("a11y.remoteImageWithAlt", { alt }) : t("a11y.remoteImage"),
  );
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Remote image: ${alt}` : "Remote image";
  label.setAttribute("aria-hidden", "true");
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  url.setAttribute("aria-hidden", "true");
  wrap.append(label, url);
  return wrap;
}

function makeBrokenImagePlaceholder(src: string, alt: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder cm-md-reading-image-broken";
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    alt ? tA11y("a11y.brokenImageWithAlt", { alt }) : t("a11y.brokenImage"),
  );
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Broken image: ${alt}` : "Broken image";
  label.setAttribute("aria-hidden", "true");
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  url.setAttribute("aria-hidden", "true");
  wrap.append(label, url);
  return wrap;
}

/** The title row of a GitHub alert. In reading mode it stands in for the
 * literal `> [!WARNING]` line, which is scaffolding rather than prose. The
 * kind is carried three ways — a text label, a glyph with its own silhouette,
 * and the colour treatment on `.cm-md-callout` — so it survives greyscale and
 * survives a screen reader; only the glyph is hidden from the a11y tree,
 * because the label already says the same thing. */
class CalloutTitleWidget extends WidgetType {
  constructor(readonly kind: CalloutKind) { super(); }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = `cm-md-callout-title cm-md-callout-title-${this.kind}`;
    const icon = document.createElement("span");
    icon.className = "cm-md-callout-icon";
    icon.textContent = calloutIcon(this.kind);
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "cm-md-callout-label";
    label.textContent = calloutLabel(this.kind);
    wrap.append(icon, label);
    return wrap;
  }
  override eq(other: CalloutTitleWidget): boolean { return other.kind === this.kind; }
}

class HrWidget extends WidgetType {
  override toDOM(): HTMLElement {
    // Wrap the <hr> in a div so vertical breathing room is padding (measured
    // by CM's heightmap) instead of margin (not measured — would drift
    // click-to-position N px per HR cumulatively).
    const wrap = document.createElement("div");
    wrap.className = "cm-md-reading-hr-wrap";
    const hr = document.createElement("hr");
    hr.className = "cm-md-reading-hr";
    wrap.append(hr);
    return wrap;
  }
  override eq(): boolean { return true; }
}

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-bullet";
    span.textContent = "•"; // •
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean { return true; }
}

interface FrontmatterEntry { key: string; value: string; }

function parseFrontmatterBody(body: string): FrontmatterEntry[] | null {
  // Conservative key:value parser. Anything that smells like a nested block
  // (`key:` with no inline value, then indented continuation), a sequence
  // (`- item`), or a flow collection (`{...}` / `[...]`) is treated as
  // beyond our scope — return null so the caller can fall back to raw view.
  const out: FrontmatterEntry[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue;
    if (/^\s/.test(rawLine)) return null;
    if (rawLine.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w.\-]*)\s*:\s*(.*)$/.exec(rawLine);
    if (!m) return null;
    const key = m[1];
    let value = m[2].trim();
    if (value.length === 0) return null;
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out.length > 0 ? out : null;
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-reading-frontmatter";
    const inner = this.source.replace(/^(---|\+\+\+)\r?\n/, "").replace(/\r?\n(---|\+\+\+)\r?\n?$/, "");
    const entries = parseFrontmatterBody(inner);
    if (!entries) {
      const pre = document.createElement("pre");
      pre.className = "cm-md-reading-frontmatter-raw";
      pre.textContent = inner;
      wrap.append(pre);
      return wrap;
    }
    const dl = document.createElement("dl");
    dl.className = "cm-md-reading-frontmatter-list";
    for (const e of entries) {
      const dt = document.createElement("dt");
      dt.textContent = e.key;
      const dd = document.createElement("dd");
      dd.textContent = e.value;
      dl.append(dt, dd);
    }
    wrap.append(dl);
    return wrap;
  }
  override eq(other: FrontmatterWidget): boolean { return other.source === this.source; }
}

/** Replaces a paragraph-interior `\n` with a single space so multiple source
 * lines render as one visually reflowed paragraph in reading mode. CM6
 * visually merges the lines on either side because the line-break char itself
 * is covered by the replace. Hard breaks (CommonMark `  \n` or `\\\n`) skip
 * this replacement, so they keep producing visual line breaks. */
class SoftBreakWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-softbreak";
    span.textContent = " ";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean { return true; }
}

const SOFT_BREAK = Decoration.replace({ widget: new SoftBreakWidget() });

const ELIDE_INLINE = Decoration.replace({ class: "cm-md-reading-elide" });
// Fence open/close elision is split into two decorations rather than one
// block-replace. A block-replace spanning [openLineStart, firstBodyLineStart)
// puts its end-side at exactly the position of the first body line's
// Decoration.line — and CM silently drops the line dec at that boundary
// (regression: first body line losing cm-md-code-body). Splitting into an
// INLINE replace (covers content only, ends at the newline) plus a
// Decoration.line on the fence line itself (collapses line-height for
// breathing room) keeps the boundary clear.
const ELIDE_FENCE = Decoration.replace({ class: "cm-md-reading-elide-fence" });
const ELIDE_FENCE_LINE = Decoration.line({ class: "cm-md-reading-elide-fence-line" });

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)]*)\)/g;
const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n/;

// Inline marker elision. These run over the source and skip ranges inside code blocks.
const HEADING_PREFIX_RE = /^(#{1,6}) /gm;
const BLOCKQUOTE_PREFIX_RE = /^(> )+/gm;
const BULLET_LIST_RE = /^[ \t]*([-*+]) /gm;
const INLINE_CODE_RE = /`([^`\n]+?)`/g;

export const readingWidgetsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);
  const codeRanges: Array<[number, number]> = [];

  // Front matter: replace the entire YAML/TOML block with a styled metadata
  // widget so the reading view shows the document's metadata clearly instead
  // of a blank gap. Markdown-it would otherwise parse `---\n…\n---` as an hr
  // plus a setext H2 — see toc.ts for the matching skip on the headings side.
  const fm = FRONT_MATTER_RE.exec(source);
  if (fm && fm.index === 0) {
    const fmSource = fm[0].replace(/\r?\n?$/, "");
    ranges.push(
      Decoration.replace({ widget: new FrontmatterWidget(fmSource), block: true })
        .range(0, fm[0].length),
    );
    codeRanges.push([0, fm[0].length]);
  }

  // Horizontal rules: replace the line containing `---` / `***` / `___` with
  // a styled <hr> block widget. Skip hr tokens that fall inside the
  // frontmatter range — markdown-it parses the opening `---` of YAML
  // frontmatter as an hr, and we already replace the whole frontmatter block
  // with a single FrontmatterWidget above.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "hr" || !t.map) continue;
    const from = lineStarts[t.map[0]];
    const to = lineStarts[t.map[1]] ?? source.length;
    if (fm && fm.index === 0 && from < fm[0].length) continue;
    ranges.push(
      Decoration.replace({ widget: new HrWidget(), block: true }).range(from, to),
    );
  }

  // Code fence open/close: hide the ``` line content via an INLINE replace
  // (ending before the trailing \n so it doesn't collide with the body
  // line's Decoration.line at the next line start) and collapse the line
  // height via a Decoration.line on the fence line itself. The collapsed
  // line still occupies a small vertical gap so the code block breathes
  // from surrounding paragraphs.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const openTo = lineStarts[t.map[0] + 1] ?? source.length;
    const closeFrom = lineStarts[t.map[1] - 1];
    const openContentEnd = openTo > blockStart && source.charCodeAt(openTo - 1) === 10
      ? openTo - 1 : openTo;
    const closeContentEnd = blockEnd > closeFrom && source.charCodeAt(blockEnd - 1) === 10
      ? blockEnd - 1 : blockEnd;
    ranges.push(ELIDE_FENCE_LINE.range(blockStart));
    if (openContentEnd > blockStart) {
      ranges.push(ELIDE_FENCE.range(blockStart, openContentEnd));
    }
    ranges.push(ELIDE_FENCE_LINE.range(closeFrom));
    if (closeContentEnd > closeFrom) {
      ranges.push(ELIDE_FENCE.range(closeFrom, closeContentEnd));
    }
    codeRanges.push([blockStart, blockEnd]);
  }

  // Indented code blocks (CommonMark 4.4). Two jobs. First, register the
  // block in `codeRanges` so the inline-marker passes below skip it —
  // otherwise a `*p` or a backtick in an unfenced snippet gets read as
  // emphasis and elided. Second, hide the common leading indentation: those
  // four (or more) spaces are the block's marker exactly as ``` is a fence's,
  // and reading mode hides markers. Eliding the *common* indent (never each
  // line's own) keeps the snippet's internal indentation intact.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "code_block" || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    codeRanges.push([blockStart, blockEnd]);

    const bodyLines: Array<{ from: number; indent: number }> = [];
    let common = Infinity;
    for (let line = t.map[0]; line < t.map[1]; line++) {
      const from = lineStarts[line];
      if (from === undefined) break;
      let indent = 0;
      while (from + indent < source.length) {
        const c = source.charCodeAt(from + indent);
        if (c !== 0x20 /* space */ && c !== 0x09 /* tab */) break;
        indent++;
      }
      // A blank line carries no indentation to speak of and must not drag the
      // common prefix down to zero for the whole block.
      const next = source.charCodeAt(from + indent);
      if (Number.isNaN(next) || next === 0x0a || next === 0x0d) continue;
      bodyLines.push({ from, indent });
      if (indent < common) common = indent;
    }
    if (!Number.isFinite(common) || common === 0) continue;
    for (const { from } of bodyLines) {
      ranges.push(ELIDE_INLINE.range(from, from + common));
    }
  }

  // Callouts (GitHub alerts): the `> [!WARNING]` line is scaffolding, so the
  // whole line — quote prefix included — is replaced by a title row. The
  // colour treatment and the block's own indent come from `callouts.ts`, which
  // runs in both modes; only the marker substitution is reading-only.
  const calloutMarkerLines: Array<[number, number]> = [];
  for (const callout of scanCallouts(source, tokens)) {
    ranges.push(
      Decoration.replace({ widget: new CalloutTitleWidget(callout.kind) })
        .range(callout.lineFrom, callout.lineTo),
    );
    // Claim the marker line *including* its newline. Two things must not fire
    // inside it: the `> ` prefix elide below, which starts at the same offset
    // and would win the dedup pass and drop this wider replace; and the
    // paragraph-reflow soft break at the line's end — the marker line and the
    // body are one markdown-it paragraph, so reflowing would drag the body up
    // onto the title row.
    calloutMarkerLines.push([callout.lineFrom, callout.lineTo + 1]);
  }

  /** True for offsets whose source is already claimed wholesale by a block
   * replacement — front matter, a code block, a callout's marker line — and
   * which must therefore not also collect inline marker elision. */
  const inCode = (offset: number): boolean =>
    codeRanges.some(([s, e]) => offset >= s && offset < e)
    || calloutMarkerLines.some(([s, e]) => offset >= s && offset < e);

  // Paragraph reflow: replace each interior `\n` of a paragraph with a
  // space-widget so the lines visually merge. CommonMark hard breaks
  // (`  \n` or `\\\n`) skip the replacement so they retain a real line break.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "paragraph_open" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    for (let k = startLine + 1; k < endLine; k++) {
      const nl = lineStarts[k] - 1;
      if (nl <= 0 || inCode(nl)) continue;
      // Defensive: the char at `nl` must actually be a newline.
      if (source.charCodeAt(nl) !== 10) continue;
      // Hard break: `  \n` or `\\\n` (markdown-it strips trailing-space breaks
      // but the source still has them — preserving the visual line break
      // matches the rendered-HTML semantics).
      const prev = source.charCodeAt(nl - 1);
      const prev2 = nl >= 2 ? source.charCodeAt(nl - 2) : -1;
      if (prev === 0x20 /* space */ && prev2 === 0x20) continue;
      if (prev === 0x5c /* \ */) continue;
      // CommonMark §4.8: leading whitespace on a continuation line is
      // insignificant and a soft break renders as a single space. Widen the
      // replacement to swallow the run of leading spaces/tabs at the start of
      // the continuation line so the indentation doesn't survive as extra
      // visible space. Only spaces (0x20) and tabs (0x09) count, and only at
      // the very start of the next line.
      let to = nl + 1;
      while (to < source.length) {
        const c = source.charCodeAt(to);
        if (c !== 0x20 && c !== 0x09) break;
        to++;
      }
      ranges.push(SOFT_BREAK.range(nl, to));
    }
  }

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

  // Links: hide [ before, ](url) after — but only for non-http(s) links.
  // http/https links are fully replaced by a semantic <a> LinkWidget in
  // reading-links.ts; eliding their brackets here too would create an
  // overlapping Decoration.replace over the same span.
  for (const match of source.matchAll(LINK_RE)) {
    if (match.index === undefined || inCode(match.index)) continue;
    if (/^https?:\/\//i.test(match[2].trim())) continue;
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

  // Inline emphasis markers: hide just the marker pairs, keep the text. Taken
  // from markdown-it's tokens rather than matched out of the source, so what
  // gets hidden is exactly what the parser treated as a delimiter. Source
  // regexes could not keep up with the parser: emphasis broken by a soft line
  // break, emphasis wrapping an `_`, and the inner layer of `***both***` all
  // rendered italic (that mark is token-driven) with their asterisks still on
  // screen. Code spans keep their regex below — the backtick pair is
  // unambiguous in the source, and it also covers spans the token walk skips.
  for (const span of scanInlineSpans(source, tokens)) {
    if (span.kind === "code" || inCode(span.openFrom)) continue;
    ranges.push(ELIDE_INLINE.range(span.openFrom, span.openTo));
    ranges.push(ELIDE_INLINE.range(span.closeFrom, span.closeTo));
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
