import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { mathProducer } from "../../src/editor/decorations/math";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = mathProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("mathProducer", () => {
  it("emits a block widget for $$...$$", () => {
    const r = specs("$$a + b$$\n");
    const blocks = r.filter((x) => (x.spec as { block?: boolean }).block === true);
    expect(blocks.length).toBe(1);
    expect(blocks[0].from).toBe(0);
    expect(blocks[0].to).toBe(9);
  });

  it("emits an inline widget for $...$", () => {
    const r = specs("text $x^2$ end\n");
    const inline = r.filter(
      (x) =>
        (x.spec as { widget?: unknown }).widget !== undefined &&
        (x.spec as { block?: boolean }).block !== true,
    );
    expect(inline.length).toBe(1);
    expect(inline[0].from).toBe(5);
    expect(inline[0].to).toBe(10);
  });

  it("does not match a single $ followed by whitespace (currency-like)", () => {
    const r = specs("price $5.00 today $\n");
    expect(r.length).toBe(0);
  });

  it("does not match an escaped \\$", () => {
    const r = specs("amount \\$5 done\n");
    expect(r.length).toBe(0);
  });

  it("skips math inside fenced code blocks", () => {
    const r = specs("```\n$x^2$\n$$y$$\n```\n");
    expect(r.length).toBe(0);
  });

  it("handles multi-line block math", () => {
    const src = "$$\nx + y\n= z\n$$\n";
    const r = specs(src);
    const blocks = r.filter((x) => (x.spec as { block?: boolean }).block === true);
    expect(blocks.length).toBe(1);
    expect(blocks[0].from).toBe(0);
    expect(blocks[0].to).toBe(src.indexOf("$$\n", 1) + 2);
  });

  it("does not double-tokenize $$ as two inline matches", () => {
    const r = specs("$$x$$\n");
    const blocks = r.filter((x) => (x.spec as { block?: boolean }).block === true);
    const inline = r.filter(
      (x) =>
        (x.spec as { widget?: unknown }).widget !== undefined &&
        (x.spec as { block?: boolean }).block !== true,
    );
    expect(blocks.length).toBe(1);
    expect(inline.length).toBe(0);
  });

  it("emits multiple inline math spans on one line", () => {
    const r = specs("$a$ and $b$\n");
    const inline = r.filter(
      (x) =>
        (x.spec as { widget?: unknown }).widget !== undefined &&
        (x.spec as { block?: boolean }).block !== true,
    );
    expect(inline.length).toBe(2);
  });
});
