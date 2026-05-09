import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";

import { getValue, setValue } from "./store";

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function keyFor(label: string): string {
  return `viewer.window.${label}`;
}

/** Restore the stored size + position for the current window if any was
 * persisted. Best-effort: failures are silent. Called early in bootstrap so
 * the resize lands before the user notices the default-sized flash. */
export async function restoreWindowState(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const stored = await getValue<WindowState>(keyFor(win.label));
    if (!stored) return;
    if (
      typeof stored.width !== "number" ||
      typeof stored.height !== "number" ||
      typeof stored.x !== "number" ||
      typeof stored.y !== "number"
    ) return;
    // Sanity-clamp: rejecting wildly off-screen coords avoids restoring a
    // window onto a monitor that's no longer attached.
    if (stored.width < 320 || stored.height < 240) return;
    await win.setSize(new LogicalSize(stored.width, stored.height));
    await win.setPosition(new LogicalPosition(stored.x, stored.y));
  } catch {
    // ignore — first-run, store unavailable, or window API mismatch
  }
}

/** Persist the current window's size + position. Call before unload so the
 * next launch restores. */
export async function persistWindowState(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const size = await win.outerSize();
    const pos = await win.outerPosition();
    const factor = await win.scaleFactor();
    // outerSize/outerPosition are physical pixels; convert to logical so the
    // values match what setSize/setPosition expect on the next launch.
    const state: WindowState = {
      width: Math.round(size.width / factor),
      height: Math.round(size.height / factor),
      x: Math.round(pos.x / factor),
      y: Math.round(pos.y / factor),
    };
    await setValue(keyFor(win.label), state);
  } catch {
    // ignore
  }
}

/** Wire automatic persistence on beforeunload. Returns the unsubscribe. */
export function installWindowStatePersistence(): () => void {
  const handler = (): void => { void persistWindowState(); };
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}
