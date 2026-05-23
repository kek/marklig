import DOMPurify from "dompurify";

// In the Tauri webview the global `window` exists; DOMPurify auto-binds to it
// when used as a default-imported namespace (no factory call needed). In Node
// tests the test setup (tests/setup.ts) installs a JSDOM-backed `window` on
// `globalThis` before any module imports run, so the same path works there.
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  });
}

// Mermaid output is SVG (occasionally with foreignObject for HTML labels).
// Default DOMPurify config drops most SVG attributes; svg+svgFilters profiles
// keep the markup intact while still stripping <script>/event handlers.
//
// Why each non-default add is here:
//   - <use> + xlink:href: typst-svg renders glyphs via <use xlink:href="#g..."/>
//     referencing definitions in a <defs> block. Without this the glyphs
//     disappear and compiled pages are blank.
//   - href: mermaid emits clickable <a href="..."> inside diagrams. The html
//     profile permits <a>, but href on it still needs explicit allow.
//
// Both attributes go through DOMPurify's URL allow-list, which blocks
// javascript: and data: schemes — exercised by the test suite so a future
// DOMPurify upgrade that changes defaults gets caught.
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["use"],
    ADD_ATTR: ["xlink:href", "href"],
    FORBID_TAGS: ["script"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  });
}
