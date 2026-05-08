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
}

export async function clearRecents(): Promise<void> {
  await setValue<string[]>(KEY, []);
}
