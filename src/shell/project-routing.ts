/**
 * Pure routing decision for "switch to folder X" (issue #100). Kept free of
 * Tauri imports so it is unit-testable without a real window. The router in
 * main.ts turns this decision into focus / adopt / spawn actions.
 */

import type { WindowSessionEntry } from "./window-session";

export type ProjectRoute =
  | { kind: "focus"; label: string }
  | { kind: "adopt" }
  | { kind: "spawn" };

/**
 * Decide how to route a project switch.
 *
 *   1. A live window already owns `target`     → focus it (may be the
 *      requesting window itself, which the router treats as a no-op).
 *   2. Target unowned, requesting window blank  → adopt the folder in place.
 *   3. Target unowned, requesting window claimed → spawn a new window.
 *
 * `target` is assumed already canonical; the caller canonicalizes both the
 * target and the map values before calling.
 */
export function decideProjectRoute(input: {
  target: string;
  requestingLabel: string;
  requestingFolder: string | null;
  folderByLabel: ReadonlyMap<string, string | null>;
}): ProjectRoute {
  for (const [label, folder] of input.folderByLabel) {
    if (folder === input.target) return { kind: "focus", label };
  }
  if (input.requestingFolder === null) return { kind: "adopt" };
  return { kind: "spawn" };
}

/**
 * Decide which already-open window should receive a single file (issue #142).
 *
 * The file routes to the open window whose sidebar folder tree *contains* it —
 * i.e. whose folder is an ancestor of (or equal to) the file's path. When more
 * than one open window contains the file (e.g. one rooted at `/proj` and a
 * nested one at `/proj/docs`), the most specific (deepest / longest-path) folder
 * wins, so the file lands in the window that visibly shows its directory.
 *
 * Returns `null` when no open window's tree contains the file; the caller then
 * spawns a new window rooted at the file's own directory tree.
 *
 * Containment is decided on *canonical* path segments, not a raw `startsWith`,
 * so `/proj/docs` does NOT contain `/proj/docs-old/x.md`. The caller is
 * responsible for canonicalizing `file` and the folder map values first
 * (`canonicalize_path`), exactly as `resolve_folder_root` already canonicalizes
 * the folder roots stored in `folderByLabel`.
 *
 * Blank windows (folder null/undefined) never contain anything.
 */
export function deepestContainingFolder(input: {
  file: string;
  folderByLabel: ReadonlyMap<string, string | null>;
}): { label: string; folder: string } | null {
  const fileSegs = pathSegments(input.file);
  let best: { label: string; folder: string; depth: number } | null = null;
  for (const [label, folder] of input.folderByLabel) {
    if (folder == null) continue;
    const folderSegs = pathSegments(folder);
    if (!segmentsContain(folderSegs, fileSegs)) continue;
    const depth = folderSegs.length;
    if (!best || depth > best.depth) best = { label, folder, depth };
  }
  return best ? { label: best.label, folder: best.folder } : null;
}

/** Split an absolute path into non-empty segments. Trailing slashes and
 *  doubled separators collapse, so `/proj/docs/` and `/proj/docs` match. */
function pathSegments(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/** True when `folderSegs` is a prefix of (or equal to) `fileSegs` on a real
 *  segment boundary — i.e. the folder is an ancestor of, or the same as, the
 *  file. `/proj/docs` contains `/proj/docs/x.md` and `/proj/docs` itself, but
 *  not `/proj/docs-old/x.md`. */
function segmentsContain(folderSegs: string[], fileSegs: string[]): boolean {
  if (folderSegs.length > fileSegs.length) return false;
  for (let i = 0; i < folderSegs.length; i++) {
    if (folderSegs[i] !== fileSegs[i]) return false;
  }
  return true;
}

/**
 * Drop duplicate folders from a restorable session set, keeping the newest
 * entry (by timestampMs) per folder. Blank windows (folder null/undefined) are
 * never deduped against each other. Survivor order matches input order.
 *
 * Live routing already guarantees a 1:1 folder→window mapping, so this only
 * matters for a stale / legacy / corrupted store (#100 safety net).
 */
export function dedupeSessionByFolder(
  entries: readonly WindowSessionEntry[],
): WindowSessionEntry[] {
  // Winner per folder: highest timestampMs.
  const winnerByFolder = new Map<string, WindowSessionEntry>();
  for (const e of entries) {
    if (e.folder == null) continue;
    const cur = winnerByFolder.get(e.folder);
    if (!cur || e.timestampMs > cur.timestampMs) winnerByFolder.set(e.folder, e);
  }
  return entries.filter((e) => {
    if (e.folder == null) return true;
    return winnerByFolder.get(e.folder) === e;
  });
}
