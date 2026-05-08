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

  it("elides heading prefix `# `", () => {
    const r = specs("# Hello\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 0 && x.to === 2)).toBe(true);
  });

  it("elides bold marker pairs but keeps inner text", () => {
    const r = specs("a **bold** b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 4)).toBe(true);
    expect(inline.some((x) => x.from === 8 && x.to === 10)).toBe(true);
  });

  it("elides italic asterisk markers", () => {
    const r = specs("a *em* b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 3)).toBe(true);
    expect(inline.some((x) => x.from === 5 && x.to === 6)).toBe(true);
  });

  it("elides inline code backticks", () => {
    const r = specs("a `c` b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 3)).toBe(true);
    expect(inline.some((x) => x.from === 4 && x.to === 5)).toBe(true);
  });

  it("replaces bullet marker char with a bullet widget, keeps leading indent and trailing space", () => {
    const r = specs("- one\n  - nested\n");
    const widgets = r.filter(
      (x) => (x.spec as { widget?: unknown }).widget !== undefined,
    );
    // Top-level "- " at offset 0 → replace just the "-" at [0,1)
    expect(widgets.some((x) => x.from === 0 && x.to === 1)).toBe(true);
    // Nested "  - " at offset 6 → replace just the "-" at [8,9)
    expect(widgets.some((x) => x.from === 8 && x.to === 9)).toBe(true);
  });

  it("does not touch ordered list numbers (numbers are content)", () => {
    const r = specs("1. first\n2. second\n");
    // No ranges should overlap the "1." / "2." prefixes.
    expect(r.every((x) => !(x.from === 0 || x.from === 9))).toBe(true);
  });

  it("elides blockquote `> ` prefix", () => {
    const r = specs("> quoted\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 0 && x.to === 2)).toBe(true);
  });

  it("does not elide markers inside fenced code blocks", () => {
    const r = specs("```\n# not a heading\n**not bold**\n```\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    // No inline elides should land inside the fence body (positions 4-36)
    expect(inline.every((x) => x.from < 4 || x.from >= 36)).toBe(true);
  });

  it("emits a table widget for GFM tables", () => {
    const r = specs("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r.some((x) => (x.spec as { widget?: unknown }).widget !== undefined && (x.spec as { block?: boolean }).block === true)).toBe(true);
  });
});
