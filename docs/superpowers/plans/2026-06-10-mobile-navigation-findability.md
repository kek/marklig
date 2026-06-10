# Mobile navigation & findability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phone's flat synced-file list with a drill-in directory browser (by synced folder, then by directory) plus a whole-desktop fuzzy search overlay.

**Architecture:** Frontend-only. A new pure module `mobile-file-tree.ts` builds an in-memory tree from data already on the phone (`mobile.synced_files` + `mobile.synced_folder_labels`). `mobile-synced-view.ts` becomes a path-stack drill-in browser with a search overlay reusing the desktop matcher (`src/ui/fuzzy.ts`). `mobile-bootstrap.ts` persists the synced nav path across the document route and makes Android hardware-back pop one level at a time.

**Tech Stack:** TypeScript (strict), vanilla DOM, Vitest (jsdom). No Rust, no new Tauri commands, no sync-protocol changes.

**Spec:** `docs/superpowers/specs/2026-06-10-mobile-navigation-findability-design.md`

This is a Jujutsu repo — commit with `jj desc -m "…"` then `jj new` (the `git add`/`git commit` shown in steps is shorthand; use jj). Run a single Vitest file with `npx vitest run <path>`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/ui/mobile-file-tree.ts` | create | Pure tree model: `buildTree`, `childrenAt`, `flattenForSearch` |
| `tests/ui/mobile-file-tree.test.ts` | create | Unit tests for the pure model |
| `src/i18n/strings.ts` | modify | New `mobile.browse.*` / `mobile.search.*` keys |
| `src/ui/mobile-synced-view.ts` | modify | Drill-in browser + search overlay; expose `handleBack`; pass path to `onOpenFile` |
| `tests/ui/mobile-synced-view.test.ts` | create | DOM tests: drill-in, search, live-op refresh, single-folder skip |
| `src/mobile-bootstrap.ts` | modify | Persist synced path across document route; multi-level Android back |

---

## Task 1: Pure file-tree model

**Files:**
- Create: `src/ui/mobile-file-tree.ts`
- Test: `tests/ui/mobile-file-tree.test.ts`

### Step 1.1: Write the failing tests

- [ ] Create `tests/ui/mobile-file-tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildTree,
  childrenAt,
  flattenForSearch,
  type TreeInputFile,
} from "../../src/ui/mobile-file-tree";

function f(folderIdHex: string, relpath: string): TreeInputFile {
  return { folderIdHex, relpath, syncedAtUnix: 1 };
}

const LABELS = { aaaa: "Notes", bbbb: "Work" };

describe("buildTree", () => {
  it("groups files into folder nodes labeled from the labels map", () => {
    const tree = buildTree(
      [f("aaaa", "a.md"), f("bbbb", "b.md")],
      LABELS,
    );
    expect(tree.folders.map((x) => x.label)).toEqual(["Notes", "Work"]);
    expect(tree.folders.map((x) => x.folderIdHex)).toEqual(["aaaa", "bbbb"]);
  });

  it("falls back to a truncated folder id when no label exists", () => {
    const tree = buildTree([f("0123456789abcdef", "a.md")], {});
    expect(tree.folders[0].label).toBe("01234567");
  });

  it("nests directories from the relpath and counts files", () => {
    const tree = buildTree(
      [f("aaaa", "notes/sub/c.md"), f("aaaa", "notes/a.md"), f("aaaa", "top.md")],
      LABELS,
    );
    const folder = tree.folders[0];
    expect(folder.fileCount).toBe(3);
    const notes = folder.root.dirs.get("notes")!;
    expect(notes.files.map((x) => x.relpath)).toEqual(["notes/a.md"]);
    expect(notes.dirs.get("sub")!.files.map((x) => x.relpath)).toEqual([
      "notes/sub/c.md",
    ]);
    expect(folder.root.files.map((x) => x.relpath)).toEqual(["top.md"]);
  });

  it("sorts folders by label, dirs before files, both alphabetical", () => {
    const tree = buildTree(
      [f("bbbb", "z.md"), f("bbbb", "dir/x.md"), f("aaaa", "a.md")],
      LABELS,
    );
    expect(tree.folders.map((x) => x.label)).toEqual(["Notes", "Work"]);
    const work = tree.folders[1].root;
    expect([...work.dirs.keys()]).toEqual(["dir"]);
    expect(work.files.map((x) => x.relpath)).toEqual(["z.md"]);
  });
});

