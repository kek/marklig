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
