export async function setWindowTitle(path: string | null, dirty: boolean): Promise<void> {
  const base = path ? basename(path) : "Viewer";
  const title = dirty ? `• ${base}` : base;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    document.title = title;
  }
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
