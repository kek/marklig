import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { inlineProducer } from "../../src/editor/decorations/inline";

function classesOf(source: string) {
  const tokens = parseMarkdown(source);
  const set = inlineProducer({ source, tokens });
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

describe("inlineProducer", () => {
  it("marks **bold** spans (markers + content)", () => {
    const r = classesOf("a **bold** b\n");
    expect(r).toEqual([{ from: 2, to: 10, class: "cm-md-strong" }]);
  });

  it("marks *italic* spans", () => {
    const r = classesOf("a *em* b\n");
    expect(r).toEqual([{ from: 2, to: 6, class: "cm-md-em" }]);
  });

  it("marks `code` spans", () => {
    const r = classesOf("a `c` b\n");
    expect(r).toEqual([{ from: 2, to: 5, class: "cm-md-code-inline" }]);
  });

  it("marks ~~strike~~ spans", () => {
    const r = classesOf("a ~~s~~ b\n");
    expect(r).toEqual([{ from: 2, to: 7, class: "cm-md-strike" }]);
  });

  it("handles nested emphasis", () => {
    const r = classesOf("***both***\n");
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-strong" }));
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-em" }));
  });

  it("decorates emphasis on continuation lines of a wrapped paragraph", () => {
    // markdown-it puts both lines of soft-wrapped prose into a single inline
    // token with map [0, 2]. The producer must walk both lines to find
    // *italic* on line 2.
    const source = "first line **bold**\nsecond line *italic*\n";
    const r = classesOf(source);
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-strong", from: 11, to: 19 }));
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-em", from: 32, to: 40 }));
  });
});
