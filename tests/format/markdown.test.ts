import { describe, it, expect } from "vitest";
import { markdownFormat } from "../../src/format/markdown";

describe("markdownFormat", () => {
  it("exposes editing producers and reading producers", () => {
    expect(markdownFormat.editingProducers.length).toBeGreaterThan(0);
    expect(markdownFormat.readingProducers.length).toBeGreaterThan(
      markdownFormat.editingProducers.length,
    );
  });
});
