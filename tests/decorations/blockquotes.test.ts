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
});
