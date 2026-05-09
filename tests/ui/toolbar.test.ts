import { describe, it, expect } from "vitest";

import { computeDocStats } from "../../src/ui/toolbar";

describe("computeDocStats", () => {
  it("returns zero for an empty document", () => {
    const s = computeDocStats("");
    expect(s.words).toBe(0);
    expect(s.chars).toBe(0);
    expect(s.readingMinutes).toBe(0);
  });

  it("counts words split on whitespace", () => {
    const s = computeDocStats("Hello world\nthis is markdown.");
    expect(s.words).toBe(5);
  });

  it("excludes markdown syntax from word counts", () => {
    // # ** _ ` etc. shouldn't count as words. Inline code is stripped, so
    // 'code' isn't counted; 'Title', 'bold', and 'em' are.
    const s = computeDocStats("# Title\n\n**bold** _em_ `code`");
    expect(s.words).toBe(3);
  });

  it("excludes fenced code from word counts", () => {
    const s = computeDocStats("Intro paragraph.\n\n```js\nconst x = 1;\n```\n\nOutro.");
    // Intro paragraph. + Outro. = 3 words; 'const x = 1;' is excluded.
    expect(s.words).toBe(3);
  });

  it("excludes inline code from word counts", () => {
    const s = computeDocStats("Run `git status` to see things.");
    // Run, to, see, things → 4
    expect(s.words).toBe(4);
  });

  it("strips HTML tags before counting", () => {
    const s = computeDocStats("Hello <strong>world</strong>!");
    expect(s.words).toBe(2);
  });

  it("char count is raw source length (markdown syntax included)", () => {
    const src = "# Hi";
    expect(computeDocStats(src).chars).toBe(src.length);
  });

  it("reading time is at least 1 minute for non-empty docs", () => {
    expect(computeDocStats("one").readingMinutes).toBe(1);
  });

  it("reading time scales with word count at ~200 wpm", () => {
    const words = Array.from({ length: 600 }, () => "word").join(" ");
    expect(computeDocStats(words).readingMinutes).toBe(3);
  });
});
