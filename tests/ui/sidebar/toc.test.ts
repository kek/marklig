import { describe, it, expect } from "vitest";

import { extractTocEntries, documentHeadingFor } from "../../../src/ui/sidebar/toc";

describe("extractTocEntries", () => {
  it("collects ATX headings with their level and source offset", () => {
    const src = "# A\n\n## B\n\ntext\n\n### C\n";
    expect(extractTocEntries(src)).toEqual([
      { level: 1, text: "A", from: 0 },
      { level: 2, text: "B", from: 5 },
      { level: 3, text: "C", from: 17 },
    ]);
  });

  it("skips YAML frontmatter so it does not appear as a stray TOC entry", () => {
    const src = "---\ntitle: Hi\nauthor: Bob\n---\n\n# Doc\n";
    const entries = extractTocEntries(src);
    expect(entries).toEqual([{ level: 1, text: "Doc", from: "---\ntitle: Hi\nauthor: Bob\n---\n\n".length }]);
  });

  it("skips TOML frontmatter (+++)", () => {
    const src = "+++\ntitle = \"Hi\"\n+++\n\n# Doc\n";
    const entries = extractTocEntries(src);
    expect(entries.map((e) => e.text)).toEqual(["Doc"]);
  });

  it("does not skip --- horizontal rules that are not at line 0", () => {
    const src = "# Top\n\nbody\n\n---\n\n## After\n";
    const entries = extractTocEntries(src);
    expect(entries.map((e) => e.text)).toEqual(["Top", "After"]);
  });
});

describe("documentHeadingFor", () => {
  it("returns the basename without the .md extension", () => {
    expect(documentHeadingFor("/Users/ke/notes/Idea.md")).toBe("Idea");
  });

  it("handles Windows-style paths", () => {
    expect(documentHeadingFor("C:\\users\\ke\\Notes\\Hello.md")).toBe("Hello");
  });

  it("strips alternative markdown extensions", () => {
    expect(documentHeadingFor("/a/b/post.markdown")).toBe("post");
    expect(documentHeadingFor("/a/b/page.mdx")).toBe("page");
    expect(documentHeadingFor("/a/b/index.mdown")).toBe("index");
  });

  it("keeps non-markdown extensions intact", () => {
    expect(documentHeadingFor("/a/notes.txt")).toBe("notes.txt");
  });

  it("falls back to the localised Untitled label when no path is given", () => {
    // EN default is "Untitled" — the test asserts the fallback path runs.
    expect(documentHeadingFor(null)).toBe("Untitled");
    expect(documentHeadingFor("")).toBe("Untitled");
  });
});
