import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

export const linksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);

    walkLinkChildren(t.children, blockStart, blockSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};

function walkLinkChildren(
  children: Token[],
  lineStart: number,
  lineSource: string,
  out: Range<Decoration>[],
): void {
  let cursor = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type === "link_open") {
      // Detect linkify-generated links: markup is "" and the next text token
      // matches the href — these are raw autolinks, not [text](url) syntax.
      const nextText = children[i + 1];
      const href = c.attrGet("href") ?? "";
      if (
        c.markup === "" &&
        nextText?.type === "text" &&
        nextText.content === href
      ) {
        // Raw URL autolink — emit cm-md-link-auto
        const idx = lineSource.indexOf(nextText.content, cursor);
        if (idx >= 0) {
          out.push(
            Decoration.mark({ class: "cm-md-link-auto" }).range(
              lineStart + idx,
              lineStart + idx + nextText.content.length,
            ),
          );
          cursor = idx + nextText.content.length;
        }
      } else {
        // Inline link: [text](url). Locate the span by scanning the real
        // source structure rather than reconstructing `[text]` from the child
        // text tokens — the latter silently drops nested inline markup
        // (em/strong/code/strikethrough) and so fails to match. See issue #156.
        const span = findInlineLinkSpan(lineSource, cursor);
        if (!span) continue;
        out.push(
          Decoration.mark({ class: "cm-md-link-text" }).range(
            lineStart + span.from,
            lineStart + span.textTo,
          ),
        );
        out.push(
          Decoration.mark({ class: "cm-md-link-url" }).range(
            lineStart + span.urlFrom,
            lineStart + span.to,
          ),
        );
        cursor = span.to;
      }
    } else if (c.type === "text" && /^https?:\/\/\S+/.test(c.content)) {
      // Fallback: plain-text URL (e.g. from a parser with linkify disabled)
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) {
        out.push(
          Decoration.mark({ class: "cm-md-link-auto" }).range(
            lineStart + idx,
            lineStart + idx + c.content.length,
          ),
        );
        cursor = idx + c.content.length;
      }
    } else if (c.type === "text") {
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) cursor = idx + c.content.length;
    }
  }
}

/** Source positions of an inline `[text](url)` construct, all relative to the
 *  start of `source`:
 *   - `from`    — the opening `[`
 *   - `textTo`  — one past the closing `]` (i.e. the `(`)
 *   - `urlFrom` — the opening `(`  (same as `textTo`)
 *   - `to`      — one past the closing `)`
 */
export interface InlineLinkSpan {
  from: number;
  textTo: number;
  urlFrom: number;
  to: number;
}

/**
 * Locate the next inline `[text](url)` construct in `source` at or after
 * `start`, returning its real source positions. Returns `null` if no
 * well-formed construct is found (caller should skip rather than mis-range).
 *
 * The bracket scan tracks nesting so a `]` belonging to a nested construct
 * (e.g. an image `![alt](src)` or another bracket pair inside the link text)
 * doesn't prematurely close the link text. The matching `]` must be
 * immediately followed by `(`, and the URL portion runs to the matching `)`,
 * also depth-tracked so parenthesised URLs / titles close correctly.
 *
 * Known limitation: a literal `]` or `)` inside the link text that markdown-it
 * accepted via backslash-escaping or balanced nesting we don't model can lead
 * us to skip the link (we never produce a wrong range — we return null). This
 * matches the prior behaviour for those rare cases.
 */
export function findInlineLinkSpan(
  source: string,
  start: number,
): InlineLinkSpan | null {
  const open = source.indexOf("[", start);
  if (open < 0) return null;

  // Find the `]` that closes the link text, honoring nested `[ ]`.
  let depth = 0;
  let closeBracket = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        closeBracket = i;
        break;
      }
    }
  }
  if (closeBracket < 0) return null;

  // `]` must be immediately followed by `(` for an inline link.
  const urlFrom = closeBracket + 1;
  if (source[urlFrom] !== "(") return null;

  // Find the matching `)`, honoring nested `( )` (e.g. in the URL or title).
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = urlFrom; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) return null;

  return {
    from: open,
    textTo: urlFrom,
    urlFrom,
    to: closeParen + 1,
  };
}
