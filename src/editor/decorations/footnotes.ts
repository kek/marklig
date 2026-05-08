import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

const FOOTNOTE_REF_RE = /\[\^[^\]]+\]/g;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/m;

export const footnotesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (const match of source.matchAll(FOOTNOTE_REF_RE)) {
    if (match.index === undefined) continue;
    const lineIdx = lineFor(lineStarts, match.index);
    const lineStart = lineStarts[lineIdx];
    const lineSource = source.slice(lineStart, lineStarts[lineIdx + 1] ?? source.length);
    if (FOOTNOTE_DEF_RE.test(lineSource) && lineSource.startsWith(match[0])) {
      ranges.push(
        Decoration.mark({ class: "cm-md-footnote-def" })
          .range(match.index, match.index + match[0].length),
      );
    } else {
      ranges.push(
        Decoration.mark({ class: "cm-md-footnote-ref" })
          .range(match.index, match.index + match[0].length),
      );
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "dt_open" && t.map) {
      ranges.push(
        Decoration.line({ class: "cm-md-deflist-term" }).range(lineStarts[t.map[0]]),
      );
    } else if (t.type === "dd_open" && t.map) {
      for (let line = t.map[0]; line < t.map[1]; line++) {
        ranges.push(
          Decoration.line({ class: "cm-md-deflist-def" }).range(lineStarts[line]),
        );
      }
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  // Dedupe (deflist def lines might overlap with other class on same line)
  const seen = new Set<string>();
  const dedup = ranges.filter((r) => {
    const key = `${r.from}:${r.to}:${(r.value.spec as { class?: string }).class}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Decoration.set(dedup, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function lineFor(lineStarts: number[], offset: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}
