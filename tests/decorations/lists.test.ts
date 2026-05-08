import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { listsProducer } from "../../src/editor/decorations/lists";

function classesOnLines(source: string): Array<{ line: number; class: string }> {
  const tokens = parseMarkdown(source);
  const set = listsProducer({ source, tokens });
  const out: Array<{ line: number; class: string }> = [];
  const lines = computeLines(source);
  const cursor = set.iter();
  while (cursor.value) {
    const line = lines.findIndex((start) => start === cursor.from);
    out.push({
      line,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

function computeLines(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

describe("listsProducer", () => {
  it("marks bullet list lines with cm-md-list-bullet", () => {
    const r = classesOnLines("- one\n- two\n");
    expect(r).toEqual([
      { line: 0, class: "cm-md-list cm-md-list-bullet" },
      { line: 1, class: "cm-md-list cm-md-list-bullet" },
    ]);
  });

  it("marks ordered list lines with cm-md-list-ordered", () => {
    const r = classesOnLines("1. one\n2. two\n");
    expect(r.every((x) => x.class === "cm-md-list cm-md-list-ordered")).toBe(true);
  });

  it("marks task list lines with cm-md-list-task and -done", () => {
    const r = classesOnLines("- [x] done\n- [ ] todo\n");
    expect(r[0].class).toContain("cm-md-list-task");
    expect(r[0].class).toContain("cm-md-list-task-done");
    expect(r[1].class).toContain("cm-md-list-task");
    expect(r[1].class).not.toContain("cm-md-list-task-done");
  });
});
