import { listMarkdownFiles, type MarkdownFileEntry } from "../../shell/files";

export interface FolderSidebarHandle {
  element: HTMLElement;
  /** Show files for `root`. Pass null to clear. */
  setFolder: (root: string | null) => Promise<void>;
  /** Re-list files for the current root, preserving expansion + active. Used
   * when an external watcher notices the tree changed on disk. */
  refresh: () => Promise<void>;
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

interface FileNode {
  kind: "file";
  name: string;
  path: string;
  relative: string;
}

interface DirNode {
  kind: "dir";
  name: string;
  /** Path within the root, e.g. "docs/superpowers". Empty for the root itself. */
  relative: string;
  children: TreeNode[];
}

type TreeNode = FileNode | DirNode;

function splitSegments(rel: string): string[] {
  return rel.split(/[\\/]/).filter((s) => s.length > 0);
}

/** Build a folder tree from the flat sorted list returned by the Rust walker. */
function buildTree(entries: MarkdownFileEntry[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", relative: "", children: [] };

  for (const entry of entries) {
    const segs = splitSegments(entry.relative);
    if (segs.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      let next = cursor.children.find(
        (c): c is DirNode => c.kind === "dir" && c.name === name,
      );
      if (!next) {
        const relParts = segs.slice(0, i + 1).join("/");
        next = { kind: "dir", name, relative: relParts, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      kind: "file",
      name: segs[segs.length - 1],
      path: entry.path,
      relative: entry.relative,
    });
  }

  // Folders first, then files, alphabetical within each group. Sort recursively.
  const sortNode = (node: DirNode): void => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) if (c.kind === "dir") sortNode(c);
  };
  sortNode(root);
  return root;
}

/** Mount a folder section above the existing TOC. Hidden until a folder is
 * opened. Renders a tree of folders + .md files; folders are collapsed by
 * default and can be expanded by clicking the disclosure triangle. */
export function mountFolderSidebar(opts: MountFolderOptions): FolderSidebarHandle {
  const section = document.createElement("section");
  section.className = "viewer-folder hidden";

  const heading = document.createElement("h4");
  heading.id = "viewer-folder-heading";
  heading.textContent = "Folder";

  const folderName = document.createElement("div");
  folderName.className = "viewer-folder-name";

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
  let currentRoot: string | null = null;
  let tree: DirNode = { kind: "dir", name: "", relative: "", children: [] };
  /** Folder relative-paths (e.g. "docs/superpowers") that are user-expanded. */
  const expanded = new Set<string>();
  let currentFilter = "";

  function basename(path: string): string {
    const m = path.match(/[^\\/]+$/);
    return m ? m[0] : path;
  }

  /** Containing folder (relative form) of a file's relative path, or "" if root. */
  function dirnameOf(rel: string): string {
    const segs = splitSegments(rel);
    return segs.slice(0, -1).join("/");
  }

  /** Add a folder and all its ancestors to the expanded set. */
  function expandAncestors(rel: string): void {
    if (!rel) return;
    const segs = splitSegments(rel);
    for (let i = 1; i <= segs.length; i++) {
      expanded.add(segs.slice(0, i).join("/"));
    }
  }

  /** Does this subtree contain a file whose relative path matches the filter? */
  function subtreeMatches(node: TreeNode, q: string): boolean {
    if (node.kind === "file") return node.relative.toLowerCase().includes(q);
    return node.children.some((c) => subtreeMatches(c, q));
  }

  function render(): void {
    list.innerHTML = "";
    if (tree.children.length === 0) {
      const empty = document.createElement("p");
      empty.className = "viewer-folder-empty";
      empty.textContent = "No Markdown files in this folder.";
      list.append(empty);
      return;
    }

    const q = currentFilter.trim().toLowerCase();
    const filtering = q.length > 0;

    const renderChildren = (parent: DirNode, depth: number): void => {
      for (const node of parent.children) {
        if (filtering && !subtreeMatches(node, q)) continue;

        if (node.kind === "dir") {
          const isOpen = filtering || expanded.has(node.relative);
          const row = document.createElement("button");
          row.type = "button";
          row.className = "viewer-folder-item viewer-folder-dir";
          row.style.setProperty("--depth", String(depth));
          row.setAttribute("aria-expanded", isOpen ? "true" : "false");
          row.title = node.relative;

          const chevron = document.createElement("span");
          chevron.className = "viewer-folder-chevron";
          chevron.setAttribute("aria-hidden", "true");
          chevron.textContent = isOpen ? "▾" : "▸";

          const label = document.createElement("span");
          label.className = "viewer-folder-label";
          label.textContent = node.name;

          row.append(chevron, label);
          row.addEventListener("click", () => {
            if (filtering) return; // filter forces open; ignore toggles
            if (expanded.has(node.relative)) expanded.delete(node.relative);
            else expanded.add(node.relative);
            render();
          });
          list.append(row);

          if (isOpen) renderChildren(node, depth + 1);
        } else {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "viewer-folder-item viewer-folder-file";
          btn.style.setProperty("--depth", String(depth));
          btn.title = node.relative;
          btn.dataset.path = node.path;
          btn.textContent = node.name;
          if (node.path === activePath) {
            btn.classList.add("active");
            btn.setAttribute("aria-current", "true");
          }
          btn.addEventListener("click", () => opts.onActivate(node.path));
          list.append(btn);
        }
      }
    };

    renderChildren(tree, 0);
  }

  filter.addEventListener("input", () => {
    currentFilter = filter.value;
    render();
  });

  async function setFolder(root: string | null): Promise<void> {
    currentRoot = root;
    if (!root) {
      section.classList.add("hidden");
      list.innerHTML = "";
      folderName.textContent = "";
      tree = { kind: "dir", name: "", relative: "", children: [] };
      expanded.clear();
      currentFilter = "";
      filter.value = "";
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

    tree = buildTree(files);
    expanded.clear();
    // Reveal the folder containing the active file, if any.
    if (activePath) {
      const match = files.find((f) => f.path === activePath);
      if (match) expandAncestors(dirnameOf(match.relative));
    }
    render();
  }

  async function refresh(): Promise<void> {
    if (!currentRoot) return;
    let files: MarkdownFileEntry[] = [];
    try {
      files = await listMarkdownFiles(currentRoot);
    } catch {
      // Folder may have been removed; leave the previous tree visible so
      // the user isn't suddenly staring at an error after a transient I/O
      // hiccup. A subsequent setFolder() (e.g. user picks a new project)
      // resets state cleanly.
      return;
    }
    tree = buildTree(files);
    // Drop expanded entries whose folders no longer exist so stale paths
    // don't linger if a user repeatedly creates/removes the same dir.
    const present = new Set<string>();
    const collectDirs = (node: TreeNode): void => {
      if (node.kind !== "dir") return;
      if (node.relative) present.add(node.relative);
      for (const c of node.children) collectDirs(c);
    };
    for (const c of tree.children) collectDirs(c);
    for (const rel of [...expanded]) if (!present.has(rel)) expanded.delete(rel);
    // Reveal the active file's folder if it's still around.
    if (activePath) {
      const match = files.find((f) => f.path === activePath);
      if (match) expandAncestors(dirnameOf(match.relative));
    }
    render();
  }

  function setActiveFile(path: string | null): void {
    activePath = path;
    if (path) {
      // Find the entry to know which folder to reveal.
      const stack: TreeNode[] = [...tree.children];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.kind === "file" && node.path === path) {
          expandAncestors(dirnameOf(node.relative));
          break;
        } else if (node.kind === "dir") {
          stack.push(...node.children);
        }
      }
    }
    render();
  }

  return {
    element: section,
    setFolder,
    refresh,
    setActiveFile,
    destroy() {
      section.remove();
    },
  };
}
