import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the underlying store with a per-test reset so each test starts clean.
vi.mock("../../src/shell/store", () => {
  let state: Record<string, unknown> = {};
  return {
    getValue: vi.fn(async (k: string) => state[k]),
    setValue: vi.fn(async (k: string, v: unknown) => {
      state[k] = v;
    }),
    __reset: () => {
      state = {};
    },
  };
});

import {
  loadRecents,
  recordRecent,
  clearRecents,
  uriDisplayName,
} from "../../src/shell/mobile-recents";
import * as store from "../../src/shell/store";

describe("mobile-recents", () => {
  beforeEach(() => {
    (store as unknown as { __reset: () => void }).__reset();
  });

  it("starts empty", async () => {
    expect(await loadRecents()).toEqual([]);
  });

  it("records and reads back", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    const list = await loadRecents();
    expect(list).toHaveLength(1);
    expect(list[0].uri).toBe("content://a");
    expect(list[0].displayName).toBe("a.md");
    expect(typeof list[0].lastOpenedMs).toBe("number");
  });

  it("dedupes by URI, freshest first", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    await recordRecent({ uri: "content://b", displayName: "b.md" });
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    const list = await loadRecents();
    expect(list.map((r) => r.uri)).toEqual(["content://a", "content://b"]);
  });

  it("caps at MAX=20 entries", async () => {
    for (let i = 0; i < 30; i++) {
      await recordRecent({
        uri: `content://${i}`,
        displayName: `${i}.md`,
      });
    }
    const list = await loadRecents();
    expect(list).toHaveLength(20);
    expect(list[0].uri).toBe("content://29");
    expect(list[list.length - 1].uri).toBe("content://10");
  });

  it("clears", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    await clearRecents();
    expect(await loadRecents()).toEqual([]);
  });

  it("filters malformed entries on load (forward-compat against schema drift)", async () => {
    const storeMock = store as unknown as {
      __reset: () => void;
      setValue: (key: string, value: unknown) => Promise<void>;
    };
    await storeMock.setValue("mobile.recents", [
      { uri: "good", displayName: "ok.md", lastOpenedMs: 1 },
      { uri: 42, displayName: "bad", lastOpenedMs: 1 },
      null,
      "garbage",
    ]);
    const list = await loadRecents();
    expect(list).toHaveLength(1);
    expect(list[0].uri).toBe("good");
  });
});

describe("uriDisplayName", () => {
  it("extracts filename from a content URI with encoded filename", () => {
    expect(
      uriDisplayName("content://media/external/file/123/My%20Doc.md"),
    ).toBe("My Doc.md");
  });
  it("extracts filename from a file URI", () => {
    expect(uriDisplayName("file:///sdcard/Download/foo.md")).toBe("foo.md");
  });
  it("falls back to the raw URI when no slash", () => {
    expect(uriDisplayName("opaque")).toBe("opaque");
  });
  it("survives malformed percent-encoding", () => {
    expect(uriDisplayName("content://broken/%E0")).toBe("content://broken/%E0");
  });
});
