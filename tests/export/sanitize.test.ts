import { describe, it, expect } from "vitest";

import { sanitizeHtml, sanitizeSvg } from "../../src/export/sanitize";

describe("sanitizeHtml", () => {
  it("strips <script>", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
  });

  it("strips inline event handlers", () => {
    expect(sanitizeHtml('<a href="x" onclick="bad()">x</a>')).not.toContain("onclick");
  });

  it("strips javascript: urls", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("preserves harmless markdown-rendered HTML", () => {
    const html = "<h1>Title</h1><p><strong>bold</strong> and <em>italic</em></p>";
    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe("sanitizeSvg", () => {
  it("preserves harmless SVG markup", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain("<svg");
    expect(out).toContain("<rect");
  });

  it("strips <script> from SVG", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).not.toContain("<script");
    expect(out).toContain("<rect");
  });

  it("strips event handlers from SVG elements", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="bad()" width="10" height="10"/></svg>';
    expect(sanitizeSvg(svg)).not.toContain("onclick");
  });

  it("preserves <use xlink:href> for same-document glyph refs (typst)", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<defs><path id="g0" d="M0 0h1v1H0z"/></defs>' +
      '<use xlink:href="#g0"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain("<use");
    expect(out).toMatch(/(xlink:)?href="#g0"/);
  });

  it("strips javascript: URLs from href on <a> inside SVG (mermaid surface)", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<a href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>';
    expect(sanitizeSvg(svg)).not.toContain("javascript:");
  });

  it("strips javascript: URLs from xlink:href on <use>", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<use xlink:href="javascript:alert(1)"/></svg>';
    expect(sanitizeSvg(svg)).not.toContain("javascript:");
  });
});
