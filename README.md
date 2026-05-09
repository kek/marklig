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

## Architecture

- `src/editor/` — CodeMirror setup, markdown-it parser, decoration producers (one per construct: headings, inline, lists, links, images, blockquotes, tables, code blocks, front matter, footnotes, math, mermaid, reading-mode widgets).
- `src/shell/` — file lifecycle, watcher, settings, recents, recovery, close handling.
- `src/ui/` — toolbar, modal, sidebar (folder + TOC), preferences, shortcuts, titlebar.
- `src/export/` — HTML and sanitization for export.
- `src-tauri/` — Rust shell: file I/O, watcher (notify-debouncer-full), native menus.

See `REQUIREMENTS.md` for the full v1 spec and `ROADMAP.md` for the sub-spec breakdown and shipping status.

## License

MIT — see [LICENSE](LICENSE).
