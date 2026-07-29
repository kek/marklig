import { describe, it, expect } from "vitest";

import { buildHtmlExport } from "../../src/export/html";

const fakeKatexCss = ".katex { font-family: KaTeX_Main; }";

// A stand-in for the real (async, DOM-dependent) Mermaid renderer. jsdom can't
// run Mermaid's layout engine, so tests inject a deterministic SVG the same way
// `katexCss` overrides the real stylesheet lookup.
const fakeMermaid = async () => ({
  status: "ok" as const,
  payload: `<svg class="mermaid-svg"><g class="node"><foreignObject><div class="nodeLabel">Start</div></foreignObject></g></svg>`,
});

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

  it("pre-renders a mermaid fence as inline SVG, not as source", async () => {
    const src = "```mermaid\ngraph TD; A-->B;\n```\n";
    const out = await buildHtmlExport(src, { katexCss: fakeKatexCss, renderMermaid: fakeMermaid });
    expect(out).toContain("<svg");
    expect(out).toContain('class="mermaid-svg"');
    // Injected raw (not sanitized): Mermaid's <foreignObject> HTML labels must
    // survive verbatim — DOMPurify would strip them, dropping flowchart text.
    expect(out).toContain("<foreignObject>");
    expect(out).toContain('<div class="nodeLabel">Start</div>');
    // The diagram source must not survive as a code fence.
    expect(out).not.toContain("graph TD");
    expect(out).not.toContain('class="language-mermaid"');
  });

  it("unwraps the block-level mermaid substitution from its <p> shell", async () => {
    const src = "```mermaid\ngraph TD; A-->B;\n```\n";
    const out = await buildHtmlExport(src, { katexCss: fakeKatexCss, renderMermaid: fakeMermaid });
    expect(out).not.toMatch(/<p>\s*<div class="mermaid-diagram">/);
  });

  it("keeps surrounding markdown around a rendered diagram", async () => {
    const src = "# Title\n\n```mermaid\ngraph TD; A-->B;\n```\n\nAfter\n";
    const out = await buildHtmlExport(src, { katexCss: fakeKatexCss, renderMermaid: fakeMermaid });
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<p>After</p>");
    expect(out).toContain("<svg");
  });

  it("degrades a failed mermaid diagram to its source fence instead of breaking the export", async () => {
    const failing = async () => ({ status: "error" as const, payload: "Parse error on line 1" });
    const src = "```mermaid\nnot a diagram\n```\n";
    const out = await buildHtmlExport(src, { katexCss: fakeKatexCss, renderMermaid: failing });
    expect(out).not.toContain("<svg");
    // Body still complete and the source is preserved as a code block.
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain("not a diagram");
  });
});

// Body-level rendering: title escaping, the math pipeline, sanitization. These
// used to be asserted against a synchronous sibling builder; that builder had
// no callers in src/ and was removed, so they now run against the one builder
// every export surface actually uses.
describe("buildHtmlExport — body rendering", () => {
  it("escapes the title", async () => {
    const out = await buildHtmlExport("# Hi\n", { title: "<x> & \"y\"", katexCss: fakeKatexCss });
    expect(out).toContain("<title>&lt;x&gt; &amp; &quot;y&quot;</title>");
    expect(out).not.toContain("<x>");
  });

  it("renders inline math via KaTeX, not as raw $…$", async () => {
    const out = await buildHtmlExport("Pythagoras: $a^2 + b^2 = c^2$\n", { katexCss: fakeKatexCss });
    expect(out).toContain('class="katex"');
    expect(out).not.toMatch(/\$a\^2/);
  });

  it("renders block math via KaTeX in display mode", async () => {
    const out = await buildHtmlExport("$$\nx = y\n$$\n", { katexCss: fakeKatexCss });
    expect(out).toContain("katex-display");
    // The block math placeholder should be unwrapped from any <p>…</p> shell.
    expect(out).not.toMatch(/<p>\s*<span class="katex-display"/);
  });

  it("does not tokenize currency-like text as math", async () => {
    const out = await buildHtmlExport("Costs $5 today\n", { katexCss: fakeKatexCss });
    // Body should not contain rendered KaTeX (class="katex" is the marker;
    // the CSS itself references .katex-display, so a plain "katex" substring
    // search is too broad).
    expect(out).not.toContain('class="katex"');
    expect(out).toContain("$5");
  });

  it("strips <script> from the rendered body", async () => {
    const out = await buildHtmlExport("<script>alert(1)</script>\n\nok\n", { katexCss: fakeKatexCss });
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toContain("ok");
  });

  it("isolates math from markdown-it so `*` inside math isn't parsed as emphasis", async () => {
    const out = await buildHtmlExport("$a*b*c$\n", { katexCss: fakeKatexCss });
    expect(out).toContain('class="katex"');
    expect(out).not.toContain("<em>b</em>");
  });

  it("handles multiple inline maths on one line", async () => {
    const out = await buildHtmlExport("$a$ and $b$\n", { katexCss: fakeKatexCss });
    const matches = out.match(/class="katex"/g);
    expect(matches?.length).toBe(2);
  });

  it("does not tokenize math inside inline backtick code", async () => {
    // `$x$` should display the dollars literally; only the bare $a^2$ counts.
    const out = await buildHtmlExport("Use `$x$` for math like $a^2$.\n", { katexCss: fakeKatexCss });
    const matches = out.match(/class="katex"/g);
    expect(matches?.length).toBe(1);
    expect(out).toContain("$x$");
  });
});
