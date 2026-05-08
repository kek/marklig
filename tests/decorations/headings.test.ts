import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { headingsProducer } from "../../src/editor/decorations/headings";

function rangesOf(source: string) {
  const tokens = parseMarkdown(source);
  const set = headingsProducer({ source, tokens });
  const out: Array<{ from: number; to: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

describe("headingsProducer", () => {
  it("emits a line decoration for each ATX heading 1-6", () => {
    const source = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n";
    expect(rangesOf(source)).toEqual([
      { from: 0,  to: 0,  class: "cm-md-heading cm-md-heading-1" },
      { from: 5,  to: 5,  class: "cm-md-heading cm-md-heading-2" },
      { from: 11, to: 11, class: "cm-md-heading cm-md-heading-3" },
      { from: 18, to: 18, class: "cm-md-heading cm-md-heading-4" },
      { from: 26, to: 26, class: "cm-md-heading cm-md-heading-5" },
      { from: 35, to: 35, class: "cm-md-heading cm-md-heading-6" },
    ]);
  });

  it("ignores text without headings", () => {
    expect(rangesOf("just a paragraph\n")).toEqual([]);
  });
});
