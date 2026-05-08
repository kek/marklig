import { describe, it, expect, beforeAll } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { codeblocksProducer, primeHighlighter } from "../../src/editor/decorations/codeblocks";

beforeAll(async () => {
  await primeHighlighter(["javascript"]);
});

function classes(source: string) {
  const tokens = parseMarkdown(source);
  const set = codeblocksProducer({ source, tokens });
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

describe("codeblocksProducer", () => {
  it("marks fence lines with cm-md-code-fence", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    const fences = r.filter((x) => x.class.includes("cm-md-code-fence"));
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it("marks code body lines with cm-md-code-body", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    expect(r.some((x) => x.class.includes("cm-md-code-body"))).toBe(true);
  });
});
