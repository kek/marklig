import { emit, emitTo } from "@tauri-apps/api/event";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "../editor/theme";

// macOS has one app-wide menu, and its action callbacks fire in whichever
// webview registered the menu (typically main). That means actions like Save
// or Toggle Sidebar would naively run against main's state regardless of
// which window has focus. This module routes each menu action as an event
// to the focused window, where a local listener executes it against that
// window's own state. setTheme broadcasts to every window instead so all
// stay visually in sync.

export type MenuAction =
  | { type: "openFile" }
  | { type: "openFolder" }
  | { type: "newWindow" }
  | { type: "saveFile" }
  | { type: "saveFileAs" }
  | { type: "revealInFileManager" }
  | { type: "toggleMode" }
  | { type: "toggleSidebar" }
  | { type: "setTheme"; theme: Theme }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomReset" }
  | { type: "openFind" }
  | { type: "openReplace" }
  | { type: "openRecent"; path: string }
  | { type: "clearRecents" }
  | { type: "exportHtml" }
  | { type: "printDocument" }
  | { type: "copyAsHtml" }
  | { type: "openPreferences" }
  | { type: "showKeyboardShortcuts" }
  | { type: "openProject"; path: string }
  | { type: "clearRecentProjects" }
  | { type: "openProjectPalette" }
  | { type: "quickOpen" };

export interface LocalMenuHandlers {
  openFile: () => Promise<void>;
  openFolder: () => Promise<void>;
  newWindow: () => Promise<void>;
  saveFile: () => void | Promise<void>;
  saveFileAs: () => Promise<void>;
  revealInFileManager: () => Promise<void>;
  toggleMode: () => void;
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  openFind: () => void;
  openReplace: () => void;
  openRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
  exportHtml: () => Promise<void>;
  printDocument: () => void;
  copyAsHtml: () => Promise<void>;
  openPreferences: () => Promise<void>;
  showKeyboardShortcuts: () => void;
  openProject: (path: string) => Promise<void>;
  clearRecentProjects: () => Promise<void>;
  openProjectPalette: () => Promise<void> | void;
  quickOpen: () => void | Promise<void>;
}

const EVENT = "viewer:menu-action";

/** Install the per-window listener that executes incoming menu actions
 * against this window's local handlers. Returns an unsubscribe function.
 *
 * Uses the current window's scoped listener (`getCurrentWindow().listen`)
 * rather than the top-level `listen` from `@tauri-apps/api/event` — the
 * top-level one receives every event regardless of `emitTo` target, which
 * caused actions dispatched with `emitTo(focusedLabel, ...)` to run in
 * every window (e.g. project switch propagating everywhere). */
export async function installMenuActionListener(
  handlers: LocalMenuHandlers,
): Promise<() => void> {
  return await getCurrentWindow().listen<MenuAction>(EVENT, async (e) => {
    const a = e.payload;
    switch (a.type) {
      case "openFile": await handlers.openFile(); break;
      case "openFolder": await handlers.openFolder(); break;
      case "newWindow": await handlers.newWindow(); break;
      case "saveFile": await handlers.saveFile(); break;
      case "saveFileAs": await handlers.saveFileAs(); break;
      case "revealInFileManager": await handlers.revealInFileManager(); break;
      case "toggleMode": handlers.toggleMode(); break;
      case "toggleSidebar": handlers.toggleSidebar(); break;
      case "setTheme": handlers.setTheme(a.theme); break;
      case "zoomIn": handlers.zoomIn(); break;
      case "zoomOut": handlers.zoomOut(); break;
      case "zoomReset": handlers.zoomReset(); break;
      case "openFind": handlers.openFind(); break;
      case "openReplace": handlers.openReplace(); break;
      case "openRecent": await handlers.openRecent(a.path); break;
      case "clearRecents": await handlers.clearRecents(); break;
      case "exportHtml": await handlers.exportHtml(); break;
      case "printDocument": handlers.printDocument(); break;
      case "copyAsHtml": await handlers.copyAsHtml(); break;
      case "openPreferences": await handlers.openPreferences(); break;
      case "showKeyboardShortcuts": handlers.showKeyboardShortcuts(); break;
      case "openProject": await handlers.openProject(a.path); break;
      case "clearRecentProjects": await handlers.clearRecentProjects(); break;
      case "openProjectPalette": await handlers.openProjectPalette(); break;
      case "quickOpen": await handlers.quickOpen(); break;
    }
  });
}

/** Send an action to whichever window currently has focus. Falls back to the
 * current JS context's own window if Tauri reports no focused window — under
 * some focus-tracking races getFocusedWindow returns null briefly, and a
 * blanket broadcast would run the action in every open window (e.g. every
 * window would switch projects on Ctrl-R). */
export async function dispatchToFocused(action: MenuAction): Promise<void> {
  const focused = (await Window.getFocusedWindow()) ?? getCurrentWindow();
  await emitTo(focused.label, EVENT, action);
}

/** Broadcast an action to every window. Use for app-wide settings like
 * the theme so all windows update in lockstep. */
export async function dispatchToAll(action: MenuAction): Promise<void> {
  await emit(EVENT, action);
}
