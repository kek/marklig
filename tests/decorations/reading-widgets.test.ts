import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { readingWidgetsProducer } from "../../src/editor/decorations/reading-widgets";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = readingWidgetsProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("readingWidgetsProducer", () => {
  it("hides link brackets and url, keeping inner text", () => {
    const r = specs("[t](u)\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide"));
    expect(hides.length).toBeGreaterThanOrEqual(2);
  });

  it("emits an image widget for ![alt](path)", () => {
    const r = specs("![a](./p.png)\n");
    expect(r.some((x) => (x.spec as { widget?: unknown }).widget !== undefined)).toBe(true);
  });

  it("hides code fence lines but not body", () => {
    const r = specs("```\nx\n```\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide-line"));
    expect(hides.length).toBe(2);
  });

  it("hides front matter entirely", () => {
    const r = specs("---\ntitle: x\n---\n\n# Doc\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide-line"));
    expect(hides.length).toBe(3);
  });
});
