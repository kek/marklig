import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { tablesProducer } from "../../src/editor/decorations/tables";

function lineClasses(source: string) {
  const tokens = parseMarkdown(source);
  const set = tablesProducer({ source, tokens });
  const out: Array<{ from: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

describe("tablesProducer", () => {
  it("marks every line of a GFM table with cm-md-table", () => {
    const r = lineClasses("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.class.includes("cm-md-table"))).toBe(true);
  });

  it("marks header row with cm-md-table-header", () => {
    const r = lineClasses("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r[0].class).toContain("cm-md-table-header");
    expect(r[1].class).toContain("cm-md-table-separator");
  });
});
