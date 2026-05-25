import { canonicalizePath } from "./file-positions";
import { getValue, setValue } from "./store";

/**
 * Per-project "last opened file" map.
 *
 * Lets the app remember, independently for each project root the user has
 * visited, which file was last open in that project. Used both at relaunch
 * (restore the file that belonged to the *project* we're restoring, not the
 * most-recent file overall) and at project-switch (replace the buffer with
 * the file the user was last looking at in the project they're switching to,
 * not the file from the project they just left).
 *
 * Keys are canonicalised absolute paths — the same folder mounted via two
 * different spellings (`/Users/me/foo` vs `/Users/me/./foo`) hashes to the
 * same key so the lookup stays reflexive. See issue #99.
 *
 * Persisted under the `projectRecents` key on the same store as the rest of
 * the app's state. The schema is a plain `{root: lastFile}` record — small,
 * trivially JSON-able, and not worth a top-level migration.
 *
 * Hard-capped: once the map grows past PROJECT_RECENTS_LIMIT entries the
 * oldest (smallest `ts` on the value side) are dropped. Keeps the store
 * from accumulating entries forever as users wander through transient
 * projects (`/tmp/xyz`, `/var/folders/.../T/...`).
 */

export const PROJECT_RECENTS_LIMIT = 50;
const KEY = "projectRecents";

interface ProjectRecentEntry {
  /** Last absolute file path opened *in* this project. */
  path: string;
  /** Last-write timestamp (`Date.now()`) — used for LRU eviction. */
  ts: number;
}

export type ProjectRecentsMap = Record<string, ProjectRecentEntry>;

async function loadRaw(): Promise<ProjectRecentsMap> {
  const stored = await getValue<unknown>(KEY);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: ProjectRecentsMap = {};
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.path !== "string" || typeof r.ts !== "number") continue;
    out[k] = { path: r.path, ts: r.ts };
  }
  return out;
}

/** Return the canonical path string for a project root, or null if input is
 *  nullish. Errors fall back to the input — same contract as
 *  `canonicalizePath` in `file-positions.ts`. */
async function keyFor(root: string): Promise<string> {
  return await canonicalizePath(root);
}

/** Look up the file last opened in `root`. Returns null if the project is
 *  unknown or no file was recorded. */
export async function getLastFileInProject(
  root: string,
): Promise<string | null> {
  if (!root) return null;
  const key = await keyFor(root);
  const map = await loadRaw();
  return map[key]?.path ?? null;
}

/** Record that `filePath` was opened while project `root` was active. */
export async function recordFileInProject(
  root: string,
  filePath: string,
): Promise<void> {
  if (!root || !filePath) return;
  const key = await keyFor(root);
  const map = await loadRaw();
  map[key] = { path: filePath, ts: Date.now() };
  // LRU evict if we're over the cap. Sort entries by `ts` ascending, drop
  // the oldest until size <= limit. Cheap enough at 50 entries.
  const entries = Object.entries(map);
  if (entries.length > PROJECT_RECENTS_LIMIT) {
    entries.sort((a, b) => a[1].ts - b[1].ts);
    const trimmed = entries.slice(entries.length - PROJECT_RECENTS_LIMIT);
    const next: ProjectRecentsMap = {};
    for (const [k, v] of trimmed) next[k] = v;
    await setValue(KEY, next);
    return;
  }
  await setValue(KEY, map);
}

/** Forget a single project's last-opened file. Used when the file the project
 *  pointed at no longer exists on disk, so the next switch doesn't loop on a
 *  missing-file fallback. */
export async function forgetFileInProject(root: string): Promise<void> {
  if (!root) return;
  const key = await keyFor(root);
  const map = await loadRaw();
  if (!(key in map)) return;
  delete map[key];
  await setValue(KEY, map);
}

/** Wipe the entire map. Currently unused in the UI but exposed for symmetry
 *  with `clearRecents`/`clearRecentProjects` so a future "Clear all" menu
 *  item or a test reset has a single call to make. */
export async function clearProjectRecents(): Promise<void> {
  await setValue<ProjectRecentsMap>(KEY, {});
}
