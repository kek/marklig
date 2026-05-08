import type { EditorView } from "@codemirror/view";

import { parseMarkdown } from "../../editor/parser";

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
  destroy: () => void;
}

export interface MountTocOptions {
  view: EditorView;
  parent: HTMLElement;
  initiallyVisible: boolean;
  onActivate: (entry: TocEntry) => void;
}

export function mountTocSidebar(opts: MountTocOptions): TocSidebarHandle {
  const aside = document.createElement("aside");
  aside.className = "viewer-toc";
  if (!opts.initiallyVisible) aside.classList.add("hidden");
  opts.parent.append(aside);

  const heading = document.createElement("h4");
  heading.textContent = "Contents";
  aside.append(heading);

  const list = document.createElement("nav");
  list.className = "viewer-toc-list";
  aside.append(list);

  let visible = opts.initiallyVisible;

  function extractEntries(): TocEntry[] {
    const source = opts.view.state.doc.toString();
    const tokens = parseMarkdown(source);
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    const out: TocEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== "heading_open" || !t.map) continue;
      const level = Number(t.tag.replace("h", "")) as TocEntry["level"];
      const inline = tokens[i + 1];
      const text = inline?.content?.trim() ?? "";
      out.push({ level, text, from: lineStarts[t.map[0]] });
    }
    return out;
  }

  function render(): void {
    const entries = extractEntries();
    list.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "viewer-toc-empty";
      empty.textContent = "No headings in this document.";
      list.append(empty);
      return;
    }
    for (const e of entries) {
      const a = document.createElement("a");
      a.className = `viewer-toc-item viewer-toc-l${e.level}`;
      a.textContent = e.text;
      a.dataset.from = String(e.from);
      a.addEventListener("click", (event) => {
        event.preventDefault();
        opts.onActivate(e);
      });
      list.append(a);
    }
  }

  function setActive(offset: number): void {
    const items = list.querySelectorAll<HTMLElement>(".viewer-toc-item");
    let activeIndex = -1;
    items.forEach((el, idx) => {
      const from = Number(el.dataset.from ?? "0");
      if (from <= offset) activeIndex = idx;
      el.classList.remove("active");
    });
    if (activeIndex >= 0) items.item(activeIndex)?.classList.add("active");
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
    destroy() { aside.remove(); },
  };
}
