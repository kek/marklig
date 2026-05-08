import {
  Menu,
  Submenu,
  MenuItem,
  PredefinedMenuItem,
  CheckMenuItem,
} from "@tauri-apps/api/menu";

export interface MenuHandlers {
  openFile: () => Promise<void>;
  saveFile: () => void | Promise<void>;
  closeWindow: () => Promise<void>;
  toggleMode: () => void;
  toggleSidebar: () => void;
  setTheme: (t: "light" | "dark" | "system") => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  openFind: () => void;
  openReplace: () => void;
  recents: () => Promise<string[]>;
  openRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
}

export async function buildAndAttachMenu(handlers: MenuHandlers): Promise<Menu> {
  const recents = await handlers.recents();

  const recentItems: Array<MenuItem | PredefinedMenuItem> = [];
  if (recents.length === 0) {
    recentItems.push(
      await MenuItem.new({
        id: "no-recent",
        text: "(none)",
        enabled: false,
        action: () => {},
      }),
    );
  } else {
    for (let i = 0; i < recents.length; i++) {
      const p = recents[i];
      recentItems.push(
        await MenuItem.new({
          id: `recent-${i}`,
          text: shortName(p),
          action: () => {
            void handlers.openRecent(p);
          },
        }),
      );
    }
    recentItems.push(await PredefinedMenuItem.new({ item: "Separator" }));
    recentItems.push(
      await MenuItem.new({
        id: "clear-recents",
        text: "Clear Menu",
        action: () => {
          void handlers.clearRecents();
        },
      }),
    );
  }

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({
        id: "open",
        text: "Open…",
        accelerator: "CmdOrCtrl+O",
        action: () => {
          void handlers.openFile();
        },
      }),
      await Submenu.new({ text: "Open Recent", items: recentItems }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "save",
        text: "Save",
        accelerator: "CmdOrCtrl+S",
        action: () => {
          void handlers.saveFile();
        },
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "close",
        text: "Close Window",
        accelerator: "CmdOrCtrl+W",
        action: () => {
          void handlers.closeWindow();
        },
      }),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "find",
        text: "Find…",
        accelerator: "CmdOrCtrl+F",
        action: () => handlers.openFind(),
      }),
      await MenuItem.new({
        id: "replace",
        text: "Find and Replace…",
        accelerator: "CmdOrCtrl+Shift+F",
        action: () => handlers.openReplace(),
      }),
    ],
  });

  const themeMenu = await Submenu.new({
    text: "Theme",
    items: [
      await CheckMenuItem.new({
        id: "theme-light",
        text: "Light",
        checked: false,
        action: () => handlers.setTheme("light"),
      }),
      await CheckMenuItem.new({
        id: "theme-dark",
        text: "Dark",
        checked: false,
        action: () => handlers.setTheme("dark"),
      }),
      await CheckMenuItem.new({
        id: "theme-system",
        text: "Follow System",
        checked: true,
        action: () => handlers.setTheme("system"),
      }),
    ],
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({
        id: "toggle-mode",
        text: "Reading / Edit Mode",
        accelerator: "CmdOrCtrl+E",
        action: () => handlers.toggleMode(),
      }),
      await MenuItem.new({
        id: "toggle-sidebar",
        text: "Show / Hide Sidebar",
        accelerator: "CmdOrCtrl+Shift+O",
        action: () => handlers.toggleSidebar(),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      themeMenu,
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "zoom-reset",
        text: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        action: () => handlers.zoomReset(),
      }),
      await MenuItem.new({
        id: "zoom-in",
        text: "Zoom In",
        accelerator: "CmdOrCtrl+Plus",
        action: () => handlers.zoomIn(),
      }),
      await MenuItem.new({
        id: "zoom-out",
        text: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        action: () => handlers.zoomOut(),
      }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "BringAllToFront" }),
    ],
  });

  const helpMenu = await Submenu.new({
    text: "Help",
    items: [],
  });

  // macOS consumes the first submenu as the application menu (the bold
  // app-name slot), and never auto-injects About/Hide/Quit when a custom
  // menu is set. Build it explicitly so Cmd+Q works and File/Help remain
  // visible in their normal slots.
  const appMenu = await Submenu.new({
    text: "viewer",
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Services" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu],
  });
  await menu.setAsAppMenu();
  return menu;
}

function shortName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
