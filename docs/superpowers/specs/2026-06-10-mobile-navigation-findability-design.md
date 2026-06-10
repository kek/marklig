# Mobile navigation & findability — design spec

**Issues:** #152 (browse synced files by project + directory hierarchy), #153 (fuzzy-find search for synced files)
**Scope:** Phone-side only. Replaces the flat synced-file list with a drill-in directory browser plus a full-screen fuzzy search overlay.
**Relation to prior work:** Builds on the v2 mobile companion (issue #70) and live push sync (#97 / PR #148). Reuses the desktop fuzzy matcher (`src/ui/fuzzy.ts`).

---

## 1. Motivation

On the phone, synced files are presented as one flat, ungrouped scroll. `src/ui/mobile-synced-view.ts` lists every `.md` under a pairing (grouped only by `folder_id`), with no way to drill in and no way to search. With a real folder of notes this is a long, unnavigable list. This spec adds hierarchical browse (by synced folder, then by directory) and a fuzzy finder over all of a pairing's synced files.

**Out of scope (decided during brainstorming):** recents and the library home stay as-is; no on-device storage browsing (SAF picker); no Rust / sync-protocol / new-command work — this is a frontend-only change driven by data the phone already has.

---

## 2. Data model

Everything derives from data already on the phone:
- `mobile.synced_files` — flat list of `{ pair_id_hex, folder_id_hex, relpath, abs_path, synced_at_unix }` (see `listSyncedFiles` in `src/shell/mobile-pairings.ts`).
- `mobile.synced_folder_labels` — `folder_id_hex → human label` (see `syncedFolderLabels`).

A new **pure** module `src/ui/mobile-file-tree.ts` (no DOM, no Tauri) builds an in-memory tree:

```ts
export interface FileTreeFile { folderIdHex: string; relpath: string; syncedAtUnix: number; }
export interface DirNode {
  name: string;                 // segment name ("" for a folder root)
  dirs: Map<string, DirNode>;   // child directories by segment
  files: FileTreeFile[];        // file leaves directly in this dir
}
export interface FolderNode { folderIdHex: string; label: string; root: DirNode; fileCount: number; }
export interface FileTree { folders: FolderNode[]; }

export function buildTree(files: SyncedFile[], labels: Record<string, string>): FileTree;
// Resolve the node at a path; null if the path no longer exists.
export function childrenAt(tree: FileTree, folderIdHex: string, segments: string[]): DirNode | null;
// Flatten every file across every folder for search.
export function flattenForSearch(tree: FileTree): { folderIdHex: string; relpath: string; label: string; searchKey: string }[];
```

- Top level = one `FolderNode` per `folder_id_hex`, labeled via `syncedFolderLabels` (fallback: `folderIdHex.slice(0,8)`). Folders sorted by label.
- Within a folder, `relpath` splits on `/` into `DirNode`s and file leaves. Dirs sorted before files; both alphabetical.
- `searchKey` = `relpath` (the label is shown but `relpath` is what fuzzy-matches), so results rank on the path the user thinks in.

---

## 3. Navigation (drill-in)

`mountMobileSynced` (`src/ui/mobile-synced-view.ts`) becomes a drill-in browser driven by a path stack `{ folderIdHex: string | null, segments: string[] }` (`folderIdHex === null` = projects level).

- **Top bar** — left: back/breadcrumb; right: a **search icon** (present at every level). Breadcrumb truncates from the left on deep paths (`…/sub/deeper`); rows ellipsize long names.
- **Projects level** — lists `FolderNode`s (label + file count). **If the pairing has exactly one synced folder, this level is skipped** and the view lands in that folder's root (breadcrumb shows the folder label).
- **Directory level** — folder rows (name + immediate child count) above file rows (name + relative synced time, as today). Tap a folder → push segment; breadcrumb crumb / back → pop.
- **File tap** → `onOpenFile({ folder_id_hex, relpath })` → document route (rendering unchanged).
- The sync **status line, pull-to-refresh, "Sync now", and Unpair** controls live at the top of the **projects level** (or the single-folder root when the projects level is skipped), preserving today's behavior.

---

## 4. Search

- A search icon in the top bar opens a **full-screen overlay** (its own ephemeral UI within the synced view; not a router route).
- Reuses `src/ui/fuzzy.ts` — no new matcher. Input fuzzy-ranks `flattenForSearch(tree)` across **all** the pairing's synced folders (whole-desktop scope, decided in brainstorming).
- Results are a flat, ranked list showing each file's full relative path; tap → `onOpenFile`.
- A clear/✕ control closes the overlay back to the browse level it was launched from.
- Touch-friendly: a real text input (mobile keyboard), clear button; not a desktop modal palette.

---

## 5. Routing & lifecycle (`src/mobile-bootstrap.ts`)

- **Synced nav path persists across the document route.** Today, back from the document route always returns to `library`. A file opened *from the synced browser* must return to the synced view **at the path it was opened from**. The route/shared state grows a remembered synced path so re-mounting the synced view restores `{ folderIdHex, segments }`.
- **Android hardware back** (`decideAndroidBack`): currently synced→library in one step. New behavior pops one level at a time: directory segment → … → projects level → library. The synced view exposes its current path depth to the router (shared ref/callback, mirroring how the back-bar already coordinates), so a hardware back pops the deepest level first.
- **Search overlay open + hardware back** → closes the overlay (does not exit the synced view).
- **Live ops** (`LIVE_OP_EVENT` / existing `refresh()` listener): re-derive the tree from `mobile.synced_files` and re-render the current path. If an `op_delete` removed the directory the user is standing in, pop to the nearest surviving ancestor (or projects/root). Never leave a blank screen.

---

## 6. Edge cases

| Case | Behavior |
|---|---|
| Empty directory | "No files here yet" line (new `t()` key) |
| Pairing with zero synced files | Existing empty / never-synced status (unchanged) |
| Search with no matches | "No matches" line (new `t()` key) |
| Current path vanished after a sync | Graceful pop to nearest surviving ancestor / root |
| Deep path / long names | Breadcrumb left-truncates; rows ellipsize |
| Single-folder pairing | Projects level skipped; land in folder root |

All user-facing strings go through `t()` in `src/i18n/strings.ts`. Safe-area insets honored as in the rest of the mobile shell.

---

## 7. Testing

- **Unit (Vitest, no DOM)** — `tests/ui/mobile-file-tree.test.ts`: tree building from relpaths; single- vs multi-folder; `childrenAt` (including missing paths); `flattenForSearch`; fuzzy-ranking integration with `fuzzy.ts` (query → expected ordering).
- **DOM-level (jsdom)** — `tests/ui/mobile-synced-view.test.ts` (extend if present): drill-in push/pop re-renders the list; breadcrumb pop; search overlay filters and `onOpenFile` fires with the correct `{ folder_id_hex, relpath }`; live-op refresh rebuilds and preserves-or-pops the path; single-folder skip.
- **No e2e** — mobile has no Playwright path, consistent with the rest of the mobile shell.

---

## 8. File structure

```
src/ui/
  mobile-file-tree.ts      (NEW) pure tree model + search flatten
  mobile-synced-view.ts    (MODIFY) drill-in browser + search overlay
src/mobile-bootstrap.ts    (MODIFY) persist synced nav path across document route; multi-level Android back
src/i18n/strings.ts        (MODIFY) new keys: empty dir, no matches, search placeholder/label
tests/ui/
  mobile-file-tree.test.ts (NEW)
  mobile-synced-view.test.ts (NEW or extend)
```

---

## 9. Decisions recorded

- **Drill-in (Files.app style)** over accordion or flat+filter — scales to deep trees, matches phone conventions.
- **Whole-desktop search scope** — the finder spans all of a pairing's synced folders regardless of current location.
- **Single-folder pairings skip the projects level** — no pointless one-item screen.
- **Frontend-only** — derives from `mobile.synced_files` + `mobile.synced_folder_labels`; no Rust/sync changes.
- **Reuse `src/ui/fuzzy.ts`** — consistent ranking with the desktop `Cmd-P` quick-open.
- **File opened from browse returns to its path**, not the library — preserves navigation context.
```
