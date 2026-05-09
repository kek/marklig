// English source-of-truth string table. Every user-facing string in modals,
// notices, and menus that should be localizable lives here. The TypeScript
// type derived from this object is the canonical key set — adding a new
// locale is `Record<StringKey, string>`, no code changes needed.
//
// Keys are dot-namespaced by feature area so the eventual translator UX
// (or external translation file) reads as a hierarchy.
export const EN = {
  // Modal: preferences
  "prefs.title": "Preferences",
  "prefs.appearance": "Appearance",
  "prefs.theme.system": "Follow system",
  "prefs.theme.light": "Light",
  "prefs.theme.dark": "Dark",
  "prefs.images": "Remote images",
  "prefs.images.help":
    "Markdown can reference images by URL. The viewer never fetches them by default — pick what should happen when a document points at one.",
  "prefs.images.placeholder": "Show a placeholder with the URL (default)",
  "prefs.images.load": "Load and display",
  "prefs.images.off": "Hide entirely",
  "prefs.close": "Close",

  // Modal: keyboard shortcuts
  "shortcuts.title": "Keyboard Shortcuts",
  "shortcuts.group.file": "File",
  "shortcuts.group.view": "View",
  "shortcuts.group.edit": "Edit",
  "shortcuts.group.app": "App",
  "shortcuts.action.open": "Open…",
  "shortcuts.action.save": "Save",
  "shortcuts.action.print": "Print…",
  "shortcuts.action.closeWindow": "Close window",
  "shortcuts.action.toggleMode": "Toggle reading / edit mode",
  "shortcuts.action.toggleSidebar": "Toggle sidebar",
  "shortcuts.action.actualSize": "Actual size",
  "shortcuts.action.zoomIn": "Zoom in",
  "shortcuts.action.zoomOut": "Zoom out",
  "shortcuts.action.find": "Find",
  "shortcuts.action.findReplace": "Find and replace",
  "shortcuts.action.copyAsHtml": "Copy as HTML",
  "shortcuts.action.settings": "Settings",
  "shortcuts.action.shortcuts": "Keyboard shortcuts",

  // Modal: reconcile (file changed on disk)
  "reconcile.title": "File changed on disk",
  "reconcile.body": "Your unsaved edits and the new content cannot both be kept.",
  "reconcile.reload": "Reload from disk",
  "reconcile.keep": "Keep my edits",

  // Modal: dirty-prompt for out-of-band open (drag-drop, file association)
  "dirty.title": "Unsaved changes",
  "dirty.body": "Discard your unsaved changes and open this file?",
  "dirty.discard": "Discard and open",
  "dirty.cancel": "Cancel",

  // Transient notices
  "notice.orphan": "This file is no longer on disk. Save As to choose a new location.",
  "notice.reloaded": "Reloaded from disk",
} as const;

export type StringKey = keyof typeof EN;

/** Map of overrides for the active locale. Falls back to EN per key. */
let overrides: Partial<Record<StringKey, string>> = {};

/** Look up a localized string. Returns the EN default when no override exists. */
export function t(key: StringKey): string {
  return overrides[key] ?? EN[key];
}

/** Install a locale's strings. Pass an empty object to revert to EN. */
export function setLocaleStrings(strings: Partial<Record<StringKey, string>>): void {
  overrides = { ...strings };
}

/** Read the active locale tag (BCP-47). Returns navigator.language for now;
 * a future preferences entry can override. */
export function activeLocale(): string {
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en";
}
