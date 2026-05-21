import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import {
  StateField,
  StateEffect,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  /** Null = diagnostic refers to the entry file; non-null = an import.
   * v1 only renders entry-file diagnostics. */
  file: string | null;
}

export const setTypstDiagnostics = StateEffect.define<Diagnostic[]>();

function mkMark(severity: "error" | "warning", message: string): Decoration {
  const cls = severity === "error" ? "typst-diag-error" : "typst-diag-warn";
  return Decoration.mark({ class: cls, attributes: { title: message } });
}

/** Convert a UTF-8 byte column within a line of text into a UTF-16 code-unit
 *  offset (the unit CodeMirror documents are measured in).
 *
 *  Rust / Typst report diagnostic ranges in UTF-8 bytes. JS strings are
 *  UTF-16. For ASCII the two coincide; any non-ASCII character makes them
 *  diverge.
 *
 *  Counts:
 *    - U+0000–U+007F  → 1 byte  / 1 code unit
 *    - U+0080–U+07FF  → 2 bytes / 1 code unit
 *    - U+0800–U+FFFF (non-surrogate) → 3 bytes / 1 code unit
 *    - U+10000+       → 4 bytes / 2 code units (surrogate pair)
 *
 *  If `byteCol` exceeds the line's byte length the full character length
 *  of `lineText` is returned (clamped, never throws).
 */
export function byteColumnToCharOffset(
  lineText: string,
  byteCol: number,
): number {
  if (byteCol <= 0) return 0;
  let bytesSoFar = 0;
  let i = 0;
  while (i < lineText.length && bytesSoFar < byteCol) {
    const codeUnit = lineText.charCodeAt(i);
    let chBytes: number;
    let consume = 1;
    if (codeUnit < 0x80) {
      chBytes = 1;
    } else if (codeUnit < 0x800) {
      chBytes = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      // High surrogate of a supplementary code point — 4 UTF-8 bytes, 2 UTF-16 code units.
      chBytes = 4;
      consume = 2;
    } else {
      chBytes = 3;
    }
    if (bytesSoFar + chBytes > byteCol) {
      // The target byte position falls inside this character — snap to the
      // character's start (the safest choice for span boundaries).
      break;
    }
    bytesSoFar += chBytes;
    i += consume;
  }
  return i;
}

function buildSet(
  doc: { lines: number; length: number; line(n: number): { from: number; text: string } },
  diags: Diagnostic[],
): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  // Sort by start offset to satisfy RangeSetBuilder's ordering contract.
  const sorted = [...diags]
    .filter((d) => d.file === null)
    .map((d) => {
      const startLineNo = Math.max(
        1,
        Math.min(doc.lines, d.range.start.line + 1),
      );
      const endLineNo = Math.max(
        startLineNo,
        Math.min(doc.lines, d.range.end.line + 1),
      );
      const startLine = doc.line(startLineNo);
      const endLine = doc.line(endLineNo);
      const fromChar = byteColumnToCharOffset(
        startLine.text,
        Math.max(0, d.range.start.column),
      );
      const toChar = byteColumnToCharOffset(
        endLine.text,
        Math.max(0, d.range.end.column),
      );
      const from = startLine.from + fromChar;
      const to = Math.min(endLine.from + toChar, doc.length);
      return { from, to, d };
    })
    .filter((x) => x.to > x.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  for (const { from, to, d } of sorted) {
    b.add(from, to, mkMark(d.severity, d.message));
  }
  return b.finish();
}

const diagField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTypstDiagnostics)) {
        return buildSet(tr.state.doc, e.value);
      }
    }
    if (tr.docChanged) {
      // Keep existing decorations stable across cursor moves; only remap on
      // doc changes so they shift with edits.
      return value.map(tr.changes);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function typstDiagnosticsExtension(): Extension {
  return [diagField];
}
