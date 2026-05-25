import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
// @ts-expect-error -- no type declarations
import taskLists from "markdown-it-task-lists";
// @ts-expect-error -- no type declarations
import footnote from "markdown-it-footnote";
// @ts-expect-error -- no type declarations
import deflist from "markdown-it-deflist";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
})
  .use(taskLists, { enabled: false, label: false })
  .use(footnote)
  .use(deflist);

export type MdToken = Token;

export function parseMarkdown(source: string): MdToken[] {
  if (source.length === 0) return [];
  return md.parse(maskUnclosedFences(source), {});
}

// markdown-it auto-closes an unclosed ```/~~~ fence at EOF, which makes
// everything from the orphan opener onward come out as one big fence token —
// no heading_open, no list_item_open for the swallowed content, and the
// last source line ends up styled by the codeblocks producer as the
// (fake) closing fence. We pre-scan the source, and if we find an opener
// with no matching closer we overwrite the marker with spaces of equal
// length so the parser stops treating it as a fence. The EditorView shows
// the original source unchanged — only the parser sees the masked view —
// and positions/offsets are preserved because the mask is in-place. */
function maskUnclosedFences(source: string): string {
  const lines = source.split("\n");
  let open: { idx: number; marker: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    const marker = m[2];
    const trailing = m[3];
    if (open === null) {
      open = { idx: i, marker };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      trailing.trim().length === 0
    ) {
      open = null;
    }
  }
  if (open === null) return source;
  lines[open.idx] = lines[open.idx].replace(
    /^( {0,3})(`{3,}|~{3,})/,
    (_, indent: string, marker: string) => indent + " ".repeat(marker.length),
  );
  return lines.join("\n");
}

/**
 * Render the markdown source to HTML. Currently consumed only by parser
 * conformance snapshots; it is the seam Sub-spec C will use for the
 * HTML/PDF export pipeline. Output should be passed through `sanitizeHtml`
 * (src/export/sanitize.ts) before insertion into any DOM outside the
 * CodeMirror surface.
 */
export function renderHtml(source: string): string {
  return md.render(source);
}
