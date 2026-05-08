const STORAGE_KEY = "viewer.toc-explicit";

type ExplicitChoice = boolean | null;

function loadExplicit(): ExplicitChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function storeExplicit(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export function shouldShowSidebar(_path: string, headingCount: number): boolean {
  const explicit = loadExplicit();
  if (explicit !== null) return explicit;
  return headingCount >= 3;
}

export function recordExplicitToggle(visible: boolean): void {
  storeExplicit(visible);
}

export function resetTocStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
