import { describe, expect, it } from "vitest";

import { decideProjectRoute, dedupeSessionByFolder } from "../../src/shell/project-routing";
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
