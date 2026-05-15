import { describe, it, expect } from "vitest";

import { basename, splitPath } from "../../src/shell/path-label";

// Issue #69: the Projects menu was sometimes rendering blank entries because
// `path.slice(lastIndexOf("/") + 1)` returns "" whenever the path ends with
// a separator. These tests pin the defensive fallback so that regression
// can't sneak back in.

describe("basename", () => {
  it("returns the last segment of a POSIX path", () => {
    expect(basename("/Users/ke/src/viewer")).toBe("viewer");
  });

  it("returns the last segment of a Windows path", () => {
    expect(basename("C:\\Users\\ke\\src\\viewer")).toBe("viewer");
  });

  it("strips a trailing POSIX separator before taking the last segment", () => {
    // The original bug: trailing slash made the menu label empty.
    expect(basename("/Users/ke/src/viewer/")).toBe("viewer");
  });

  it("strips multiple trailing POSIX separators", () => {
    expect(basename("/Users/ke/src/viewer///")).toBe("viewer");
  });

  it("strips a trailing Windows separator", () => {
    expect(basename("C:\\Users\\ke\\src\\viewer\\")).toBe("viewer");
  });

  it("falls back to the original for the POSIX root path", () => {
    // `/` is pure separators — never let the user see a blank menu line.
    expect(basename("/")).toBe("/");
  });

  it("falls back to the original for a Windows backslash-only path", () => {
    expect(basename("\\")).toBe("\\");
  });

  it("returns a bare name unchanged", () => {
    expect(basename("viewer")).toBe("viewer");
  });

  it("returns a dotfile-only segment unchanged", () => {
    expect(basename("/Users/ke/.config")).toBe(".config");
  });

  it("preserves non-ASCII / Swedish characters", () => {
    expect(basename("/Users/ke/Skrivbord/Räksmörgås")).toBe("Räksmörgås");
  });

  it("returns the empty string for empty input", () => {
    // Defensive: empty in, empty out — caller is responsible for filtering.
    expect(basename("")).toBe("");
  });
});

describe("splitPath", () => {
  it("splits a POSIX path", () => {
    expect(splitPath("/Users/ke/src/viewer")).toEqual({
      base: "viewer",
      parent: "/Users/ke/src",
    });
  });

  it("splits a Windows path", () => {
    expect(splitPath("C:\\Users\\ke\\src\\viewer")).toEqual({
      base: "viewer",
      parent: "C:\\Users\\ke\\src",
    });
  });

  it("strips a trailing separator before splitting", () => {
    expect(splitPath("/Users/ke/src/viewer/")).toEqual({
      base: "viewer",
      parent: "/Users/ke/src",
    });
  });

  it("falls back to the original for the POSIX root", () => {
    expect(splitPath("/")).toEqual({ base: "/", parent: "" });
  });

  it("treats a bare name as basename only", () => {
    expect(splitPath("viewer")).toEqual({ base: "viewer", parent: "" });
  });
});
