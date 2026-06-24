import { getValue, setValue } from "./store";

/** Canonicalize a path to a stable, absolute, symlink-resolved string so two
 * spellings of the same file or folder (`/foo/./bar.md` vs `/foo/bar.md`, a
 * symlinked parent, or the bare basename the CLI shim passes) collapse to one
 * key. Backed by the Rust `canonicalize_path` command (`std::fs::canonicalize`)
 * — lexical normalization alone wouldn't resolve symlinks or absolutize a
 * relative path. Falls back to the input on environments without the Tauri
 * IPC (tests / vite-only / mobile) or when the path can't be resolved (doesn't
 * exist yet). See issue #99. */
export async function canonicalizePath(path: string): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("canonicalize_path", { path });
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

/** What to do with the viewport right after a doc-load. `target` is fed to the
 * rAF scroll-restore watchdog. `restoreCursor` decides whether a cursor/
 * selection is placed: we suppress it for link-initiated opens so following an
 * internal Markdown link lands at the very top with NO highlighted section
 * (issue #161). */
export interface RestorePlan {
  target: { scrollTop: number; line: number; col: number };
  restoreCursor: boolean;
}

/** Decide whether to restore a saved position or reset to the top when a
 * document loads. Pure so it can be unit-tested without `main.ts`.
 *
 * - Link-initiated opens (`fromLink`) ALWAYS reset to the top with no cursor,
 *   regardless of any saved position — following an internal link should open
 *   the target at the very top with nothing highlighted (issue #161).
 * - Every other open path (recents, session restore, reopen-last, folder-tree)
 *   restores the saved position (cursor included) when one exists, and resets
 *   to the top otherwise (issue #146). */
export function planPositionRestore(
  saved: FilePosition | null,
  opts: { fromLink: boolean },
): RestorePlan {
  if (opts.fromLink) {
    return { target: { scrollTop: 0, line: 1, col: 0 }, restoreCursor: false };
  }
  if (saved) {
    return {
      target: { scrollTop: saved.scrollTop, line: saved.line, col: saved.col },
      restoreCursor: true,
    };
  }
  return { target: { scrollTop: 0, line: 1, col: 0 }, restoreCursor: true };
}

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
