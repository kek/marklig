// Pure, DOM-free model that turns the phone's flat synced-file list into a
// browsable directory tree (grouped by synced folder = "project") and a flat
// list for fuzzy search. Derives entirely from data already in the store:
// `mobile.synced_files` + `mobile.synced_folder_labels`. Unit-tested without
// any DOM or Tauri dependency.

/** Minimal shape this module needs from a synced file record. The store's
 * `SyncedFile` (src/shell/mobile-pairings.ts) is structurally compatible. */
export interface TreeInputFile {
  folderIdHex: string;
  relpath: string;
  syncedAtUnix: number;
}

export interface FileLeaf {
  folderIdHex: string;
  relpath: string;
  /** Last path segment (display name). */
  name: string;
  syncedAtUnix: number;
}

export interface DirNode {
  /** Segment name; "" for a folder root. */
  name: string;
  dirs: Map<string, DirNode>;
  files: FileLeaf[];
}

export interface FolderNode {
  folderIdHex: string;
  label: string;
  root: DirNode;
  /** Total number of files in this folder across all subdirectories. */
  fileCount: number;
}

export interface FileTree {
  folders: FolderNode[];
}

export interface SearchEntry {
  folderIdHex: string;
  relpath: string;
  label: string;
  /** What the fuzzy matcher scores against. */
  searchKey: string;
}

function newDir(name: string): DirNode {
  return { name, dirs: new Map(), files: [] };
}

/** Build the tree. Folders sorted by label (then id); within a dir, child
 * dirs and files are sorted alphabetically (dirs listed before files at the
 * render layer). */
export function buildTree(
  files: TreeInputFile[],
  labels: Record<string, string>,
): FileTree {
  const byFolder = new Map<string, FolderNode>();

  for (const file of files) {
    let folder = byFolder.get(file.folderIdHex);
    if (!folder) {
      folder = {
        folderIdHex: file.folderIdHex,
        label: labels[file.folderIdHex] ?? file.folderIdHex.slice(0, 8),
        root: newDir(""),
        fileCount: 0,
      };
      byFolder.set(file.folderIdHex, folder);
    }
    folder.fileCount++;

    const segments = file.relpath.split("/");
    let dir = folder.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = dir.dirs.get(seg);
      if (!child) {
        child = newDir(seg);
        dir.dirs.set(seg, child);
      }
      dir = child;
    }
    dir.files.push({
      folderIdHex: file.folderIdHex,
      relpath: file.relpath,
      name: segments[segments.length - 1],
      syncedAtUnix: file.syncedAtUnix,
    });
  }

  // Sort files within each dir alphabetically by name.
  const sortDir = (d: DirNode): void => {
    d.files.sort((a, b) => a.name.localeCompare(b.name));
    d.dirs = new Map([...d.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    for (const child of d.dirs.values()) sortDir(child);
  };
  for (const folder of byFolder.values()) sortDir(folder.root);

  const folders = [...byFolder.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.folderIdHex.localeCompare(b.folderIdHex),
  );
  return { folders };
}

/** Resolve the `DirNode` at `segments` within a folder. Returns null if the
 * folder or any segment is missing. Empty `segments` → folder root. */
export function childrenAt(
  tree: FileTree,
  folderIdHex: string,
  segments: string[],
): DirNode | null {
  const folder = tree.folders.find((x) => x.folderIdHex === folderIdHex);
  if (!folder) return null;
  let dir = folder.root;
  for (const seg of segments) {
    const child = dir.dirs.get(seg);
    if (!child) return null;
    dir = child;
  }
  return dir;
}

/** Flatten every file across every folder for the search overlay, preserving
 * folder order then in-folder file order. */
export function flattenForSearch(tree: FileTree): SearchEntry[] {
  const out: SearchEntry[] = [];
  const walk = (dir: DirNode, label: string): void => {
    for (const file of dir.files) {
      out.push({
        folderIdHex: file.folderIdHex,
        relpath: file.relpath,
        label,
        searchKey: file.relpath,
      });
    }
    for (const child of dir.dirs.values()) walk(child, label);
  };
  for (const folder of tree.folders) {
    // Walk files-before-subdirs at each level to match buildTree ordering
    // used by the test (folder root files first, then nested).
    walk(folder.root, folder.label);
  }
  return out;
}
