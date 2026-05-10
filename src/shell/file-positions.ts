import { getValue, setValue } from "./store";

/** Canonicalize an absolute path so two spellings of the same file (e.g.
 * `/foo/./bar.md` vs `/foo/bar.md`, or `/foo//bar.md`) collapse to the
 * same key. Falls back to the input on environments without the Tauri
 * path API (tests / vite-only). */
export async function canonicalizePath(path: string): Promise<string> {
  try {
    const { normalize } = await import("@tauri-apps/api/path");
    return await normalize(path);
  } catch {
    return path;
  }
}

/** Per-file scroll/cursor position. Keyed by absolute file path in the
 * persisted map. `ts` is `Date.now()` at the time of the last write — used
 * for LRU eviction once the map exceeds {@link FILE_POSITIONS_LIMIT}. */
export interface FilePosition {
  /** scrollDOM.scrollTop in CSS pixels. */
  scrollTop: number;
  /** Best-effort cursor line (1-based). 0 if unknown. */
  line: number;
  /** Cursor column (0-based). 0 if unknown. */
  col: number;
  /** Last-write timestamp (Date.now()). */
  ts: number;
}

export type FilePositionsMap = Record<string, FilePosition>;

const KEY = "filePositions";

/** Hard cap on the number of remembered files. Oldest (smallest `ts`) entries
 * are dropped when the map grows past this. Keeps the settings file from
 * accumulating thousands of entries over the app's lifetime. */
export const FILE_POSITIONS_LIMIT = 500;

export async function loadAllFilePositions(): Promise<FilePositionsMap> {
  const stored = await getValue<FilePositionsMap>(KEY);
  return stored ?? {};
}

export async function getFilePosition(path: string): Promise<FilePosition | null> {
  const all = await loadAllFilePositions();
  return all[path] ?? null;
}

/** Persist a position for `path`, evicting the oldest entries if the map
 * grows past {@link FILE_POSITIONS_LIMIT}. */
export async function setFilePosition(path: string, pos: Omit<FilePosition, "ts">): Promise<void> {
  const all = await loadAllFilePositions();
  all[path] = { ...pos, ts: Date.now() };
  const trimmed = lruTrim(all, FILE_POSITIONS_LIMIT);
  await setValue<FilePositionsMap>(KEY, trimmed);
}

export async function clearFilePosition(path: string): Promise<void> {
  const all = await loadAllFilePositions();
  if (!(path in all)) return;
  delete all[path];
  await setValue<FilePositionsMap>(KEY, all);
}

export async function clearAllFilePositions(): Promise<void> {
  await setValue<FilePositionsMap>(KEY, {});
}

/** Pure LRU trim: if `map` has more than `limit` entries, drop the
 * smallest-`ts` entries until it fits. Mutates and returns `map`. Exported
 * for unit tests. */
export function lruTrim(map: FilePositionsMap, limit: number): FilePositionsMap {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  // Sort by ts ascending — oldest first. Keys with missing ts sort before
  // valid ones (they're effectively "ancient" and get evicted first).
  keys.sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0));
  const dropCount = keys.length - limit;
  for (let i = 0; i < dropCount; i++) {
    delete map[keys[i]];
  }
  return map;
}
