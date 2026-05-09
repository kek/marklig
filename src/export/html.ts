import katex from "katex";
import { renderHtml } from "../editor/parser";
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
}

/**
 * Build a self-contained HTML document from markdown source. The returned
 * string is ready to be written to disk, opened in a browser, or sent to
 * a print pipeline. Math (`$…$` / `$$…$$`) is rendered via KaTeX. Mermaid
 * blocks remain as fenced code (rendering would require async setup +
 * inflate exports; deferred to a future iteration).
 */
export async function buildHtmlExport(
  source: string,
  opts: BuildHtmlExportOptions = {},
): Promise<string> {
  const title = escapeHtml(opts.title ?? "Markdown export");
  const body = renderBodyHtml(source);
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
  const body = renderBodyHtml(source);
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

function renderBodyHtml(source: string): string {
  const blocks: Array<{ token: string; html: string; display: boolean }> = [];
  const placeholderFor = (i: number) => `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;

  let i = 0;
  // Mask inline code spans BEFORE math extraction so `$x$` inside backticks
  // is kept as literal text. Restored after markdown-it renders.
  const codeMasks: Array<{ token: string; original: string }> = [];
  let pre = source.replace(/`[^`\n]+?`/g, (m) => {
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
