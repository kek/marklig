import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";

const CONTENT_PATH = resolve(__dirname, "../../website/content.md");

describe("website/content.md", () => {
  it("exists on disk", () => {
    expect(existsSync(CONTENT_PATH)).toBe(true);
  });

  it("parses with markdown-it without throwing", () => {
    const md = new MarkdownIt();
    const src = readFileSync(CONTENT_PATH, "utf-8");
    expect(() => md.parse(src, {})).not.toThrow();
  });

  it("contains the required H2 sections", () => {
    const src = readFileSync(CONTENT_PATH, "utf-8");
    const required = [
      "## Reading-first",
      "## Full Markdown",
      "## Typst",
      "## Android companion",
      "## Sync",
      "## Roadmap",
      "## Install",
    ];
    for (const heading of required) {
      expect(src).toContain(heading);
    }
  });

  it("starts with the H1 + italic lede", () => {
    // Normalise line endings before matching. The file is LF in the repository
    // and on the Unix runners, but `actions/checkout` on the Windows runner
    // inherits that image's `core.autocrlf=true` and materialises it as CRLF,
    // so `startsWith("# Märklig\n")` was false there and only there — the
    // single failure in 604 on the first run this workflow ever had. The claim
    // being made is about the document's first line and its lede, not about
    // which bytes terminate a line.
    //
    // The trailing "\n" stays in the needle after normalising: it is what makes
    // this assert the H1 line is *exactly* `# Märklig` rather than merely
    // starting with it, so `# Märkligt` or `# Märklig — a reader` still fail.
    const src = readFileSync(CONTENT_PATH, "utf-8").replace(/\r\n/g, "\n");
    expect(src.startsWith("# Märklig\n")).toBe(true);
    expect(src).toContain("*Markdown that's beautiful to read.*");
  });
});
