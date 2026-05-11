import { describe, it, expect } from "vitest";

import { filterProjects, splitPath } from "../../src/ui/project-palette";

describe("splitPath", () => {
  it("splits a POSIX path into basename and parent", () => {
    expect(splitPath("/Users/ke/src/viewer")).toEqual({
      base: "viewer",
      parent: "/Users/ke/src",
    });
  });

  it("splits a Windows-style path", () => {
    expect(splitPath("C:\\Users\\ke\\src\\viewer")).toEqual({
      base: "viewer",
      parent: "C:\\Users\\ke\\src",
    });
  });

  it("treats a bare name as basename only", () => {
    expect(splitPath("viewer")).toEqual({ base: "viewer", parent: "" });
  });
});

describe("filterProjects", () => {
  const paths = [
    "/Users/ke/src/viewer",
    "/Users/ke/src/notes",
    "/Users/ke/work/dashboard",
    "/Users/ke/work/viewer-archive",
    "/var/log/viewer-tmp",
  ];

  it("returns every entry in input order for an empty query", () => {
    const result = filterProjects(paths, "");
    expect(result.map((m) => m.path)).toEqual(paths);
    // Empty query keeps recency order verbatim.
    expect(result.map((m) => m.recencyIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("filters case-insensitively on substring", () => {
    const result = filterProjects(paths, "VIEW");
    expect(result.map((m) => m.path)).toEqual([
      "/Users/ke/src/viewer",
      "/Users/ke/work/viewer-archive",
      "/var/log/viewer-tmp",
    ]);
  });

  it("ranks basename matches above parent-only matches", () => {
    // 'work' only appears in parent dirs for the matching entries.
    const result = filterProjects(
      [
        "/Users/ke/work/alpha",
        "/Users/ke/projects/work-thing",
        "/Users/ke/work/beta",
      ],
      "work",
    );
    // 'work-thing' (basename hit) should beat the two parent-only hits.
    expect(result.map((m) => m.path)).toEqual([
      "/Users/ke/projects/work-thing",
      "/Users/ke/work/alpha",
      "/Users/ke/work/beta",
    ]);
  });

  it("breaks ties by recency (input order)", () => {
    const result = filterProjects(paths, "viewer");
    // All three contain 'viewer' in the basename → tie on rank;
    // recency-ordered input order wins.
    expect(result.map((m) => m.path)).toEqual([
      "/Users/ke/src/viewer",
      "/Users/ke/work/viewer-archive",
      "/var/log/viewer-tmp",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterProjects(paths, "no-such-thing")).toEqual([]);
  });

  it("trims surrounding whitespace from the query", () => {
    const result = filterProjects(paths, "   notes   ");
    expect(result.map((m) => m.path)).toEqual(["/Users/ke/src/notes"]);
  });

  it("treats a whitespace-only query as empty", () => {
    const result = filterProjects(paths, "   ");
    expect(result.map((m) => m.path)).toEqual(paths);
  });
});
