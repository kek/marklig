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
