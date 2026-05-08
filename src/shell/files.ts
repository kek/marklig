import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
