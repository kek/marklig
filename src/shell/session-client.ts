import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The frontend half of the Rust-owned session. This module only *reports* —
 * it never decides. Restore, routing, and window creation all live in
 * `src-tauri/src/session/`, which is what keeps a cold launch and a warm
 * `md <path>` on one code path.
 */

export type WindowMode = "reading" | "edit";

export interface SessionGetters {
  currentPath: () => string | null;
  folder: () => string | null;
  dirty: () => boolean;
  scrollTop: () => number;
  mode: () => WindowMode;
  sidebarVisible?: () => boolean;
}

/** How often to push this window's state to Rust. On macOS, Cmd-Q tears
 *  windows down without firing per-window close events, so the last tick is
 *  what the next launch restores from. */
const REPORT_TICK_MS = 1500;

async function report(getters: SessionGetters): Promise<void> {
  try {
    const win = getCurrentWindow();
    const [size, pos, factor] = await Promise.all([
      win.outerSize(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    // outerSize/outerPosition are physical pixels; the Rust spawner sets
    // logical ones, so normalise here or a HiDPI window doubles each launch.
    await invoke("session_report", {
      label: win.label,
      folder: getters.folder(),
      path: getters.currentPath(),
      dirty: getters.dirty(),
      x: Math.round(pos.x / factor),
      y: Math.round(pos.y / factor),
      width: Math.round(size.width / factor),
      height: Math.round(size.height / factor),
      scrollTop: Math.max(0, getters.scrollTop()),
      mode: getters.mode(),
      sidebarVisible: getters.sidebarVisible?.() ?? null,
    });
  } catch {
    // Best-effort: a failed report must never block window close or quit.
  }
}

/** Start reporting this window's state. Returns the unsubscribe. */
export function installSessionReporting(getters: SessionGetters): () => void {
  // Immediate write so even an instant quit after launch has state.
  void report(getters);
  const interval = window.setInterval(() => { void report(getters); }, REPORT_TICK_MS);

  // Last-line backstop for the Cmd-Q teardown path. Skipped when the user
  // closed this window on purpose — `close.ts` has already called
  // `forgetWindow`, and a redundant report would resurrect it (issue #34).
  const onBeforeUnload = (): void => {
    if (isUserClosingThisWindow()) return;
    void report(getters);
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

/** Drop this window from the session — it was closed deliberately. */
export async function forgetWindow(label: string): Promise<void> {
  try {
    await invoke("session_forget", { label });
  } catch {
    // ignore
  }
}

/** Ask Rust to route an open request. `requesting` is this window's label for
 *  in-app actions (Switch Project, folder drag-drop) and omitted for anything
 *  the user aimed at the app from outside. */
export async function requestOpen(
  paths: string[],
  requesting?: string,
): Promise<void> {
  try {
    await invoke("session_open_paths", { paths, requesting: requesting ?? null });
  } catch {
    // ignore
  }
}

// Set by close.ts while its close-requested handler is mid-flight, so the
// `beforeunload` fired by the subsequent destroy() doesn't undo the forget.
// This is the single source of truth for that flag — window-session.ts
// (until Task 11 removes it) imports `isUserClosingThisWindow` from here
// rather than keeping its own copy, so a window closed via close.ts is never
// resurrected by window-session.ts's own beforeunload tick (issue #34).
let userClosingThisWindow = false;
export function markUserClosingThisWindow(): void {
  userClosingThisWindow = true;
}
export function isUserClosingThisWindow(): boolean {
  return userClosingThisWindow;
}
