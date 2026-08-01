import { describe, it, expect } from "vitest";

import { decideExportRoute, saveAsExtension } from "../../src/export/route";

describe("decideExportRoute", () => {
  it("routes markdown through the markdown-it pipeline", () => {
    expect(decideExportRoute({ format: "markdown", typstRender: null }))
      .toEqual({ kind: "markdown" });
  });

  it("ignores any stray typst render when the document is markdown", () => {
    expect(
      decideExportRoute({
        format: "markdown",
        typstRender: { pages: ["<svg/>"], stale: false },
      }),
    ).toEqual({ kind: "markdown" });
  });

  it("routes typst at the compiled pages", () => {
    const pages = ["<svg id='p1'/>", "<svg id='p2'/>"];
    expect(decideExportRoute({ format: "typst", typstRender: { pages, stale: false } }))
      .toEqual({ kind: "typst", pages });
  });

  // The whole point of the function: a `.typ` must never fall through to the
  // Markdown pipeline, which is what silently exported Typst source as prose.
  it("blocks — never falls back to markdown — when typst has not compiled", () => {
    expect(decideExportRoute({ format: "typst", typstRender: null }))
      .toEqual({ kind: "blocked", reason: "typst-not-compiled" });
  });

  it("blocks when a typst compile produced no pages", () => {
    expect(
      decideExportRoute({ format: "typst", typstRender: { pages: [], stale: false } }),
    ).toEqual({ kind: "blocked", reason: "typst-not-compiled" });
  });

  it("blocks when the pages are a prior revision's (compile now failing)", () => {
    expect(
      decideExportRoute({
        format: "typst",
        typstRender: { pages: ["<svg/>"], stale: true },
      }),
    ).toEqual({ kind: "blocked", reason: "typst-stale" });
  });

  it("never returns markdown for a typst document, under any render state", () => {
    const states = [
      null,
      { pages: [], stale: false },
      { pages: [], stale: true },
      { pages: ["<svg/>"], stale: false },
      { pages: ["<svg/>"], stale: true },
    ];
    for (const typstRender of states) {
      expect(decideExportRoute({ format: "typst", typstRender }).kind)
        .not.toBe("markdown");
    }
  });
});

describe("saveAsExtension", () => {
  it("keeps a typst document typst", () => {
    expect(saveAsExtension("typst")).toBe("typ");
  });

  it("keeps a markdown document markdown", () => {
    expect(saveAsExtension("markdown")).toBe("md");
  });
});
