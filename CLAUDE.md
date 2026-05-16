# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Viewer is a desktop Markdown reader/editor built on **Tauri 2 + CodeMirror 6 + markdown-it**. The product thesis (`REQUIREMENTS.md`) is that *rendered Markdown should look beautiful enough to read in*, with editing as a secondary mode. `ROADMAP.md` tracks v1 sub-specs A–F (A–C shipped, D–F partial).

This repo is a **Jujutsu** repo (`.jj/` exists). Use `jj`, not raw `git`, for VCS operations — see the `jujutsu` skill before any commit/branch action.

## Commands

```bash
npm run tauri:dev     # Run the desktop app (preferred dev loop)
npm run dev           # Vite-only — opens in a browser, no native shell / no Tauri APIs
npm run tauri:build   # Production build (also: `-- --debug` for debug build, used in CI)

npm test              # Vitest unit suite (jsdom)
npm run test:watch
npx vitest run tests/decorations/headings.test.ts   # Run a single unit test file
npx vitest run -t "renders ATX headings"            # Run by test name

npm run test:e2e                                     # Playwright e2e
npx playwright test tests/e2e/edit-and-save.spec.ts  # Single spec
npx playwright test --update-snapshots               # Refresh visual-regression baselines

npx tsc -b --noEmit         # Frontend type-check (CI runs this)
cargo check                 # Rust check, run from src-tauri/
```

E2E runs `fullyParallel: false, workers: 1` (see `playwright.config.ts`) — they share window/file state and must run serially.

## Architecture — the decorated-source pattern

The single most important thing to understand: **there is no separate preview pane.** Reading and editing share one CodeMirror 6 EditorView. Mode is just a different set of *decorations* + *keymap* + *readOnly* applied via Compartments (`src/editor/editor.ts`).

