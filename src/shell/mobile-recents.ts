// Mobile-only persisted recents. Backed by the same tauri-plugin-store
// instance the desktop already uses; the key namespace ("mobile.recents")
// is distinct so desktop / mobile recents don't conflict if both ever
// share a profile dir (currently they don't).
//
// Entries are content:// URIs (preferred) or file:// URIs. The display
// name is derived from the URI's last segment — Tauri 2's plugin-fs
// doesn't expose DocumentFile metadata, so we don't have a "true"
// display name without a Kotlin bridge. The last-segment fallback is
// good enough for v2.0 standalone use.

import { getValue, setValue } from "./store";

export interface MobileRecent {
  uri: string;
  displayName: string;
  lastOpenedMs: number;
}

const KEY = "mobile.recents";
const MAX = 20;

export async function loadRecents(): Promise<MobileRecent[]> {
  const raw = await getValue<MobileRecent[]>(KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is MobileRecent =>
      r != null &&
      typeof r.uri === "string" &&
      typeof r.displayName === "string" &&
      typeof r.lastOpenedMs === "number",
  );
}

export async function recordRecent(
  entry: Omit<MobileRecent, "lastOpenedMs">,
): Promise<void> {
  const list = await loadRecents();
  const filtered = list.filter((r) => r.uri !== entry.uri);
  const next: MobileRecent = { ...entry, lastOpenedMs: Date.now() };
  await setValue(KEY, [next, ...filtered].slice(0, MAX));
}

export async function clearRecents(): Promise<void> {
  await setValue(KEY, []);
}

export function uriDisplayName(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const lastSlash = decoded.lastIndexOf("/");
    if (lastSlash >= 0 && lastSlash < decoded.length - 1) {
      return decoded.slice(lastSlash + 1);
    }
    return decoded;
  } catch {
    return uri;
  }
}
