import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { frontmatterProducer } from "../../src/editor/decorations/frontmatter";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = frontmatterProducer({ source, tokens });
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

describe("frontmatterProducer", () => {
  it("marks YAML front matter at the top of file", () => {
    const src = "---\ntitle: Hi\n---\n\n# Doc\n";
    const r = ranges(src);
    expect(r.map((x) => x.from)).toEqual([0, 4, 14]);
    expect(r.every((x) => x.class.includes("cm-md-frontmatter"))).toBe(true);
  });

  it("ignores --- that's not at line 0", () => {
    const src = "# Doc\n\n---\nhr above this\n";
    expect(ranges(src)).toEqual([]);
  });

  it("handles TOML front matter (+++)", () => {
    const src = "+++\ntitle = \"Hi\"\n+++\n\n# Doc\n";
    const r = ranges(src);
    expect(r).toHaveLength(3);
  });
});
