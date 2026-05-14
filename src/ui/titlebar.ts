import { setMode } from "../editor/editor";
import type { Mode } from "../editor/editor";
import { t } from "../i18n/strings";
import type { DocStats, ToolbarHandle, ToolbarOptions } from "./toolbar";

// Re-export for callers that want to swap mount points without re-importing
// from toolbar.ts.
export type { DocStats, ToolbarHandle, ToolbarOptions } from "./toolbar";

/** Set the OS window title (and document.title as a fallback when the Tauri
 *  API isn't reachable — e.g. in tests / vite-only `npm run dev`). */
export async function setWindowTitle(path: string | null, dirty: boolean): Promise<void> {
  const base = path ? basename(path) : "Viewer";
  const title = dirty ? `• ${base}` : base;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    document.title = title;
  }
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Detect macOS so the frontend can branch on platform-specific window chrome
 *  (overlay titlebar with traffic-light spacer). Uses `navigator.userAgent`
 *  because the OS plugin isn't wired and userAgent is reliable for the four
 *  desktop targets we ship.
 *
 *  Exported so tests / other modules can override-test the detection without
 *  monkey-patching navigator. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated but still reliable for desktop OS sniffing;
  // userAgent fallback covers webviews that scrub it.
  const platformStr = (navigator.platform ?? "").toLowerCase();
  if (platformStr.includes("mac")) return true;
  const ua = (navigator.userAgent ?? "").toLowerCase();
  return ua.includes("mac os x") || ua.includes("macintosh");
}

/** Tag <html> with a platform class so CSS rules can branch (e.g. hide the
 *  legacy toolbar on macOS where the titlebar carries those controls). Safe
 *  to call repeatedly. */
export function applyPlatformClass(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (isMacPlatform()) {
    root.classList.add("platform-macos");
  } else {
    root.classList.remove("platform-macos");
  }
}

/** Mount the custom macOS titlebar (overlay style). Hosts the edit-mode
 *  toggle, TOC toggle, file-name readout, and the doc-stats counters. The
 *  whole bar drags the window (-webkit-app-region: drag); interactive
 *  elements opt out individually via no-drag.
 *
 *  Returns the same `ToolbarHandle` shape as `mountToolbar` so the caller can
 *  use the two interchangeably. */
export function mountTitlebar(parent: HTMLElement, opts: ToolbarOptions): ToolbarHandle {
  const bar = document.createElement("header");
  bar.className = "viewer-titlebar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Window toolbar");
  // Tauri 2 drives window-drag through the data attribute, not the legacy
  // -webkit-app-region CSS. The handler matches on event.target directly,
  // so every non-interactive descendant also needs the attribute or the
  // bar only drags from its own background pixels.
  bar.setAttribute("data-tauri-drag-region", "");

  const spacer = document.createElement("span");
  spacer.className = "viewer-titlebar-spacer-left";
  spacer.setAttribute("data-tauri-drag-region", "");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "viewer-titlebar-btn viewer-titlebar-btn--icon";
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
  sidebar.className = "viewer-titlebar-btn viewer-titlebar-btn--icon";
  sidebar.innerHTML = ICON_TOC;
  sidebar.setAttribute("aria-label", t("toolbar.toc"));
  sidebar.title = t("toolbar.toc.title");
  sidebar.setAttribute("aria-pressed", opts.initialSidebarVisible ? "true" : "false");
  sidebar.addEventListener("click", () => opts.onSidebarToggle?.());

  // Centred file-name block: dirty indicator prefix + path readout. We wrap
  // them so the whole thing centres as one unit between left and right
  // groups. The bullet is plain text (no SVG) so it picks up the accent
  // colour through CSS variables.
  const nameWrap = document.createElement("span");
  nameWrap.className = "viewer-titlebar-name";
  nameWrap.setAttribute("data-tauri-drag-region", "");
  const dirty = document.createElement("span");
  dirty.className = "viewer-titlebar-dirty";
  dirty.textContent = "";
  dirty.setAttribute("data-tauri-drag-region", "");
  const pathEl = document.createElement("span");
  pathEl.className = "viewer-titlebar-path";
  pathEl.setAttribute("data-tauri-drag-region", "");
  nameWrap.append(dirty, pathEl);

  const stats = document.createElement("span");
  stats.className = "viewer-titlebar-stats";
  stats.setAttribute("data-tauri-drag-region", "");

  const left = document.createElement("span");
  left.className = "viewer-titlebar-group viewer-titlebar-group--left";
  left.setAttribute("data-tauri-drag-region", "");
  left.append(spacer, toggle, sidebar);

  const centre = document.createElement("span");
  centre.className = "viewer-titlebar-group viewer-titlebar-group--centre";
  centre.setAttribute("data-tauri-drag-region", "");
  centre.append(nameWrap);

  const right = document.createElement("span");
  right.className = "viewer-titlebar-group viewer-titlebar-group--right";
  right.setAttribute("data-tauri-drag-region", "");
  right.append(stats);

  bar.append(left, centre, right);
  parent.prepend(bar);

  function applyButtonLabel(): void {
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
      pathEl.textContent = p ? basenameFile(p) : "";
      pathEl.title = p ?? "";
      if (p) pathEl.dataset.path = p;
      else delete pathEl.dataset.path;
    },
    setStats(s: DocStats) {
      const w = s.words.toLocaleString();
      const c = s.chars.toLocaleString();
      stats.textContent =
        s.words > 0
          ? `${w} words · ${c} chars · ${s.readingMinutes} min`
          : `${c} chars`;
    },
  };
}

function basenameFile(path: string): string {
  const m = path.match(/[^\\/]+$/);
  return m ? m[0] : path;
}

// Lucide-style inline SVGs duplicated from toolbar.ts. Kept inline (rather
// than imported from a shared module) so each surface can iterate on its
// own visual treatment without coupling.
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false"';

const ICON_EDIT =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>` +
  `<path d="m15 5 4 4"/>` +
  `</svg>`;

const ICON_READ =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M12 7v14"/>` +
  `<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>` +
  `</svg>`;

const ICON_TOC =
  `<svg ${SVG_ATTRS}>` +
  `<path d="M3 5h.01"/>` +
  `<path d="M3 12h.01"/>` +
  `<path d="M3 19h.01"/>` +
  `<path d="M8 5h13"/>` +
  `<path d="M8 12h13"/>` +
  `<path d="M8 19h13"/>` +
  `</svg>`;

