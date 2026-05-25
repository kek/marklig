import { invoke } from "@tauri-apps/api/core";

import { listMarkdownFiles, type MarkdownFileEntry } from "./files";
import { getLastFileInProject } from "./project-recents";

/**
 * Resolve which file to show in a window whose active project is `root`.
 *
 * Used in two places (restore-time + project-switch-time) so the rule is
 * identical at both. The order of preference, per issue #122:
 *
 *   1. Last-opened file *in that project*, from the per-project recents map.
 *   2. The project root's top-level `README.md` if it exists. Matched
 *      case-insensitively against the root's direct children — the file
 *      `README.md` on a case-sensitive filesystem (macOS/Linux) and
 *      `readme.md` / `Readme.md` etc. on a case-insensitive one all count.
 *      Only the root is considered; a `README.md` deep in a subdirectory is
 *      not the project's intro and shouldn't pop up on switch.
 *   3. null — caller falls back to the welcome buffer
 *      (`defaultPlaceholder()` in main.ts) and an empty `currentPath`.
 *
 * Best-effort: I/O failures at any step (folder gone, walker errored, fs
 * race on the README probe) collapse to null. The bug we're fixing is the
 * opposite of being too noisy — a missing project should be dropped
 * silently, not surfaced as a modal.
 */
export async function resolveProjectFallbackFile(
  root: string,
): Promise<string | null> {
  if (!root) return null;

  // 1. Last-opened-in-this-project. We still verify the file exists on disk
  //    before returning it; the user may have deleted it externally between
  //    sessions, in which case we fall through rather than hand the caller a
  //    path that will throw on read.
  try {
    const last = await getLastFileInProject(root);
    if (last) {
      try {
        const exists = await invoke<boolean>("path_exists", { path: last });
        if (exists) return last;
      } catch {
        // Tauri unavailable (jsdom / vite-only dev) — assume the path is
        // valid. Callers in test environments mock this out.
        return last;
      }
    }
  } catch {
    // ignore; fall through to README probe
  }

  // 2. README.md at the project root. We list the folder via the same Rust
  //    walker the sidebar uses; the walker returns markdown files relative
  //    to the root. A relative path with no separator is a root entry. We
  //    match case-insensitively so a Windows-style `Readme.md` and a
  //    macOS-style `README.md` both resolve.
  let files: MarkdownFileEntry[] = [];
  try {
    files = await listMarkdownFiles(root);
  } catch {
    return null;
  }
  for (const f of files) {
    if (f.relative.includes("/") || f.relative.includes("\\")) continue;
    if (f.relative.toLowerCase() === "readme.md") return f.path;
  }

  // 3. Welcome buffer — caller handles.
  return null;
}
