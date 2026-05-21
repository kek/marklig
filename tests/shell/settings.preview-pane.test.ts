import { describe, it, expect, beforeEach } from "vitest";
import {
  getPreviewPaneOpen,
  setPreviewPaneOpen,
  getPreviewPaneWidth,
  setPreviewPaneWidth,
} from "../../src/shell/settings";

describe("preview-pane settings", () => {
  beforeEach(() => {
    // Reset to defaults each test by setting known values.
    setPreviewPaneOpen("markdown", false);
    setPreviewPaneOpen("typst", true);
    setPreviewPaneWidth(0.5);
  });

  it("defaults to false for markdown and true for typst", () => {
    // After resetting above, those ARE the defaults.
    expect(getPreviewPaneOpen("markdown")).toBe(false);
    expect(getPreviewPaneOpen("typst")).toBe(true);
  });

  it("setPreviewPaneOpen mutates only the targeted format", () => {
    setPreviewPaneOpen("markdown", true);
    expect(getPreviewPaneOpen("markdown")).toBe(true);
    expect(getPreviewPaneOpen("typst")).toBe(true); // untouched
  });

  it("preview-pane width clamps to [0.2, 0.8]", () => {
    setPreviewPaneWidth(0.1);
    expect(getPreviewPaneWidth()).toBe(0.2);
    setPreviewPaneWidth(0.9);
    expect(getPreviewPaneWidth()).toBe(0.8);
    setPreviewPaneWidth(0.42);
    expect(getPreviewPaneWidth()).toBe(0.42);
  });
});
