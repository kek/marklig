import type { EditorView } from "@codemirror/view";

import { setMode } from "../editor/editor";
import type { Mode, ModeExtensions } from "../editor/editor";

export interface ToolbarOptions {
  view: EditorView;
  modeExtensions: { reading: ModeExtensions; edit: ModeExtensions };
  initialMode: Mode;
  onModeChange?: (mode: Mode) => void;
  onSidebarToggle?: () => void;
}

export interface ToolbarHandle {
  setDirty: (dirty: boolean) => void;
  setMode: (mode: Mode) => void;
  /** Update the document-stat readout (words / chars / reading time). */
  setStats: (stats: DocStats) => void;
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
  toggle.className = "viewer-toolbar-btn";

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
  sidebar.className = "viewer-toolbar-btn";
  sidebar.textContent = "TOC";
  sidebar.title = "Toggle table of contents";
  sidebar.addEventListener("click", () => opts.onSidebarToggle?.());

  const dirty = document.createElement("span");
  dirty.className = "viewer-dirty-indicator";
  dirty.textContent = "";

  // Spacer pushes the doc-stats readout to the right edge of the toolbar.
  const spacer = document.createElement("span");
  spacer.className = "viewer-toolbar-spacer";

  const stats = document.createElement("span");
  stats.className = "viewer-toolbar-stats";

  bar.append(toggle, sidebar, dirty, spacer, stats);
  parent.prepend(bar);

  function applyButtonLabel(): void {
    toggle.textContent = mode === "reading" ? "Edit" : "Read";
    toggle.title = mode === "reading"
      ? "Switch to edit mode (Cmd/Ctrl+E)"
      : "Switch to reading mode (Cmd/Ctrl+E)";
  }

  return {
    setDirty(d) { dirty.textContent = d ? "•" : ""; },
    setMode(m) {
      mode = m;
      applyButtonLabel();
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
  };
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
