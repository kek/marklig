import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface OpenedDoc {
  path: string;
  source: string;
}

export async function openFileViaDialog(): Promise<OpenedDoc | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx", "mdown"] },
    ],
  });
  if (typeof picked !== "string") return null;
  return readDoc(picked);
}

export async function readDoc(path: string): Promise<OpenedDoc> {
  const source = await invoke<string>("read_text_file", { path });
  return { path, source };
}

export async function saveDoc(path: string, contents: string): Promise<void> {
  await invoke("write_text_file", { path, contents });
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

/** Recursively walk `root` for .md/.markdown/.mdx/.mdown files, skipping
 * common ignored directories (node_modules, .git, target, etc.). The Rust
 * side also caps depth and entry count to prevent runaway scans. */
export async function listMarkdownFiles(root: string): Promise<MarkdownFileEntry[]> {
  return await invoke<MarkdownFileEntry[]>("list_markdown_files", { root });
}

/** True when `path` is a directory on disk. Used by drag-drop routing to
 * decide whether to open a path as a file or as a folder. */
export async function isDirectory(path: string): Promise<boolean> {
  return await invoke<boolean>("is_directory", { path });
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
