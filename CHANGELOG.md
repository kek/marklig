# Changelog

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
