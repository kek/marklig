import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";

export const linksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const lineStart = lineStarts[t.map[0]];
    const lineEnd = lineStarts[t.map[0] + 1] ?? source.length;
    const lineSource = source.slice(lineStart, lineEnd);

    walkLinkChildren(t.children, lineStart, lineSource, ranges);
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
        // Inline link: [text](url)
        const text = collectTextUntilClose(children, i + 1, "link_close");
        const literal = "[" + text + "]";
        const textIdx = lineSource.indexOf(literal, cursor);
        if (textIdx < 0) continue;
        const textFrom = lineStart + textIdx;
        const textTo = lineStart + textIdx + literal.length;
        out.push(Decoration.mark({ class: "cm-md-link-text" }).range(textFrom, textTo));
        const urlStart = lineSource.indexOf("(", textIdx + literal.length);
        if (urlStart >= 0) {
          const urlEnd = lineSource.indexOf(")", urlStart);
          if (urlEnd > urlStart) {
            out.push(
              Decoration.mark({ class: "cm-md-link-url" }).range(
                lineStart + urlStart,
                lineStart + urlEnd + 1,
              ),
            );
            cursor = urlEnd + 1;
          }
        }
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

function collectTextUntilClose(children: Token[], start: number, close: string): string {
  let out = "";
  for (let i = start; i < children.length; i++) {
    if (children[i].type === close) break;
    if (children[i].type === "text") out += children[i].content;
  }
  return out;
}

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
