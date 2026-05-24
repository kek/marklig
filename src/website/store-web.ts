// localStorage-backed peer of src/shell/store.ts for the website deploy
// target. The Vite alias in vite.config.website.ts swaps this in for the
// shell/store module during the website build, so consumers upstream
// (src/shell/settings.ts → src/ui/sidebar/toc.ts) don't know they're
// talking to localStorage instead of Tauri Store.
//
// All four exports keep the original async signatures so callers in
// shell/settings.ts (which await them) work without modification.
//
// Keys are namespaced under `marklig.web.` to keep this storage island
// out of any other localStorage usage the page might pick up.

const NS = "marklig.web.";

export async function getValue<T>(key: string): Promise<T | undefined> {
  const raw = localStorage.getItem(NS + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function setValue<T>(key: string, value: T): Promise<void> {
  localStorage.setItem(NS + key, JSON.stringify(value));
}

export async function deleteValue(key: string): Promise<void> {
  localStorage.removeItem(NS + key);
}

export async function listKeys(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) out.push(k.slice(NS.length));
  }
  return out;
}
