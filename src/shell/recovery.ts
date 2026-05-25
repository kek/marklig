import { invoke } from "@tauri-apps/api/core";

export interface RecoveryEntry {
  originalPath: string;
  contents: string;
  timestampMs: number;
}

interface RawRecoveryEntry {
  original_path: string;
  contents: string;
  timestamp_ms: number;
}

export async function writeRecovery(originalPath: string, contents: string): Promise<void> {
  await invoke("write_recovery", { originalPath, contents });
}

export async function readAllRecovery(): Promise<RecoveryEntry[]> {
  const raw = (await invoke<RawRecoveryEntry[]>("read_all_recovery")) ?? [];
  return raw.map((r) => ({
    originalPath: r.original_path,
    contents: r.contents,
    timestampMs: r.timestamp_ms,
  }));
}

export async function clearRecovery(originalPath: string): Promise<void> {
  await invoke("clear_recovery", { originalPath });
}

/** Result of inspecting the recovery store at startup.
 *
 * - `kind: "none"` — no dump exists (or the store is empty). Normal launch.
 * - `kind: "match"` — dump exists but matches the on-disk file. Nothing was
 *    lost; the caller should drop the dump and proceed with a normal launch.
 * - `kind: "load"` — dump differs from disk (or the file is gone). The caller
 *    should load `source` into the buffer and mark it dirty against
 *    `diskBaseline` so the user sees their unsaved edits + a dirty dot.
 *
 * In every non-`none` case the caller is expected to call `clearRecovery`
 * after acting. The 5 s recovery loop will write a fresh dump for the
 * now-restored buffer if it's still dirty when the next interval fires. */
export type RecoveryAction =
  | { kind: "none" }
  | { kind: "match"; path: string }
  | { kind: "load"; path: string; source: string; diskBaseline: string };

/** Decide what to do with the recovery store at boot.
 *
 * Pure decision logic, kept out of `main.ts` so the three branches (none /
 * match / load) can be unit-tested without standing up a window. `readDisk`
 * returns the file's current on-disk contents, or null if the file is gone /
 * unreadable — a missing file still counts as "differs" so the dump isn't
 * silently dropped. */
export async function resolveRecoveryAction(
  entries: RecoveryEntry[],
  readDisk: (path: string) => Promise<string | null>,
): Promise<RecoveryAction> {
  if (entries.length === 0) return { kind: "none" };
  const entry = entries[0];
  const disk = await readDisk(entry.originalPath);
  if (disk !== null && entry.contents === disk) {
    return { kind: "match", path: entry.originalPath };
  }
  return {
    kind: "load",
    path: entry.originalPath,
    source: entry.contents,
    diskBaseline: disk ?? "",
  };
}

export interface RecoveryLoopOptions {
  intervalMs: number;
  isDirty: () => boolean;
  currentPath: () => string | null;
  currentContents: () => string;
}

/** Start a periodic recovery dump. Returns a stop function. */
export function startRecoveryLoop(opts: RecoveryLoopOptions): () => void {
  const handle = setInterval(() => {
    if (!opts.isDirty()) return;
    const path = opts.currentPath();
    if (!path) return;
    void writeRecovery(path, opts.currentContents());
  }, opts.intervalMs);
  return () => clearInterval(handle);
}
