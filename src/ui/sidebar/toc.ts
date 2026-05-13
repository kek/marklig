import type { EditorView } from "@codemirror/view";

import { parseMarkdown } from "../../editor/parser";
import { t } from "../../i18n/strings";
import { getTocSectionOpen, setTocSectionOpen } from "../../shell/settings";

export interface TocEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** Absolute source offset where the heading line starts. */
  from: number;
}

export interface TocSidebarHandle {
  element: HTMLElement;
  /** Re-extract headings from the current editor source and re-render the list. */
  refresh: () => void;
  /** Highlight the entry whose heading is at or above the given source offset. */
  setActive: (offset: number) => void;
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
  /** Update the section heading to match the currently-open document. Pass
   * null/empty to fall back to the localised "Untitled" string. */
  setDocumentTitle: (path: string | null) => void;
  destroy: () => void;
}

export interface MountTocOptions {
  view: EditorView;
  parent: HTMLElement;
  initiallyVisible: boolean;
  initialDocumentPath?: string | null;
  onActivate: (entry: TocEntry) => void;
}

/** Derive the heading label from a file path: basename without the markdown
 * extension. Falls back to the localised "Untitled" when the path is empty. */
export function documentHeadingFor(path: string | null): string {
  if (!path) return t("sidebar.toc.untitled");
  const base = path.split(/[\\/]/).pop() ?? path;
  const stripped = base.replace(/\.(md|markdown|mdx|mdown)$/i, "");
  return stripped.length > 0 ? stripped : t("sidebar.toc.untitled");
}

/** Pure heading extraction. Exported for unit tests. Skips YAML/TOML
 * frontmatter — markdown-it parses `---\n...\n---` as an hr followed by a
 * setext H2 whose content is the YAML body, which would otherwise leak into
 * the TOC as a stray entry. */
export function extractTocEntries(source: string): TocEntry[] {
  const tokens = parseMarkdown(source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const fm = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n/.exec(source);
  let frontmatterEndLine = 0;
  if (fm && fm.index === 0) {
    for (let i = 0; i < fm[0].length; i++) {
      if (source.charCodeAt(i) === 10) frontmatterEndLine++;
    }
  }
  const out: TocEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || !t.map) continue;
    if (t.map[0] < frontmatterEndLine) continue;
    const level = Number(t.tag.replace("h", "")) as TocEntry["level"];
    const inline = tokens[i + 1];
    const text = inline?.content?.trim() ?? "";
    out.push({ level, text, from: lineStarts[t.map[0]] });
  }
  return out;
}

const SIDEBAR_WIDTH_KEY = "viewer.sidebar.width";
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;

export function mountTocSidebar(opts: MountTocOptions): TocSidebarHandle {
  const aside = document.createElement("aside");
  aside.className = "viewer-toc";
  if (!opts.initiallyVisible) aside.classList.add("hidden");
  opts.parent.append(aside);

  // Restore persisted width and install a drag handle on the right edge.
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
    aside.style.setProperty("--sidebar-width", `${stored}px`);
  }
  installResizeHandle(aside);

  const headingId = "viewer-toc-heading";
  const bodyId = "viewer-toc-body";
  // Heading is a button so it's keyboard-activatable (Enter/Space) by default
  // and presents the correct semantics for a collapsible section toggle.
  const heading = document.createElement("button");
  heading.type = "button";
  heading.id = headingId;
  heading.className = "viewer-sidebar-section-heading viewer-toc-heading";
  heading.setAttribute("aria-controls", bodyId);

  const chevron = document.createElement("span");
  chevron.className = "viewer-folder-chevron viewer-sidebar-section-chevron";
  chevron.setAttribute("aria-hidden", "true");

  const headingLabel = document.createElement("span");
  headingLabel.className = "viewer-sidebar-section-heading-label";
  headingLabel.textContent = documentHeadingFor(opts.initialDocumentPath ?? null);

  heading.append(chevron, headingLabel);
  aside.append(heading);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "viewer-sidebar-section-body viewer-toc-body";

  // <nav> labelled by the heading so screen readers announce "<filename>
  // navigation" instead of an unnamed landmark.
  const list = document.createElement("nav");
  list.className = "viewer-toc-list";
  list.setAttribute("aria-labelledby", headingId);
  body.append(list);
  aside.append(body);

  let sectionOpen = getTocSectionOpen();
  applySectionState();

  heading.addEventListener("click", () => {
    sectionOpen = !sectionOpen;
    setTocSectionOpen(sectionOpen);
    applySectionState();
  });

  function applySectionState(): void {
    heading.setAttribute("aria-expanded", sectionOpen ? "true" : "false");
    heading.setAttribute(
      "aria-label",
      sectionOpen ? t("sidebar.toc.collapse") : t("sidebar.toc.expand"),
    );
    chevron.textContent = sectionOpen ? "▾" : "▸";
    body.hidden = !sectionOpen;
    aside.classList.toggle("viewer-toc--collapsed", !sectionOpen);
  }

  let visible = opts.initiallyVisible;

  function extractEntries(): TocEntry[] {
    return extractTocEntries(opts.view.state.doc.toString());
  }

  function render(): void {
    const entries = extractEntries();
    list.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "viewer-toc-empty";
      empty.textContent = t("sidebar.toc.empty");
      list.append(empty);
      return;
    }
    for (const e of entries) {
      // <button> rather than <a>: there's no URL, the action is in-app, and
      // <button> is keyboard-focusable + Enter/Space-activatable by default.
      const item = document.createElement("button");
      item.type = "button";
      item.className = `viewer-toc-item viewer-toc-l${e.level}`;
      item.textContent = e.text;
      item.dataset.from = String(e.from);
      item.addEventListener("click", () => opts.onActivate(e));
      list.append(item);
    }
  }

  function setActive(offset: number): void {
    const items = list.querySelectorAll<HTMLElement>(".viewer-toc-item");
    let activeIndex = -1;
    items.forEach((el, idx) => {
      const from = Number(el.dataset.from ?? "0");
      if (from <= offset) activeIndex = idx;
      el.classList.remove("active");
      el.removeAttribute("aria-current");
    });
    if (activeIndex >= 0) {
      const active = items.item(activeIndex);
      active?.classList.add("active");
      // aria-current="location" tells screen readers this entry is where the
      // viewport currently is — the analog of "you are here".
      active?.setAttribute("aria-current", "location");
    }
  }

  render();

  return {
    element: aside,
    refresh: render,
    setActive,
    setVisible(v) {
      visible = v;
      aside.classList.toggle("hidden", !v);
    },
    isVisible: () => visible,
    setDocumentTitle(path) {
      const label = documentHeadingFor(path);
      headingLabel.textContent = label;
      heading.title = path ?? label;
    },
    destroy() { aside.remove(); },
  };
}

function installResizeHandle(aside: HTMLElement): void {
  const handle = document.createElement("div");
  handle.className = "viewer-sidebar-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize sidebar");
  handle.tabIndex = 0;
  aside.append(handle);

  const apply = (px: number): void => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
    aside.style.setProperty("--sidebar-width", `${clamped}px`);
    return;
  };
  const persist = (): void => {
    const w = aside.getBoundingClientRect().width;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w)));
  };

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aside.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.classList.add("viewer-resizing");
    const onMove = (m: MouseEvent): void => apply(startW + (m.clientX - startX));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      document.body.classList.remove("viewer-resizing");
      persist();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // Keyboard nudges: arrow keys widen/narrow by 16 px, with persistence.
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 16 : -16;
    const cur = aside.getBoundingClientRect().width;
    apply(cur + delta);
    persist();
  });
}
