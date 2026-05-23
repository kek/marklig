import type { EditorView } from "@codemirror/view";

import { setMode } from "../editor/editor";
import type { Mode, ModeExtensions } from "../editor/editor";
import { t } from "../i18n/strings";

export interface ToolbarOptions {
  view: EditorView;
  modeExtensions: { reading: ModeExtensions; edit: ModeExtensions };
  initialMode: Mode;
  onModeChange?: (mode: Mode) => void;
  onSidebarToggle?: () => void;
  /** Whether the TOC sidebar is initially open — used to set the toggle's
   * aria-pressed / active visual state at mount time. */
  initialSidebarVisible?: boolean;
}

export interface ToolbarHandle {
  setDirty: (dirty: boolean) => void;
  setMode: (mode: Mode) => void;
  /** Reflect TOC sidebar visibility in the toggle's pressed/active state. */
  setSidebarVisible: (visible: boolean) => void;
  /** Update the document-stat readout (words / chars / reading time). */
  setStats: (stats: DocStats) => void;
  /** Update the path readout in the toolbar. Pass null when no doc is open. */
  setPath: (path: string | null) => void;
  /** Update the right-side transient status text (e.g. Typst compile state).
   * Pass null to clear. */
  setStatus: (text: string | null) => void;
}

export interface DocStats {
  words: number;
  chars: number;
  /** Reading-time estimate in minutes, rounded up; 0 for empty docs. */
  readingMinutes: number;
}

export function mountToolbar(parent: HTMLElement, opts: ToolbarOptions): ToolbarHandle {
  const bar = document.createElement("div");
  bar.className = "viewer-toolbar";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "viewer-toolbar-btn viewer-toolbar-btn--icon";
  // Edit toggle stays "pressed" while editing — that's the active state.
  toggle.setAttribute("aria-pressed", "false");

  let mode: Mode = opts.initialMode;
  applyButtonLabel();

  toggle.addEventListener("click", () => {
    mode = mode === "reading" ? "edit" : "reading";
    setMode(opts.view, mode, opts.modeExtensions[mode]);
    applyButtonLabel();
    opts.onModeChange?.(mode);
  });

  const sidebar = document.createElement("button");
  sidebar.type = "button";
  sidebar.className = "viewer-toolbar-btn viewer-toolbar-btn--icon";
  sidebar.innerHTML = ICON_TOC;
  sidebar.setAttribute("aria-label", t("toolbar.toc"));
  sidebar.title = t("toolbar.toc.title");
  sidebar.setAttribute("aria-pressed", opts.initialSidebarVisible ? "true" : "false");
  sidebar.addEventListener("click", () => opts.onSidebarToggle?.());

  const dirty = document.createElement("span");
  dirty.className = "viewer-dirty-indicator";
  dirty.textContent = "";

  // Path readout in the middle of the toolbar — collapses to file name only
  // when the path is too wide for the available space (CSS overflow + RTL).
  const pathEl = document.createElement("span");
  pathEl.className = "viewer-toolbar-path";

  // Spacer pushes the doc-stats readout to the right edge of the toolbar.
  const spacer = document.createElement("span");
  spacer.className = "viewer-toolbar-spacer";

  const stats = document.createElement("span");
  stats.className = "viewer-toolbar-stats";

  // Right-side status slot (Typst compile progress / timing). Sits between
  // path and stats; empty (no padding) when there's nothing to show.
  const status = document.createElement("span");
  status.className = "viewer-toolbar-status";

  bar.append(toggle, sidebar, dirty, pathEl, spacer, status, stats);
  parent.prepend(bar);

  function applyButtonLabel(): void {
    // The edit toggle is a "current mode → press to switch" affordance:
    //   reading mode  → button shows the EDIT icon, label "Edit"
    //   edit mode     → button shows the READ icon, label "Read"
    // aria-pressed reflects "edit mode is on" so screen readers convey the
    // toggle state, not the icon glyph.
    if (mode === "reading") {
      toggle.innerHTML = ICON_EDIT;
      toggle.setAttribute("aria-label", t("toolbar.edit"));
      toggle.title = t("toolbar.edit.title");
      toggle.setAttribute("aria-pressed", "false");
    } else {
      toggle.innerHTML = ICON_READ;
      toggle.setAttribute("aria-label", t("toolbar.read"));
      toggle.title = t("toolbar.read.title");
      toggle.setAttribute("aria-pressed", "true");
    }
  }

  return {
    setDirty(d) { dirty.textContent = d ? "•" : ""; },
    setMode(m) {
      mode = m;
      applyButtonLabel();
    },
    setSidebarVisible(visible) {
      sidebar.setAttribute("aria-pressed", visible ? "true" : "false");
    },
    setPath(p) {
      // Show the file name in the toolbar (so it's always visible regardless
      // of path length); keep the full path in the title attribute and the
      // dataset for hover/tooling. Long paths in the toolbar would just
      // ellipsis-truncate to the leading dirs, which isn't useful.
      pathEl.textContent = p ? basename(p) : "";
      pathEl.title = p ?? "";
      if (p) pathEl.dataset.path = p;
      else delete pathEl.dataset.path;
    },
    setStats(s) {
      // Keep this terse: writers typically scan the toolbar, not parse it.
      // 'min' for reading time; '·' separator instead of pipes/commas.
      const w = s.words.toLocaleString();
      const c = s.chars.toLocaleString();
      stats.textContent =
        s.words > 0
          ? `${w} words · ${c} chars · ${s.readingMinutes} min`
          : `${c} chars`;
    },
    setStatus(text) {
      status.textContent = text ?? "";
    },
  };
}

function basename(path: string): string {
  const m = path.match(/[^\\/]+$/);
  return m ? m[0] : path;
}

/** Compute word/char counts and a reading-time estimate from raw markdown.
 * Words are runs of letters/digits, optionally containing apostrophes and
 * hyphens (so contractions and hyphenated terms count as one). Markdown
 * syntax (`#`, `**`, code fences, HTML tags) is stripped before counting,
 * so `**bold**` reads as one word and `\`code\`` doesn't count.
 * Reading speed: 200 wpm — about right for the kind of doc this app reads
 * (technical / prose mix). */
export function computeDocStats(source: string): DocStats {
  const cleaned = source
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`\n]*`/g, " ")        // inline code
    .replace(/<[^>]+>/g, " ");         // HTML tags
  // Word = one alphanumeric followed by alphanumeric/apostrophe/hyphen.
  // Avoids counting standalone punctuation like '!' or '—' as words.
  const words = (cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? []).length;
  const chars = source.length;
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  return { words, chars, readingMinutes };
}

// Inline SVGs (Lucide-style 24×24 outline strokes). Embedded as strings so the
// app stays free of icon-font / icon-package dependencies. `aria-hidden` keeps
// AT from announcing the glyph — the surrounding button carries the label.
// Strokes use `currentColor` so dark/light themes inherit the correct hue from
// the toolbar button's color, no per-theme overrides needed.
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Lucide `pencil` (edit). */
const ICON_EDIT =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>` +
  `<path d="m15 5 4 4"/>` +
  `</svg>`;

/** Lucide `book-open` (read). */
const ICON_READ =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M12 7v14"/>` +
  `<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>` +
  `</svg>`;

/** Lucide `list` (table of contents). */
const ICON_TOC =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M3 5h.01"/>` +
  `<path d="M3 12h.01"/>` +
  `<path d="M3 19h.01"/>` +
  `<path d="M8 5h13"/>` +
  `<path d="M8 12h13"/>` +
  `<path d="M8 19h13"/>` +
  `</svg>`;
