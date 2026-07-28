import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { supportedExtensions } from "../format";

export interface OpenedDoc {
  path: string;
  source: string;
  /** True when the path doesn't exist on disk yet — the buffer is a blank
   * "new file" preview; saving will create the file. Callers use this to
   * switch into edit mode and skip side-effects (watcher, recents) that
   * assume the file is real. */
  isNew?: boolean;
}

export async function openFileViaDialog(): Promise<OpenedDoc | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Documents", extensions: supportedExtensions() }],
  });
  if (typeof picked !== "string") return null;
  return readDoc(picked);
}

export async function readDoc(path: string): Promise<OpenedDoc> {
  // `md <nonexistent.md>` (and the equivalent file-association launch with
  // a not-yet-created path) lands here. Probe first instead of catching a
  // read error so we don't mask genuine I/O failures from `read_text_file`.
  const exists = await invoke<boolean>("path_exists", { path });
  if (!exists) return { path, source: "", isNew: true };
  const source = await invoke<string>("read_text_file", { path });
  return { path, source };
}

export async function saveDoc(path: string, contents: string): Promise<void> {
  await invoke("write_text_file", { path, contents });
}

/** Rename a file on disk via the Rust shell. Rejects when `to` already
 * exists — callers (the sidebar rename flow) should pre-check the in-memory
 * tree and surface a friendly inline error before this throws. */
export async function renameFile(from: string, to: string): Promise<void> {
  await invoke("rename_file", { from, to });
}

/** Move a file to the OS trash. Falls back to plain unlink on the Rust side
 * if the trash call errors; the frontend doesn't need to distinguish. */
export async function trashFile(path: string): Promise<void> {
  await invoke("trash_file", { path });
}

export interface MarkdownFileEntry {
  path: string;
  /** Path relative to the folder root, e.g. "docs/intro.md". */
  relative: string;
}

/** Prompt for a folder; returns the absolute path or null on cancel. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ multiple: false, directory: true });
  return typeof picked === "string" ? picked : null;
}

/** Recursively walk `root` for supported document files (.md/.markdown/.mdx/
 * .mdown/.typ), skipping common ignored directories (node_modules, .git,
 * target, etc.). The Rust side also caps depth and entry count to prevent
 * runaway scans. */
export async function listMarkdownFiles(root: string): Promise<MarkdownFileEntry[]> {
  return await invoke<MarkdownFileEntry[]>("list_documents", { root });
}

/** True when `path` is a directory on disk. Used by drag-drop routing to
 * decide whether to open a path as a file or as a folder. */
export async function isDirectory(path: string): Promise<boolean> {
  return await invoke<boolean>("is_directory", { path });
}

/** Resolve the folder a file "belongs to": the nearest ancestor containing a
 * VCS marker (.git, .jj, .hg, .svn), or the file's parent directory if none. */
export async function resolveFolderRoot(path: string): Promise<string> {
  return await invoke<string>("resolve_folder_root", { path });
}

/** Prompt for an HTML save destination and write the contents. Returns the
 * destination path on success, null if the user cancels. */
export async function saveHtmlExport(
  contents: string,
  defaultName: string,
): Promise<string | null> {
  const dest = await save({
    title: "Export as HTML",
    defaultPath: defaultName,
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
  });
  if (typeof dest !== "string") return null;
  await invoke("write_text_file", { path: dest, contents });
  return dest;
}

/** Prompt for a PDF save destination, then render the export HTML to a PDF
 * via the native webview-to-PDF command and write it there. Returns the
 * destination path on success, null if the user cancels the dialog. */
export async function savePdfExport(
  html: string,
  defaultName: string,
): Promise<string | null> {
  const dest = await save({
    title: "Export as PDF",
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof dest !== "string") return null;
  await invoke("export_pdf", { html, destPath: dest });
  return dest;
}

/** Prompt for a save destination and write the Typst file contents. Returns
 * the chosen path on success, null on cancel. Used by File → New Typst File
 * to create the initial .typ file on disk. */
export async function saveTypstAs(
  contents: string,
  defaultName: string,
): Promise<string | null> {
  const dest = await save({
    title: "New Typst File",
    defaultPath: defaultName,
    filters: [{ name: "Typst", extensions: ["typ"] }],
  });
  if (typeof dest !== "string") return null;
  await invoke("write_text_file", { path: dest, contents });
  return dest;
}

/** Prompt for a save destination and write the markdown contents. Returns
 * the chosen path on success, null on cancel. Used by File -> Save As… to
 * rebind currentPath without losing edits. */
export async function saveMarkdownAs(
  contents: string,
  defaultName: string,
): Promise<string | null> {
  const dest = await save({
    title: "Save As",
    defaultPath: defaultName,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx", "mdown"] },
    ],
  });
  if (typeof dest !== "string") return null;
  await invoke("write_text_file", { path: dest, contents });
  return dest;
}

/** Reveal a file in the OS file manager (Finder on macOS, Explorer on
 * Windows, xdg-open the parent dir on Linux). Best-effort; failures are
 * surfaced as a thrown error from the underlying invoke. */
export async function revealInFileManager(path: string): Promise<void> {
  await invoke("reveal_in_file_manager", { path });
}
