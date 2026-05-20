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
  "prefs.autosave": "Auto-save",
  "prefs.autosave.label": "Save automatically after a short pause in typing",
  "prefs.close": "Close",

  // Modal: keyboard shortcuts
  "shortcuts.title": "Keyboard Shortcuts",
  "shortcuts.group.file": "File",
  "shortcuts.group.view": "View",
  "shortcuts.group.edit": "Edit",
  "shortcuts.group.app": "App",
  "shortcuts.action.open": "Open…",
  "shortcuts.action.openFolder": "Open Folder…",
  "shortcuts.action.save": "Save",
  "shortcuts.action.print": "Print…",
  "shortcuts.action.goToFile": "Go to file…",
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
  "shortcuts.group.projects": "Projects",
  "shortcuts.action.switchProject": "Switch project",

  // Modal: project switcher (quick palette)
  "palette.projects.title": "Switch Project",
  "palette.projects.placeholder": "Type to filter projects…",
  "palette.projects.empty": "No recent projects",
  "palette.projects.noMatches": "No matching projects",

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

  // Menus
  "menu.file": "File",
  "menu.file.newWindow": "New Window",
  "menu.file.open": "Open…",
  "menu.file.openFolder": "Open Folder…",
  "menu.file.openRecent": "Open Recent",
  "menu.file.openRecent.empty": "(none)",
  "menu.file.openRecent.clear": "Clear Menu",
  "menu.file.save": "Save",
  "menu.file.saveAs": "Save As…",
  "menu.file.export": "Export",
  "menu.file.export.html": "HTML…",
  "menu.file.print": "Print…",
  "menu.file.goToFile": "Go to File…",
  "menu.file.revealMac": "Reveal in Finder",
  "menu.file.revealWindows": "Show in Explorer",
  "menu.file.revealLinux": "Show in File Manager",
  "menu.file.closeWindow": "Close Window",
  "menu.edit": "Edit",
  "menu.edit.find": "Find…",
  "menu.edit.findReplace": "Find and Replace…",
  "menu.edit.copyAsHtml": "Copy as HTML",
  "menu.view": "View",
  "menu.view.toggleMode": "Reading / Edit Mode",
  "menu.view.toggleSidebar": "Show / Hide Sidebar",
  "menu.view.actualSize": "Actual Size",
  "menu.view.zoomIn": "Zoom In",
  "menu.view.zoomOut": "Zoom Out",
  "menu.view.theme": "Theme",
  "menu.view.theme.light": "Light",
  "menu.view.theme.dark": "Dark",
  "menu.view.theme.system": "Follow System",
  "menu.projects": "Projects",
  "menu.projects.empty": "(none)",
  "menu.projects.clear": "Clear Menu",
  "menu.projects.openRecentPalette": "Switch Project…",
  "menu.window": "Window",
  "menu.help": "Help",
  "menu.help.shortcuts": "Keyboard Shortcuts",
  "menu.app.settings": "Settings…",

  // Transient notices
  "notice.orphan": "This file is no longer on disk. Save As to choose a new location.",
  "notice.reloaded": "Reloaded from disk",

  // Quick-open / fuzzy file finder palette (Cmd-P)
  "quickOpen.title": "Go to file",
  "quickOpen.inputLabel": "Search files in folder",
  "quickOpen.placeholder": "Type to search files…",
  "quickOpen.noFolder": "Open a folder to search files",
  "quickOpen.noMatches": "No matching files",
  "quickOpen.loading": "Loading files…",
  "quickOpen.error": "Could not list files in this folder",

  // Sidebar sections (folder tree + table of contents)
  "sidebar.folder.filter": "Filter…",
  "sidebar.folder.filterAriaLabel": "Filter files in folder",
  "sidebar.folder.empty": "No Markdown files in this folder.",
  "sidebar.folder.error": "Could not read folder: {message}",
  "sidebar.folder.expand": "Expand folder section",
  "sidebar.folder.collapse": "Collapse folder section",
  "sidebar.folder.newFile": "New file",
  "sidebar.folder.newFileTitle": "Create a new Markdown file in this folder",
  "sidebar.folder.newFileMenu": "New File…",
  "sidebar.folder.newFilePlaceholder": "untitled.md",
  "sidebar.folder.newFileAriaLabel": "Name for the new file",
  "sidebar.folder.newFileDefault": "untitled.md",
  "sidebar.folder.newFileErrorEmpty": "Enter a file name.",
  "sidebar.folder.newFileErrorSlash": "Subfolders aren't supported here — leave out the “/”.",
  "sidebar.folder.newFileErrorExists": "A file with that name already exists.",
  "sidebar.folder.newFileErrorWrite": "Could not create file: {message}",
  "sidebar.toc.untitled": "Untitled",
  "sidebar.toc.empty": "No headings in this document.",
  "sidebar.toc.expand": "Expand contents section",
  "sidebar.toc.collapse": "Collapse contents section",

  // Toolbar buttons (icon buttons need a localized aria-label / title)
  "toolbar.edit": "Edit",
  "toolbar.edit.title": "Switch to edit mode (Cmd/Ctrl+E)",
  "toolbar.read": "Read",
  "toolbar.read.title": "Switch to reading mode (Cmd/Ctrl+E)",
  "toolbar.toc": "Table of contents",
  "toolbar.toc.title": "Toggle table of contents",

  // Reading-mode ARIA labels (announced to screen readers)
  "a11y.codeBlock": "Code block",
  "a11y.codeBlockWithLang": "Code block, {lang}",
  "a11y.mermaidDiagram": "Mermaid diagram",
  "a11y.mermaidDiagramFailed": "Mermaid diagram (failed to render)",
  "a11y.mermaidDiagramLoading": "Rendering Mermaid diagram",
  "a11y.graphvizDiagram": "Graphviz diagram",
  "a11y.graphvizDiagramFailed": "Graphviz diagram (failed to render)",
  "a11y.graphvizDiagramLoading": "Rendering Graphviz diagram",
  "a11y.remoteImage": "Remote image",
  "a11y.remoteImageWithAlt": "Remote image: {alt}",
  "a11y.brokenImage": "Broken image",
  "a11y.brokenImageWithAlt": "Broken image: {alt}",

  // Mobile companion (v2.0). Library home + back navigation. Pairing copy
  // is a placeholder for v2.1 — the CTA only shows a "coming soon" hint
  // until step 5/7 of the mobile plan lands the real flow.
  "mobile.library.title": "Märklig",
  "mobile.library.recents": "Recent files",
  "mobile.library.empty":
    "Open a Markdown file from the share sheet or pair with a desktop to see it here.",
  "mobile.library.pair_cta": "Pair with a desktop",
  "mobile.library.pair_unavailable": "Pairing arrives in v2.1.",
  "mobile.library.paired_desktops": "Paired desktops",
  "mobile.library.back": "Back to library",
  "mobile.pair.title": "Pair with a desktop",
  "mobile.pair.qr_label": "Paste the QR URL shown on the desktop",
  "mobile.pair.qr_placeholder": "marklig-pair://v1/…",
  "mobile.pair.host_label": "Desktop LAN IP or hostname",
  "mobile.pair.host_placeholder": "192.168.1.110",
  "mobile.pair.name_label": "What should the desktop call this phone?",
  "mobile.pair.name_placeholder": "My phone",
  "mobile.pair.submit": "Pair",
  "mobile.pair.cancel": "Cancel",
  "mobile.pair.in_progress": "Pairing…",
  "mobile.pair.success_prefix": "Paired with ",
  "mobile.pair.success_fingerprint":
    "Verification code: {fingerprint}. If it matches what the desktop shows, you're done.",
  "mobile.pair.failed_prefix": "Pairing failed: ",
  "mobile.pair.dismiss": "Back to library",
  "mobile.synced.sync_now": "Sync now",
  "mobile.synced.empty":
    "No synced files yet. Tap Sync now to pull from the desktop.",
  "mobile.synced.syncing": "Syncing…",
  "mobile.synced.synced_n": "Synced {n} files.",
  "mobile.synced.failed_prefix": "Sync failed: ",
  "mobile.synced.prompt_host": "Desktop LAN IP",
  "mobile.pair.scan_instructions":
    "Point the camera at the QR code shown in the desktop's Settings → Pairings.",
  "mobile.pair.scan_starting": "Starting camera…",
  "mobile.pair.scan_ready": "Aim at the QR code.",
  "mobile.pair.invalid_qr": "Not a Märklig pairing QR — try again.",
  "mobile.pair.no_camera": "No camera detected.",
  "mobile.pair.camera_failed_prefix": "Camera failed: ",
  "mobile.pair.manual_entry": "Enter manually",
  "mobile.pair.use_camera": "Use camera",
  "mobile.pair.confirm_title": "Pair with this desktop?",
  "mobile.pair.confirm_host_prefix": "Detected desktop at",

  // Desktop pairing UX (step 5 of the v2 mobile companion).
  "pairing.modal.title": "Pair with a phone",
  "pairing.modal.starting": "Starting pairing…",
  "pairing.modal.ready": "Scan the QR code below on your phone.",
  "pairing.modal.scan_hint":
    "Open Märklig on the phone and scan this QR code, or paste the URL into a paired-device entry.",
  "pairing.modal.qr_payload_aria": "Pairing URL to scan from the phone",
  "pairing.modal.alpha_note":
    "v2.0-alpha: pairing requires the phone-side scanner from steps 6 + 7. " +
    "The URL is shown as text here as a placeholder while the QR renderer and " +
    "the LAN handshake are wired up.",
  "pairing.modal.failed_prefix": "Pairing failed: ",
  "pairing.modal.close": "Cancel",
  "pairings.pane.title": "Paired phones",
  "pairings.pane.empty":
    "No phones paired yet. Use Pair with a phone… to add one.",
  "pairings.pane.synced_folders": "Synced folders",
  "pairings.pane.no_synced_folders": "No folders synced.",
  "pairings.pane.add_folder": "Add a folder…",
  "pairings.pane.unpair": "Unpair",
  "pairings.pane.unpair_confirm": "Unpair {name}? This stops any future syncs.",
  "pairings.pane.last_seen": "Last seen {ago}",
  "pairings.pane.paired": "Paired {when}",
} as const;

export type StringKey = keyof typeof EN;

/** Map of overrides for the active locale. Falls back to EN per key. */
let overrides: Partial<Record<StringKey, string>> = {};

/** Look up a localized string. Returns the EN default when no override exists. */
export function t(key: StringKey): string {
  return overrides[key] ?? EN[key];
}

/** Look up a localized string and substitute `{name}` placeholders.
 * Example: tA11y("a11y.codeBlockWithLang", { lang: "rust" }) → "Code block, rust". */
export function tA11y(
  key: StringKey,
  params: Record<string, string> = {},
): string {
  let s: string = overrides[key] ?? EN[key];
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, v);
  }
  return s;
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
