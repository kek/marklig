// Quick-switcher palette for recent projects (issue #27). Bound to Ctrl+R
// (literal Ctrl, even on macOS, so Cmd+R stays free for the reload convention).
//
// The filter and ranking logic is exported separately so tests can exercise it
// without booting the DOM/modal harness.

import { t } from "../i18n/strings";
import { loadRecentProjects } from "../shell/recent-projects";
import { dispatchToFocused } from "../shell/menu-actions";

/** Split a path into basename + parent. Handles both POSIX and Windows
 * separators so Finder-style and File Explorer-style paths both render. */
export function splitPath(path: string): { base: string; parent: string } {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return { base: path, parent: "" };
  return { base: path.slice(idx + 1), parent: path.slice(0, idx) };
}

export interface ProjectMatch {
  path: string;
  /** Index in the source array (preserves recency tiebreaker). */
  recencyIndex: number;
  /** 0 = basename hit, 1 = parent-dir-only hit. */
  rank: number;
}

/** Filter+rank recent-project entries by a substring query (case-insensitive).
 * Order: basename matches first, then parent-only matches; within each rank,
 * most-recent (lower recencyIndex) comes first. Empty query returns all
 * entries in original (most-recent-first) order. */
export function filterProjects(paths: readonly string[], query: string): ProjectMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return paths.map((path, recencyIndex) => ({ path, recencyIndex, rank: 0 }));
  }
  const matches: ProjectMatch[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const lower = path.toLowerCase();
    if (!lower.includes(q)) continue;
    const { base } = splitPath(path);
    const rank = base.toLowerCase().includes(q) ? 0 : 1;
    matches.push({ path, recencyIndex: i, rank });
  }
  matches.sort((a, b) => a.rank - b.rank || a.recencyIndex - b.recencyIndex);
  return matches;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let titleSeq = 0;
let openInstance: { dismiss: () => void } | null = null;

/** Open the project switcher palette. No-op if any modal is already open. */
export async function openProjectPalette(): Promise<void> {
  // Coexist with the shared modal helper: don't stack on top of preferences /
  // shortcuts dialogs, and don't double-open ourselves.
  if (openInstance) return;
  if (document.querySelector(".viewer-prefs-overlay")) return;

  const projects = await loadRecentProjects();
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  // Reuse the prefs overlay class so the openModal() guard sees us and the
  // styling stays consistent.
  overlay.className = "viewer-prefs-overlay";

  const card = document.createElement("div");
  card.className = "viewer-prefs-card viewer-palette-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  const titleId = `viewer-palette-title-${++titleSeq}`;
  card.setAttribute("aria-labelledby", titleId);

  const heading = document.createElement("h3");
  heading.id = titleId;
  heading.textContent = t("palette.projects.title");
  card.append(heading);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "viewer-palette-input";
  input.placeholder = t("palette.projects.placeholder");
  input.setAttribute("aria-label", t("palette.projects.placeholder"));
  input.autocomplete = "off";
  input.spellcheck = false;
  card.append(input);

  const listEl = document.createElement("ul");
  listEl.className = "viewer-palette-list";
  listEl.setAttribute("role", "listbox");
  card.append(listEl);

  const emptyEl = document.createElement("p");
  emptyEl.className = "viewer-palette-empty";
  card.append(emptyEl);

  let current: ProjectMatch[] = [];
  let selectedIdx = 0;

  function dismiss(): void {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", onKey, true);
    openInstance = null;
    previouslyFocused?.focus?.();
  }

  function activate(): void {
    const match = current[selectedIdx];
    if (!match) return;
    dismiss();
    void dispatchToFocused({ type: "openProject", path: match.path });
  }

  function renderRow(match: ProjectMatch, idx: number): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "viewer-palette-row";
    li.setAttribute("role", "option");
    li.dataset.idx = String(idx);
    if (idx === selectedIdx) {
      li.classList.add("is-selected");
      li.setAttribute("aria-selected", "true");
    } else {
      li.setAttribute("aria-selected", "false");
    }
    const { base, parent } = splitPath(match.path);
    const baseEl = document.createElement("span");
    baseEl.className = "viewer-palette-base";
    baseEl.textContent = base || match.path;
    li.append(baseEl);
    if (parent.length > 0) {
      const parentEl = document.createElement("span");
      parentEl.className = "viewer-palette-parent";
      parentEl.textContent = parent;
      li.append(parentEl);
    }
    li.addEventListener("mousedown", (e) => {
      // mousedown so the input doesn't lose focus to a transient click target;
      // selecting an entry should commit immediately.
      e.preventDefault();
      selectedIdx = idx;
      activate();
    });
    return li;
  }

  function render(): void {
    listEl.replaceChildren();
    if (current.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = projects.length === 0
        ? t("palette.projects.empty")
        : t("palette.projects.noMatches");
      return;
    }
    listEl.hidden = false;
    emptyEl.hidden = true;
    for (let i = 0; i < current.length; i++) {
      listEl.append(renderRow(current[i], i));
    }
    const sel = listEl.querySelector<HTMLElement>(".is-selected");
    sel?.scrollIntoView({ block: "nearest" });
  }

  function recompute(): void {
    current = filterProjects(projects, input.value);
    selectedIdx = current.length > 0 ? 0 : -1;
    render();
  }

  function move(delta: number): void {
    if (current.length === 0) return;
    selectedIdx = (selectedIdx + delta + current.length) % current.length;
    render();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(+1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate();
      return;
    }
    if (e.key !== "Tab") return;
    // Trap Tab inside the card so focus can't escape into the editor.
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  input.addEventListener("input", recompute);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dismiss();
  });
  // useCapture so Escape always wins over CodeMirror / other keydown handlers.
  document.addEventListener("keydown", onKey, true);

  overlay.append(card);
  document.body.append(overlay);
  openInstance = { dismiss };

  recompute();
  input.focus();
}

/** Test/teardown helper — close any open palette synchronously. */
export function _closeProjectPaletteForTests(): void {
  openInstance?.dismiss();
}
