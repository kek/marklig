import {
  listMarkdownFiles,
  renameFile,
  saveDoc,
  trashFile,
  type MarkdownFileEntry,
} from "../../shell/files";
import { t, tA11y } from "../../i18n/strings";
import { getFolderSectionOpen, setFolderSectionOpen } from "../../shell/settings";

export interface FolderSidebarHandle {
  element: HTMLElement;
  /** Show files for `root`. Pass null to clear. */
  setFolder: (root: string | null) => Promise<void>;
  /** Re-list files for the current root, preserving expansion + active. Used
   * when an external watcher notices the tree changed on disk. */
  refresh: () => Promise<void>;
  /** Mark which file is currently active (highlights matching entry). */
  setActiveFile: (path: string | null) => void;
  /** Programmatically begin a "new file" flow targeting `dirRelative`
   * (empty string for the root). Exposed for tests; the "+" button and
   * folder context menu call into the same path internally. */
  beginNewFile: (dirRelative?: string) => void;
  /** Programmatically begin an inline rename on the file at `absolutePath`.
   * Exposed for tests; the file context menu's "Rename…" item calls into
   * the same path. No-op if the file isn't in the current tree. */
  beginRename: (absolutePath: string) => void;
  /** Programmatically begin the delete confirmation modal for `absolutePath`.
   * Exposed for tests; the file context menu's "Delete…" item calls into
   * the same path. */
  beginDelete: (absolutePath: string) => void;
  destroy: () => void;
}

export interface MountFolderOptions {
  parent: HTMLElement;
  /** Insert the folder section before this element (e.g. the TOC). */
  insertBefore?: HTMLElement;
  onActivate: (path: string) => void;
  /** Called after a new file has been successfully written to disk. The
   * absolute path is the same one we'll see on the next folder refresh.
   * If absent, the "+" / "New File…" affordances are still shown but the
   * sidebar only writes the file — opening is left to the caller. */
  onCreate?: (absolutePath: string) => void | Promise<void>;
  /** Called after a file has been renamed on disk. Both paths are absolute.
   * The host re-targets `currentPath` if the renamed file is the open one,
   * updates recents, and refreshes the tree. If absent, the rename menu
   * item is hidden. */
  onRename?: (fromAbsolute: string, toAbsolute: string) => void | Promise<void>;
  /** Called after a file has been moved to trash on disk. The path is the
   * absolute path that was deleted. The host generally doesn't need to do
   * much here — the watcher's remove event drives the orphan flow when the
   * deleted file was the open one — but the host may want to force an
   * immediate tree refresh. If absent, the delete menu item is hidden. */
  onDelete?: (absolutePath: string) => void | Promise<void>;
}

/** Markdown extensions matched case-insensitively. Mirrors `is_markdown_ext`
 * in `src-tauri/src/commands/files.rs` — keep in sync. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx", "mdown"]);

/** Outcome of {@link validateNewFilename}. `ok` carries the canonical
 * filename (with `.md` appended when none was given); `kind` on the error
 * branch identifies which validation rule fired so callers can localize. */
export type NewFilenameResult =
  | { ok: true; filename: string }
  | { ok: false; kind: "empty" | "slash" };

/** Normalize a user-typed filename for the "new file" flow:
 *   - trims surrounding whitespace
 *   - rejects empty / whitespace-only input
 *   - rejects names containing `/` or `\` (subdirs out of scope for v1)
 *   - appends `.md` if no extension is present
 *
 * Any extension the user explicitly typed (including non-Markdown ones like
 * `.txt`) is preserved — we don't second-guess explicit intent. Markdown
 * extensions are matched case-insensitively to mirror the Rust walker. */
export function validateNewFilename(raw: string): NewFilenameResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, kind: "empty" };
  if (/[\\/]/.test(trimmed)) return { ok: false, kind: "slash" };

  const dotIdx = trimmed.lastIndexOf(".");
  const hasExt = dotIdx > 0 && dotIdx < trimmed.length - 1;
  if (!hasExt) return { ok: true, filename: `${trimmed}.md` };
  // Explicit extension — keep verbatim. (We only special-case "no extension";
  // a user who typed `.txt` gets `.txt`.)
  return { ok: true, filename: trimmed };
}

