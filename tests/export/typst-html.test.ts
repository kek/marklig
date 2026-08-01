import { describe, it, expect } from "vitest";

import {
  buildTypstHtmlExport,
  pageSizePt,
  typstExportStylesheet,
} from "../../src/export/typst-html";

// A4 as typst_svg 0.14 actually spells it — captured from a real
// `typst_svg::svg(page)` call, not invented: full-precision points in the
// viewBox and a `pt`-suffixed width/height, plus the `typst-doc` class.
const A4_HEADER =
  `<svg class="typst-doc" viewBox="0 0 595.2755905511812 841.8897637795276"` +
  ` width="595.2755905511812pt" height="841.8897637795276pt"` +
  ` xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`;

function page(inner: string): string {
  return `${A4_HEADER}${inner}</svg>`;
}

describe("pageSizePt", () => {
  it("reads the page box out of a real typst_svg viewBox", () => {
    const size = pageSizePt(page(""));
    expect(size.width).toBeCloseTo(595.2755905511812, 6);
    expect(size.height).toBeCloseTo(841.8897637795276, 6);
  });

  it("handles a comma-separated viewBox", () => {
    expect(pageSizePt(`<svg viewBox="0,0,100,200"></svg>`))
      .toEqual({ width: 100, height: 200 });
  });

  it("falls back to A4 when the viewBox is missing or unusable", () => {
    for (const svg of [
      `<svg></svg>`,
      `<svg viewBox=""></svg>`,
      `<svg viewBox="0 0 nope 200"></svg>`,
      `<svg viewBox="0 0 100"></svg>`,
      `<svg viewBox="0 0 0 200"></svg>`,
    ]) {
      expect(pageSizePt(svg).width).toBeCloseTo(595.2755905511812, 6);
    }
  });
});

describe("typstExportStylesheet", () => {
  it("sets @page to the document's own box with no added margin", () => {
    const css = typstExportStylesheet({ width: 595.2755905511812, height: 841.8897637795276 });
    expect(css).toContain("@page { size: 595.28pt 841.89pt; margin: 0; }");
  });

  it("breaks after every page but the last", () => {
    const css = typstExportStylesheet({ width: 100, height: 200 });
    expect(css).toContain("break-after: page");
    expect(css).toContain(".typst-page:last-child { break-after: auto");
  });
});

describe("buildTypstHtmlExport", () => {
  it("emits one .typst-page wrapper per compiled page, in order", () => {
    const html = buildTypstHtmlExport([
      page(`<text id="first">One</text>`),
      page(`<text id="second">Two</text>`),
    ]);
    expect(html.match(/class="typst-page"/g)).toHaveLength(2);
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
  });

  it("escapes the title into <title>", () => {
    const html = buildTypstHtmlExport([page("")], { title: `a<b>"c` });
    expect(html).toContain(`<title>a&lt;b&gt;&quot;c</title>`);
    expect(buildTypstHtmlExport([page("")])).toContain("<title>Typst export</title>");
  });

  it("is a complete self-contained document with no external references", () => {
    const html = buildTypstHtmlExport([page("")]);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
  });

  it("produces a document even with no pages (page size falls back)", () => {
    const html = buildTypstHtmlExport([]);
    expect(html).toContain("@page { size: 595.28pt 841.89pt");
    // The stylesheet still mentions the class; the body carries no page div.
    expect(html).not.toContain(`class="typst-page"`);
    expect(html).not.toContain("<svg");
  });

  // The chosen sanitization policy: unlike the Mermaid export path in
  // src/export/html.ts, which injects raw because DOMPurify strips its
  // <foreignObject> HTML labels, typst pages go through `sanitizeSvg` — the
  // same treatment the preview pane gives them. These cases pin that the
  // policy costs nothing, i.e. that everything typst_svg emits survives.
  describe("sanitization preserves what typst_svg emits", () => {
    it("keeps glyph <symbol> definitions and their <use xlink:href> refs", () => {
      const html = buildTypstHtmlExport([
        page(
          `<defs><symbol id="gAB" overflow="visible"><path d="M1 2 L3 4 Z"/></symbol></defs>` +
            `<use xlink:href="#gAB" x="0" y="0" fill="#000"/>`,
        ),
      ]);
      expect(html).toContain("<symbol");
      expect(html).toContain(`id="gAB"`);
      expect(html).toContain(`xlink:href="#gAB"`);
    });

    it("keeps embedded raster images on both xlink:href and href", () => {
      const dataUri =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
      const html = buildTypstHtmlExport([
        page(
          `<image x="5" y="5" width="40" height="40" xlink:href="${dataUri}"/>` +
            `<image x="50" y="5" width="40" height="40" href="${dataUri}"/>`,
        ),
      ]);
      expect(html.match(/<image/g)).toHaveLength(2);
      expect(html.match(/data:image\/png/g)).toHaveLength(2);
    });

    it("keeps clip paths, transforms and text attributes", () => {
      const html = buildTypstHtmlExport([
        page(
          `<defs><clipPath id="c1"><rect x="0" y="0" width="10" height="10"/></clipPath></defs>` +
            `<g clip-path="url(#c1)" transform="translate(10 20)">` +
            `<text x="2" y="2" font-family="serif" font-size="11">Hi</text></g>`,
        ),
      ]);
      expect(html).toContain("clipPath");
      expect(html).toContain(`clip-path="url(#c1)"`);
      expect(html).toContain(`transform="translate(10 20)"`);
      expect(html).toContain(`font-family="serif"`);
    });

    it("keeps the intrinsic pt dimensions and the viewBox", () => {
      const html = buildTypstHtmlExport([page("")]);
      expect(html).toContain(`width="595.2755905511812pt"`);
      expect(html).toContain(`viewBox="0 0 595.2755905511812 841.8897637795276"`);
    });

    it("still strips script and event handlers", () => {
      const html = buildTypstHtmlExport([
        page(`<script>alert(1)</script><rect onload="alert(2)" width="1" height="1"/>`),
      ]);
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("onload");
    });

    it("blocks a javascript: link inside a page", () => {
      const html = buildTypstHtmlExport([
        // eslint-disable-next-line no-script-url
        page(`<a xlink:href="javascript:alert(1)"><text x="1" y="1">x</text></a>`),
      ]);
      expect(html).not.toContain("javascript:");
    });
  });

  // The regression this whole change exists for: the compiled-pages export must
  // contain no trace of the markdown-it pipeline having seen the Typst source.
  it("contains no markdown-it rendering of the typst source", () => {
    const html = buildTypstHtmlExport([page(`<text>Sample Typst document</text>`)], {
      title: "sample",
    });
    expect(html).not.toContain("<p>= ");
    expect(html).not.toContain("#set page");
    expect(html).not.toContain("Markdown export");
  });
});
