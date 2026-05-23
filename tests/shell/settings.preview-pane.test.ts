import { describe, it, expect, beforeEach, vi } from "vitest";

const storage: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: async <T>(key: string): Promise<T | undefined> => storage[key] as T | undefined,
  setValue: async <T>(key: string, value: T): Promise<void> => { storage[key] = value; },
}));

import {
  getPreviewPaneWidth,
  setPreviewPaneWidth,
} from "../../src/shell/settings";

describe("preview-pane settings", () => {
  beforeEach(() => {
    setPreviewPaneWidth(0.5);
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