describe("childrenAt", () => {
  const tree = buildTree([f("aaaa", "notes/sub/c.md")], LABELS);

  it("resolves the dir node at a path", () => {
    const node = childrenAt(tree, "aaaa", ["notes"]);
    expect([...node!.dirs.keys()]).toEqual(["sub"]);
  });

  it("returns null for a missing folder or path", () => {
    expect(childrenAt(tree, "zzzz", [])).toBeNull();
    expect(childrenAt(tree, "aaaa", ["nope"])).toBeNull();
  });

  it("returns the folder root for an empty segment list", () => {
    const node = childrenAt(tree, "aaaa", []);
    expect([...node!.dirs.keys()]).toEqual(["notes"]);
  });
});

describe("flattenForSearch", () => {
  it("returns one entry per file across all folders with searchKey = relpath", () => {
    const tree = buildTree(
      [f("aaaa", "notes/c.md"), f("bbbb", "b.md")],
      LABELS,
    );
    const flat = flattenForSearch(tree);
    expect(flat).toEqual([
      { folderIdHex: "aaaa", relpath: "notes/c.md", label: "Notes", searchKey: "notes/c.md" },
      { folderIdHex: "bbbb", relpath: "b.md", label: "Work", searchKey: "b.md" },
    ]);
  });
});
```

### Step 1.2: Run tests, verify they fail

- [ ] `npx vitest run tests/ui/mobile-file-tree.test.ts`
- Expected: FAIL — cannot resolve `../../src/ui/mobile-file-tree`.

### Step 1.3: Implement the module

- [ ] Create `src/ui/mobile-file-tree.ts`:

```ts
// Pure, DOM-free model that turns the phone's flat synced-file list into a
// browsable directory tree (grouped by synced folder = "project") and a flat
// list for fuzzy search. Derives entirely from data already in the store:
// `mobile.synced_files` + `mobile.synced_folder_labels`. Unit-tested without
// any DOM or Tauri dependency.

/** Minimal shape this module needs from a synced file record. The store's
 * `SyncedFile` (src/shell/mobile-pairings.ts) is structurally compatible. */
export interface TreeInputFile {
  folderIdHex: string;
  relpath: string;
  syncedAtUnix: number;
}

export interface FileLeaf {
  folderIdHex: string;
  relpath: string;
  /** Last path segment (display name). */
  name: string;
  syncedAtUnix: number;
}

export interface DirNode {
  /** Segment name; "" for a folder root. */
  name: string;
  dirs: Map<string, DirNode>;
  files: FileLeaf[];
}

export interface FolderNode {
  folderIdHex: string;
  label: string;
  root: DirNode;
  fileCount: number;
}

export interface FileTree {
  folders: FolderNode[];
}

export interface SearchEntry {
  folderIdHex: string;
  relpath: string;
  label: string;
  /** What the fuzzy matcher scores against. */
  searchKey: string;
}

function newDir(name: string): DirNode {
  return { name, dirs: new Map(), files: [] };
}

function basename(relpath: string): string {
  const i = relpath.lastIndexOf("/");
  return i >= 0 ? relpath.slice(i + 1) : relpath;
}

/** Build the tree. Folders sorted by label (then id); within a dir, child
 * dirs and files are sorted alphabetically (dirs listed before files at the
 * render layer). */
