import {
  Menu,
  Submenu,
  MenuItem,
  PredefinedMenuItem,
  CheckMenuItem,
} from "@tauri-apps/api/menu";

import { t } from "../i18n/strings";

export interface MenuHandlers {
  openFile: () => Promise<void>;
  openFolder: () => Promise<void>;
  newWindow: () => Promise<void>;
  saveFile: () => void | Promise<void>;
  saveFileAs: () => Promise<void>;
  revealInFileManager: () => Promise<void>;
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
  exportHtml: () => Promise<void>;
  printDocument: () => void;
  copyAsHtml: () => Promise<void>;
  openPreferences: () => Promise<void>;
  showKeyboardShortcuts: () => void;
  recentProjects: () => Promise<string[]>;
  openProject: (path: string) => Promise<void>;
  clearRecentProjects: () => Promise<void>;
}

export async function buildAndAttachMenu(handlers: MenuHandlers): Promise<Menu> {
  const recents = await handlers.recents();
  const projects = await handlers.recentProjects();

  const recentItems: Array<MenuItem | PredefinedMenuItem> = [];
  if (recents.length === 0) {
    recentItems.push(
      await MenuItem.new({
        id: "no-recent",
        text: t("menu.file.openRecent.empty"),
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
        text: t("menu.file.openRecent.clear"),
        action: () => {
          void handlers.clearRecents();
        },
      }),
    );
  }

  const projectItems: Array<MenuItem | PredefinedMenuItem> = [];
  if (projects.length === 0) {
    projectItems.push(
      await MenuItem.new({
        id: "no-projects",
        text: t("menu.projects.empty"),
        enabled: false,
        action: () => {},
      }),
    );
  } else {
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      projectItems.push(
        await MenuItem.new({
          id: `project-${i}`,
          text: shortName(p),
          action: () => {
            void handlers.openProject(p);
          },
        }),
      );
    }
    projectItems.push(await PredefinedMenuItem.new({ item: "Separator" }));
    projectItems.push(
      await MenuItem.new({
        id: "clear-recent-projects",
        text: t("menu.projects.clear"),
        action: () => {
          void handlers.clearRecentProjects();
        },
      }),
    );
  }

  const fileMenu = await Submenu.new({
    text: t("menu.file"),
    items: [
      await MenuItem.new({
        id: "new-window",
        text: t("menu.file.newWindow"),
        accelerator: "CmdOrCtrl+N",
        action: () => { void handlers.newWindow(); },
      }),
      await MenuItem.new({
        id: "open",
        text: t("menu.file.open"),
        accelerator: "CmdOrCtrl+O",
        action: () => {
          void handlers.openFile();
        },
      }),
      await MenuItem.new({
        id: "open-folder",
        text: t("menu.file.openFolder"),
        accelerator: "CmdOrCtrl+Shift+O",
        action: () => { void handlers.openFolder(); },
      }),
      await Submenu.new({ text: t("menu.file.openRecent"), items: recentItems }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "save",
        text: t("menu.file.save"),
        accelerator: "CmdOrCtrl+S",
        action: () => {
          void handlers.saveFile();
        },
      }),
      await MenuItem.new({
        id: "save-as",
        text: t("menu.file.saveAs"),
        accelerator: "CmdOrCtrl+Shift+S",
        action: () => { void handlers.saveFileAs(); },
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "reveal-in-file-manager",
        text: revealLabel(),
        action: () => { void handlers.revealInFileManager(); },
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await Submenu.new({
        text: t("menu.file.export"),
        items: [
          await MenuItem.new({
            id: "export-html",
            text: t("menu.file.export.html"),
            action: () => { void handlers.exportHtml(); },
          }),
        ],
      }),
      await MenuItem.new({
        id: "print",
        text: t("menu.file.print"),
        accelerator: "CmdOrCtrl+P",
        action: () => handlers.printDocument(),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "close",
        text: t("menu.file.closeWindow"),
        accelerator: "CmdOrCtrl+W",
        action: () => {
          void handlers.closeWindow();
        },
      }),
    ],
  });

  const editMenu = await Submenu.new({
    text: t("menu.edit"),
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
        text: t("menu.edit.find"),
        accelerator: "CmdOrCtrl+F",
        action: () => handlers.openFind(),
      }),
      await MenuItem.new({
        id: "replace",
        text: t("menu.edit.findReplace"),
        accelerator: "CmdOrCtrl+Shift+F",
        action: () => handlers.openReplace(),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "copy-as-html",
        text: t("menu.edit.copyAsHtml"),
        accelerator: "CmdOrCtrl+Shift+C",
        action: () => { void handlers.copyAsHtml(); },
      }),
    ],
  });

  const themeMenu = await Submenu.new({
    text: t("menu.view.theme"),
    items: [
      await CheckMenuItem.new({
        id: "theme-light",
        text: t("menu.view.theme.light"),
        checked: false,
        action: () => handlers.setTheme("light"),
      }),
      await CheckMenuItem.new({
        id: "theme-dark",
        text: t("menu.view.theme.dark"),
        checked: false,
        action: () => handlers.setTheme("dark"),
      }),
      await CheckMenuItem.new({
        id: "theme-system",
        text: t("menu.view.theme.system"),
        checked: true,
        action: () => handlers.setTheme("system"),
      }),
    ],
  });

  const viewMenu = await Submenu.new({
    text: t("menu.view"),
    items: [
      await MenuItem.new({
        id: "toggle-mode",
        text: t("menu.view.toggleMode"),
        accelerator: "CmdOrCtrl+E",
        action: () => handlers.toggleMode(),
      }),
      await MenuItem.new({
        id: "toggle-sidebar",
        text: t("menu.view.toggleSidebar"),
        accelerator: "CmdOrCtrl+Shift+L",
        action: () => handlers.toggleSidebar(),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      themeMenu,
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "zoom-reset",
        text: t("menu.view.actualSize"),
        accelerator: "CmdOrCtrl+0",
        action: () => handlers.zoomReset(),
      }),
      await MenuItem.new({
        id: "zoom-in",
        text: t("menu.view.zoomIn"),
        accelerator: "CmdOrCtrl+Plus",
        action: () => handlers.zoomIn(),
      }),
      await MenuItem.new({
        id: "zoom-out",
        text: t("menu.view.zoomOut"),
        accelerator: "CmdOrCtrl+-",
        action: () => handlers.zoomOut(),
      }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: t("menu.window"),
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "BringAllToFront" }),
    ],
  });

  const helpMenu = await Submenu.new({
    text: t("menu.help"),
    items: [
      await MenuItem.new({
        id: "keyboard-shortcuts",
        text: t("menu.help.shortcuts"),
        accelerator: "F1",
        action: () => handlers.showKeyboardShortcuts(),
      }),
    ],
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
      await MenuItem.new({
        id: "preferences",
        text: t("menu.app.settings"),
        accelerator: "CmdOrCtrl+,",
        action: () => { void handlers.openPreferences(); },
      }),
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

  const projectsMenu = await Submenu.new({
    text: t("menu.projects"),
    items: projectItems,
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, projectsMenu, editMenu, viewMenu, windowMenu, helpMenu],
  });
  await menu.setAsAppMenu();
  return menu;
}

function revealLabel(): string {
  if (typeof navigator === "undefined") return t("menu.file.revealLinux");
  const platform = navigator.platform || "";
  if (/Mac/i.test(platform)) return t("menu.file.revealMac");
  if (/Win/i.test(platform)) return t("menu.file.revealWindows");
  return t("menu.file.revealLinux");
}

function shortName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
