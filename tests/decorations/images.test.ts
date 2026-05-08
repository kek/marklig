import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { imagesProducer } from "../../src/editor/decorations/images";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = imagesProducer({ source, tokens });
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

describe("imagesProducer", () => {
  it("marks image source spans", () => {
    const r = ranges("see ![alt](./pic.png) here\n");
    expect(r).toEqual([{ from: 4, to: 21, class: "cm-md-image" }]);
  });
});
