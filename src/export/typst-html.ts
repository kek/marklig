/**
 * Self-contained HTML export for compiled Typst documents — the Typst-side
 * counterpart to `buildHtmlExport` (`./html.ts`), which is markdown-it and
 * nothing else.
 *
 * The input is what `typst_compile` already returns and the preview pane
 * already shows: one SVG per page, from `typst_svg::svg`. There is no second
 * rendering backend here, and no new dependency — the pages are the same
 * first-party render the reader is looking at when they pick Export.
 *
 * Free of Tauri imports (`sanitizeSvg` is DOM-only) so the whole builder is
 * unit-testable in jsdom.
 */

import { sanitizeSvg } from "./sanitize";

export interface BuildTypstHtmlOptions {
  /** Used as <title>. Defaults to "Typst export". */
  title?: string;
}

/** A4 in points — the size `typst_svg` emits for a default `#set page()`.
 * Only used when a page's viewBox can't be parsed, which shouldn't happen. */
const FALLBACK_PAGE_PT = { width: 595.2755905511812, height: 841.8897637795276 };

export interface PagePt {
  width: number;
  height: number;
}

/**
 * Read a page's size in points out of its SVG.
 *
 * `typst_svg::svg` (0.14) emits `viewBox="0 0 W H"` alongside `width="Wpt"
 * height="Hpt"`, both in typst's internal points. The viewBox is the more
 * robust of the two to parse (no unit suffix), and it's what the pane already
 * relies on for aspect ratio.
 */
export function pageSizePt(svg: string): PagePt {
  const m = /viewBox\s*=\s*"([^"]*)"/.exec(svg);
  if (m) {
    const parts = m[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [, , width, height] = parts;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return { ...FALLBACK_PAGE_PT };
}

/**
 * Build a self-contained HTML document from compiled Typst pages. The result is
 * ready to be written to disk, printed, put on the clipboard, or handed to the
 * native webview-to-PDF capture (`export_pdf`).
 *
 * Every SVG goes through `sanitizeSvg` — the same treatment the preview pane
 * gives it, so the exported document is byte-for-byte the markup the reader
 * saw. This differs deliberately from the Mermaid export path in `./html.ts`,
 * which injects raw because DOMPurify strips Mermaid's `<foreignObject>` HTML
 * labels. `sanitizeSvg` has no such effect on typst output: it was already
 * tuned for it (the `<use xlink:href="#g…">` glyph references its comment
 * names), and `tests/export/typst-html.test.ts` pins that it also preserves
 * embedded raster images, clip paths and glyph `<symbol>` definitions. Choosing
 * "sanitize" over "raw" therefore costs nothing and keeps one fewer raw-HTML
 * injection point in the codebase.
 *
 * Page fidelity: `@page { size: … ; margin: 0 }` is set from the first page's
 * own dimensions, so a PDF capture produces pages at the document's real size
 * rather than reflowing it onto US Letter. Documents that mix page sizes render
 * every page at the first one's box — CSS `@page` can't vary per page, and
 * a real fix belongs in a Typst PDF backend (see the deferral in
 * `docs/superpowers/specs/2026-05-21-typst-support-design.md`).
 */
export function buildTypstHtmlExport(
  pages: string[],
  opts: BuildTypstHtmlOptions = {},
): string {
  const title = escapeHtml(opts.title ?? "Typst export");
  const size = pages.length > 0 ? pageSizePt(pages[0]) : { ...FALLBACK_PAGE_PT };
  const body = pages
    .map((svg) => `<div class="typst-page">${sanitizeSvg(svg)}</div>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${typstExportStylesheet(size)}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Stylesheet for a compiled-pages export. Screen gets a page-stack reading
 * view; print/PDF gets the document's own page box with no added margin. */
export function typstExportStylesheet(size: PagePt): string {
  const w = trimNum(size.width);
  const h = trimNum(size.height);
  return `
:root { --page-bg: #ffffff; --app-bg: #f2f1ec; --page-shadow: rgba(0,0,0,0.18); }
@media (prefers-color-scheme: dark) {
  /* The pages themselves stay white — they're a printed artifact, and
     inverting a compiled SVG would misrepresent the document. Only the
     surround follows the viewer's theme. */
  :root { --app-bg: #1b1c20; --page-shadow: rgba(0,0,0,0.55); }
}
html, body { margin: 0; padding: 0; background: var(--app-bg); }
body { display: flex; flex-direction: column; align-items: center; padding: 24px 16px; gap: 16px; }
.typst-page {
  background: var(--page-bg);
  box-shadow: 0 1px 6px var(--page-shadow);
  width: ${w}pt;
  max-width: 100%;
}
.typst-page svg {
  display: block;
  /* typst_svg emits intrinsic width/height in pt; 100% of the page wrapper is
     the same box on print and scales down on a narrow screen. */
  width: 100%;
  height: auto;
}
@page { size: ${w}pt ${h}pt; margin: 0; }
@media print {
  html, body { background: #fff; }
  body { display: block; padding: 0; gap: 0; }
  .typst-page {
    box-shadow: none;
    width: ${w}pt;
    height: ${h}pt;
    max-width: none;
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
  }
  .typst-page:last-child { break-after: auto; page-break-after: auto; }
}
`;
}

// Points come out of typst as full float64 (`595.2755905511812`). Keeping two
// decimals is well under a print device's resolution and keeps the stylesheet
// readable in a file the user may well open in an editor.
function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