/** Outcome of {@link validateRenameFilename}. `unchanged` is the
 * silent-close path (user pressed Enter on the same name); siblings is the
 * pre-collision-checked input the caller still needs to match against. */
export type RenameFilenameResult =
  | { ok: true; filename: string }
  | { ok: true; unchanged: true }
  | { ok: false; kind: "empty" | "slash" };

/** Normalize a user-typed rename for an existing file. Unlike
 * {@link validateNewFilename}, we do NOT auto-append `.md` — the user
 * already had an extension on the existing file and may be deliberately
 * changing it (e.g. `.md` → `.mdx`). Empty extension is allowed; the OS
 * will treat it as an extensionless file.
 *
 *  - Trims surrounding whitespace.
 *  - Rejects empty / whitespace-only input.
 *  - Rejects names containing `/` or `\` (subdir moves out of scope).
 *  - Returns `{ ok: true, unchanged: true }` if the trimmed name equals
 *    `currentFilename` — caller closes the input silently with no I/O. */
export function validateRenameFilename(
  raw: string,
  currentFilename: string,
): RenameFilenameResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, kind: "empty" };
  if (/[\\/]/.test(trimmed)) return { ok: false, kind: "slash" };
  if (trimmed === currentFilename) return { ok: true, unchanged: true };
  return { ok: true, filename: trimmed };
}

/** True if `filename` (basename only) ends in a Markdown extension. Used by
 * tests; runtime code doesn't gate on this — the Rust walker decides what's
 * listed. Exported for symmetry with the validator. */
export function isMarkdownFilename(filename: string): boolean {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return MARKDOWN_EXTS.has(filename.slice(dotIdx + 1).toLowerCase());
}

/** Join an absolute folder root with a relative subdir (possibly empty) and
 * a leaf filename, using the same separator that's already in `root`. We
 * detect Windows-style paths by looking for `\` in the root or a drive
 * letter prefix — purely a string operation, no fs access. */
