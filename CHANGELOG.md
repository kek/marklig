# Changelog

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
