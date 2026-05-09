# Changelog

## [0.6.0] - 2026-05-09 — Sub-spec D + E partial; reading-mode polish

### Added

- **File associations** for `.md` / `.markdown` / `.mdx` / `.mdown`. Tauri's bundler emits `CFBundleDocumentTypes` + `UTExportedTypeDeclarations` on macOS, registry entries on Windows, and `MimeType=` on the Linux `.desktop`. Files arrive via `tauri::RunEvent::Opened` (URLs, not argv); the Rust handler forwards them to the frontend as a `file-open-request` event. The frontend listener routes through a new `openWithDirtyPrompt` helper used by both drag-drop and OS-level launches. Cold-start case (Finder double-click) waits up to 500 ms for the event before falling back to the open dialog, so no redundant dialog flashes.
- **Preferences modal** (`Cmd/Ctrl + ,`). Two settings exposed: appearance (system / light / dark) and remote-image policy (placeholder / load / off). Both already wired through the data layer; this surfaces them. Settings changes dispatch a new `refreshDecorationsEffect` so widgets that read settings at render time (notably `ImageWidget`) pick up the change without a doc reload.
- **Keyboard shortcuts modal** (Help → Keyboard Shortcuts, `F1`). Lists every shortcut grouped by area, with platform-correct glyphs (⌘/⇧ on macOS, Ctrl/Shift elsewhere). `F1` chosen because `Cmd+/` and `Cmd+?` need shifted punctuation on most non-US layouts.
- **Reading-mode polish**: horizontal rules (`---` / `***` / `___`) render as block `<hr>` widgets in reading mode (previously left as literal text); bullet markers (`-`/`*`/`+`) render as `•` (previously elided entirely).

### Fixed

- Math producer mistokenized `` `$x$` `` (dollars inside backticks) as KaTeX. Both the in-app math producer and the export-side math pre-process now mask inline code spans before scanning for math.
- Mermaid label text was missing in rendered diagrams. The DOMPurify `svg + html` profile combo was eating Mermaid 11's `<foreignObject>` HTML labels. Mermaid output is trusted (our own dep, `securityLevel: "strict"`); skip the redundant sanitize pass.

### Test surface

- 119 unit tests across 25 files (was 114/25). 5 new across math, reading-widgets, and html-export.

### Not yet (Sub-spec D)

- Folder/project tree, multi-window UX, OS-level Recents (LSRecentDocuments / Jump List / RecentManager).

### Not yet (Sub-spec E)

- Auto-updater. Needs `tauri-plugin-updater`, signing keys, and an update-feed host — separate piece of work.

## [0.5.0] - 2026-05-08 — Sub-spec C: Export & print

### Added

- **HTML export.** File → Export → HTML… writes a self-contained `.html` file: full DOCTYPE, inlined export stylesheet (light + dark via `prefers-color-scheme`, print-friendly `@media print`), inlined KaTeX CSS for math, and the rendered body. Math (`$…$`, `$$…$$`) is rendered via KaTeX during the export pass; markdown-it never sees the math source so `*` inside an expression doesn't become `<em>`. `<script>` and event handlers are stripped through `sanitizeHtml`.
- **Print** (`Cmd/Ctrl + P`). Renders the same export HTML into a hidden same-process iframe and triggers `iframe.contentWindow.print()`. Works on macOS / Linux (system print dialog → "Save as PDF" → file). The `@media print` block in the export stylesheet drops the page padding, black-on-white forces inheritance, and `page-break-inside: avoid` keeps code blocks/blockquotes together.
- **Copy as HTML** (`Cmd/Ctrl + Shift + C`). `ClipboardItem` with both `text/html` and a `text/plain` fallback. Pasting into a rich-text receiver yields formatted output; pasting into a terminal yields the text content.

### Bullet rendering fix

- Reading-mode bullets were elided entirely — `- foo` rendered as `foo` with no marker. Bullet markers (`-` / `*` / `+`) now render as `•`; ordered list numbers stay visible (numbers carry semantic content).

### Test surface

- 114 unit tests across 25 files (was 104/24): 9 for `buildHtmlExport` (document shape, title escaping, math/KaTeX, currency disambiguation, sanitization, emphasis-vs-math isolation, multi-inline-math), 1 added for ordered-list non-elision.

### Not yet

- Dedicated "Export as PDF…" menu entry. Currently routed through the OS print dialog's "Save as PDF". A first-class PDF action would need a Rust-side webview-to-PDF call; deferred.
- Mermaid in exports. Mermaid is async per-instance; rendering during a synchronous export pass would block. Fenced `mermaid` blocks export as their source until a future iteration.