export function buildTree(
  files: TreeInputFile[],
  labels: Record<string, string>,
): FileTree {
  const byFolder = new Map<string, FolderNode>();

  for (const file of files) {
    let folder = byFolder.get(file.folderIdHex);
    if (!folder) {
      folder = {
        folderIdHex: file.folderIdHex,
        label: labels[file.folderIdHex] ?? file.folderIdHex.slice(0, 8),
        root: newDir(""),
        fileCount: 0,
      };
      byFolder.set(file.folderIdHex, folder);
    }
    folder.fileCount++;

    const segments = file.relpath.split("/");
    let dir = folder.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = dir.dirs.get(seg);
      if (!child) {
        child = newDir(seg);
        dir.dirs.set(seg, child);
      }
      dir = child;
    }
    dir.files.push({
      folderIdHex: file.folderIdHex,
      relpath: file.relpath,
      name: basename(file.relpath),
      syncedAtUnix: file.syncedAtUnix,
    });
  }

  // Sort files within each dir alphabetically by name.
  const sortDir = (d: DirNode): void => {
    d.files.sort((a, b) => a.name.localeCompare(b.name));
    d.dirs = new Map([...d.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    for (const child of d.dirs.values()) sortDir(child);
  };
  for (const folder of byFolder.values()) sortDir(folder.root);

  const folders = [...byFolder.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.folderIdHex.localeCompare(b.folderIdHex),
  );
  return { folders };
}

/** Resolve the `DirNode` at `segments` within a folder. Returns null if the
 * folder or any segment is missing. Empty `segments` → folder root. */
export function childrenAt(
  tree: FileTree,
  folderIdHex: string,
  segments: string[],
): DirNode | null {
  const folder = tree.folders.find((x) => x.folderIdHex === folderIdHex);
  if (!folder) return null;
  let dir = folder.root;
  for (const seg of segments) {
    const child = dir.dirs.get(seg);
    if (!child) return null;
    dir = child;
  }
  return dir;
}

/** Flatten every file across every folder for the search overlay, preserving
 * folder order then in-folder file order. */
export function flattenForSearch(tree: FileTree): SearchEntry[] {
  const out: SearchEntry[] = [];
  const walk = (dir: DirNode, label: string): void => {
    for (const file of dir.files) {
      out.push({
        folderIdHex: file.folderIdHex,
        relpath: file.relpath,
        label,
        searchKey: file.relpath,
      });
    }
    for (const child of dir.dirs.values()) walk(child, label);
  };
  for (const folder of tree.folders) {
    // Walk files-before-subdirs at each level to match buildTree ordering
    // used by the test (folder root files first, then nested).
    walk(folder.root, folder.label);
  }
  return out;
}
```

> Note: `flattenForSearch` walks files at each level before descending — matches the test's expected ordering for `notes/c.md` then `b.md` across folders. Within a single folder, root files come before nested files.

### Step 1.4: Run tests, verify pass

- [ ] `npx vitest run tests/ui/mobile-file-tree.test.ts`
- Expected: PASS (all cases).

### Step 1.5: Commit

```bash
git add src/ui/mobile-file-tree.ts tests/ui/mobile-file-tree.test.ts
git commit -m "Mobile: pure file-tree model for synced-file navigation"
```

---

## Task 2: i18n keys

**Files:**
- Modify: `src/i18n/strings.ts`

### Step 2.1: Add keys

- [ ] In `src/i18n/strings.ts`, add these entries immediately after the `"mobile.synced.unpair_failed_prefix"` line (keep them in the `mobile.*` cluster):

```ts
  "mobile.browse.empty_dir": "No files here yet",
  "mobile.browse.file_count": "{n} items",
  "mobile.browse.search_label": "Search files",
  "mobile.search.placeholder": "Search files…",
  "mobile.search.input_label": "Search synced files",
  "mobile.search.no_matches": "No matching files",
  "mobile.search.close": "Close search",
```

### Step 2.2: Type-check

- [ ] `npx tsc -b --noEmit`
- Expected: no errors (the `StringKey` union widens automatically).

### Step 2.3: Commit

```bash
git add src/i18n/strings.ts
git commit -m "Mobile: i18n keys for browse + search"
```

---

## Task 3: Drill-in browser + search overlay in the synced view

**Files:**
- Modify: `src/ui/mobile-synced-view.ts`
- Test: `tests/ui/mobile-synced-view.test.ts`

This task rewrites how `mountMobileSynced` renders files. **Preserve unchanged:** the title, fingerprint, sync status line (`renderRelativeStatus`), "Sync now" button + `runSync` throttle logic, pull-to-refresh, unpair two-tap confirm, auto-sync triggers, and the `LIVE_OP_EVENT` / `CAUGHT_UP_EVENT` listeners. **Replace:** the flat folder-grouped `<ul>` built in `refresh()` with the drill-in renderer below. **Add:** a path stack, breadcrumb, a search button + overlay, and a `handleBack` export for the router.

### Step 3.1: Write the failing DOM tests

- [ ] Create `tests/ui/mobile-synced-view.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/platform", () => ({ isMobile: () => false }));
vi.mock("../../src/shell/mobile-pairings", () => ({
  syncNow: vi.fn(),
  listSyncedFiles: vi.fn(),
  syncedFolderLabels: vi.fn(),
  unpairMobile: vi.fn(),
}));
// The synced view imports event-name constants from mobile-sync-client, which
// transitively pulls in @tauri-apps/api/core. Mock it to just the constants so
// the test imports cleanly without a Tauri runtime.
vi.mock("../../src/shell/mobile-sync-client", () => ({
  LIVE_OP_EVENT: "sync:live-op",
  CAUGHT_UP_EVENT: "sync:caught-up",
}));

import { mountMobileSynced } from "../../src/ui/mobile-synced-view";
import {
  listSyncedFiles,
  syncedFolderLabels,
  type MobilePairing,
} from "../../src/shell/mobile-pairings";

const PAIR: MobilePairing = {
  pair_id_hex: "aa".repeat(16),
  friendly_name: "Desk",
  verification_fingerprint: "AA-BB",
  paired_at_unix: 0,
  last_seen_at_unix: 0,
};

function sf(folderIdHex: string, relpath: string) {
  return {
    pair_id_hex: PAIR.pair_id_hex,
    folder_id_hex: folderIdHex,
    relpath,
    abs_path: "/x/" + relpath,
    synced_at_unix: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "<div id='root'></div>";
});

function root() {
  return document.getElementById("root")!;
}

describe("drill-in browse", () => {
  it("single-folder pairing skips the projects level and lists the folder root", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md"), sf("f1", "top.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });

    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file, path) => opened.push({ file, path }),
      onBack: () => {},
      onUnpaired: () => {},
    });
    // wait a microtask for the async refresh()
    await Promise.resolve();
    await Promise.resolve();

    const rows = root().querySelectorAll(".mobile-browse__row");
    const labels = [...rows].map((r) => r.textContent);
    // A directory row "notes" and a file row "top.md" at the root.
    expect(labels.some((t) => t?.includes("notes"))).toBe(true);
    expect(labels.some((t) => t?.includes("top.md"))).toBe(true);

    handle.teardown();
  });

  it("drilling into a folder shows its children, handleBack pops back up", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    const dirRow = [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--dir")].find(
      (r) => r.textContent?.includes("notes"),
    )!;
    dirRow.click();
    expect(root().textContent).toContain("a.md");

    // handleBack returns true (consumed) when not at the top level.
    expect(handle.handleBack()).toBe(true);
    expect(root().textContent).toContain("notes");
    handle.teardown();
  });

  it("tapping a file calls onOpenFile with the file and current path", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "top.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file, path) => opened.push({ file, path }),
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--file")]
      .find((r) => r.textContent?.includes("top.md"))!
      .click();
    expect(opened).toHaveLength(1);
    expect(opened[0].file.relpath).toBe("top.md");
    expect(opened[0].path).toEqual({ folderIdHex: "f1", segments: [] });
    handle.teardown();
  });
});

