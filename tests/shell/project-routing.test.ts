import { describe, expect, it } from "vitest";

import {
  decideProjectRoute,
  dedupeSessionByFolder,
  deepestContainingFolder,
} from "../../src/shell/project-routing";
import type { WindowSessionEntry } from "../../src/shell/window-session";

function entry(p: Partial<WindowSessionEntry>): WindowSessionEntry {
  return {
    label: "main",
    path: null,
    x: 0,
    y: 0,
    width: 1000,
    height: 760,
    scrollTop: 0,
    mode: "reading",
    folder: null,
    timestampMs: 0,
    ...p,
  };
}

describe("decideProjectRoute", () => {
  it("focuses another window that already owns the target folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/b",
      folderByLabel: new Map([
        ["main", "/proj/b"],
        ["window-2", "/proj/a"],
      ]),
    });
    expect(route).toEqual({ kind: "focus", label: "window-2" });
  });

  it("focuses the requesting window when it already owns the target", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/a",
      folderByLabel: new Map([["main", "/proj/a"]]),
    });
    expect(route).toEqual({ kind: "focus", label: "main" });
  });

  it("focuses the owning window regardless of which window requested (issue #137)", () => {
    // `md .` for folder A while folder B's window (or another app) is
    // frontmost: the request arrives at main (the requester), but the
    // owning window is window-2. The decision must name the *owner*, not
    // the requester — the router then raises that window.
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/b",
      folderByLabel: new Map([
        ["main", "/proj/b"],
        ["window-2", "/proj/a"],
        ["window-3", "/proj/c"],
      ]),
    });
    expect(route).toEqual({ kind: "focus", label: "window-2" });
  });

  it("adopts when the target is unowned and the requesting window has no folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: null,
      folderByLabel: new Map([["main", null]]),
    });
    expect(route).toEqual({ kind: "adopt" });
  });

  it("spawns when the target is unowned and the requesting window owns a different folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/b",
      folderByLabel: new Map([["main", "/proj/b"]]),
    });
    expect(route).toEqual({ kind: "spawn" });
  });

  it("adopts into an empty map when the requesting window has no folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: null,
      folderByLabel: new Map(),
    });
    expect(route).toEqual({ kind: "adopt" });
  });
});

describe("deepestContainingFolder", () => {
  it("matches a window rooted exactly at the file's folder", () => {
    const out = deepestContainingFolder({
      file: "/proj/docs/x.md",
      folderByLabel: new Map([["main", "/proj/docs"]]),
    });
    expect(out).toEqual({ label: "main", folder: "/proj/docs" });
  });

  it("matches a window whose tree contains the file in a subfolder", () => {
    // Window rooted at /proj contains /proj/docs/x.md even though the file
    // lives two segments deeper.
    const out = deepestContainingFolder({
      file: "/proj/docs/x.md",
      folderByLabel: new Map([["main", "/proj"]]),
    });
    expect(out).toEqual({ label: "main", folder: "/proj" });
  });

  it("picks the deepest (most specific) window when several contain the file", () => {
    const out = deepestContainingFolder({
      file: "/proj/docs/x.md",
      folderByLabel: new Map([
        ["main", "/proj"],
        ["window-2", "/proj/docs"],
        ["window-3", "/other"],
      ]),
    });
    expect(out).toEqual({ label: "window-2", folder: "/proj/docs" });
  });

  it("picks the deepest regardless of map insertion order", () => {
    const out = deepestContainingFolder({
      file: "/a/b/c/file.md",
      folderByLabel: new Map([
        ["window-2", "/a/b/c"],
        ["main", "/a"],
        ["window-3", "/a/b"],
      ]),
    });
    expect(out).toEqual({ label: "window-2", folder: "/a/b/c" });
  });

  it("does not treat /proj/docs as containing /proj/docs-old/x.md (boundary)", () => {
    const out = deepestContainingFolder({
      file: "/proj/docs-old/x.md",
      folderByLabel: new Map([["main", "/proj/docs"]]),
    });
    expect(out).toBeNull();
  });

  it("returns null when no open window's tree contains the file", () => {
    const out = deepestContainingFolder({
      file: "/elsewhere/y.md",
      folderByLabel: new Map([
        ["main", "/proj"],
        ["window-2", "/proj/docs"],
      ]),
    });
    expect(out).toBeNull();
  });

  it("returns null for an empty map (signals spawn)", () => {
    const out = deepestContainingFolder({
      file: "/proj/x.md",
      folderByLabel: new Map(),
    });
    expect(out).toBeNull();
  });

  it("ignores blank (null-folder) windows", () => {
    const out = deepestContainingFolder({
      file: "/proj/x.md",
      folderByLabel: new Map([
        ["main", null],
        ["window-2", "/proj"],
      ]),
    });
    expect(out).toEqual({ label: "window-2", folder: "/proj" });
  });

  it("returns null when only blank windows are open", () => {
    const out = deepestContainingFolder({
      file: "/proj/x.md",
      folderByLabel: new Map([["main", null]]),
    });
    expect(out).toBeNull();
  });

  it("tolerates a trailing slash on the folder root", () => {
    const out = deepestContainingFolder({
      file: "/proj/docs/x.md",
      folderByLabel: new Map([["main", "/proj/docs/"]]),
    });
    expect(out).toEqual({ label: "main", folder: "/proj/docs/" });
  });

  it("does not match when the folder is deeper than the file", () => {
    const out = deepestContainingFolder({
      file: "/proj/x.md",
      folderByLabel: new Map([["main", "/proj/docs"]]),
    });
    expect(out).toBeNull();
  });
});

describe("dedupeSessionByFolder", () => {
  it("keeps the newest entry when two windows share a folder", () => {
    const older = entry({ label: "window-2", folder: "/proj/a", timestampMs: 100 });
    const newer = entry({ label: "main", folder: "/proj/a", timestampMs: 200 });
    const out = dedupeSessionByFolder([older, newer]);
    expect(out).toEqual([newer]);
  });

  it("leaves entries with distinct folders untouched", () => {
    const a = entry({ label: "main", folder: "/proj/a", timestampMs: 1 });
    const b = entry({ label: "window-2", folder: "/proj/b", timestampMs: 2 });
    const out = dedupeSessionByFolder([a, b]);
    expect(out).toEqual([a, b]);
  });

  it("never dedupes blank (null-folder) windows against each other", () => {
    const a = entry({ label: "main", folder: null, timestampMs: 1 });
    const b = entry({ label: "window-2", folder: null, timestampMs: 2 });
    const out = dedupeSessionByFolder([a, b]);
    expect(out).toHaveLength(2);
  });

  it("preserves input order of the surviving entries", () => {
    const a = entry({ label: "main", folder: "/proj/a", timestampMs: 1 });
    const b = entry({ label: "window-2", folder: null, timestampMs: 2 });
    const c = entry({ label: "window-3", folder: "/proj/c", timestampMs: 3 });
    const out = dedupeSessionByFolder([a, b, c]);
    expect(out).toEqual([a, b, c]);
  });

  it("treats a missing folder field the same as null (legacy entry)", () => {
    const a = entry({ label: "main", folder: undefined });
    const b = entry({ label: "window-2", folder: undefined });
    const out = dedupeSessionByFolder([a, b]);
    expect(out).toHaveLength(2);
  });
});