## [0.4.0] - 2026-05-08 — Sub-spec B: Rich content

Math, Mermaid, and the remote-image policy. Plus a few bugfixes from the Foundation pass that weren't caught until heavy use after shipping.

### Added

- **Math (KaTeX).** Inline `$…$` and block `$$…$$` rendered in reading mode. KaTeX errors fall back to literal source. Currency-like text (`$5`) and escaped `\$` are not tokenized.
- **Mermaid diagrams.** Fenced code blocks tagged `mermaid` render as SVG in reading mode. Mermaid is dynamically imported on first use, so the initial bundle is unaffected (~3 KB delta). Render failures show the source verbatim above the error message rather than throwing.
- **Remote-image policy.** `load` / `placeholder` / `off` setting (default `placeholder`). Local images always render; remote images render only when explicitly allowed. Persists via the Tauri store. Broken images (in `load` mode) get a styled placeholder via `onerror`.
- **HTML / SVG sanitization on every innerHTML path.** KaTeX HTML output through `sanitizeHtml`; Mermaid SVG output through a new `sanitizeSvg` (DOMPurify with svg + svgFilters profiles to keep markup intact while stripping `<script>` and event handlers).

### Fixed (Foundation polish)

- Caret invisible in dark mode — CodeMirror's base theme set `caret-color: black` under its `.cm-light` class (always active without a `.cm-dark` flip). Now explicit per `data-mode`: `--fg` in edit, transparent in reading (read-only — no caret needed).
- Click-to-position drifted by N lines on documents with multiple headings — heading line spacing was using `margin`, but CM's heightmap measures `.cm-line` via `offsetHeight`/`getBoundingClientRect`, neither of which include vertical margins. Switched to `padding`.
- macOS lost File / Help / Cmd-Q after the first file selection — `setAsAppMenu` consumes the first submenu as the bold-app-name slot, and never auto-injects About/Hide/Quit. Added an explicit "viewer" application submenu and a Help submenu.

### Test surface

- 104 unit tests across 24 files (was 89/22): math producer (8), mermaid producer (5), settings/URL classification (10), `sanitizeSvg` (3), plus the existing 78.

## [0.3.0] - 2026-05-08 — Plan 3: Polish & platform — Foundation complete

Foundation Sub-spec A complete. The viewer meets every Definition of Done criterion in spec §12 on macOS, Windows, and Linux.

### Added

- Togglable TOC sidebar (auto-on for 3+ headings, persisted thereafter; click to jump; scroll-syncs the active heading; `Cmd/Ctrl + Shift + O` toggle)
- Recents menu (last 10, dedupe-on-record, "Clear Menu" entry)
- Crash recovery (5s dirty-buffer dump to `<app-data>/recovery/`; startup prompt to restore)
- Native menu inventory: File / Edit / View / Window with every item working — no stubs, no greyed-out submenus
- Document zoom: `Cmd/Ctrl + 0/+/-` with min 10px, max 32px
- Find/replace: `Cmd/Ctrl + F` panel works in both reading and edit modes
- DOMPurify-based `sanitizeHtml` seam for Sub-spec C export paths
- Real iconset (replaces Plan 1 placeholder; `tauri build` no longer blocked)
- GitHub Actions CI matrix (Ubuntu / macOS / Windows: tsc, vitest, cargo check, playwright e2e, tauri build)
- Visual regression Playwright corpus (light + dark theme baselines)

### Plan 1 + Plan 2 carryover items closed

- Switched watcher to `notify-debouncer-full` so file-removed events emit (orphan path now reachable)
- Preserve scroll position on external reload
- Reconcile modal default focus on "Keep my edits" (safe action)
- `frontmatter.ts` and `inline.ts` use shared `computeLineStarts` (no per-loop reallocation)
- `thiserror` direct dep aligned to 2.x
- `setActiveTheme` wired (theme persistence on user pick — surfaced via View → Theme menu)
- `renderHtml` documented as the export pipeline seam

### Test surface

- 80 unit tests across 21 test files (parser, theme, dirty tracker, every decoration producer, recents, recovery, sanitize, sidebar state)
- 5 Playwright e2e: open-and-render, edit-and-save, external-change, visual-regression (light + dark)

## [0.2.0] - 2026-05-08 — Plan 2: Editing & file lifecycle

Foundation Sub-spec A, Plan 2 of 3 complete. The viewer is now an editor: toggle between reading and editing, save, and the buffer auto-reloads when the file changes on disk.

### Added