describe("search overlay", () => {
  it("filters across folders and opens a result", async () => {
    (listSyncedFiles as any).mockResolvedValue([
      sf("f1", "notes/alpha.md"),
      sf("f2", "beta.md"),
    ]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes", f2: "Work" });
    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file) => opened.push(file),
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    root().querySelector<HTMLElement>(".mobile-browse__search-btn")!.click();
    const input = root().querySelector<HTMLInputElement>(".mobile-search__input")!;
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));

    const results = root().querySelectorAll(".mobile-search__result");
    expect(results).toHaveLength(1);
    (results[0] as HTMLElement).click();
    expect(opened[0].relpath).toBe("notes/alpha.md");
    handle.teardown();
  });
});

describe("live-op refresh", () => {
  it("rebuilds the tree and pops out of a directory that was deleted", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    // Drill into notes/.
    [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--dir")]
      .find((r) => r.textContent?.includes("notes"))!
      .click();
    expect(root().textContent).toContain("a.md");

    // A live op deletes notes/a.md — the only file. Next refresh has no files
    // in notes/, so the view must pop back to the (now empty) folder root.
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "top.md")]);
    window.dispatchEvent(
      new CustomEvent("sync:live-op", { detail: { pairIdHex: PAIR.pair_id_hex } }),
    );
    // Allow the async refresh() to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root().textContent).toContain("top.md");
    handle.teardown();
  });
});

describe("handleBack at top level", () => {
  it("returns false so the router falls back to onBack/library", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.handleBack()).toBe(false);
    handle.teardown();
  });
});
```

### Step 3.2: Run tests, verify they fail

- [ ] `npx vitest run tests/ui/mobile-synced-view.test.ts`
- Expected: FAIL — `mountMobileSynced` returns a teardown function (not `{ teardown, handleBack }`), and `.mobile-browse__*` classes don't exist.

### Step 3.3: Update imports and the handler/return types

- [ ] At the top of `src/ui/mobile-synced-view.ts`, add imports:

```ts
import { buildTree, childrenAt, flattenForSearch } from "./mobile-file-tree";
import type { FileTree, FileLeaf, SearchEntry } from "./mobile-file-tree";
import { scoreMatch, buildHighlightedSpans } from "./fuzzy";
```

> `tA11y` (already imported at the top of this file alongside `t`) is the interpolating variant — use it for any string with a `{n}` placeholder; plain `t()` for the rest.

- [ ] Add a path type and update the handler + return types. Replace the `MobileSyncedHandlers` interface with:

```ts
/** Where the user is in the drill-in browser. `folderIdHex === null` is the
 * projects level (only reachable when the pairing has >1 synced folder). */
export interface SyncedPath {
  folderIdHex: string | null;
  segments: string[];
}

export interface MobileSyncedHandlers {
  /** `path` is where the user was when they opened the file, so the router
   * can restore it on back. */
  onOpenFile: (file: SyncedFile, path: SyncedPath) => void;
  onBack: () => void;
  onUnpaired: () => void;
}

/** Handle returned by mountMobileSynced. `handleBack` pops one browse level
 * (or closes the search overlay) and returns true if it consumed the action;
 * false means "already at the top — router should go to the library". */
