import { t } from "../i18n/strings";
import { openModal } from "./modal";

interface ShortcutEntry {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  heading: string;
  entries: ShortcutEntry[];
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";
const shift = isMac ? "⇧" : "Shift";

function buildGroups(): ShortcutGroup[] {
  return [
    {
      heading: t("shortcuts.group.file"),
      entries: [
        { keys: `${mod}+O`, description: t("shortcuts.action.open") },
        { keys: `${mod}+${shift}+O`, description: t("shortcuts.action.openFolder") },
        { keys: `${mod}+S`, description: t("shortcuts.action.save") },
        { keys: `${mod}+P`, description: t("shortcuts.action.print") },
        { keys: `${mod}+W`, description: t("shortcuts.action.closeWindow") },
      ],
    },
    {
      heading: t("shortcuts.group.view"),
      entries: [
        { keys: `${mod}+E`, description: t("shortcuts.action.toggleMode") },
        { keys: `${mod}+${shift}+L`, description: t("shortcuts.action.toggleSidebar") },
        { keys: `${mod}+0`, description: t("shortcuts.action.actualSize") },
        { keys: `${mod}+Plus`, description: t("shortcuts.action.zoomIn") },
        { keys: `${mod}+−`, description: t("shortcuts.action.zoomOut") },
      ],
    },
    {
      heading: t("shortcuts.group.edit"),
      entries: [
        { keys: `${mod}+F`, description: t("shortcuts.action.find") },
        { keys: `${mod}+${shift}+F`, description: t("shortcuts.action.findReplace") },
        { keys: `${mod}+${shift}+C`, description: t("shortcuts.action.copyAsHtml") },
      ],
    },
    {
      heading: t("shortcuts.group.projects"),
      entries: [
        // Ctrl+R on every platform (incl. macOS) — Cmd+R is reload by
        // convention, so the palette uses literal Ctrl.
        { keys: "Ctrl+R", description: t("shortcuts.action.switchProject") },
      ],
    },
    {
      heading: t("shortcuts.group.app"),
      entries: [
        { keys: `${mod}+,`, description: t("shortcuts.action.settings") },
        { keys: "F1", description: t("shortcuts.action.shortcuts") },
      ],
    },
  ];
}

/** Open the keyboard-shortcuts modal. Resolves when the user closes it. */
export function openKeyboardShortcuts(): Promise<void> {
  return openModal({
    title: t("shortcuts.title"),
    closeLabel: t("prefs.close"),
    build: (body) => {
      for (const g of buildGroups()) {
        const section = document.createElement("section");
        section.className = "viewer-prefs-section";
        const h = document.createElement("h4");
        h.textContent = g.heading;
        section.append(h);

        const dl = document.createElement("dl");
        dl.className = "viewer-shortcut-list";
        for (const e of g.entries) {
          const dt = document.createElement("dt");
          dt.className = "viewer-shortcut-keys";
          dt.textContent = e.keys;
          const dd = document.createElement("dd");
          dd.className = "viewer-shortcut-desc";
          dd.textContent = e.description;
          dl.append(dt, dd);
        }
        section.append(dl);
        body.append(section);
      }
    },
  });
}
