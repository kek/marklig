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
    const src = readFileSync(CONTENT_PATH, "utf-8");
    expect(src.startsWith("# Märklig\n")).toBe(true);
    expect(src).toContain("*Markdown that's beautiful to read.*");
  });
});
