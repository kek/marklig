import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import type { MdToken } from "../parser";
import { t } from "../../i18n/strings";

/** GitHub-flavored alerts ("callouts"): a blockquote whose first line is
 * nothing but `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` /
 * `[!CAUTION]`. GitHub renders those as a titled, colour-coded admonition
 * rather than a quotation, and so do we.
 *
 * This file is the shared *scan* plus the mode-independent decorations, in
 * the same spirit as `emphasis.ts`: `reading-widgets.ts` imports `scanCallouts`
 * to substitute a title widget for the marker line, so both surfaces agree on
 * exactly which blockquotes are alerts. */
export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface CalloutBlock {
  kind: CalloutKind;
  /** First source line of the blockquote (0-based). */
  fromLine: number;
  /** One past the blockquote's last source line. */
  toLine: number;
  /** Offset of the start of the marker line (before its `>` prefixes). */
  lineFrom: number;
  /** Offset just past the marker line's content — the newline is excluded. */
  lineTo: number;
  /** Offset of `[` in `[!NOTE]`. */
  markerFrom: number;
  /** Offset just past the matching `]`. */
  markerTo: number;
}

/** The marker must be the only thing on the line. GitHub treats
 * `> [!NOTE] hello` as an ordinary blockquote, and so do we — recognising it
 * would silently swallow the "hello" into a title we don't render. Matching is
 * case-insensitive, which GitHub also does (`[!note]` is a note). */
const MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;

/** One level of blockquote prefix: up to three leading spaces of block
 * indentation, a `>`, and the single optional space CommonMark eats. */
const QUOTE_PREFIX_RE = /^ {0,3}>( ?)/;

/** Strip exactly `depth` blockquote prefixes, or null if the line doesn't
 * carry that many. Stripping by depth is what keeps a nested alert
 * (`> > [!WARNING]`) from also being read as the *outer* blockquote's marker:
 * at depth 1 the remainder is still `> [!WARNING]`, which is not a bare
 * marker, and only the inner token at depth 2 sees `[!WARNING]`. */
function stripQuotePrefixes(line: string, depth: number): string | null {
  let rest = line;
  for (let i = 0; i < depth; i++) {
    const m = QUOTE_PREFIX_RE.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/** Find every GitHub alert in the document, innermost blockquotes included. */
export function scanCallouts(source: string, tokens: MdToken[]): CalloutBlock[] {
  const out: CalloutBlock[] = [];
  const lineStarts = computeLineStarts(source);
  let depth = 0;

  for (const token of tokens) {
    if (token.type === "blockquote_close") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token.type !== "blockquote_open") continue;
    depth++;
    if (!token.map) continue;

    const firstLine = token.map[0];
    const lineFrom = lineStarts[firstLine];
    const lineEnd = lineStarts[firstLine + 1] ?? source.length;
    const lineTo = lineEnd > lineFrom && source.charCodeAt(lineEnd - 1) === 10
      ? lineEnd - 1
      : lineEnd;
    // A CRLF document leaves the \r inside the line; it must not defeat the
    // "marker alone on its line" anchor.
    const lineText = source.slice(lineFrom, lineTo).replace(/\r$/, "");

    const rest = stripQuotePrefixes(lineText, depth);
    if (rest === null) continue;
    const m = MARKER_RE.exec(rest);
    if (!m) continue;

    const markerFrom = lineFrom + (lineText.length - rest.length);
    out.push({
      kind: m[1].toLowerCase() as CalloutKind,
      fromLine: firstLine,
      toLine: token.map[1],
      lineFrom,
      lineTo,
      markerFrom,
      markerTo: markerFrom + m[1].length + 3 /* [ ! ] */,
    });
  }

  return out;
}

/** Visible title for a callout kind. Goes through `t()` like every other
 * user-facing string; it is also what a screen reader announces via the line
 * decoration's aria-label, so the kind never depends on colour alone. */
export function calloutLabel(kind: CalloutKind): string {
  return t(`callout.${kind}`);
}

/** A monochrome glyph per kind, distinct in *shape* so WARNING and CAUTION
 * stay tellable apart without colour. U+FE0E asks for the text presentation —
 * without it these render as full-colour emoji, which clashes with the serif
 * reading view and stops them inheriting the callout's own colour. CAUTION
 * uses U+2298 rather than the obvious ⛔ because ⛔ has no text-presentation
 * glyph at all: the variation selector is ignored and it comes out as a
 * colour emoji regardless. */
const CALLOUT_ICONS: Record<CalloutKind, string> = {
  note: "ℹ︎", // ℹ information
  tip: "✦", // ✦ four-pointed star (no emoji form)
  important: "‼︎", // ‼ double exclamation
  warning: "⚠︎", // ⚠ warning triangle
  caution: "⊘", // ⊘ circled division slash — "do not"
};

export function calloutIcon(kind: CalloutKind): string {
  return CALLOUT_ICONS[kind];
}

/** Shared by both modes: the block's colour/indent treatment, and a mark over
 * the `[!KIND]` text. In edit mode that mark is what mutes the marker while
 * keeping it visible (the repo's rule for markers); in reading mode
 * `reading-widgets.ts` replaces the marker line outright with a title row. */
export const calloutsProducer: DecorationProducer = ({ source, tokens }) => {
  const callouts = scanCallouts(source, tokens);
  if (callouts.length === 0) return Decoration.set([], true);

  const lineStarts = computeLineStarts(source);
  const ranges: Range<Decoration>[] = [];

  // line start -> owning callout. Written in document order, so an inner
  // blockquote (whose token comes later) wins the lines it shares with the
  // outer one and the line is decorated exactly once.
  const owners = new Map<number, { kind: CalloutKind; first: boolean; last: boolean }>();

  for (const callout of callouts) {
    const quoted: number[] = [];
    for (let line = callout.fromLine; line < callout.toLine; line++) {
      const lineStart = lineStarts[line];
      if (lineStart === undefined) break;
      const lineEnd = lineStarts[line + 1] ?? source.length;
      // Same rule as blockquotes.ts: only lines that actually carry a `>`.
      if (!source.slice(lineStart, lineEnd).trimStart().startsWith(">")) continue;
      quoted.push(lineStart);
    }
    quoted.forEach((lineStart, i) => {
      owners.set(lineStart, {
        kind: callout.kind,
        first: i === 0,
        last: i === quoted.length - 1,
      });
    });

    ranges.push(
      Decoration.mark({ class: "cm-md-callout-marker" })
        .range(callout.markerFrom, callout.markerTo),
    );
  }

  for (const [lineStart, owner] of owners) {
    const classes = ["cm-md-callout", `cm-md-callout-${owner.kind}`];
    if (owner.first) classes.push("cm-md-callout-first");
    if (owner.last) classes.push("cm-md-callout-last");
    const attributes: Record<string, string> = {
      role: "note",
      "data-callout": owner.kind,
    };
    // Name the region once, on its opening line, rather than repeating the
    // kind on every line of a long alert.
    if (owner.first) attributes["aria-label"] = calloutLabel(owner.kind);
    ranges.push(
      Decoration.line({ class: classes.join(" "), attributes }).range(lineStart),
    );
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};
