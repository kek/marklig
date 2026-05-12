import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { blockquotesProducer } from "../../src/editor/decorations/blockquotes";

function lines(source: string) {
  const tokens = parseMarkdown(source);
  const set = blockquotesProducer({ source, tokens });
  const out: number[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push(cursor.from);
    cursor.next();
  }
  return out;
}

describe("blockquotesProducer", () => {
  it("marks each blockquote line", () => {
    const source = "> a\n> b\nc\n";
    expect(lines(source)).toEqual([0, 4]);
  });

  it("exposes role=blockquote on each quoted line", () => {
    const source = "> one\n> two\n>\n> four\n";
    const tokens = parseMarkdown(source);
    const set = blockquotesProducer({ source, tokens });
    const attrs: Array<Record<string, string> | undefined> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { attributes?: Record<string, string> };
      attrs.push(spec.attributes);
      cursor.next();
    }
    expect(attrs.length).toBeGreaterThanOrEqual(3);
    for (const a of attrs) expect(a).toEqual({ role: "blockquote" });
  });
});
