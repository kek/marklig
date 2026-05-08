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
