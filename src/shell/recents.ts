import { invoke } from "@tauri-apps/api/core";

import { getValue, setValue } from "./store";

export const RECENTS_LIMIT = 10;
const KEY = "recents";

export async function loadRecents(): Promise<string[]> {
  return (await getValue<string[]>(KEY)) ?? [];
}

export async function recordRecent(path: string): Promise<void> {
  const current = await loadRecents();
  const filtered = current.filter((p) => p !== path);
  filtered.unshift(path);
  const capped = filtered.slice(0, RECENTS_LIMIT);
  await setValue(KEY, capped);
  // Surface in OS-level recents (macOS NSDocumentController; no-op on
  // Windows/Linux for now). Best-effort: failure shouldn't block the open.
  try {
    await invoke("register_recent_document", { path });
  } catch {
    // ignore — OS recents is decorative, not load-bearing
  }
}

export async function clearRecents(): Promise<void> {
  await setValue<string[]>(KEY, []);
}

/** Swap an old path for a new one in the recents list, preserving order.
 * Used by the in-app rename flow so the recents menu doesn't point at a
 * stale path on disk. If `oldPath` isn't in the list this is a no-op
 * rather than a prepend — rename of a file that was never opened
 * shouldn't surface it as a recent. */
export async function renameRecent(oldPath: string, newPath: string): Promise<void> {
  if (oldPath === newPath) return;
  const current = await loadRecents();
  const idx = current.indexOf(oldPath);
  if (idx === -1) return;
  // Also remove an existing newPath entry to keep the list deduped.
  const filtered = current.filter((p, i) => i !== idx && p !== newPath);
  filtered.splice(idx, 0, newPath);
  await setValue(KEY, filtered.slice(0, RECENTS_LIMIT));
}
