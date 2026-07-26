import katex from "katex";
import { renderHtml, parseMarkdown } from "../editor/parser";
import { computeLineStarts } from "../editor/decorations/index";
import { renderMermaid as renderMermaidSvg, type MermaidEntry } from "../editor/decorations/mermaid";
import { sanitizeHtml } from "./sanitize";
import { exportStylesheet } from "./styles";

// Bundle KaTeX's stylesheet via Vite's `?inline` query when running in the
// browser/build, but tolerate test environments where this query may resolve
// to `undefined`. Loaded lazily so the tree-shaker can drop it from any
// non-export entry that happens to import this module.
async function loadKatexCss(): Promise<string> {
  try {
    const mod = await import("katex/dist/katex.min.css?inline");
    return (mod as { default?: string }).default ?? "";
  } catch {
    return "";
  }
}

export interface BuildHtmlExportOptions {
  /** Used as <title>. Defaults to "Markdown export". */
  title?: string;
  /** Override the inlined KaTeX CSS — primarily for tests. */
  katexCss?: string;
  /**
   * Override the Mermaid renderer — primarily for tests, where jsdom can't run
   * Mermaid's layout engine. Defaults to the real (DOM-dependent) renderer.
   */
  renderMermaid?: (source: string) => Promise<MermaidEntry>;
}

/**
 * Build a self-contained HTML document from markdown source. The returned
 * string is ready to be written to disk, opened in a browser, or sent to
 * a print pipeline. Math (`$…$` / `$$…$$`) is rendered via KaTeX.
 *
 * Mermaid diagrams are async per-instance, so — mirroring the math pipeline —
 * every `mermaid` fence is pre-rendered to an SVG here, then substituted
 * synchronously in `renderBodyHtml`. A diagram that fails to render is left as
 * its source fence rather than breaking the export.
 */
