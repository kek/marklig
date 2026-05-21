import { describe, it, expect } from "vitest";
import {
  detectFormat,
  isSupportedExtension,
  supportedExtensions,
  type Format,
} from "../../src/format";

describe("format", () => {
  it("detects markdown for .md and variants", () => {
    expect(detectFormat("a.md")).toBe<Format>("markdown");
    expect(detectFormat("/abs/path/a.markdown")).toBe<Format>("markdown");
    expect(detectFormat("FILE.MD")).toBe<Format>("markdown");
    expect(detectFormat("a.mdx")).toBe<Format>("markdown");
    expect(detectFormat("a.mdown")).toBe<Format>("markdown");
  });

  it("detects typst for .typ", () => {
    expect(detectFormat("a.typ")).toBe<Format>("typst");
    expect(detectFormat("/abs/X.TYP")).toBe<Format>("typst");
  });

  it("defaults to markdown for null / unknown / no path", () => {
    expect(detectFormat(null)).toBe<Format>("markdown");
    expect(detectFormat("noext")).toBe<Format>("markdown");
    expect(detectFormat("a.txt")).toBe<Format>("markdown");
  });

  it("isSupportedExtension covers md + typ variants", () => {
    for (const p of ["a.md", "a.markdown", "a.mdx", "a.mdown", "a.typ"]) {
      expect(isSupportedExtension(p)).toBe(true);
    }
    expect(isSupportedExtension("a.txt")).toBe(false);
    expect(isSupportedExtension("a.pdf")).toBe(false);
  });

  it("supportedExtensions returns the full list", () => {
    expect(supportedExtensions()).toEqual(
      expect.arrayContaining(["md", "markdown", "mdx", "mdown", "typ"]),
    );
  });
});
