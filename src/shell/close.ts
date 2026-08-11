import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";

import { forgetWindow, markUserClosingThisWindow } from "./session-client";

export interface CloseHandlerOptions {
  isDirty: () => boolean;
  /**
   * Save the current buffer unconditionally — overwrites disk even when the
   * buffer is marked `diverged`. The user is on their way out; there's nobody
   * to answer a "save anyway?" prompt. The caller is expected to:
   *   - run `watcherHandle.markSelfWrite()` before the write, and
   *   - clear the recovery dump on success.
   * Failures are logged but never propagated — a broken write must not block
   * window close (the user would be stuck with no way to quit).
   */
  forceSave: () => Promise<void>;
}

/**
 * Wires a per-window close handler that flushes any dirty buffer to disk
 * before allowing the window to close. The handler also owns removing this
 * window's persisted session entry, so a window the user closed on purpose
 * doesn't get resurrected on the next launch.
 *
 * Also subscribes to a global `viewer:before-quit` event so app-quit (Cmd-Q
 * on macOS, Alt-F4 / right-click-Quit elsewhere) can broadcast a flush
 * request before tearing windows down. The Rust side fires this from
 * `RunEvent::ExitRequested` and waits for `viewer:before-quit-ack` from
 * every window before calling `app.exit()`.
 *
 * Returns an unsubscribe function.
 */
export async function installCloseHandler(
  opts: CloseHandlerOptions,
): Promise<() => void> {
  const win = getCurrentWindow();
  let closing = false;

  // Per-window close. We OWN destroy() — the Tauri wrapper's auto-destroy is
  // only used on the clean (non-dirty) path. We always preventDefault and
  // explicitly destroy so the order is deterministic: save → remove session
  // entry → destroy.
  const stopClose = await win.onCloseRequested(async (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    // Tell window-session.ts that this window's `beforeunload` (which will
    // fire during destroy() below) should NOT write a fresh session entry —
    // we just removed it on purpose.
    markUserClosingThisWindow();
    try {
      if (opts.isDirty()) {
        try {
          await opts.forceSave();
        } catch (err) {
          // Best-effort. Surface for debugging but don't block the close —
          // we'd otherwise trap the user in a window that won't shut.
          console.warn("force-save on close failed", err);
        }
      }
      try {
        await forgetWindow(win.label);
      } catch {
        // ignore
      }
    } finally {
      try {
        await win.destroy();
      } catch {
        // ignore — window may already be gone
      }
    }
  });

  // App-quit broadcast. Rust fires this from RunEvent::ExitRequested and
  // waits for one ack per window before calling app.exit(). We save (still
  // unconditionally — same reasoning as window-close) and ack regardless of
  // whether the save succeeded; an app-quit blocked by a broken disk write
  // is worse than the alternative.
  const stopBeforeQuit = await listen<unknown>(
    "viewer:before-quit",
    async () => {
      if (opts.isDirty()) {
        try {
          await opts.forceSave();
        } catch (err) {
          console.warn("force-save on app-quit failed", err);
        }
      }
      try {
        await emit("viewer:before-quit-ack", { label: win.label });
      } catch {
        // ignore — Rust has a timeout
      }
    },
  );

  return () => {
    stopClose();
    stopBeforeQuit();
  };
}