export async function buildHtmlExport(
  source: string,
  opts: BuildHtmlExportOptions = {},
): Promise<string> {
  const title = escapeHtml(opts.title ?? "Markdown export");
  const mermaidRenders = await prerenderMermaid(source, opts.renderMermaid ?? renderMermaidSvg);
  const body = renderBodyHtml(source, mermaidRenders);
  const katexCss = opts.katexCss ?? (await loadKatexCss());
  const css = `${exportStylesheet()}\n/* katex */\n${katexCss}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// Synchronous variant for callers that don't need KaTeX CSS inlined (e.g.
// copy-as-HTML to clipboard — receivers typically have their own styling
// or don't render math).
export function buildHtmlExportSync(
  source: string,
  opts: BuildHtmlExportOptions = {},
): string {
  const title = escapeHtml(opts.title ?? "Markdown export");
  // No async pass here, so Mermaid diagrams can't be pre-rendered — they fall
  // through to their source fence (the map is empty).
  const body = renderBodyHtml(source, new Map());
  const css = `${exportStylesheet()}\n/* katex */\n${opts.katexCss ?? ""}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// Pure-ASCII placeholder that markdown-it won't touch and that's improbable
// to appear in user content. Avoids the leading/trailing whitespace problem:
// markdown-it strips whitespace inside <p>, so a placeholder ` MATH0 ` ends
// up as `MATH0` and a substring split misses it.
const PLACEHOLDER_PREFIX = "xKATEXMATHSPANxxx";
const PLACEHOLDER_SUFFIX = "xKATEXEND";

/** A `mermaid` fence located in the source, mirroring `mermaidProducer`. */
interface MermaidBlock {
  start: number;
  end: number;
  content: string;
}

// Locate every `mermaid` fenced block using the same token + line-start logic
// as the live-preview `mermaidProducer`, so the export renders exactly the
// blocks the reader sees on screen.
function collectMermaidBlocks(source: string): MermaidBlock[] {
  const tokens = parseMarkdown(source);
  const lineStarts = computeLineStarts(source);
  const blocks: MermaidBlock[] = [];
  for (const t of tokens) {
    if (t.type !== "fence" || !t.map) continue;
    if ((t.info || "").trim().toLowerCase() !== "mermaid") continue;
    blocks.push({
      start: lineStarts[t.map[0]],
      end: lineStarts[t.map[1]] ?? source.length,
      content: t.content,
    });
  }
  return blocks;
}

// Render every distinct Mermaid diagram in the source ahead of the synchronous
// body build. Mirrors how math is prepared up front, except Mermaid rendering
// is async — hence the awaited fan-out into a source→SVG map.
async function prerenderMermaid(
  source: string,
  render: (source: string) => Promise<MermaidEntry>,
): Promise<Map<string, MermaidEntry>> {
  const uniqueSources = [...new Set(collectMermaidBlocks(source).map((b) => b.content))];
  const entries = await Promise.all(uniqueSources.map((s) => render(s)));
  const map = new Map<string, MermaidEntry>();
  uniqueSources.forEach((s, idx) => map.set(s, entries[idx]));
  return map;
}

function renderBodyHtml(
  source: string,
  mermaidRenders: Map<string, MermaidEntry>,
): string {
  const blocks: Array<{ token: string; html: string; display: boolean }> = [];
  const placeholderFor = (i: number) => `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;

  let i = 0;

  // Mermaid first: swap each successfully pre-rendered diagram for a block
  // placeholder (surrounded by blank lines so markdown-it gives it its own
  // <p>, which we later unwrap — the SVG is itself a block element). Blocks
  // with no "ok" render (failed diagrams, or the sync path with no renderer)
  // are left untouched and fall through to normal fenced-code rendering.
  // Substitutions run back-to-front so earlier source offsets stay valid.
  const mermaidBlocks = collectMermaidBlocks(source);
  let pre = source;
  for (let b = mermaidBlocks.length - 1; b >= 0; b--) {
    const block = mermaidBlocks[b];
    const entry = mermaidRenders.get(block.content);
    if (!entry || entry.status !== "ok") continue;
    // Inject the raw Mermaid SVG, not sanitizeSvg(payload): this SVG is our own
    // first-party Mermaid render of the user's diagram (mermaid runs with
    // securityLevel: "strict" on the source), and the reading-view widget in
    // src/editor/decorations/mermaid.ts injects the identical SVG raw for the
    // same reason — DOMPurify strips Mermaid's <foreignObject> HTML labels, so
    // sanitizing here would silently drop flowchart node/edge text.
    const html = `<div class="mermaid-diagram">${entry.payload}</div>`;
    const ph = placeholderFor(i);
    blocks.push({ token: ph, html, display: true });
    i++;
    pre = `${pre.slice(0, block.start)}\n\n${ph}\n\n${pre.slice(block.end)}`;
  }

  // Mask inline code spans BEFORE math extraction so `$x$` inside backticks
  // is kept as literal text. Restored after markdown-it renders.
  const codeMasks: Array<{ token: string; original: string }> = [];
  pre = pre.replace(/`[^`\n]+?`/g, (m) => {
    const ph = `${PLACEHOLDER_PREFIX}CODE${codeMasks.length}${PLACEHOLDER_SUFFIX}`;
    codeMasks.push({ token: ph, original: m });
    return ph;
  });

  // Block math first so $$ can't be re-tokenized by the inline pass. Surround
  // the placeholder with blank lines so markdown-it puts it in its own <p>,
  // which we then unwrap (KaTeX block output is itself a block element).
  pre = pre.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr: string) => {
    const html = renderKatex(expr.trim(), true);
    const ph = placeholderFor(i);
    blocks.push({ token: ph, html, display: true });
    i++;
    return `\n\n${ph}\n\n`;
  });

  pre = pre.replace(
    /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g,
    (_, expr: string) => {
      const html = renderKatex(expr, false);
      const ph = placeholderFor(i);
      blocks.push({ token: ph, html, display: false });
      i++;
      return ph;
    },
  );

  // Restore inline code spans before markdown-it sees them.
  for (const { token, original } of codeMasks) {
    pre = pre.split(token).join(original);
  }

  let html = sanitizeHtml(renderHtml(pre));

  for (const { token, html: mathHtml, display } of blocks) {
    if (display) {
      html = html.replace(
        new RegExp(`<p>\\s*${escapeRegex(token)}\\s*</p>`, "g"),
        mathHtml,
      );
    }
    html = html.split(token).join(mathHtml);
  }

  return html;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderKatex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      output: "html",
    });
  } catch {
    return `<span class="cm-md-math-error">${escapeHtml(displayMode ? `$$${expr}$$` : `$${expr}$`)}</span>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
