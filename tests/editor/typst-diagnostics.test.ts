import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import {
  typstDiagnosticsExtension,
  setTypstDiagnostics,
  byteColumnToCharOffset,
  type Diagnostic,
} from "../../src/editor/typst-diagnostics";

function countRanges(set: DecorationSet): number {
  let n = 0;
  const iter = set.iter();
  while (iter.value !== null) {
    n++;
    iter.next();
  }
  return n;
}

function getDecorationsFromView(view: EditorView): DecorationSet {
  // The diag field provides decorations via EditorView.decorations.from(f).
  // We can't easily re-look up the StateField from outside, so observe the
  // composite decoration facet output.
  let combined: DecorationSet = Decoration.none;
  for (const v of view.state.facet(EditorView.decorations)) {
    const value = typeof v === "function" ? v(view) : v;
    combined = combined.update({ add: [], filter: () => true }).update({
      add: [],
    });
    // The simpler approach: just return value directly when there's exactly
    // one provider (our diag field). For the test suite that is true.
    combined = value;
  }
  return combined;
}

describe("typst diagnostics field", () => {
  it("applies and clears decorations", () => {
    const state = EditorState.create({
      doc: "= Heading\n\nparagraph",
      extensions: [typstDiagnosticsExtension()],
    });
    const view = new EditorView({ state });

    const diags: Diagnostic[] = [
      {
        severity: "error",
        message: "boom",
        range: { start: { line: 0, column: 2 }, end: { line: 0, column: 9 } },
        file: null,
      },
    ];
    view.dispatch({ effects: setTypstDiagnostics.of(diags) });
    expect(countRanges(getDecorationsFromView(view))).toBe(1);

    view.dispatch({ effects: setTypstDiagnostics.of([]) });
    expect(countRanges(getDecorationsFromView(view))).toBe(0);

    view.destroy();
  });

  it("ignores diagnostics from non-entry files", () => {
    const state = EditorState.create({
      doc: "= H\n",
      extensions: [typstDiagnosticsExtension()],
    });
    const view = new EditorView({ state });
    view.dispatch({
      effects: setTypstDiagnostics.of([
        {
          severity: "error",
          message: "in import",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
          file: "imports/inner.typ",
        },
      ]),
    });
    expect(countRanges(getDecorationsFromView(view))).toBe(0);
    view.destroy();
  });

  it("error and warning use different classes", () => {
    const state = EditorState.create({
      doc: "ab\ncd",
      extensions: [typstDiagnosticsExtension()],
    });
    const view = new EditorView({ state });
    view.dispatch({
      effects: setTypstDiagnostics.of([
        {
          severity: "error",
          message: "e",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 2 } },
          file: null,
        },
        {
          severity: "warning",
          message: "w",
          range: { start: { line: 1, column: 0 }, end: { line: 1, column: 2 } },
          file: null,
        },
      ]),
    });

    const set = getDecorationsFromView(view);
    const classes: string[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = (iter.value as { spec: { class?: string } }).spec;
      if (spec.class) classes.push(spec.class);
      iter.next();
    }
    expect(classes).toEqual(["typst-diag-error", "typst-diag-warn"]);
    view.destroy();
  });

  it("places a decoration at the right offset for a non-ASCII line (byte column → char offset)", () => {
    // "räv" has an ASCII 'r' (1 byte), a 2-byte 'ä' (U+00E4), then 'v' (1 byte).
    // After "räv " (= 5 bytes) the word "boom" starts at byte column 5.
    // In UTF-16 code units that's char index 4.
    const doc = "räv boom\n";
    const state = EditorState.create({
      doc,
      extensions: [typstDiagnosticsExtension()],
    });
    const view = new EditorView({ state });
    view.dispatch({
      effects: setTypstDiagnostics.of([
        {
          severity: "error",
          message: "highlights 'boom'",
          range: { start: { line: 0, column: 5 }, end: { line: 0, column: 9 } },
          file: null,
        },
      ]),
    });

    const set = getDecorationsFromView(view);
    const iter = set.iter();
    expect(iter.value).not.toBeNull();
    // doc.line(1).from === 0. byte 5 → char 4; byte 9 → char 8.
    expect(iter.from).toBe(4);
    expect(iter.to).toBe(8);

    view.destroy();
  });
});

describe("byteColumnToCharOffset", () => {
  it("ASCII passes through 1:1", () => {
    expect(byteColumnToCharOffset("hello world", 0)).toBe(0);
    expect(byteColumnToCharOffset("hello world", 5)).toBe(5);
    expect(byteColumnToCharOffset("hello world", 11)).toBe(11);
  });

  it("counts 2-byte UTF-8 characters as 2 bytes / 1 char", () => {
    // 'ä' = U+00E4 = 2 UTF-8 bytes.
    expect(byteColumnToCharOffset("räv", 1)).toBe(1); // after 'r'
    expect(byteColumnToCharOffset("räv", 3)).toBe(2); // after 'rä'
    expect(byteColumnToCharOffset("räv", 4)).toBe(3); // after 'räv'
  });

  it("counts 3-byte CJK characters as 3 bytes / 1 char", () => {
    // '中' = U+4E2D = 3 UTF-8 bytes.
    expect(byteColumnToCharOffset("中a", 3)).toBe(1);
    expect(byteColumnToCharOffset("中a", 4)).toBe(2);
  });

  it("counts a 4-byte supplementary character as 4 bytes / 2 UTF-16 code units", () => {
    // '😀' = U+1F600 = 4 UTF-8 bytes, encoded as a surrogate pair in JS.
    expect(byteColumnToCharOffset("😀x", 4)).toBe(2);
    expect(byteColumnToCharOffset("😀x", 5)).toBe(3);
  });

  it("clamps gracefully when byteCol exceeds the line", () => {
    expect(byteColumnToCharOffset("abc", 100)).toBe(3);
  });
});