- Edit mode with decorated source (markers visible, formatting applied per spec §2.2)
- Mode toggle: toolbar button + `Cmd/Ctrl + E` shortcut, two-way synced
- Reading-mode keymap: Space, Shift+Space, Page keys, arrows, Home/End, Cmd/Ctrl + arrow for top/bottom
- Save: `Cmd/Ctrl + S` writes to the original path
- Dirty tracking: window title bullet, toolbar dot indicator
- Close-with-dirty prompt (Save / Discard / Cancel)
- Drag-and-drop a `.md` file onto the window to open it (with dirty-discard prompt)
- Rust file watcher (`notify` crate) on the open file's parent directory; self-write filter; reconciliation:
  - Clean buffer → silent reload with "Reloaded from disk" notice
  - Dirty buffer → modal prompt (Reload / Keep edits)
  - File deleted/moved → orphan state with notice; dirty flag forced on
- Diverged-state save warning ("Save anyway?") when user kept dirty edits after external change
- Watcher switches to the new path when drag-drop opens a different file
- Three Playwright e2e specs: open-and-render, edit-and-save, external-change

### Plan 1 carryover items closed

- Shiki token-level syntax coloring via async cache + StateEffect
- Multi-line paragraph decoration in `inline.ts` and `links.ts`
- Explicit `color-scheme: light/dark` on forced themes
- `computeLineStarts` promoted to a shared util in `decorations/index.ts`

### Not yet (Plan 3 — Polish & platform)

- TOC sidebar
- Recents menu
- Crash recovery
- Native menu inventory
- Document zoom
- Find/replace UI
- HTML sanitization (DOMPurify) for export paths
- GitHub Actions CI matrix
- Visual regression corpus
- Real app icon and packaging

## [0.1.0] - 2026-05-08 — Plan 1: Read-only viewer

Foundation Sub-spec A, Plan 1 of 3 complete. The app boots, opens a Markdown file (via dialog or CLI argument), and renders it in beautiful, themed read-only mode.

### Added

- Tauri 2.x desktop shell with Vite + TypeScript frontend
- markdown-it parser with GFM, footnotes, definition lists, and task-list plugins
- CodeMirror 6 editor with three compartments (`readOnly`, `decorations`, `keymap`)
- Eleven decoration producers, one per construct:
  - Headings (H1–H6)
  - Inline (bold, italic, code, strikethrough, with nested-emphasis support)
  - Lists (bullet, ordered, task lists)
  - Links (inline `[text](url)` + linkify-generated autolinks)
  - Images (source-span styling)
  - Blockquotes (with lazy-continuation handling)
  - Tables (header / separator / body rows)
  - Code blocks (fence + body line classes; Shiki priming)
  - Front matter (YAML and TOML at file start)
  - Footnotes and definition lists
  - Reading-mode widgets (link bracket/paren elide, image rendering, code-fence and front-matter line elide)
- Light, dark, and OS-follow themes via CSS custom properties; `theme-light`/`theme-dark` class flip on `<html>`
- Theme persistence in `localStorage` and live OS-theme change watcher
- Rust `read_text_file` Tauri command with 50 MB cap and typed `FileError`
- Frontend bootstrap that opens a file via OS dialog (or first markdown CLI arg fallback) and wires every decoration producer into the editor
- Vitest unit tests: parser, theme, every decoration producer (47 tests across 14 files)
- Playwright e2e smoke test for the open-and-render flow with mocked Tauri internals

### Known limitations carried into Plan 2

- The reading-mode block-replace widget for code fences visually occludes the `cm-md-code-body` line class. The text content still renders; only the line-class CSS doesn't apply at the exact start position. Plan 2 will revisit decoration ordering when adding edit-mode behaviour.
- The `src-tauri/icons/icon.png` placeholder (104 bytes) is enough for `tauri dev` but too small for `tauri build`. A real icon ships with Plan 3 packaging.
- Direct dependency `thiserror = "1"` is overshadowed by transitive `thiserror = "2"` from the Tauri plugins. Will align in Plan 2 when the Rust shell grows.

### Not yet (Plan 2 — Editing & file lifecycle)

- Edit mode and decorated-source styling overlays
- Mode toggle and reading-mode keymap (Space/Shift+Space, Page keys, arrows, Home/End)
- Save and dirty tracking
- Drag-and-drop, file watcher, reconciliation (clean / dirty / orphaned)

### Not yet (Plan 3 — Polish & platform)

- TOC sidebar
- Recents menu and crash recovery
- Native menu inventory and full keyboard shortcuts
- Document zoom, find/replace
- HTML sanitization hardening (DOMPurify reading-pass)
- GitHub Actions CI matrix
- Visual regression corpus
- Real app icon and packaging
