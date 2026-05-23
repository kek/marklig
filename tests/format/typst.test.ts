import { describe, it, expect } from "vitest";
import { typstFormat } from "../../src/format/typst";

describe("typstFormat", () => {
  it("exposes editing+reading producers (empty by default — highlighting comes from lang)", () => {
    expect(typstFormat.editingProducers).toEqual([]);
    expect(typstFormat.readingProducers).toEqual([]);
  });

  it("exposes the language extension", () => {
    expect(typstFormat.languageExtension).toBeDefined();
  });
});
