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
  /** False while the window is still applying the state Rust handed it.
   * Reporting before that publishes a half-built window — notably
   * `folder: null` for a window Rust restored into a project, which would
   * overwrite the registry entry Rust seeded synchronously and make the
   * window look adoptable to an external open request. Defaults to ready
   * when omitted. */
  ready?: () => boolean;
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
  // Silence is safe: Rust seeded this window's registry entry synchronously
  // when it created the window, so skipping a tick leaves the truth in
  // place. Publishing early replaces it with something less true.
  if (getters.ready?.() === false) return;
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
  // Immediate write so even an instant quit after launch has state — a no-op
  // until `ready`, at which point the regular tick takes over.
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

/** Ask to own the application menu. True for exactly one window at a time.
 *  Ownership is elected first-come rather than pinned to the `main` label:
 *  a restored session need not contain a window with that label at all, and
 *  a label-gated menu would then never be built. Rust re-elects — by
 *  emitting `viewer:claim-menu` — when the owner is deliberately closed. */
export async function claimMenu(label: string): Promise<boolean> {
  try {
    // Only an explicit denial withholds the menu. A missing or stubbed
    // backend (a browser-only `npm run dev` session, an e2e harness) answers
    // with nothing, and a window with no menu at all is the worse failure.
    return (await invoke<boolean>("session_claim_menu", { label })) !== false;
  } catch {
    return true;
  }
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

/** `File → New Window`: ask Rust for a blank window. Deliberately not a
 *  routing call — there is no path to route, and the user asked for a window
 *  rather than for a document. */
export async function newWindow(): Promise<void> {
  try {
    await invoke("session_new_window");
  } catch {
    // ignore
  }
}

// Set by close.ts while its close-requested handler is mid-flight, so the
// `beforeunload` fired by the subsequent destroy() doesn't undo the forget.
// This is the single source of truth for that flag, so a window closed via
// close.ts is never resurrected by the reporter's own beforeunload tick
// (issue #34).
let userClosingThisWindow = false;
export function markUserClosingThisWindow(): void {
  userClosingThisWindow = true;
}
export function isUserClosingThisWindow(): boolean {
  return userClosingThisWindow;
}
