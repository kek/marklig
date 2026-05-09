import { listMarkdownFiles, type MarkdownFileEntry } from "../../shell/files";

export interface FolderSidebarHandle {
  element: HTMLElement;
  /** Show files for `root`. Pass null to clear. */
  setFolder: (root: string | null) => Promise<void>;
  /** Mark which file is currently active (highlights matching entry). */
  setActiveFile: (path: string | null) => void;
  destroy: () => void;
}

export interface MountFolderOptions {
  parent: HTMLElement;
  /** Insert the folder section before this element (e.g. the TOC). */
  insertBefore?: HTMLElement;
  onActivate: (path: string) => void;
}

/** Mount a folder section above the existing TOC. Hidden until a folder is
 * opened. Renders a flat, sorted list of .md files with their path relative
 * to the folder root — depth is communicated via indent on '/' segments. */
export function mountFolderSidebar(opts: MountFolderOptions): FolderSidebarHandle {
  const section = document.createElement("section");
  section.className = "viewer-folder hidden";

  const heading = document.createElement("h4");
  heading.id = "viewer-folder-heading";
  heading.textContent = "Folder";

  const folderName = document.createElement("div");
  folderName.className = "viewer-folder-name";

  // Filter input — substring match on the relative path. Hidden (via
  // type=search default UA) browser controls are fine here since the
  // toolbar style sheet renames borders/padding.
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "viewer-folder-filter";
  filter.placeholder = "Filter…";
  filter.setAttribute("aria-label", "Filter files in folder");

  const list = document.createElement("nav");
  list.className = "viewer-folder-list";
  list.setAttribute("aria-labelledby", "viewer-folder-heading");

  section.append(heading, folderName, filter, list);

  if (opts.insertBefore) {
    opts.parent.insertBefore(section, opts.insertBefore);
  } else {
    opts.parent.append(section);
  }

  let activePath: string | null = null;

  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    for (const item of list.querySelectorAll<HTMLElement>(".viewer-folder-item")) {
      const rel = (item.textContent ?? "").toLowerCase();
      const matches = q.length === 0 || rel.includes(q);
      item.classList.toggle("filter-hidden", !matches);
    }
  });

  function basename(path: string): string {
    const m = path.match(/[^\\/]+$/);
    return m ? m[0] : path;
  }

  async function setFolder(root: string | null): Promise<void> {
    if (!root) {
      section.classList.add("hidden");
      list.innerHTML = "";
      folderName.textContent = "";
      return;
    }
    folderName.textContent = basename(root);
    folderName.title = root;
    section.classList.remove("hidden");

    let files: MarkdownFileEntry[] = [];
    try {
      files = await listMarkdownFiles(root);
    } catch (err) {
      list.innerHTML = "";
      const error = document.createElement("p");
      error.className = "viewer-folder-empty";
      error.textContent = `Could not read folder: ${String(err instanceof Error ? err.message : err)}`;
      list.append(error);
      return;
    }

    list.innerHTML = "";
    if (files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "viewer-folder-empty";
      empty.textContent = "No Markdown files in this folder.";
      list.append(empty);
      return;
    }

    for (const entry of files) {
      const btn = document.createElement("button");
      btn.type = "button";
      const depth = (entry.relative.match(/[\\/]/g) ?? []).length;
      btn.className = `viewer-folder-item viewer-folder-depth-${Math.min(depth, 4)}`;
      btn.textContent = entry.relative;
      btn.title = entry.path;
      btn.dataset.path = entry.path;
      if (entry.path === activePath) btn.classList.add("active");
      btn.addEventListener("click", () => opts.onActivate(entry.path));
      list.append(btn);
    }
  }

  function setActiveFile(path: string | null): void {
    activePath = path;
    for (const item of list.querySelectorAll<HTMLElement>(".viewer-folder-item")) {
      const isActive = item.dataset.path === path;
      item.classList.toggle("active", isActive);
      if (isActive) {
        item.setAttribute("aria-current", "true");
      } else {
        item.removeAttribute("aria-current");
      }
    }
  }

  return {
    element: section,
    setFolder,
    setActiveFile,
    destroy() {
      section.remove();
    },
  };
}