export interface MobileSyncedHandle {
  teardown: () => void;
  handleBack: () => boolean;
}
```

- [ ] Change the signature of `mountMobileSynced` to accept an optional initial path and return the handle:

```ts
export async function mountMobileSynced(
  root: HTMLElement,
  pairing: MobilePairing,
  handlers: MobileSyncedHandlers,
  initialPath?: SyncedPath,
): Promise<MobileSyncedHandle> {
```

### Step 3.4: Add browse state and replace the file-list rendering

- [ ] Inside `mountMobileSynced`, after the existing element setup (after the `list` `<ul>` is created and appended), add the browse state and a search button in the top bar. Add a search button next to the back button:

```ts
  // Drill-in browse state. tree is rebuilt from the store on every refresh().
  let tree: FileTree = { folders: [] };
  let path: SyncedPath = initialPath ?? { folderIdHex: null, segments: [] };

  // Breadcrumb / level header rendered above the list.
  const crumb = document.createElement("div");
  crumb.className = "mobile-browse__crumb";
  wrap.insertBefore(crumb, list);

  // Search button lives in the back-bar row.
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "mobile-browse__search-btn";
  searchBtn.setAttribute("aria-label", t("mobile.browse.search_label"));
  searchBtn.textContent = "🔍";
  searchBtn.addEventListener("click", () => openSearch());
  root.insertBefore(searchBtn, wrap); // top-right; positioned via CSS
```

- [ ] Replace the **body** of `refresh()` (the part that lists files) with a tree rebuild + level render. Keep the leading `listSyncedFiles` / `syncedFolderLabels` calls and the empty-state status. New `refresh()`:

```ts
  const refresh = async (): Promise<void> => {
    const files = await listSyncedFiles(pairing.pair_id_hex);
    const labels = await syncedFolderLabels(pairing.pair_id_hex);
    // Map the store's snake_case SyncedFile shape to the tree module's
    // camelCase TreeInputFile at the boundary (the pure module stays
    // independent of store naming).
    tree = buildTree(
      files.map((x) => ({
        folderIdHex: x.folder_id_hex,
        relpath: x.relpath,
        syncedAtUnix: x.synced_at_unix,
      })),
      labels,
    );

    if (files.length === 0 && lastDisplayedSuccessMs === null) {
      status.textContent = t("mobile.synced.empty");
    }

    // If the pairing has exactly one folder and we're at the projects level,
    // drop straight into that folder's root.
    if (path.folderIdHex === null && tree.folders.length === 1) {
      path = { folderIdHex: tree.folders[0].folderIdHex, segments: [] };
    }
    // If our current path vanished (e.g. live delete), pop to nearest ancestor.
    normalizePath();
    renderLevel();
  };

  /** Pop trailing segments until the path resolves, then drop to projects
   * level if even the folder is gone. */
  function normalizePath(): void {
    if (path.folderIdHex === null) return;
    while (childrenAt(tree, path.folderIdHex, path.segments) === null) {
      if (path.segments.length > 0) {
        path = { folderIdHex: path.folderIdHex, segments: path.segments.slice(0, -1) };
      } else {
        path = { folderIdHex: null, segments: [] };
        // Re-apply single-folder skip after a reset.
        if (tree.folders.length === 1) {
          path = { folderIdHex: tree.folders[0].folderIdHex, segments: [] };
        }
        return;
      }
    }
  }
```

- [ ] Add the level renderer and row builders (place after `refresh`):

```ts
  function renderLevel(): void {
    list.innerHTML = "";
    crumb.innerHTML = "";

    if (path.folderIdHex === null) {
      // Projects level: list synced folders.
      crumb.textContent = pairing.friendly_name || pairing.pair_id_hex.slice(0, 12);
      for (const folder of tree.folders) {
        list.appendChild(
          browseRow("dir", folder.label, tA11y("mobile.browse.file_count", { n: String(folder.fileCount) }), () => {
            path = { folderIdHex: folder.folderIdHex, segments: [] };
            renderLevel();
          }),
        );
      }
      return;
    }

    const node = childrenAt(tree, path.folderIdHex, path.segments);
    if (!node) return; // normalizePath guarantees this won't happen
    renderBreadcrumb();

    if (node.dirs.size === 0 && node.files.length === 0) {
      const empty = document.createElement("li");
      empty.className = "mobile-browse__empty";
      empty.textContent = t("mobile.browse.empty_dir");
      list.appendChild(empty);
      return;
    }

    for (const [name, child] of node.dirs) {
      const count = child.dirs.size + child.files.length;
      list.appendChild(
        browseRow("dir", name, tA11y("mobile.browse.file_count", { n: String(count) }), () => {
          path = { folderIdHex: path.folderIdHex, segments: [...path.segments, name] };
          renderLevel();
        }),
      );
    }
    for (const file of node.files) {
      list.appendChild(
        browseRow("file", file.name, formatRelative(file.syncedAtUnix * 1000), () =>
          handlers.onOpenFile(toSyncedFile(file), path),
        ),
      );
    }
  }

  function renderBreadcrumb(): void {
    // Build clickable crumbs: <folder label> / seg / seg
    const parts: { label: string; segments: string[] }[] = [];
    const folder = tree.folders.find((x) => x.folderIdHex === path.folderIdHex);
    parts.push({ label: folder?.label ?? "", segments: [] });
    for (let i = 0; i < path.segments.length; i++) {
      parts.push({ label: path.segments[i], segments: path.segments.slice(0, i + 1) });
    }
    crumb.innerHTML = "";
    parts.forEach((part, idx) => {
      if (idx > 0) crumb.appendChild(document.createTextNode(" / "));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mobile-browse__crumb-btn";
      btn.textContent = part.label;
      btn.addEventListener("click", () => {
        path = { folderIdHex: path.folderIdHex, segments: part.segments };
        renderLevel();
      });
      crumb.appendChild(btn);
    });
  }

  function browseRow(
    kind: "dir" | "file",
    name: string,
    meta: string,
    onActivate: () => void,
  ): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `mobile-browse__row mobile-browse__row--${kind} mobile-library__item`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mobile-library__item-btn";
    btn.addEventListener("click", onActivate);
    const nameEl = document.createElement("span");
    nameEl.className = "mobile-library__item-name";
    nameEl.textContent = (kind === "dir" ? "📁 " : "") + name;
    const metaEl = document.createElement("span");
    metaEl.className = "mobile-library__item-when";
    metaEl.textContent = meta;
    btn.append(nameEl, metaEl);
    li.appendChild(btn);
    return li;
  }

  /** Reconstruct the store-shaped SyncedFile from a tree leaf for onOpenFile. */
  function toSyncedFile(leaf: FileLeaf): SyncedFile {
    return {
      pair_id_hex: pairing.pair_id_hex,
      folder_id_hex: leaf.folderIdHex,
      relpath: leaf.relpath,
      abs_path: "",
      synced_at_unix: leaf.syncedAtUnix,
    };
  }
