import { describe, it, expect } from "vitest";

import { buildHtmlExport, buildHtmlExportSync } from "../../src/export/html";

const fakeKatexCss = ".katex { font-family: KaTeX_Main; }";

describe("buildHtmlExport (async)", () => {
  it("emits a complete HTML document with the given title", async () => {
    const out = await buildHtmlExport("# Hello\n\nworld\n", { title: "Doc", katexCss: fakeKatexCss });
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain("<title>Doc</title>");
    expect(out).toContain("<h1>Hello</h1>");
    expect(out).toContain("<p>world</p>");
  });

  it("inlines the KaTeX stylesheet alongside the export styles", async () => {
    const out = await buildHtmlExport("# H\n", { katexCss: fakeKatexCss });
    expect(out).toMatch(/<style>[^<]*--fg:/);
    expect(out).toContain(fakeKatexCss);
  });
});

describe("buildHtmlExportSync", () => {
  it("escapes the title", () => {
    const out = buildHtmlExportSync("# Hi\n", { title: "<x> & \"y\"" });
    expect(out).toContain("<title>&lt;x&gt; &amp; &quot;y&quot;</title>");
    expect(out).not.toContain("<x>");
  });

  it("renders inline math via KaTeX, not as raw $…$", () => {
    const out = buildHtmlExportSync("Pythagoras: $a^2 + b^2 = c^2$\n");
    expect(out).toContain('class="katex"');
    expect(out).not.toMatch(/\$a\^2/);
  });

  it("renders block math via KaTeX in display mode", () => {
    const out = buildHtmlExportSync("$$\nx = y\n$$\n");
    expect(out).toContain("katex-display");
    // The block math placeholder should be unwrapped from any <p>…</p> shell.
    expect(out).not.toMatch(/<p>\s*<span class="katex-display"/);
  });

  it("does not tokenize currency-like text as math", () => {
    const out = buildHtmlExportSync("Costs $5 today\n");
    // Body should not contain rendered KaTeX (class="katex" is the marker;
    // the CSS itself references .katex-display, so a plain "katex" substring
    // search is too broad).
    expect(out).not.toContain('class="katex"');
    expect(out).toContain("$5");
  });

  it("strips <script> from the rendered body", () => {
    const out = buildHtmlExportSync("<script>alert(1)</script>\n\nok\n");
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toContain("ok");
  });

  it("isolates math from markdown-it so `*` inside math isn't parsed as emphasis", () => {
    const out = buildHtmlExportSync("$a*b*c$\n");
    expect(out).toContain('class="katex"');
    expect(out).not.toContain("<em>b</em>");
  });

  it("handles multiple inline maths on one line", () => {
    const out = buildHtmlExportSync("$a$ and $b$\n");
    const matches = out.match(/class="katex"/g);
    expect(matches?.length).toBe(2);
  });

  it("does not tokenize math inside inline backtick code", () => {
    // `$x$` should display the dollars literally; only the bare $a^2$ counts.
    const out = buildHtmlExportSync("Use `$x$` for math like $a^2$.\n");
    const matches = out.match(/class="katex"/g);
    expect(matches?.length).toBe(1);
    expect(out).toContain("$x$");
  });
});
