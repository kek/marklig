import { getValue, setValue } from "./store";

// Recent-folder list, kept separate from the file recents because a project
// represents a place to navigate to, not a document to load. Mirrors the
// recents.ts API so the menu layer can populate the submenu identically.

export const RECENT_PROJECTS_LIMIT = 10;
const KEY = "recentProjects";

export async function loadRecentProjects(): Promise<string[]> {
  return (await getValue<string[]>(KEY)) ?? [];
}

export async function recordRecentProject(path: string): Promise<void> {
  const current = await loadRecentProjects();
  const filtered = current.filter((p) => p !== path);
  filtered.unshift(path);
  const capped = filtered.slice(0, RECENT_PROJECTS_LIMIT);
  await setValue(KEY, capped);
}

export async function clearRecentProjects(): Promise<void> {
  await setValue<string[]>(KEY, []);
}