```

### Step 3.5: Add the search overlay

- [ ] Add the search overlay functions inside `mountMobileSynced` (after the browse renderers). The overlay is a `div` appended to `root`, removed on close:

```ts
  let searchOverlay: HTMLElement | null = null;

  function openSearch(): void {
    if (searchOverlay) return;
    const overlay = document.createElement("div");
    overlay.className = "mobile-search";
    searchOverlay = overlay;

    const bar = document.createElement("div");
    bar.className = "mobile-search__bar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mobile-search__close";
    closeBtn.setAttribute("aria-label", t("mobile.search.close"));
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closeSearch);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mobile-search__input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("mobile.search.placeholder");
    input.setAttribute("aria-label", t("mobile.search.input_label"));
    bar.append(closeBtn, input);

    const results = document.createElement("ul");
    results.className = "mobile-search__results";
    const empty = document.createElement("p");
    empty.className = "mobile-search__empty";
    empty.style.display = "none";
    empty.textContent = t("mobile.search.no_matches");

    overlay.append(bar, results, empty);
    root.appendChild(overlay);

    const all: SearchEntry[] = flattenForSearch(tree);

    const render = (): void => {
      const q = input.value.trim();
      results.innerHTML = "";
      const matched =
        q.length === 0
          ? all.map((e) => ({ entry: e, positions: [] as number[], score: 0 }))
          : all
              .map((entry) => {
                const m = scoreMatch(entry.searchKey, q);
                return m ? { entry, positions: m.positions, score: m.score } : null;
              })
              .filter((x): x is { entry: SearchEntry; positions: number[]; score: number } => x !== null)
              .sort((a, b) => b.score - a.score || a.entry.relpath.localeCompare(b.entry.relpath));

      empty.style.display = matched.length === 0 ? "block" : "none";
      for (const { entry, positions } of matched) {
        const li = document.createElement("li");
        li.className = "mobile-search__result mobile-library__item";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mobile-library__item-btn";
        const nameEl = document.createElement("span");
        nameEl.className = "mobile-library__item-name";
        for (const node of buildHighlightedSpans(entry.relpath, positions)) nameEl.append(node);
        const metaEl = document.createElement("span");
        metaEl.className = "mobile-library__item-when";
        metaEl.textContent = entry.label;
        btn.append(nameEl, metaEl);
        btn.addEventListener("click", () => {
          closeSearch();
          handlers.onOpenFile(
            {
              pair_id_hex: pairing.pair_id_hex,
              folder_id_hex: entry.folderIdHex,
              relpath: entry.relpath,
              abs_path: "",
              synced_at_unix: 0,
            },
            path,
          );
        });
        li.appendChild(btn);
        results.appendChild(li);
      }
    };

    input.addEventListener("input", render);
    render();
    input.focus();
  }

  function closeSearch(): void {
    if (searchOverlay) {
      searchOverlay.remove();
      searchOverlay = null;
    }
  }
