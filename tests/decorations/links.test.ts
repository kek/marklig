import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import {
  linksProducer,
  findInlineLinkSpan,
} from "../../src/editor/decorations/links";

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

  it("decorates links on continuation lines of a wrapped paragraph", () => {
    const src = "first line\nsee [docs](https://example.com) on line 2\n";
    const r = ranges(src);
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-text", from: 15, to: 21 }),
    );
  });

  it("decorates a link whose text contains emphasis", () => {
    const src = "see [a _b_ c](https://example.com) here\n";
    const r = ranges(src);
    // text mark spans `[a _b_ c]` (offsets 4..13), url mark spans `(...)`.
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-text", from: 4, to: 13 }),
    );
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-url", from: 13, to: 34 }),
    );
  });

  it("decorates a link whose text contains bold", () => {
    const src = "[a **b** c](https://example.com)\n";
    const r = ranges(src);
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-text", from: 0, to: 11 }),
    );
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-url", from: 11, to: 32 }),
    );
  });

  it("decorates a link whose text contains inline code", () => {
    const src = "[a `b` c](https://example.com)\n";
    const r = ranges(src);
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-text", from: 0, to: 9 }),
    );
    expect(r).toContainEqual(
      expect.objectContaining({ class: "cm-md-link-url", from: 9, to: 30 }),
    );
  });
});

describe("findInlineLinkSpan", () => {
  it("covers the full construct for a plain link", () => {
    const s = "[t](http://x)";
    const span = findInlineLinkSpan(s, 0);
    expect(span).toEqual({ from: 0, textTo: 3, to: s.length });
  });

  it("does not let a ) inside a double-quoted title truncate the URL", () => {
    const s = '[t](http://x "a)b")';
    const span = findInlineLinkSpan(s, 0);
    // Without title-aware scanning the `)` inside the title would close early.
    expect(span).toEqual({ from: 0, textTo: 3, to: s.length });
  });

  it("does not let a ) inside a single-quoted title truncate the URL", () => {
    const s = "[t](http://x 'a)b')";
    const span = findInlineLinkSpan(s, 0);
    expect(span).toEqual({ from: 0, textTo: 3, to: s.length });
  });

  it("returns null when the closing paren is missing", () => {
    expect(findInlineLinkSpan("[t](url", 0)).toBeNull();
  });

  it("returns null when a space separates ] and ( (not an inline link)", () => {
    expect(findInlineLinkSpan("[t] (url)", 0)).toBeNull();
  });

  it("returns null when there is no bracket at all", () => {
    expect(findInlineLinkSpan("no link here", 0)).toBeNull();
  });
});
