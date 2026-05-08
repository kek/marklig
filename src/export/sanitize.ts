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
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    FORBID_TAGS: ["script"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  });
}