- `readOnlyCompartment` — `EditorState.readOnly` toggle
- `decorationsCompartment` — the decoration `StateField` for the active mode
- `keymapCompartment` — reading vs edit keymap
- `selectionCompartment` — `drawSelection()` in edit, native browser selection in reading (CM's drawn selection looks blocky over heavy widget layout)

Reading mode adds `readingWidgetsProducer`, `mathProducer`, `mermaidProducer` to the editing producers; everything else is shared. Both modes parse the same source — only the producer set differs. Markers are *hidden* (replaced by widgets / collapsed via `Decoration.replace`) in reading mode and *muted but visible* in edit mode.

### Decoration producers (`src/editor/decorations/`)

One file per Markdown construct (`headings`, `inline`, `lists`, `links`, `images`, `blockquotes`, `tables`, `codeblocks`, `frontmatter`, `footnotes`, `reading-widgets`, `math`, `mermaid`). Each exports a `DecorationProducer: (ctx) => DecorationSet` that runs against the markdown-it token stream from `src/editor/parser.ts`.

`buildDecorationField` (`decorations/index.ts`) collects ranges from all producers, calls `Decoration.set(ranges, /* sort */ true)` — the `true` is **required for correctness**, not an optimization, because adjacent line/block-replace decorations need startSide ordering the manual sort doesn't model.

Recompute triggers:
- `tr.docChanged` — normal path
- `highlightCacheEffect` (Shiki finished tokenizing a block)
- `mermaidCacheEffect` (Mermaid finished rendering an SVG)
- `refreshDecorationsEffect` — dispatch this whenever **external state read by widgets at render time changes** (e.g. `remoteImagePolicy` flips). Without it, settings changes wouldn't reflow until the next keystroke.

### Async widget caches (Shiki / Mermaid)

Both libraries are async and big. Pattern: synchronous decoration producer reads from a per-source-string cache; on miss it kicks off async work and returns a placeholder; cache fill triggers a `StateEffect` that re-runs the field. See `decorations/codeblocks.ts` (Shiki) and `decorations/mermaid.ts` (Mermaid). Mermaid is loaded via dynamic `import("mermaid")` so its ~1 MB lives in its own chunk.

### Rust shell (`src-tauri/src/`)

`commands/` exposes invoke handlers for file I/O (`read_text_file`, `write_text_file`, `list_markdown_files`, `is_directory`, `reveal_in_file_manager`), the recovery store (`write_recovery`, `read_all_recovery`, `clear_recovery`), the watcher (`watcher_start/stop/mark_self_write`, backed by `notify-debouncer-full` — **not** `notify-debouncer-mini`, which doesn't fire remove events), and macOS `recents_os` (NSDocumentController via `objc2`).

`lib.rs` listens for `RunEvent::Opened` and forwards file-association launches to the frontend as a `file-open-request` event. Bootstrap (`src/main.ts`) waits up to 500ms for this on startup before falling back to last-opened / open dialog, so double-clicking a `.md` doesn't briefly show a redundant dialog.

### File lifecycle (`src/shell/`)

- **Save** (`files.ts`) calls `watcherHandle.markSelfWrite()` *before* writing, so the watcher swallows the resulting fs event instead of treating it as an external change.
- **Watcher reconciliation** (`watcher.ts` + `ui/reconcile.ts`): clean buffer + external change → silent reload preserving scrollTop; dirty buffer + external change → modal (reload / keep-mine / cancel); file removed externally → orphan notice and `currentPath = null`. A user's "keep mine" sets `diverged = true`, which then warns on next save.
- **Crash recovery** (`recovery.ts`): every 5s while dirty, the buffer is dumped via `write_recovery`. On startup the *main* window only (`label === "main"`) prompts to restore. Save / explicit discard clears the dump.
- **Auto-save** is debounced 1000 ms after the last edit; skipped while `diverged` so it doesn't pop the "save anyway?" modal mid-typing.
- **Multi-window**: secondary windows (`?file=…` URL param or plain `New Window`) start blank — they don't run recovery and don't auto-restore last-opened. Only `main` does.

### Export & sanitization (`src/export/`)

`buildHtmlExport` produces a self-contained HTML doc (inlined export stylesheet + KaTeX CSS via Vite `?inline` query). Math is pre-extracted with the same regex used by `decorations/math.ts`, rendered through `katex.renderToString`, and re-substituted *after* markdown-it tokenizes so math source isn't double-tokenized.

**Sanitization is mandatory for every innerHTML path:**
- markdown-it HTML (export, copy-as-HTML) → `sanitizeHtml` (DOMPurify, default html profile)
- KaTeX HTML output → `sanitizeHtml`
- Mermaid SVG → `sanitizeSvg` (DOMPurify with `USE_PROFILES: { svg: true, svgFilters: true, html: true }` — needed to keep `<foreignObject>` HTML labels)

The reading view itself doesn't innerHTML the document — it stays text + CM widgets — so the architectural guarantee from REQUIREMENTS §6 holds even before the sanitizer runs.

Print uses a hidden same-process iframe + `contentWindow.print()` (Tauri's webview doesn't reliably forward `window.print()` from a popup). PDF currently goes through the OS print dialog's Save-as-PDF — there's no native Rust-side webview-to-PDF path.

### Mobile target (Android, v2 companion in progress)

`src-tauri/gen/android/` is tracked. The Android target is scaffolded via
`tauri android init` and renders the existing webview frontend through
`TauriActivity`. Build outputs (`.gradle/`, `build/`, `local.properties`)
are gitignored; the project itself (Gradle config, Kotlin entry-point,
resources) is checked in.

Desktop-only Rust code is gated behind `#[cfg(desktop)]`: the `watcher`,
`folder_watcher`, `files`, `recents_os`, and `cli_tool` modules; the
`.manage(WatcherState::new())` / `.manage(FolderWatcherState::new())`
calls; and most of the `invoke_handler` chain. The mobile-only handler
chain currently exposes just `take_pending_open_paths`. `pub fn run()`
carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]` so Tauri's
Android JNI entry point is generated. When adding new commands, default
to gating them desktop-only unless they're explicitly designed for both —
Android does not have an FS watcher and does not have NSDocumentController.

On the frontend, `src/main.ts` forks at the bottom on `isMobile()`
(from `src/platform.ts`): mobile dynamically imports
`src/mobile-bootstrap.ts`, which renders the bundled `src/sample.md`
through the same decoration producer set as desktop reading mode. There
is no mobile file shell yet — step 2 of the v2 plan adds Storage Access
Framework integration.

`npm run tauri:android:dev` runs the dev loop (requires `NDK_HOME` and a
running emulator — see README "Android" section).

### Settings, i18n, recents

- `src/shell/settings.ts` — settings store with `subscribeSettings()`. After mutating, dispatch `refreshDecorationsEffect` so widgets that read settings at `toDOM` time (notably `ImageWidget` honoring `remoteImagePolicy: load|placeholder|off`) pick up changes without a doc reload.
- `src/i18n/strings.ts` — `t(key)` is the only path for user-visible strings. Don't hardcode UI text.
- Recents: `src/shell/recents.ts` (in-app, last 10, deduped) plus `recents_os.rs` (macOS NSDocumentController). Windows Jump List + Linux RecentManager are not yet wired (see ROADMAP.md sub-spec D).

## Conventions

- **TypeScript-strict; one decoration producer per construct.** When adding Markdown features, follow the existing producer contract — don't bypass it with custom view plugins.
- **Never re-introduce raw HTML rendering paths without sanitization.** If you add a new innerHTML site, route it through `sanitizeHtml` or `sanitizeSvg`.
- **Don't use `notify-debouncer-mini`.** It silently drops remove events; the codebase moved to `notify-debouncer-full` for that reason.
- **Don't add libraries that ship Latin-only assets / US-keyboard shortcuts.** Sweden / Swedish-keyboard is a first-class target; avoid `\` `[` `]` `/` for new shortcuts (use letters, digits, function keys).
- **Tests live under `tests/`** mirroring `src/` (e.g. `tests/decorations/headings.test.ts` covers `src/editor/decorations/headings.ts`). Snapshot fixtures live in `tests/parser/fixtures` and `tests/parser/__snapshots__`. Visual-regression baselines are in `tests/e2e/visual-regression.spec.ts-snapshots/`.

## Where to look

- `REQUIREMENTS.md` — full v1 product spec (what, not how).
- `ROADMAP.md` — sub-spec A–F status, with detailed shipping notes per plan.
- `CHANGELOG.md` — release notes per shipped plan.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and TDD-disciplined task plans (workflow: `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development`).
