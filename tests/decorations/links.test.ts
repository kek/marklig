import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { linksProducer } from "../../src/editor/decorations/links";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = linksProducer({ source, tokens });
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

describe("linksProducer", () => {
  it("decorates link text and url separately", () => {
    const r = ranges("see [docs](https://example.com) here\n");
    expect(r).toEqual([
      { from: 4,  to: 10, class: "cm-md-link-text" },
      { from: 10, to: 31, class: "cm-md-link-url"  },
    ]);
  });

  it("decorates autolinks", () => {
    const r = ranges("see https://example.com here\n");
    const auto = r.find((x) => x.class === "cm-md-link-auto");
    expect(auto).toBeDefined();
  });
});
