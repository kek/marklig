import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../../src/editor/parser";

function flattenTokens(tokens: any[]): any[] {
  const out: any[] = [];
  for (const t of tokens) {
    out.push(t);
    if (t.children) out.push(...flattenTokens(t.children));
  }
  return out;
}

describe("parseMarkdown", () => {
  it("returns an empty token list for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("parses a level-1 heading", () => {
    const tokens = parseMarkdown("# Hello");
    const heading = tokens.find((t) => t.type === "heading_open");
    expect(heading).toBeDefined();
    expect(heading?.tag).toBe("h1");
  });

  it("parses GFM tables", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const tokens = parseMarkdown(md);
    expect(tokens.some((t) => t.type === "table_open")).toBe(true);
  });

  it("parses task lists", () => {
    const md = "- [x] done\n- [ ] todo\n";
    const tokens = parseMarkdown(md);
    const allTokens = flattenTokens(tokens);
    const checkbox = allTokens.find((t) => t.type === "html_inline" && t.content.startsWith("<input"));
    expect(checkbox).toBeDefined();
  });

  it("parses footnotes", () => {
    const md = "Text[^1]\n\n[^1]: Note\n";
    const tokens = parseMarkdown(md);
    const allTokens = flattenTokens(tokens);
    expect(allTokens.some((t) => t.type === "footnote_ref")).toBe(true);
  });

  it("parses definition lists", () => {
    const md = "Term\n: Definition\n";
    const tokens = parseMarkdown(md);
    expect(tokens.some((t) => t.type === "dl_open")).toBe(true);
  });
});