export function joinFolderPath(
  root: string,
  dirRelative: string,
  filename: string,
): string {
  const isWindows = root.includes("\\") || /^[A-Za-z]:[\\/]/.test(root);
  const sep = isWindows ? "\\" : "/";
  const parts = [root.replace(/[\\/]+$/, "")];
  if (dirRelative) {
    // Normalize the subdir's separators to match the root.
    const normalized = dirRelative.replace(/[\\/]+/g, sep).replace(/^[\\/]|[\\/]$/g, "");
    if (normalized) parts.push(normalized);
  }
  parts.push(filename);
  return parts.join(sep);
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

  // Heading is a button: clicking toggles the collapsed/expanded state of the
  // body (filter + list). The label is the folder's basename (or empty until
  // a folder is opened); tooltip carries the full path.
  const bodyId = "viewer-folder-body";
  const heading = document.createElement("button");
  heading.type = "button";
  heading.id = "viewer-folder-heading";
  heading.className = "viewer-sidebar-section-heading viewer-folder-heading";
  heading.setAttribute("aria-controls", bodyId);

  const chevron = document.createElement("span");
  chevron.className = "viewer-folder-chevron viewer-sidebar-section-chevron";
  chevron.setAttribute("aria-hidden", "true");

  const headingLabel = document.createElement("span");
  headingLabel.className = "viewer-sidebar-section-heading-label";

  heading.append(chevron, headingLabel);

  // Header row: the collapsible heading button on the left, a "+" action
  // button on the right. The "+" is hidden until a folder is actually
  // opened so the empty sidebar doesn't show an affordance that goes
  // nowhere — same gating as `section.hidden`.
  const header = document.createElement("div");
  header.className = "viewer-folder-header";

  const newFileBtn = document.createElement("button");
  newFileBtn.type = "button";
  newFileBtn.className = "viewer-folder-new-file";
  newFileBtn.textContent = "+";
  newFileBtn.setAttribute("aria-label", t("sidebar.folder.newFile"));
  newFileBtn.title = t("sidebar.folder.newFileTitle");

  header.append(heading, newFileBtn);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "viewer-sidebar-section-body viewer-folder-body";

  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "viewer-folder-filter";
  filter.placeholder = t("sidebar.folder.filter");
  filter.setAttribute("aria-label", t("sidebar.folder.filterAriaLabel"));

  const list = document.createElement("nav");
  list.className = "viewer-folder-list";
  list.setAttribute("aria-labelledby", "viewer-folder-heading");

  body.append(filter, list);
  section.append(header, body);

  // Initial open/closed reflects persisted setting.
  let sectionOpen = getFolderSectionOpen();
  applySectionState();

  heading.addEventListener("click", () => {
    sectionOpen = !sectionOpen;
    setFolderSectionOpen(sectionOpen);
    applySectionState();
  });

  function applySectionState(): void {
    heading.setAttribute("aria-expanded", sectionOpen ? "true" : "false");
    heading.setAttribute(
      "aria-label",
      sectionOpen ? t("sidebar.folder.collapse") : t("sidebar.folder.expand"),
    );
    chevron.textContent = sectionOpen ? "▾" : "▸";
    body.hidden = !sectionOpen;
    section.classList.toggle("viewer-folder--collapsed", !sectionOpen);
  }

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

  /** When non-null, the tree renders an inline input below the named
   * folder (empty string = root) for the user to type a new filename.
   * Cleared on commit / cancel. */
  let pendingCreateDir: string | null = null;
  /** Last validation error to show beneath the inline input. */
  let pendingCreateError: string | null = null;
  /** When non-null, the file row at this absolute path is replaced by an
   * inline rename input pre-filled with the current basename. */
  let pendingRenamePath: string | null = null;
  /** Last validation error for the active rename input. */
  let pendingRenameError: string | null = null;

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

  /** Find a DirNode by its relative path within the in-memory tree. Empty
   * string returns the root. Returns null if no such directory exists in
   * the tree — callers fall back to the root in that case. */
  function findDir(rel: string): DirNode | null {
    if (!rel) return tree;
    const segs = splitSegments(rel);
    let cursor: DirNode = tree;
    for (const seg of segs) {
      const next = cursor.children.find(
        (c): c is DirNode => c.kind === "dir" && c.name === seg,
      );
      if (!next) return null;
      cursor = next;
    }
    return cursor;
  }

  /** Render an inline input row for the "new file" flow. The input lives at
   * the same depth + 1 as its siblings would, pre-fills with `untitled.md`
   * with the stem pre-selected, and commits / cancels on key + blur. */
  function renderNewFileInput(parentEl: HTMLElement, depth: number): void {
    const row = document.createElement("div");
    row.className = "viewer-folder-item viewer-folder-new-file-row";
    row.style.setProperty("--depth", String(depth));

    const input = document.createElement("input");
    input.type = "text";
    input.className = "viewer-folder-new-file-input";
    input.value = t("sidebar.folder.newFileDefault");
    input.placeholder = t("sidebar.folder.newFilePlaceholder");
    input.setAttribute("aria-label", t("sidebar.folder.newFileAriaLabel"));
    input.spellcheck = false;
    row.append(input);

    if (pendingCreateError) {
      const err = document.createElement("p");
      err.className = "viewer-folder-new-file-error";
      err.setAttribute("role", "alert");
      err.textContent = pendingCreateError;
      row.append(err);
    }

    parentEl.append(row);

    // Defer focus + selection until the element is attached to the DOM so
    // setSelectionRange takes effect. The selection covers the stem
    // (everything before the final dot) so typing replaces "untitled" but
    // keeps the ".md" extension.
    queueMicrotask(() => {
      input.focus();
      const dotIdx = input.value.lastIndexOf(".");
      const end = dotIdx > 0 ? dotIdx : input.value.length;
      try { input.setSelectionRange(0, end); } catch { /* jsdom quirks */ }
    });

    // Blur-after-microtask: a click on the "+" button while an input is
    // already open would otherwise blur → cancel → re-open in the same
    // tick. Cancel only when the new focus target isn't another part of
    // our new-file UI.
    let cancelled = false;
    input.addEventListener("blur", () => {
      // setTimeout 0: let any concurrent click finish so we can decide
      // whether to cancel based on the new activeElement.
      setTimeout(() => {
        if (cancelled) return;
        const next = document.activeElement;
        if (next instanceof HTMLElement && next.classList.contains("viewer-folder-new-file-input")) {
          return;
        }
        cancelNewFile();
      }, 0);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitNewFile(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelled = true;
        cancelNewFile();
      }
    });
  }

  function render(): void {
    list.innerHTML = "";
    if (tree.children.length === 0 && pendingCreateDir == null) {
      const empty = document.createElement("p");
      empty.className = "viewer-folder-empty";
      empty.textContent = t("sidebar.folder.empty");
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
          row.dataset.dir = node.relative;

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
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showFolderContextMenu(e.clientX, e.clientY, node.relative);
          });
          list.append(row);

          if (isOpen) {
            renderChildren(node, depth + 1);
            if (pendingCreateDir === node.relative) {
              renderNewFileInput(list, depth + 1);
            }
          }
        } else {
          if (pendingRenamePath === node.path) {
            renderRenameInput(list, depth, node);
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
            btn.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              showFileContextMenu(e.clientX, e.clientY, node);
            });
            list.append(btn);
          }
        }
      }
    };

    renderChildren(tree, 0);
    // Root-level "new file" input renders after the existing root entries.
    if (pendingCreateDir === "") {
      renderNewFileInput(list, 0);
    }
  }

  function cancelNewFile(): void {
    if (pendingCreateDir == null) return;
    pendingCreateDir = null;
    pendingCreateError = null;
    render();
  }

  /** Render the inline rename input in place of a file row, pre-filled with
   * the file's current basename and selection covering the stem (everything
   * before the final dot) so the user replaces the stem and keeps the
   * extension by default. Same UX as `renderNewFileInput` but anchored to
   * an existing node. */
  function renderRenameInput(parentEl: HTMLElement, depth: number, node: FileNode): void {
    const row = document.createElement("div");
    row.className = "viewer-folder-item viewer-folder-new-file-row viewer-folder-rename-row";
    row.style.setProperty("--depth", String(depth));

    const input = document.createElement("input");
    input.type = "text";
    input.className = "viewer-folder-new-file-input viewer-folder-rename-input";
    input.value = node.name;
    input.setAttribute("aria-label", t("sidebar.folder.renameAriaLabel"));
    input.spellcheck = false;
    row.append(input);

    if (pendingRenameError) {
      const err = document.createElement("p");
      err.className = "viewer-folder-new-file-error";
      err.setAttribute("role", "alert");
      err.textContent = pendingRenameError;
      row.append(err);
    }

    parentEl.append(row);

    queueMicrotask(() => {
      input.focus();
      const dotIdx = input.value.lastIndexOf(".");
      const end = dotIdx > 0 ? dotIdx : input.value.length;
      try { input.setSelectionRange(0, end); } catch { /* jsdom quirks */ }
    });

    let cancelled = false;
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (cancelled) return;
        const next = document.activeElement;
        if (next instanceof HTMLElement && next.classList.contains("viewer-folder-rename-input")) {
          return;
        }
        cancelRename();
      }, 0);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename(input.value, node);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelled = true;
        cancelRename();
      }
    });
  }

  function cancelRename(): void {
    if (pendingRenamePath == null) return;
    pendingRenamePath = null;
    pendingRenameError = null;
    render();
  }

  /** Find a FileNode by absolute path in the in-memory tree. */
  function findFile(absPath: string): FileNode | null {
    const stack: TreeNode[] = [...tree.children];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.kind === "file") {
        if (node.path === absPath) return node;
      } else {
        for (const c of node.children) stack.push(c);
      }
    }
    return null;
  }

  /** Find the DirNode containing the file at `relativePath`. Returns the
   * root if the file is at top level, or null if the file isn't in the
   * tree at all. */
  function findParentDir(relativePath: string): DirNode | null {
    const dirRel = dirnameOf(relativePath);
    return findDir(dirRel);
  }

  async function commitRename(rawName: string, node: FileNode): Promise<void> {
    if (pendingRenamePath !== node.path || currentRoot == null) return;

    const result = validateRenameFilename(rawName, node.name);
    if (!result.ok) {
      pendingRenameError =
        result.kind === "empty"
          ? t("sidebar.folder.renameErrorEmpty")
          : t("sidebar.folder.renameErrorSlash");
      render();
      return;
    }
    if ("unchanged" in result) {
      cancelRename();
      return;
    }

    // Collision against siblings in the same folder. We compare against the
    // in-memory tree; the Rust side re-checks defensively (tree may be a
    // few hundred ms stale behind the watcher).
    const parent = findParentDir(node.relative) ?? tree;
    const collision = parent.children.some(
      (c) => c.kind === "file" && c !== node && c.name === result.filename,
    );
    if (collision) {
      pendingRenameError = t("sidebar.folder.renameErrorExists");
      render();
      return;
    }

    const dirRelative = dirnameOf(node.relative);
    const toAbs = joinFolderPath(currentRoot, dirRelative, result.filename);
    try {
      await renameFile(node.path, toAbs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pendingRenameError = tA11y("sidebar.folder.renameErrorWrite", { message: msg });
      render();
      return;
    }

    const fromAbs = node.path;
    pendingRenamePath = null;
    pendingRenameError = null;
    render();
    try {
      await opts.onRename?.(fromAbs, toAbs);
    } catch (err) {
      console.warn("onRename hook threw", err);
    }
  }

  function beginRename(absolutePath: string): void {
    if (!currentRoot) return;
    const node = findFile(absolutePath);
    if (!node) return;
    pendingRenamePath = absolutePath;
    pendingRenameError = null;
    // Expand any ancestor folders so the rename input is actually visible
    // when triggered from a deeply-nested file.
    expandAncestors(dirnameOf(node.relative));
    if (!sectionOpen) {
      sectionOpen = true;
      setFolderSectionOpen(true);
      applySectionState();
    }
    render();
  }

  /** Show a confirmation modal "Delete <name>?". Cancel has focus by
   * default so a stray Enter doesn't trigger deletion. Returns the chosen
   * action via promise. */
  function promptDeleteConfirm(filename: string): Promise<"delete" | "cancel"> {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement as HTMLElement | null;

      const overlay = document.createElement("div");
      overlay.className = "viewer-reconcile-overlay viewer-folder-delete-overlay";

      const card = document.createElement("div");
      card.className = "viewer-reconcile-card viewer-folder-delete-card";
      card.setAttribute("role", "alertdialog");
      card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", "viewer-folder-delete-title");
      card.setAttribute("aria-describedby", "viewer-folder-delete-body");

      const title = document.createElement("h3");
      title.id = "viewer-folder-delete-title";
      title.textContent = t("sidebar.folder.deleteTitle");
      const body = document.createElement("p");
      body.id = "viewer-folder-delete-body";
      body.textContent = tA11y("sidebar.folder.deleteBody", { name: filename });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "viewer-toolbar-btn";
      cancelBtn.textContent = t("sidebar.folder.deleteCancel");

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "viewer-toolbar-btn viewer-folder-delete-confirm";
      confirmBtn.textContent = t("sidebar.folder.deleteConfirm");

      const buttons = document.createElement("div");
      buttons.className = "viewer-reconcile-buttons";
      // Cancel comes first visually so Tab from Cancel lands on Confirm,
      // matching the reconcile modal layout. Cancel still gets focus on open.
      buttons.append(cancelBtn, confirmBtn);

      card.append(title, body, buttons);

      function close(choice: "delete" | "cancel"): void {
        document.body.removeChild(overlay);
        document.removeEventListener("keydown", onKey, true);
        previouslyFocused?.focus?.();
        resolve(choice);
      }
      function onKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          e.preventDefault();
          close("cancel");
          return;
        }
        if (e.key !== "Tab") return;
        const active = document.activeElement;
        if (e.shiftKey && active === cancelBtn) {
          e.preventDefault();
          confirmBtn.focus();
        } else if (!e.shiftKey && active === confirmBtn) {
          e.preventDefault();
          cancelBtn.focus();
        }
      }
      cancelBtn.addEventListener("click", () => close("cancel"));
      confirmBtn.addEventListener("click", () => close("delete"));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close("cancel");
      });
      document.addEventListener("keydown", onKey, true);

      overlay.append(card);
      document.body.append(overlay);
      // Focus Cancel — destructive default safety. A stray Enter on the
      // modal hits Cancel, not Confirm.
      cancelBtn.focus();
    });
  }

  async function beginDelete(absolutePath: string): Promise<void> {
    const node = findFile(absolutePath);
    if (!node) return;
    const choice = await promptDeleteConfirm(node.name);
    if (choice !== "delete") return;
    try {
      await trashFile(node.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No inline surface for delete errors — surface as a transient
      // notice. The reconcile-style notice classes are already in CSS.
      const note = document.createElement("div");
      note.className = "viewer-orphan-notice";
      note.textContent = tA11y("sidebar.folder.deleteErrorWrite", { message: msg });
      document.body.append(note);
      setTimeout(() => note.remove(), 6000);
      return;
    }
    try {
      await opts.onDelete?.(node.path);
    } catch (err) {
      console.warn("onDelete hook threw", err);
    }
  }

  async function commitNewFile(rawName: string): Promise<void> {
    if (pendingCreateDir == null || currentRoot == null) return;
    const targetDir = pendingCreateDir;

    const result = validateNewFilename(rawName);
    if (!result.ok) {
      pendingCreateError =
        result.kind === "empty"
          ? t("sidebar.folder.newFileErrorEmpty")
          : t("sidebar.folder.newFileErrorSlash");
      render();
      return;
    }

    // Collision check against the in-memory tree. We don't probe the fs —
    // the watcher keeps the tree fresh enough, and a race that lands
    // between this check and the write would still write to disk which
    // is the user's stated intent. The Rust side has no overwrite-guard,
    // by design (write_text_file is the same call save uses).
    const dirNode = findDir(targetDir) ?? tree;
    const collision = dirNode.children.some(
      (c) => c.kind === "file" && c.name === result.filename,
    );
    if (collision) {
      pendingCreateError = t("sidebar.folder.newFileErrorExists");
      render();
      return;
    }

    const absPath = joinFolderPath(currentRoot, targetDir, result.filename);
    try {
      await saveDoc(absPath, "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pendingCreateError = tA11y("sidebar.folder.newFileErrorWrite", { message: msg });
      render();
      return;
    }

    pendingCreateDir = null;
    pendingCreateError = null;
    render();
    // Hand off to the host. Refreshing the tree is the host's responsibility
    // — it owns the watcher and may want to coordinate the in-process
    // refresh with mode-switch + active-file highlighting.
    try {
      await opts.onCreate?.(absPath);
    } catch (err) {
      // Don't surface as inline error — the file already exists on disk
      // at this point. Log and let the host decide.
      console.warn("onCreate hook threw", err);
    }
  }

  /** Show a tiny context menu anchored at (x, y) for a folder node. v1
   * only has a single item ("New File…"); kept as a real menu so future
   * actions (rename, delete) drop in without re-architecting. */
  function showFolderContextMenu(x: number, y: number, dirRelative: string): void {
    // Tear down any prior menu first — right-click on a different folder
    // shouldn't leave stale menus floating.
    document.querySelectorAll(".viewer-folder-context-menu").forEach((el) => el.remove());

    const menu = document.createElement("div");
    menu.className = "viewer-folder-context-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const item = document.createElement("button");
    item.type = "button";
    item.className = "viewer-folder-context-menu-item";
    item.setAttribute("role", "menuitem");
    item.textContent = t("sidebar.folder.newFileMenu");
    item.addEventListener("click", () => {
      menu.remove();
      beginNewFile(dirRelative);
    });
    menu.append(item);

    const onAwayClick = (e: MouseEvent): void => {
      if (e.target instanceof Node && menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener("mousedown", onAwayClick, true);
      document.removeEventListener("keydown", onEsc, true);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        menu.remove();
        document.removeEventListener("mousedown", onAwayClick, true);
        document.removeEventListener("keydown", onEsc, true);
      }
    };
    document.addEventListener("mousedown", onAwayClick, true);
    document.addEventListener("keydown", onEsc, true);

    document.body.append(menu);
  }

  /** Show the file-node right-click menu: Open / — / Rename… / Delete….
   * Rename and Delete items are omitted when the host didn't wire the
   * corresponding callback, so the sidebar can be reused in read-only
   * embeddings without dead menu items. */
  function showFileContextMenu(x: number, y: number, node: FileNode): void {
    document.querySelectorAll(".viewer-folder-context-menu").forEach((el) => el.remove());

    const menu = document.createElement("div");
    menu.className = "viewer-folder-context-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const makeItem = (label: string, onClick: () => void): HTMLButtonElement => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "viewer-folder-context-menu-item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        menu.remove();
        onClick();
      });
      return item;
    };

    const makeSeparator = (): HTMLDivElement => {
      const sep = document.createElement("div");
      sep.className = "viewer-folder-context-menu-separator";
      sep.setAttribute("role", "separator");
      return sep;
    };

    menu.append(makeItem(t("sidebar.folder.openMenu"), () => opts.onActivate(node.path)));
    if (opts.onRename || opts.onDelete) {
      menu.append(makeSeparator());
    }
    if (opts.onRename) {
      menu.append(makeItem(t("sidebar.folder.renameMenu"), () => beginRename(node.path)));
    }
    if (opts.onDelete) {
      menu.append(makeItem(t("sidebar.folder.deleteMenu"), () => { void beginDelete(node.path); }));
    }

    const onAwayClick = (e: MouseEvent): void => {
      if (e.target instanceof Node && menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener("mousedown", onAwayClick, true);
      document.removeEventListener("keydown", onEsc, true);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        menu.remove();
        document.removeEventListener("mousedown", onAwayClick, true);
        document.removeEventListener("keydown", onEsc, true);
      }
    };
    document.addEventListener("mousedown", onAwayClick, true);
    document.addEventListener("keydown", onEsc, true);

    document.body.append(menu);
  }

  function beginNewFile(dirRelative: string = ""): void {
    if (!currentRoot) return;
    pendingCreateDir = dirRelative;
    pendingCreateError = null;
    // Make sure the target folder is open so the input is visible.
    if (dirRelative) {
      expandAncestors(dirRelative);
      expanded.add(dirRelative);
    }
    // Section may be collapsed — uncollapse so the user can see the input.
    if (!sectionOpen) {
      sectionOpen = true;
      setFolderSectionOpen(true);
      applySectionState();
    }
    render();
  }

  newFileBtn.addEventListener("click", () => beginNewFile(""));

  filter.addEventListener("input", () => {
    currentFilter = filter.value;
    render();
  });

  async function setFolder(root: string | null): Promise<void> {
    currentRoot = root;
    if (!root) {
      section.classList.add("hidden");
      list.innerHTML = "";
      headingLabel.textContent = "";
      heading.removeAttribute("title");
      tree = { kind: "dir", name: "", relative: "", children: [] };
      expanded.clear();
      currentFilter = "";
      filter.value = "";
      return;
    }
    headingLabel.textContent = basename(root);
    heading.title = root;
    section.classList.remove("hidden");

    let files: MarkdownFileEntry[] = [];
    try {
      files = await listMarkdownFiles(root);
    } catch (err) {
      list.innerHTML = "";
      const error = document.createElement("p");
      error.className = "viewer-folder-empty";
      error.textContent = tA11y("sidebar.folder.error", {
        message: String(err instanceof Error ? err.message : err),
      });
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
    beginNewFile,
    beginRename,
    beginDelete: (absolutePath: string) => { void beginDelete(absolutePath); },
    destroy() {
      section.remove();
    },
  };
}
