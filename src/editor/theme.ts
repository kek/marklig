export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "viewer.theme";

export function applyTheme(theme: Theme): void {
  const html = document.documentElement;
  html.classList.remove("theme-light", "theme-dark");
  if (theme === "system") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    html.classList.add(mq.matches ? "theme-dark" : "theme-light");
  } else {
    html.classList.add(`theme-${theme}`);
  }
}

export function loadStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export function storeTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

/** Apply a theme and persist the choice. Use this for user-driven theme changes. */
export function setActiveTheme(theme: Theme): void {
  applyTheme(theme);
  storeTheme(theme);
}
