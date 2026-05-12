import { describe, it, expect } from "vitest";
import { WidgetType } from "@codemirror/view";

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

  it("skips math inside inline backtick code", () => {
    // The literal `$x$` inside backticks should NOT be tokenized as math —
    // backticks mean 'show me the dollar signs'.
    const r = specs("Inline math syntax is `$x$` like that.\n");
    expect(r.length).toBe(0);
  });

  it("still tokenizes math outside backticks on the same line", () => {
    const r = specs("Use `$x$` to write $a^2$.\n");
    expect(r.length).toBe(1);
    // The match starts at the opening $ of the actual math span.
    expect(r[0].from).toBe("Use `$x$` to write ".length);
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

  it("rendered inline math contains a <math> element so screen readers can read it (MathML)", () => {
    const src = "Pythagoras: $a^2 + b^2 = c^2$ done.\n";
    const tokens = parseMarkdown(src);
    const set = mathProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();
    const dom = widget!.toDOM(null as never);
    expect(dom.innerHTML).toMatch(/<math[\s>]/i);
  });

  it("rendered block math contains a <math> element for screen readers", () => {
    const src = "$$\nx = y\n$$\n";
    const tokens = parseMarkdown(src);
    const set = mathProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();
    const dom = widget!.toDOM(null as never);
    expect(dom.innerHTML).toMatch(/<math[\s>]/i);
  });
});
