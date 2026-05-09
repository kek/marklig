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

/** Open a modal listing every keyboard shortcut grouped by area. Resolves
 * when the user closes it (Esc, overlay click, or close button). */
export function openKeyboardShortcuts(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "viewer-prefs-overlay";

    const card = document.createElement("div");
    card.className = "viewer-prefs-card";

    const title = document.createElement("h3");
    title.textContent = "Keyboard Shortcuts";
    card.append(title);

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
      card.append(section);
    }

    const footer = document.createElement("div");
    footer.className = "viewer-prefs-footer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-toolbar-btn";
    close.textContent = "Close";
    footer.append(close);
    card.append(footer);

    function dismiss(): void {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      resolve();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") dismiss();
    }
    close.addEventListener("click", dismiss);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener("keydown", onKey);

    overlay.append(card);
    document.body.append(overlay);
    close.focus();
  });
}
