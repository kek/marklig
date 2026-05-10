import { listen, emit, emitTo } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
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
  | { type: "showKeyboardShortcuts" };

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
}

const EVENT = "viewer:menu-action";

/** Install the per-window listener that executes incoming menu actions
 * against this window's local handlers. Returns an unsubscribe function. */
export async function installMenuActionListener(
  handlers: LocalMenuHandlers,
): Promise<() => void> {
  return await listen<MenuAction>(EVENT, async (e) => {
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
    }
  });
}

/** Send an action to whichever window currently has focus. Falls back to a
 * broadcast if no window is focused — main is virtually always listening
 * and will pick it up. */
export async function dispatchToFocused(action: MenuAction): Promise<void> {
  const focused = await Window.getFocusedWindow();
  if (focused) {
    await emitTo(focused.label, EVENT, action);
  } else {
    await emit(EVENT, action);
  }
}

/** Broadcast an action to every window. Use for app-wide settings like
 * the theme so all windows update in lockstep. */
export async function dispatchToAll(action: MenuAction): Promise<void> {
  await emit(EVENT, action);
}
