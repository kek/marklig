# Viewer

A desktop Markdown reader and editor. The defining quality is that **rendered Markdown should look beautiful** — good enough to read long-form content in, not just edit. Editing is a secondary mode you switch into when you want to change something.

Built on Tauri 2 + CodeMirror 6 + markdown-it. Runs natively on macOS, Linux, and Windows.

## Features

- **Reading mode by default** — open any `.md` / `.markdown` / `.mdx` / `.mdown` file and see it fully rendered. Markdown markers are hidden, headings are typeset, code blocks are syntax-highlighted (Shiki), tables and footnotes render inline.
- **Decorated-source editing** — toggle to edit mode (`Cmd/Ctrl + E`) and the same view becomes editable, markers visible but still styled. No round-trip through a separate textarea.
- **Rich content** — KaTeX for inline `$…$` and block `$$…$$` math; Mermaid diagrams; image rendering with a remote-image privacy policy.
- **Files & filesystem** — open, save, save-as, drag-and-drop. External-change watcher with conflict reconciliation (clean reload, dirty-prompt, orphan notice). Crash recovery via 5-second snapshot.
- **Navigation** — togglable TOC sidebar with click-to-jump and scroll-sync; folder sidebar with substring filter; multi-window with per-window watcher; OS-level Recents on macOS (NSDocumentController).
- **Export** — PDF via the OS print dialog; self-contained HTML with sanitized output (DOMPurify).
- **Search** — find/replace panel (`@codemirror/search`) in both modes.
- **Themes** — light, dark, follow-OS. Document zoom (`Cmd/Ctrl + 0/+/-`).
- **A11y & i18n** — modal a11y, reduced-motion respect, keyboard-navigable TOC, WCAG-AA contrast on muted text, i18n string extraction.

## Develop

```bash
npm install
npm run tauri:dev   # Tauri dev server (recommended)
npm run dev         # Vite-only (browser, no native shell)
```

## Test

```bash
npm test             # Vitest unit suite
npm run test:watch
npm run test:e2e     # Playwright e2e (open, edit, external change, visual regression)
```

## Build

```bash
npm run tauri:build
```

CI matrix runs Ubuntu, macOS, and Windows on every push.

### macOS Quick Look extension

The macOS build ships a Quick Look preview + thumbnail extension so pressing
Space on a `.md` file in Finder shows a fully rendered preview matching
Viewer's reading mode, and column-view thumbnails get a branded "MD" badge
plus the document's first heading.

The extension is a pair of `.appex` bundles in `src-tauri/macos/quicklook/`,
built with a hand-rolled `xcrun swiftc` script (no Xcode project needed).

```bash
# 1. Build the .appex bundles (universal arm64 + x86_64, ad-hoc signed):
scripts/build-quicklook.sh
# → target/quicklook/ViewerQuickLook.appex
# → target/quicklook/ViewerThumbnail.appex

# 2. Build the host .app:
npm run tauri:build

# 3. Copy the extensions into the .app's PlugIns directory:
scripts/build-quicklook.sh --install \
    src-tauri/target/release/bundle/macos/Viewer.app

# 4. Drag Viewer.app to /Applications. Finder registers the extensions on
#    first launch; pressing Space on any .md file then shows the rendered
#    preview, and Finder's column / icon views use the branded thumbnail.
```

To smoke-test the renderer or the bundles in isolation:

```bash
scripts/test-quicklook.sh         # Swift fixtures for MarkdownRenderer
qlmanage -p some.md               # render the preview to a Quick Look window
qlmanage -t -s 256 -o /tmp some.md  # render a thumbnail PNG
```

See `src-tauri/macos/quicklook/README.md` for architecture notes, the
sanitisation contract, what's deliberately deferred (math, Mermaid,
syntax highlighting in code blocks), and the macOS 14+ format details
(the thumbnail `Info.plist` declares the extension via both
`EXAppExtensionAttributes` and `NSExtension`; the preview point only
exists as a legacy `NSExtension` point on Tahoe).

> Note: runtime activation by quicklookd requires a real `TeamIdentifier`.
> Ad-hoc signed extensions register with `pluginkit` but are not spawned
> into the sandboxed XPC pool, so end-to-end thumbnail/preview rendering
> verifies only on a Developer ID-signed build.

## Architecture

- `src/editor/` — CodeMirror setup, markdown-it parser, decoration producers (one per construct: headings, inline, lists, links, images, blockquotes, tables, code blocks, front matter, footnotes, math, mermaid, reading-mode widgets).
- `src/shell/` — file lifecycle, watcher, settings, recents, recovery, close handling.
- `src/ui/` — toolbar, modal, sidebar (folder + TOC), preferences, shortcuts, titlebar.
- `src/export/` — HTML and sanitization for export.
- `src-tauri/` — Rust shell: file I/O, watcher (notify-debouncer-full), native menus.

See `REQUIREMENTS.md` for the full v1 spec and `ROADMAP.md` for the sub-spec breakdown and shipping status.

## macOS file associations

Viewer's `Info.plist` declares itself as an editor for `.md`, `.markdown`, `.mdx`, and `.mdown` files via `CFBundleDocumentTypes`, and it exports the `net.daringfireball.markdown` UTI (conforming to `public.plain-text`). When you install the built `Viewer.app` into `/Applications`, macOS LaunchServices picks this up automatically the first time the app is launched, indexed by Spotlight, or copied to a tracked location.

If "Open With → Viewer" doesn't show up in Finder, force-register the bundle:

```bash
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f /Applications/Viewer.app
```

(Useful when you ran a fresh build out of the source tree without copying it to `/Applications`, or after replacing the bundle in place.)

To set Viewer as your default Markdown handler:

1. In Finder, right-click any `.md` file and choose **Get Info**.
2. Under **Open with**, select **Viewer**.
3. Click **Change All…** to apply the choice to every `.md` file.

Repeat for `.markdown`, `.mdx`, and `.mdown` if you want them handled the same way — macOS keeps a separate default handler per extension/UTI.

When Viewer is already running, double-clicking a `.md` file in Finder routes through Tauri's `RunEvent::Opened`. The Rust shell forwards the path to the focused (or, failing that, main) window only — other open Viewer windows aren't disturbed — and brings that window forward.

## License

MIT — see [LICENSE](LICENSE).
