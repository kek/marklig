import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { footnotesProducer } from "../../src/editor/decorations/footnotes";

function classes(source: string) {
  const tokens = parseMarkdown(source);
  const set = footnotesProducer({ source, tokens });
  const out: string[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push((cursor.value.spec as { class?: string }).class ?? "");
    cursor.next();
  }
  return out;
}

describe("footnotesProducer", () => {
  it("marks footnote references and definitions", () => {
    const src = "Text[^1]\n\n[^1]: Note\n";
    const cls = classes(src);
    expect(cls).toContain("cm-md-footnote-ref");
    expect(cls).toContain("cm-md-footnote-def");
  });

  it("marks definition list terms and definitions", () => {
    const src = "Term\n: Definition\n";
    const cls = classes(src);
    expect(cls).toContain("cm-md-deflist-term");
    expect(cls).toContain("cm-md-deflist-def");
  });
});
