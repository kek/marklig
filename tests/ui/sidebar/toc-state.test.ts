import { describe, it, expect, beforeEach } from "vitest";

import {
  shouldShowSidebar,
  recordExplicitToggle,
  resetTocStorage,
} from "../../../src/ui/sidebar/toc-state";

beforeEach(() => {
  resetTocStorage();
});

describe("shouldShowSidebar", () => {
  it("is true for a doc with 3+ headings on first open", () => {
    expect(shouldShowSidebar("path/a.md", 3)).toBe(true);
    expect(shouldShowSidebar("path/b.md", 5)).toBe(true);
  });

  it("is false for a doc with fewer than 3 headings", () => {
    expect(shouldShowSidebar("path/a.md", 2)).toBe(false);
    expect(shouldShowSidebar("path/a.md", 0)).toBe(false);
  });

  it("after an explicit toggle, that choice wins for subsequent calls", () => {
    expect(shouldShowSidebar("path/a.md", 5)).toBe(true);
    recordExplicitToggle(false);
    expect(shouldShowSidebar("path/a.md", 5)).toBe(false);
    recordExplicitToggle(true);
    expect(shouldShowSidebar("path/a.md", 0)).toBe(true);
  });
});
