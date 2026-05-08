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
