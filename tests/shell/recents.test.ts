import { describe, it, expect, beforeEach, vi } from "vitest";

const storage: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: async <T>(key: string): Promise<T | undefined> => storage[key] as T | undefined,
  setValue: async <T>(key: string, value: T): Promise<void> => { storage[key] = value; },
}));

import {
  recordRecent,
  loadRecents,
  clearRecents,
  RECENTS_LIMIT,
} from "../../src/shell/recents";

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
});

describe("recents", () => {
  it("starts empty", async () => {
    expect(await loadRecents()).toEqual([]);
  });

  it("records most-recent first", async () => {
    await recordRecent("/a.md");
    await recordRecent("/b.md");
    await recordRecent("/c.md");
    expect(await loadRecents()).toEqual(["/c.md", "/b.md", "/a.md"]);
  });

  it("dedupes — re-recording moves to front", async () => {
    await recordRecent("/a.md");
    await recordRecent("/b.md");
    await recordRecent("/a.md");
    expect(await loadRecents()).toEqual(["/a.md", "/b.md"]);
  });

  it(`caps at RECENTS_LIMIT (${10})`, async () => {
    for (let i = 0; i < 15; i++) await recordRecent(`/${i}.md`);
    const r = await loadRecents();
    expect(r.length).toBe(RECENTS_LIMIT);
    expect(r[0]).toBe("/14.md");
  });

  it("clearRecents empties the list", async () => {
    await recordRecent("/a.md");
    await clearRecents();
    expect(await loadRecents()).toEqual([]);
  });
});
