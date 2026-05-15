// Path-to-label helpers shared by the Projects menu and the recent-project
// palette.
//
// Issue #69: the Projects menu was rendering blank entries — the payload (the
// folder path) was still routed correctly when selected, but the label
// resolved to an empty string. Root cause: `path.slice(idx + 1)` after
// `lastIndexOf("/")` returns `""` whenever a path ends with a separator
// (e.g. `/Users/ke/projects/`) or when the path *is* the separator (`/`).
// Stored project paths aren't normalised, so any caller that passes a
// trailing-slash path (CLI arg, drag-drop, restored session) ends up with a
// blank label.
//
// These helpers are defensive: strip trailing separators before splitting,
// and always fall back to a non-empty string so the menu can never render
// an item with no visible label.

const SEPS = /[/\\]+$/;

/** Last non-empty path segment, or the original (non-empty) path if there
 * isn't one. Never returns an empty string for a non-empty input. */
export function basename(path: string): string {
  if (path.length === 0) return path;
  const trimmed = path.replace(SEPS, "");
  if (trimmed.length === 0) {
    // Path was nothing but separators (`/`, `\\`, `//`). Keep the original
    // so the user at least sees *something* — better than a blank line they
    // can still click.
    return path;
  }
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return trimmed;
  const tail = trimmed.slice(idx + 1);
  // `tail` can't be empty here because we trimmed trailing separators, but
  // belt-and-braces: fall back to the trimmed path if it ever is.
  return tail.length > 0 ? tail : trimmed;
}

/** Split a path into basename + parent, both safe for direct rendering.
 * Handles POSIX and Windows separators, trailing separators, and bare names. */
export function splitPath(path: string): { base: string; parent: string } {
  if (path.length === 0) return { base: path, parent: "" };
  const trimmed = path.replace(SEPS, "");
  if (trimmed.length === 0) {
    // Pure-separator input — show the original as the base, no parent.
    return { base: path, parent: "" };
  }
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return { base: trimmed, parent: "" };
  const base = trimmed.slice(idx + 1);
  const parent = trimmed.slice(0, idx);
  return {
    base: base.length > 0 ? base : trimmed,
    parent,
  };
}
