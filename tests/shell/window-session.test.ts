import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri APIs that aren't available in jsdom. The mocked window reports
// an arbitrary label/size/position; tests for recordCurrentWindowState verify
// it's correctly normalised to logical pixels via scaleFactor.
const mockWin = {
  label: "main",
  outerSize: vi.fn().mockResolvedValue({ width: 2000, height: 1520 }),
  outerPosition: vi.fn().mockResolvedValue({ x: 100, y: 200 }),
  scaleFactor: vi.fn().mockResolvedValue(2),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockWin,
}));

const storeData = new Map<string, unknown>();

vi.mock("../../src/shell/store", () => ({
  getValue: vi.fn(async (k: string) => storeData.get(k)),
  setValue: vi.fn(async (k: string, v: unknown) => {
    storeData.set(k, v);
  }),
  deleteValue: vi.fn(async (k: string) => {
    storeData.delete(k);
  }),
  listKeys: vi.fn(async () => Array.from(storeData.keys())),
}));

import {
  upsertEntry,
  removeEntry,
  loadWindowSession,
  saveWindowSession,
  clearWindowSession,
  recordCurrentWindowState,
  type WindowSessionEntry,
} from "../../src/shell/window-session";

function entry(label: string, overrides: Partial<WindowSessionEntry> = {}): WindowSessionEntry {
  return {
    label,
    path: `/tmp/${label}.md`,
    x: 0,
    y: 0,
    width: 1000,
    height: 760,
    scrollTop: 0,
    mode: "reading",
    timestampMs: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  storeData.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  // Reset label between tests; defaults to "main"
  mockWin.label = "main";
});

describe("upsertEntry", () => {
  it("appends a new entry when none with that label exists", () => {
    const session = { windows: [entry("main")] };
    const next = upsertEntry(session, entry("window-2"));
    expect(next.windows.map((w) => w.label)).toEqual(["main", "window-2"]);
  });

  it("replaces an existing entry by label", () => {
    const session = { windows: [entry("main", { scrollTop: 100 })] };
    const next = upsertEntry(session, entry("main", { scrollTop: 999 }));
    expect(next.windows).toHaveLength(1);
    expect(next.windows[0].scrollTop).toBe(999);
  });
});

describe("removeEntry", () => {
  it("removes the entry with the given label", () => {
    const session = { windows: [entry("main"), entry("window-2")] };
    const next = removeEntry(session, "main");
    expect(next.windows.map((w) => w.label)).toEqual(["window-2"]);
  });

  it("returns the same shape when no match", () => {
    const session = { windows: [entry("main")] };
    const next = removeEntry(session, "ghost");
    expect(next.windows).toHaveLength(1);
  });
});

describe("loadWindowSession", () => {
  it("returns an empty session when nothing is stored", async () => {
    const s = await loadWindowSession();
    expect(s.windows).toEqual([]);
  });

  it("returns the persisted session", async () => {
    storeData.set("windowSession", { windows: [entry("main")] });
    const s = await loadWindowSession();
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].label).toBe("main");
  });

  it("filters out entries with invalid shapes", async () => {
    storeData.set("windowSession", {
      windows: [
        entry("main"),
        { label: 123, path: null }, // invalid
        { ...entry("window-2"), mode: "weird" }, // invalid mode
        entry("window-3"),
      ],
    });
    const s = await loadWindowSession();
    expect(s.windows.map((w) => w.label)).toEqual(["main", "window-3"]);
  });

  it("returns an empty session for non-object stored values", async () => {
    storeData.set("windowSession", "garbage");
    const s = await loadWindowSession();
    expect(s.windows).toEqual([]);
  });

  it("returns an empty session when 'windows' is not an array", async () => {
    storeData.set("windowSession", { windows: "nope" });
    const s = await loadWindowSession();
    expect(s.windows).toEqual([]);
  });

  it("accepts entries with a null path (blank window)", async () => {
    storeData.set("windowSession", { windows: [entry("main", { path: null })] });
    const s = await loadWindowSession();
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].path).toBeNull();
  });
});

describe("saveWindowSession + clearWindowSession", () => {
  it("round-trips through the store", async () => {
    await saveWindowSession({ windows: [entry("main")] });
    const s = await loadWindowSession();
    expect(s.windows).toHaveLength(1);
  });

  it("clearWindowSession leaves an empty session", async () => {
    await saveWindowSession({ windows: [entry("main"), entry("window-2")] });
    await clearWindowSession();
    const s = await loadWindowSession();
    expect(s.windows).toEqual([]);
  });
});

describe("recordCurrentWindowState", () => {
  it("normalises physical pixels to logical via scaleFactor", async () => {
    mockWin.label = "main";
    await recordCurrentWindowState({
      path: "/tmp/foo.md",
      scrollTop: 42.7,
      mode: "edit",
    });
    const session = await loadWindowSession();
    expect(session.windows).toHaveLength(1);
    const e = session.windows[0];
    // outerSize returns 2000x1520 with scaleFactor 2 -> 1000x760 logical
    expect(e.width).toBe(1000);
    expect(e.height).toBe(760);
    // outerPosition 100,200 with factor 2 -> 50,100 logical
    expect(e.x).toBe(50);
    expect(e.y).toBe(100);
    expect(e.scrollTop).toBe(43); // rounded
    expect(e.mode).toBe("edit");
    expect(e.path).toBe("/tmp/foo.md");
    expect(e.label).toBe("main");
  });

  it("upserts an existing entry rather than appending duplicates", async () => {
    mockWin.label = "window-2";
    await recordCurrentWindowState({ path: "/a.md", scrollTop: 0, mode: "reading" });
    await recordCurrentWindowState({ path: "/b.md", scrollTop: 100, mode: "edit" });
    const session = await loadWindowSession();
    const win2 = session.windows.filter((w) => w.label === "window-2");
    expect(win2).toHaveLength(1);
    expect(win2[0].path).toBe("/b.md");
    expect(win2[0].mode).toBe("edit");
  });

  it("preserves entries from other windows when one window records", async () => {
    await saveWindowSession({ windows: [entry("main")] });
    mockWin.label = "window-2";
    await recordCurrentWindowState({ path: "/x.md", scrollTop: 0, mode: "reading" });
    const session = await loadWindowSession();
    expect(session.windows.map((w) => w.label).sort()).toEqual(["main", "window-2"]);
  });

  it("clamps negative scrollTop to 0", async () => {
    await recordCurrentWindowState({ path: null, scrollTop: -50, mode: "reading" });
    const session = await loadWindowSession();
    expect(session.windows[0].scrollTop).toBe(0);
  });

  it("accepts a null path (blank window)", async () => {
    await recordCurrentWindowState({ path: null, scrollTop: 0, mode: "reading" });
    const session = await loadWindowSession();
    expect(session.windows[0].path).toBeNull();
  });
});
