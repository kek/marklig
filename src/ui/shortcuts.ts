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

const groups: ShortcutGroup[] = [
  {
    heading: "File",
    entries: [
      { keys: `${mod}+O`, description: "Open…" },
      { keys: `${mod}+S`, description: "Save" },
      { keys: `${mod}+P`, description: "Print…" },
      { keys: `${mod}+W`, description: "Close window" },
    ],
  },
  {
    heading: "View",
    entries: [
      { keys: `${mod}+E`, description: "Toggle reading / edit mode" },
      { keys: `${mod}+${shift}+O`, description: "Toggle sidebar" },
      { keys: `${mod}+0`, description: "Actual size" },
      { keys: `${mod}+Plus`, description: "Zoom in" },
      { keys: `${mod}+−`, description: "Zoom out" },
    ],
  },
  {
    heading: "Edit",
    entries: [
      { keys: `${mod}+F`, description: "Find" },
      { keys: `${mod}+${shift}+F`, description: "Find and replace" },
      { keys: `${mod}+${shift}+C`, description: "Copy as HTML" },
    ],
  },
  {
    heading: "App",
    entries: [
      { keys: `${mod}+,`, description: "Settings" },
      { keys: "F1", description: "Keyboard shortcuts" },
    ],
  },
];

/** Open the keyboard-shortcuts modal. Resolves when the user closes it. */
export function openKeyboardShortcuts(): Promise<void> {
  return openModal({
    title: "Keyboard Shortcuts",
    build: (body) => {
      for (const g of groups) {
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
