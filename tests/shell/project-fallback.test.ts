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

// Stand-in for the Rust commands. `path_exists` is consulted by the fallback
// chain to validate the last-in-project entry before returning it; the
// `listMarkdownFiles` mock (via files.ts below) feeds the README probe.
const pathExistsImpl = vi.fn<(path: string) => boolean>(() => true);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string }) => {
    if (cmd === "path_exists") return pathExistsImpl(args.path ?? "");
    throw new Error(`unmocked invoke: ${cmd}`);
  }),
}));

const listImpl = vi.fn<
  (root: string) => Array<{ path: string; relative: string }>
>(() => []);
vi.mock("../../src/shell/files", () => ({
  listMarkdownFiles: vi.fn(async (root: string) => listImpl(root)),
}));

import { resolveProjectFallbackFile } from "../../src/shell/project-fallback";
import {
  recordFileInProject,
  clearProjectRecents,
} from "../../src/shell/project-recents";

beforeEach(async () => {
  storage.clear();
  pathExistsImpl.mockReset();
  pathExistsImpl.mockImplementation(() => true);
  listImpl.mockReset();
  listImpl.mockReturnValue([]);
  await clearProjectRecents();
});

describe("resolveProjectFallbackFile", () => {
  it("returns null for an empty root", async () => {
    expect(await resolveProjectFallbackFile("")).toBeNull();
  });

  it("prefers the per-project recent when it exists on disk", async () => {
    await recordFileInProject("/proj", "/proj/notes.md");
    pathExistsImpl.mockReturnValue(true);
    listImpl.mockReturnValue([{ path: "/proj/README.md", relative: "README.md" }]);
    expect(await resolveProjectFallbackFile("/proj")).toBe("/proj/notes.md");
  });

  it("falls through to README when the per-project recent is missing from disk", async () => {
    await recordFileInProject("/proj", "/proj/gone.md");
    pathExistsImpl.mockImplementation((p) => p !== "/proj/gone.md");
    listImpl.mockReturnValue([
      { path: "/proj/README.md", relative: "README.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBe("/proj/README.md");
  });

  it("matches README.md case-insensitively (readme.md / Readme.md)", async () => {
    listImpl.mockReturnValue([
      { path: "/proj/readme.md", relative: "readme.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBe("/proj/readme.md");

    listImpl.mockReturnValue([
      { path: "/proj/Readme.md", relative: "Readme.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBe("/proj/Readme.md");
  });

  it("ignores README files in subdirectories — only the root counts", async () => {
    listImpl.mockReturnValue([
      { path: "/proj/docs/README.md", relative: "docs/README.md" },
      { path: "/proj/docs/intro.md", relative: "docs/intro.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBeNull();
  });

  it("returns null (welcome buffer) when neither recent nor README exist", async () => {
    listImpl.mockReturnValue([
      { path: "/proj/foo.md", relative: "foo.md" },
      { path: "/proj/bar.md", relative: "bar.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBeNull();
  });

  it("returns null when the folder walker throws (project gone / unreadable)", async () => {
    listImpl.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(await resolveProjectFallbackFile("/gone")).toBeNull();
  });

  it("prefers per-project recent over root README when both exist", async () => {
    await recordFileInProject("/proj", "/proj/notes.md");
    pathExistsImpl.mockReturnValue(true);
    listImpl.mockReturnValue([
      { path: "/proj/README.md", relative: "README.md" },
      { path: "/proj/notes.md", relative: "notes.md" },
    ]);
    expect(await resolveProjectFallbackFile("/proj")).toBe("/proj/notes.md");
  });
});
