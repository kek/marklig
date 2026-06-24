import { describe, it, expect, beforeEach, vi } from "vitest";

const storage: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: async <T>(key: string): Promise<T | undefined> => storage[key] as T | undefined,
  setValue: async <T>(key: string, value: T): Promise<void> => { storage[key] = value; },
}));

import {
  loadAllFilePositions,
  getFilePosition,
  setFilePosition,
  clearFilePosition,
  clearAllFilePositions,
  lruTrim,
  planPositionRestore,
  FILE_POSITIONS_LIMIT,
  type FilePositionsMap,
  type FilePosition,
} from "../../src/shell/file-positions";

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
});

describe("file-positions persistence", () => {
  it("loads an empty map by default", async () => {
    expect(await loadAllFilePositions()).toEqual({});
    expect(await getFilePosition("/a.md")).toBeNull();
  });

  it("round-trips a position", async () => {
    await setFilePosition("/a.md", { scrollTop: 120, line: 7, col: 3 });
    const got = await getFilePosition("/a.md");
    expect(got).not.toBeNull();
    expect(got?.scrollTop).toBe(120);
    expect(got?.line).toBe(7);
    expect(got?.col).toBe(3);
    expect(typeof got?.ts).toBe("number");
  });

  it("overwriting updates ts and values", async () => {
    await setFilePosition("/a.md", { scrollTop: 1, line: 1, col: 0 });
    const t1 = (await getFilePosition("/a.md"))?.ts ?? 0;
    // Force a clock advance so ts strictly increases even on fast machines.
    await new Promise((r) => setTimeout(r, 2));
    await setFilePosition("/a.md", { scrollTop: 999, line: 42, col: 0 });
    const got = await getFilePosition("/a.md");
    expect(got?.scrollTop).toBe(999);
    expect(got?.line).toBe(42);
    expect((got?.ts ?? 0) >= t1).toBe(true);
  });

  it("clearFilePosition removes a single entry", async () => {
    await setFilePosition("/a.md", { scrollTop: 1, line: 1, col: 0 });
    await setFilePosition("/b.md", { scrollTop: 2, line: 1, col: 0 });
    await clearFilePosition("/a.md");
    expect(await getFilePosition("/a.md")).toBeNull();
    expect(await getFilePosition("/b.md")).not.toBeNull();
  });

  it("clearAllFilePositions empties the store", async () => {
    await setFilePosition("/a.md", { scrollTop: 1, line: 1, col: 0 });
    await clearAllFilePositions();
    expect(await loadAllFilePositions()).toEqual({});
  });
});

describe("lruTrim", () => {
  it("is a no-op when under the limit", () => {
    const map: FilePositionsMap = {
      "/a": { scrollTop: 0, line: 0, col: 0, ts: 1 },
      "/b": { scrollTop: 0, line: 0, col: 0, ts: 2 },
    };
    const out = lruTrim(map, 5);
    expect(Object.keys(out).sort()).toEqual(["/a", "/b"]);
  });

  it("drops smallest-ts entries until at limit", () => {
    const map: FilePositionsMap = {
      "/old1": { scrollTop: 0, line: 0, col: 0, ts: 1 },
      "/old2": { scrollTop: 0, line: 0, col: 0, ts: 2 },
      "/mid":  { scrollTop: 0, line: 0, col: 0, ts: 5 },
      "/new":  { scrollTop: 0, line: 0, col: 0, ts: 10 },
    };
    const out = lruTrim(map, 2);
    expect(Object.keys(out).sort()).toEqual(["/mid", "/new"]);
  });

  it("treats missing ts as oldest (evicts those first)", () => {
    const map: FilePositionsMap = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "/legacy": { scrollTop: 0, line: 0, col: 0 } as any,
      "/keep":   { scrollTop: 0, line: 0, col: 0, ts: 5 },
    };
    const out = lruTrim(map, 1);
    expect(Object.keys(out)).toEqual(["/keep"]);
  });
});

describe("setFilePosition LRU enforcement", () => {
  it("never persists more than FILE_POSITIONS_LIMIT entries", async () => {
    // Pre-populate the store with LIMIT entries with strictly increasing ts.
    const seed: FilePositionsMap = {};
    for (let i = 0; i < FILE_POSITIONS_LIMIT; i++) {
      seed[`/seed-${i}.md`] = { scrollTop: i, line: 1, col: 0, ts: 1000 + i };
    }
    storage["filePositions"] = seed;

    await setFilePosition("/new.md", { scrollTop: 42, line: 9, col: 0 });

    const all = await loadAllFilePositions();
    expect(Object.keys(all).length).toBe(FILE_POSITIONS_LIMIT);
    // The newest write wins.
    expect(all["/new.md"]).toBeDefined();
    // The oldest seeded entry is evicted.
    expect(all["/seed-0.md"]).toBeUndefined();
  });
});

describe("planPositionRestore", () => {
  const saved: FilePosition = { scrollTop: 480, line: 12, col: 4, ts: 1 };

  it("link-initiated open resets to the top with no cursor, ignoring saved position", () => {
    const plan = planPositionRestore(saved, { fromLink: true });
    expect(plan.target).toEqual({ scrollTop: 0, line: 1, col: 0 });
    expect(plan.restoreCursor).toBe(false);
  });

  it("link-initiated open resets to the top when there is no saved position", () => {
    const plan = planPositionRestore(null, { fromLink: true });
    expect(plan.target).toEqual({ scrollTop: 0, line: 1, col: 0 });
    expect(plan.restoreCursor).toBe(false);
  });

  it("non-link open restores the saved position and cursor", () => {
    const plan = planPositionRestore(saved, { fromLink: false });
    expect(plan.target).toEqual({ scrollTop: 480, line: 12, col: 4 });
    expect(plan.restoreCursor).toBe(true);
  });

  it("non-link open with no saved position resets to the top but keeps a cursor", () => {
    const plan = planPositionRestore(null, { fromLink: false });
    expect(plan.target).toEqual({ scrollTop: 0, line: 1, col: 0 });
    expect(plan.restoreCursor).toBe(true);
  });
});
