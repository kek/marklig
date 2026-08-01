/**
 * Pure routing decision for the four file-out surfaces — Export → HTML,
 * Export → PDF, Print, and Copy as HTML. Kept free of Tauri imports so it is
 * unit-testable without a window or a compiler session; the handlers in
 * main.ts turn the decision into a build-and-write action or a notice.
 *
 * The bug this exists to prevent: every surface used to call
 * `buildHtmlExport(doc)` unconditionally, which is the markdown-it pipeline.
 * With a `.typ` open that ran the Typst *source* through a Markdown renderer
 * and wrote the result into a file named `document.pdf` — `= Heading` came out
 * as a paragraph of prose — while the correctly compiled pages sat in the
 * preview pane. Nothing warned. Every surface must consult this function.
 */

import type { Format } from "../format";

/** The most recent Typst render, as main.ts tracks it. */
export interface TypstRenderState {
  /** One SVG per page, from the last compile that produced any. */
  pages: string[];
  /** True when `pages` no longer reflects the buffer — the latest compile
   * errored or produced nothing, and the pane is showing dimmed prior pages. */
  stale: boolean;
}

export type ExportRoute =
  /** Render the Markdown source through the markdown-it export pipeline. */
  | { kind: "markdown" }
  /** Wrap these compiled Typst pages, in order, as the export document. */
  | { kind: "typst"; pages: string[] }
  /** Refuse: there is nothing faithful to export. Never fall back to
   * `markdown` here — that is precisely the silent wrong-language export. */
  | { kind: "blocked"; reason: "typst-not-compiled" | "typst-stale" };

/**
 * Decide what a file-out surface should hand to its sink.
 *
 * Markdown is unconditional — it has always been correct and stays so. Typst
 * routes at the compiled pages, and *blocks* rather than degrading when those
 * pages don't exist or don't match the buffer: a document that doesn't compile
 * has no faithful export, and quietly writing either the source or a
 * known-stale render is the defect being fixed.
 */
export function decideExportRoute(input: {
  format: Format;
  typstRender: TypstRenderState | null;
}): ExportRoute {
  if (input.format !== "typst") return { kind: "markdown" };
  const render = input.typstRender;
  if (!render || render.pages.length === 0) {
    return { kind: "blocked", reason: "typst-not-compiled" };
  }
  if (render.stale) return { kind: "blocked", reason: "typst-stale" };
  return { kind: "typst", pages: render.pages };
}

/** The file extension a Save As for `format` should default to, so saving an
 * open `.typ` under a new name doesn't convert it to Markdown identity. */
export function saveAsExtension(format: Format): string {
  return format === "typst" ? "typ" : "md";
}
