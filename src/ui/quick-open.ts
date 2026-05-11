// VS Code-style fuzzy file finder palette, opened with Cmd-P. Lists every
// markdown file under the currently-open folder root (same source as the
// sidebar's list_markdown_files) and lets the user pick one with a fuzzy
// substring match on the relative path. Enter dispatches a menu-action event
// to load the file in the focused window; Esc closes.
//
// Implementation notes:
//   - Custom modal (not openModal()) because we need full control over
//     keyboard nav (Up/Down/Enter/Esc, no Tab cycling), and a tighter card
//     shape than the preferences modal.
//   - No innerHTML: matched-char highlighting builds Text + <span> children.
//   - The file list is fetched on open() and cached for the palette
//     session; reopening fetches again. The folder is small enough that
//     this is fine without incremental refresh.

import { listMarkdownFiles, type MarkdownFileEntry } from "../shell/files";
import { dispatchToFocused } from "../shell/menu-actions";
import { t } from "../i18n/strings";
import { buildHighlightedSpans, scoreMatch, type FuzzyMatch } from "./fuzzy";

interface ScoredEntry {
  entry: MarkdownFileEntry;
  match: FuzzyMatch;
}

let activePalette: { close: () => void } | null = null;

/** Open the Cmd-P palette. If no folder is open, shows a muted hint and
 * the user can still Esc out. No-op if a palette is already open. */
export async function openQuickOpenPalette(folderRoot: string | null): Promise<void> {
  if (activePalette) return;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "viewer-quick-open-overlay";

  const card = document.createElement("div");
  card.className = "viewer-quick-open-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("quickOpen.title"));

  const input = document.createElement("input");
  input.type = "text";
  input.className = "viewer-quick-open-input";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", t("quickOpen.inputLabel"));
  input.placeholder = t("quickOpen.placeholder");

  const list = document.createElement("ul");
  list.className = "viewer-quick-open-list";
  list.setAttribute("role", "listbox");

  const empty = document.createElement("p");
  empty.className = "viewer-quick-open-empty";

  card.append(input, list, empty);
  overlay.append(card);
  document.body.append(overlay);

  let entries: MarkdownFileEntry[] = [];
  let scored: ScoredEntry[] = [];
  let selected = 0;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    activePalette = null;
    document.removeEventListener("keydown", onGlobalKey, true);
    overlay.remove();
    previouslyFocused?.focus?.();
  }
  activePalette = { close };

  function renderEmpty(message: string): void {
    list.replaceChildren();
    empty.textContent = message;
    empty.style.display = "block";
  }

  function renderRows(): void {
    empty.style.display = "none";
    list.replaceChildren();
    if (scored.length === 0) {
      renderEmpty(t("quickOpen.noMatches"));
      return;
    }
    for (let i = 0; i < scored.length; i++) {
      const { entry, match } = scored[i];
      const li = document.createElement("li");
      li.className = "viewer-quick-open-row";
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      if (i === selected) {
        li.classList.add("selected");
        li.setAttribute("aria-selected", "true");
      }

      // The fuzzy positions index into the *relative* string. Split into
      // basename + parent dir for the two-line display (filename prominent,
      // path muted), translating the position indices accordingly.
      const rel = entry.relative;
      const sepIdx = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
      const dir = sepIdx >= 0 ? rel.slice(0, sepIdx) : "";
      const base = sepIdx >= 0 ? rel.slice(sepIdx + 1) : rel;
      const baseStart = sepIdx + 1;

      const baseEl = document.createElement("span");
      baseEl.className = "viewer-quick-open-basename";
      const basePositions = match.positions
        .filter((p) => p >= baseStart)
        .map((p) => p - baseStart);
      for (const node of buildHighlightedSpans(base, basePositions)) {
        baseEl.append(node);
      }

      const dirEl = document.createElement("span");
      dirEl.className = "viewer-quick-open-dir";
      if (dir.length > 0) {
        const dirPositions = match.positions.filter((p) => p < baseStart);
        for (const node of buildHighlightedSpans(dir, dirPositions)) {
          dirEl.append(node);
        }
      }

      li.append(baseEl);
      if (dir.length > 0) li.append(dirEl);
      li.addEventListener("mousedown", (e) => {
        // Prevent the input from losing focus before we read the index;
        // also stops the global keyhandler from racing the click.
        e.preventDefault();
      });
      li.addEventListener("click", () => {
        selected = i;
        activate();
      });
      list.append(li);
    }
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView(): void {
    const el = list.querySelector<HTMLElement>(".viewer-quick-open-row.selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  function refilter(): void {
    const q = input.value.trim();
    if (q.length === 0) {
      // Empty query: show all entries in stable (relative-path) order.
      scored = entries.map((entry) => ({
        entry,
        match: { score: 0, positions: [] },
      }));
    } else {
      const matched: ScoredEntry[] = [];
      for (const entry of entries) {
        const m = scoreMatch(entry.relative, q);
        if (m) matched.push({ entry, match: m });
      }
      matched.sort((a, b) => {
        if (b.match.score !== a.match.score) return b.match.score - a.match.score;
        return a.entry.relative.localeCompare(b.entry.relative);
      });
      scored = matched;
    }
    selected = 0;
    renderRows();
  }

  function activate(): void {
    if (scored.length === 0) return;
    const pick = scored[selected];
    if (!pick) return;
    close();
    void dispatchToFocused({ type: "openRecent", path: pick.entry.path });
  }

  function move(delta: number): void {
    if (scored.length === 0) return;
    selected = (selected + delta + scored.length) % scored.length;
    // Re-render highlight without rebuilding rows: cheaper toggle.
    const rows = list.querySelectorAll<HTMLElement>(".viewer-quick-open-row");
    rows.forEach((row, idx) => {
      const sel = idx === selected;
      row.classList.toggle("selected", sel);
      if (sel) row.setAttribute("aria-selected", "true");
      else row.removeAttribute("aria-selected");
    });
    scrollSelectedIntoView();
  }

  function onGlobalKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
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
  }

  document.addEventListener("keydown", onGlobalKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  input.addEventListener("input", refilter);
  input.focus();

  if (!folderRoot) {
    renderEmpty(t("quickOpen.noFolder"));
    return;
  }

  // Render a transient loading row while the Rust walker runs. For most
  // repos this returns in well under a frame, but very large trees can
  // take a moment.
  renderEmpty(t("quickOpen.loading"));
  try {
    entries = await listMarkdownFiles(folderRoot);
  } catch {
    if (!closed) renderEmpty(t("quickOpen.error"));
    return;
  }
  if (closed) return;
  refilter();
}
