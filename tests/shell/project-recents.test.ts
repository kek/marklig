import { describe, it, expect, beforeEach, vi } from "vitest";

const storage = new Map<string, unknown>();

vi.mock("../../src/shell/store", () => ({
  getValue: async <T>(key: string): Promise<T | undefined> =>
    storage.get(key) as T | undefined,
  setValue: async <T>(key: string, value: T): Promise<void> => {
    storage.set(key, value);
  },
  deleteValue: async (key: string): Promise<void> => {
    storage.delete(key);
  },
}));

// canonicalizePath in `file-positions.ts` dynamically imports
// @tauri-apps/api/path, which throws in jsdom. The catch in canonicalizePath
// falls back to returning the input verbatim, so the map keys are the raw
// path strings — which is fine for tests that pass in already-canonical paths.

import {
  recordFileInProject,
  getLastFileInProject,
  forgetFileInProject,
  clearProjectRecents,
  PROJECT_RECENTS_LIMIT,
} from "../../src/shell/project-recents";

beforeEach(() => {
  storage.clear();
});

describe("project-recents", () => {
  it("starts empty", async () => {
    expect(await getLastFileInProject("/Users/me/proj")).toBeNull();
  });

  it("records and retrieves the last file in a project", async () => {
    await recordFileInProject("/Users/me/proj", "/Users/me/proj/foo.md");
    expect(await getLastFileInProject("/Users/me/proj")).toBe(
      "/Users/me/proj/foo.md",
    );
  });

  it("keeps separate entries per project", async () => {
    await recordFileInProject("/Users/me/p", "/Users/me/p/a.md");
    await recordFileInProject("/Users/me/q", "/Users/me/q/b.md");
    expect(await getLastFileInProject("/Users/me/p")).toBe("/Users/me/p/a.md");
    expect(await getLastFileInProject("/Users/me/q")).toBe("/Users/me/q/b.md");
  });

  it("overwrites the last file when re-recorded in the same project", async () => {
    await recordFileInProject("/Users/me/proj", "/Users/me/proj/a.md");
    await recordFileInProject("/Users/me/proj", "/Users/me/proj/b.md");
    expect(await getLastFileInProject("/Users/me/proj")).toBe(
      "/Users/me/proj/b.md",
    );
  });

  it("forgetFileInProject drops the project entry", async () => {
    await recordFileInProject("/Users/me/p", "/Users/me/p/a.md");
    await forgetFileInProject("/Users/me/p");
    expect(await getLastFileInProject("/Users/me/p")).toBeNull();
  });

  it("forgetFileInProject is a no-op for an unknown root", async () => {
    await forgetFileInProject("/Users/me/ghost");
    expect(await getLastFileInProject("/Users/me/ghost")).toBeNull();
  });

  it("clearProjectRecents empties the map", async () => {
    await recordFileInProject("/Users/me/p", "/Users/me/p/a.md");
    await recordFileInProject("/Users/me/q", "/Users/me/q/b.md");
    await clearProjectRecents();
    expect(await getLastFileInProject("/Users/me/p")).toBeNull();
    expect(await getLastFileInProject("/Users/me/q")).toBeNull();
  });

  it("ignores empty / falsy root or file inputs", async () => {
    await recordFileInProject("", "/foo.md");
    await recordFileInProject("/p", "");
    expect(storage.get("projectRecents")).toBeUndefined();
    expect(await getLastFileInProject("")).toBeNull();
  });

  it("LRU-evicts entries past the limit, oldest first", async () => {
    // Spread timestamps so the eviction order is deterministic. Date.now()
    // would tick within a single millisecond for tight loops.
    let t = 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    for (let i = 0; i < PROJECT_RECENTS_LIMIT + 5; i++) {
      t = 1000 + i;
      await recordFileInProject(`/proj/${i}`, `/proj/${i}/file.md`);
    }
    nowSpy.mockRestore();

    const stored = storage.get("projectRecents") as Record<string, unknown>;
    expect(Object.keys(stored).length).toBe(PROJECT_RECENTS_LIMIT);
    // First 5 should have been evicted as the oldest.
    for (let i = 0; i < 5; i++) {
      expect(stored[`/proj/${i}`]).toBeUndefined();
    }
    // The newer half should still be there.
    expect(stored[`/proj/${PROJECT_RECENTS_LIMIT + 4}`]).toBeDefined();
  });

  it("survives a malformed stored value (drops it silently)", async () => {
    storage.set("projectRecents", "not an object");
    expect(await getLastFileInProject("/p")).toBeNull();
    // Subsequent writes start fresh.
    await recordFileInProject("/p", "/p/a.md");
    expect(await getLastFileInProject("/p")).toBe("/p/a.md");
  });

  it("survives malformed entries on read (drops just the bad ones)", async () => {
    storage.set("projectRecents", {
      "/good": { path: "/good/a.md", ts: 1 },
      "/bad-ts": { path: "/bad-ts/a.md", ts: "no" },
      "/bad-path": { path: 42, ts: 1 },
      "/null": null,
    });
    expect(await getLastFileInProject("/good")).toBe("/good/a.md");
    expect(await getLastFileInProject("/bad-ts")).toBeNull();
    expect(await getLastFileInProject("/bad-path")).toBeNull();
    expect(await getLastFileInProject("/null")).toBeNull();
  });
});
