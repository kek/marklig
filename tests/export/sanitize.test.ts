import { describe, it, expect } from "vitest";

import { sanitizeHtml } from "../../src/export/sanitize";

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