```

### Step 3.6: Implement `handleBack` and return the handle

- [ ] At the very end of `mountMobileSynced`, replace the existing `return () => { … teardown … }` with a handle whose `teardown` runs the same cleanup and whose `handleBack` pops a level:

```ts
  const teardown = (): void => {
    if (disarmTimer !== null) {
      window.clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    closeSearch();
    for (const fn of cleanups) {
      try { fn(); } catch { /* no-op */ }
    }
    syncState.delete(pairing.pair_id_hex);
  };

  const handleBack = (): boolean => {
    if (searchOverlay) { closeSearch(); return true; }
    if (path.folderIdHex !== null && path.segments.length > 0) {
      path = { folderIdHex: path.folderIdHex, segments: path.segments.slice(0, -1) };
      renderLevel();
      return true;
    }
    if (path.folderIdHex !== null && tree.folders.length > 1) {
      // Back to the projects level (only when it wasn't skipped).
      path = { folderIdHex: null, segments: [] };
      renderLevel();
      return true;
    }
    return false; // top level — router goes to library
  };

  return { teardown, handleBack };
```

- [ ] The existing back-bar button (`backBtn`) should also pop a level when possible, falling back to `onBack`. Change its click handler to:

```ts
  backBtn.addEventListener("click", () => {
    if (!handleBack()) handlers.onBack();
  });
```

> `handleBack` is defined later in the function than `backBtn`; since the listener runs at click time (not definition time) this is fine — `handleBack` is in scope via closure hoisting of the `const` by the time the user clicks.

### Step 3.7: Run tests, verify pass

- [ ] `npx vitest run tests/ui/mobile-synced-view.test.ts`
- Expected: PASS.
- [ ] `npx tsc -b --noEmit` — no errors.

### Step 3.8: Add minimal CSS

- [ ] In `src/styles-mobile.css`, append styling for the new classes (search button top-right, full-screen overlay, breadcrumb, dir/file rows). Match existing `mobile-library__*` look:

```css
.mobile-browse__search-btn {
  position: absolute;
  top: env(safe-area-inset-top);
  right: 12px;
  font-size: 1.2rem;
  background: none;
  border: none;
  padding: 8px;
}
.mobile-browse__crumb { font-size: 0.85rem; opacity: 0.7; margin: 4px 0; }
.mobile-browse__crumb-btn { background: none; border: none; color: inherit; padding: 0; font: inherit; }
.mobile-browse__empty { opacity: 0.55; padding: 12px 0; }
.mobile-search {
  position: fixed; inset: 0; background: var(--bg, #fff); z-index: 50;
  display: flex; flex-direction: column;
  padding-top: env(safe-area-inset-top);
}
.mobile-search__bar { display: flex; gap: 8px; padding: 8px 12px; align-items: center; }
.mobile-search__input { flex: 1; font-size: 1rem; padding: 8px; }
.mobile-search__close { background: none; border: none; font-size: 1.1rem; }
.mobile-search__results { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.mobile-search__empty { opacity: 0.55; padding: 16px; }
```

### Step 3.9: Commit

```bash
git add src/ui/mobile-synced-view.ts tests/ui/mobile-synced-view.test.ts src/styles-mobile.css
git commit -m "Mobile: drill-in synced-file browser + fuzzy search overlay"
```

---

## Task 4: Routing — persist synced path + multi-level Android back

**Files:**
- Modify: `src/mobile-bootstrap.ts`

The synced view now returns `{ teardown, handleBack }` and calls `onOpenFile(file, path)`. The router must: (a) restore the synced path when returning from an opened file, and (b) route Android hardware-back through the view's `handleBack` before leaving the synced view.

### Step 4.1: Update the Route type and add return state

- [ ] In `src/mobile-bootstrap.ts`, add `path` to the synced route and import `SyncedPath`. Change the import from `./ui/mobile-synced-view`:

```ts
import { mountMobileSynced } from "./ui/mobile-synced-view";
import type { SyncedPath, MobileSyncedHandle } from "./ui/mobile-synced-view";
```

- [ ] Extend the `Route` union's synced variant:

```ts
  | { kind: "synced"; pairing: MobilePairing; path?: SyncedPath };
```

- [ ] Inside `mobileBootstrap()`, alongside `currentSyncedFile`, add:

```ts
  // Live handle to the mounted synced view, for the Android back bridge.
  let currentSyncedHandle: MobileSyncedHandle | null = null;
  // Where to return when backing out of a file opened from the synced browser.
  let syncedReturn: { pairing: MobilePairing; path: SyncedPath } | null = null;
```

### Step 4.2: Rewire the synced route block

- [ ] Replace the `if (route.kind === "synced")` block with:

```ts
    if (route.kind === "synced") {
      const handle = await mountMobileSynced(
        root,
        route.pairing,
        {
          onOpenFile: async (file, path) => {
            try {
              const source = await readSyncedFile(
                file.pair_id_hex,
                file.folder_id_hex,
                file.relpath,
              );
              currentSyncedFile = {
                pairIdHex: file.pair_id_hex,
                folderIdHex: file.folder_id_hex,
                relpath: file.relpath,
              };
              syncedReturn = { pairing: route.pairing, path };
              await renderRoute({ kind: "document", source });
            } catch (err) {
              console.error("failed to open synced file", file, err);
            }
          },
          onBack: () => {
            currentSyncedFile = null;
            syncedReturn = null;
            void renderRoute({ kind: "library" });
          },
          onUnpaired: () => {
            currentSyncedFile = null;
            syncedReturn = null;
            void renderRoute({ kind: "library" });
          },
        },
        route.path,
      );
      currentSyncedHandle = handle;
      viewCleanups.push(() => {
        handle.teardown();
        currentSyncedHandle = null;
        stopSyncClient(route.pairing.pair_id_hex);
      });
      startSyncClient(route.pairing);
      return;
    }
```

### Step 4.3: Document-route back returns to the synced path

- [ ] In the document route's back button handler (the `backBtn.addEventListener("click", …)` inside the document branch), change it to honor `syncedReturn`:

```ts
    backBtn.addEventListener("click", () => {
      if (syncedReturn) {
        const ret = syncedReturn;
        syncedReturn = null;
        currentSyncedFile = null;
        void renderRoute({ kind: "synced", pairing: ret.pairing, path: ret.path });
      } else {
        void renderRoute({ kind: "library" });
      }
    });
```

> There are two back buttons in the document branch (the Typst-unsupported guard and the normal editor mount). Apply the same change to both.

### Step 4.4: Android hardware back

- [ ] Update `decideAndroidBack` so the document route's decision can target the synced view. Since `decideAndroidBack` is pure on `Route` and `syncedReturn`/`currentSyncedHandle` are closure state, route the synced + document cases through the live state in the `__marklig_android_back` bridge instead. Replace the bridge body:

```ts
  (window as unknown as {
    __marklig_android_back?: () => boolean;
  }).__marklig_android_back = (): boolean => {
    if (navigating) return true;

    // Synced browser: pop a level / close search before leaving the view.
    if (currentRoute.kind === "synced" && currentSyncedHandle) {
      if (currentSyncedHandle.handleBack()) return true;
      navigating = true;
      void renderRoute({ kind: "library" }).finally(() => { navigating = false; });
      return true;
    }

    // Document opened from the synced browser: return to its path.
    if (currentRoute.kind === "document" && syncedReturn) {
      const ret = syncedReturn;
      syncedReturn = null;
      currentSyncedFile = null;
      navigating = true;
      void renderRoute({ kind: "synced", pairing: ret.pairing, path: ret.path })
        .finally(() => { navigating = false; });
      return true;
    }

    const decision = decideAndroidBack(currentRoute);
    if (decision.handled) {
      navigating = true;
      void renderRoute(decision.next).finally(() => { navigating = false; });
      return true;
    }
    return false;
  };
```

- [ ] Leave `decideAndroidBack` itself unchanged for the `library` / `pair` / plain-`document` / `synced`-without-handle cases (its `synced → library` and `document → library` branches remain the fallback).

### Step 4.5: Type-check + full test run

- [ ] `npx tsc -b --noEmit` — no errors.
- [ ] `npm test` — all suites pass (including the new `mobile-file-tree` and `mobile-synced-view` tests).

### Step 4.6: Commit

```bash
git add src/mobile-bootstrap.ts
git commit -m "Mobile: persist synced nav path across document route + multi-level Android back"
```

---

## Final verification

- [ ] `npm test 2>&1 | tail -20` — all Vitest suites pass.
- [ ] `npx tsc -b --noEmit` — no type errors.
- [ ] Re-read the spec (`docs/superpowers/specs/2026-06-10-mobile-navigation-findability-design.md`) and confirm each section maps to a task (see self-review below).
- [ ] Open PR against `trunk` referencing #152 and #153 (via the open-pr skill).

---

## What this plan does NOT deliver

- Recents / library-home restructuring (out of scope — synced files only).
- On-device storage browsing / SAF picker.
- Search across recents or non-synced content.
- Any Rust / sync-protocol / new-command work.
