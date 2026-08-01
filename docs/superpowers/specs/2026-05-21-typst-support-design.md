# Typst support — design

**Date:** 2026-05-21
**Status:** Draft. Brainstormed via `/superpowers:brainstorming`; awaiting user sign-off before a build plan is written under `docs/superpowers/plans/`.

---

## 1. Goals & non-goals

### In scope (desktop only)

- Open and view `.typ` files as a **first-class file format** alongside `.md`.
- Edit `.typ` source in CodeMirror 6 with Typst syntax highlighting and live diagnostics.
- A new **preview pane** (toggled with **Cmd-J** in edit mode) that, for `.typ` files, shows compiled Typst pages, and for `.md` files, shows the rendered Markdown view. Cmd-E (reading ↔ edit mode) keeps its current behavior.
- Compile via the embedded `typst` Rust crate, debounced ~300 ms, emitting SVG per page.
- Resolve `#import "./other.typ"`, image assets, system fonts, and `@preview/...` packages (fetched on first use, cached on disk).
- File lifecycle parity with `.md`: recents (in-app + macOS NSDocumentController), folder sidebar, watcher reconciliation, crash recovery, auto-save, file association, "New Typst file" command, bundled `sample.typ`.

### Out of scope (explicit non-goals)

- **Mobile / Android.** All Typst code paths are gated `#[cfg(desktop)]`. The mobile bootstrap refuses `.typ` with a clear message.
- **Typst as a Markdown export target.** Separate spec if/when we want it.
- **Typst-flavored math inside `.md`.** KaTeX stays the math engine for Markdown.
- **Inline Typst code blocks in Markdown.** Mermaid/code-fence-like rendering of Typst inside `.md` is not part of this.
- **A `typst-pdf` rendering backend.** Still deferred. Typst can emit PDF directly
  (`typst-pdf`, same 0.14 family as the four crates we already build), and that
  remains the highest-fidelity route — real PDF text, selectable and searchable,
  with the document's own page boxes and no raster/SVG round trip. It is a new
  dependency and new build time, and nothing here needs it yet.

  **Amended 2026-08-01 (#57).** This non-goal was originally written as "PDF
  export of `.typ` from inside the app", on the grounds that "the OS
  print/save-PDF dialog still works on the preview pane content". That rationale
  was not true, and had not been since before it was written: `openPrintWindow`
  prints a hidden iframe, not the pane, so no in-app command has ever printed
  the pane — and after #55 gave Export → PDF a native webview capture, both it
  and Print took the Markdown export of the Typst *source*. What shipped was
  therefore not a deferral but four enabled menu items that quietly produced the
  wrong document. Export → HTML, Export → PDF, Print and Copy as HTML now route
  at the compiled SVG pages the pane is already showing (`src/export/route.ts`,
  `src/export/typst-html.ts`), which is the pane content the original rationale
  assumed the user could reach. That uses `typst-svg`, which we already depend
  on; it adds no backend and does not settle the question above.
- **Watching sibling files** imported by an open `.typ`. Only the entry file is watched in v1; external edits to imported siblings won't refresh the preview until the entry file changes or the user re-saves.

## 2. Approaches considered

Three integration shapes were on the table:

1. **Typst-as-its-own-document (chosen).** A document's extension picks the parser/renderer pair. Markdown keeps its decorated-source pipeline; Typst gets a `typst` Rust compiler + an SVG-pages preview pane. Cmd-J toggles the preview pane in edit mode for *both* formats.
2. **Typst inside Markdown.** Code-fence widget like Mermaid. Smaller scope but not the user-requested shape.
3. **Tabbed two-document workspace.** A separate Typst "mini-app" in its own window. Doubles UI surface; rejected.

The rest of this spec details approach 1.

## 3. Architecture overview

### Format abstraction (frontend)

```
src/format/
  index.ts          // Format type, detectFormat(path), registry
  markdown.ts       // existing markdown-it parser + decoration producers, refactored in
  typst.ts          // typst tokenizer (for source highlighting) + invoke wrapper
  typst-driver.ts   // open/compile/close session driver, debounce, stale-discard
```

```ts
// src/format/index.ts
export type Format = "markdown" | "typst";
export function detectFormat(path: string | null): Format {
  return path?.toLowerCase().endsWith(".typ") ? "typst" : "markdown";
}
export function isSupportedExtension(path: string): boolean { /* .md, .markdown, .typ */ }
```

`EditorView` construction in `src/editor/editor.ts` becomes format-aware: it asks the registry for the decoration producers, keymap, and source-language extension to install in its compartments. The Markdown wiring is essentially refactored into `src/format/markdown.ts` with no behavior change.

### Mode × format matrix

| Mode \ Format | `.md` | `.typ` |
| --- | --- | --- |
| Reading (Cmd-E) | decorated source (today) | preview pane full-window, no source |
| Edit, no preview pane | decorated source (today) | source only, no preview |
| Edit, preview pane (Cmd-J) | source on left, rendered MD on right | source on left, compiled pages on right |

### Data flow on a keystroke (Typst, preview pane open)

CodeMirror dispatch → 300 ms debounce in `typst-driver.ts` → `invoke("typst_compile", { session_id, source })` → Rust recompiles using cached `World` → returns `{ pages: Vec<String /*svg*/>, diagnostics: Vec<Diag>, elapsed_ms }` → frontend updates preview-pane SVGs and pushes diagnostics into CodeMirror via a `setDiagnosticsEffect` for gutter squigglies.

## 4. Rust side (`src-tauri/src/typst/`)

### Crates (added to `src-tauri/Cargo.toml`, all `#[cfg(desktop)]`)

- `typst` — compiler core (`Library`, `World` trait, `Document`).
- `typst-svg` — SVG-per-page renderer.
- `typst-kit` — the standard `World` building blocks: download client, package storage, font discovery via `fontdb`. Used as a base for `ViewerWorld`.
- `typst-syntax` — diagnostic spans → line/column mapping back to frontend.
- `comemo` — used by typst for incremental caching. We rely on its memoization rather than rolling our own.

### Module layout

```
src-tauri/src/typst/
  mod.rs           // pub use; cfg(desktop) gate
  world.rs         // ViewerWorld: implements typst::World
  session.rs       // TypstSession: holds World + entry file + reused comemo cache
  commands.rs      // tauri::command handlers
  diagnostics.rs   // SourceDiagnostic -> wire format
  packages.rs      // @preview/... fetch + on-disk cache
```

### `ViewerWorld`

Narrow `World` impl:

- `main()` → entry `FileId`.
- `source(id)` / `file(id)` → reads from disk, resolving paths relative to the entry file's directory. Sibling `.typ` files go through `source()`; assets through `file()`.
- `book()` → a `FontBook` built once at session start from system fonts via `fontdb` (typst-kit's `Fonts::searcher`). Embedded fallback fonts (DejaVu) from typst-kit included so default-font docs always render.
- `package()` → resolves `@preview/...` via `packages.rs`. Cache directory under `$DATA_DIR/typst/packages/`. Downloaded once via typst-kit's downloader. Network calls happen on cache miss, off the compile fast path on second+ uses.
- `today()` → local date.

### `TypstSession`

One per open `.typ` file. Holds the `ViewerWorld`, the entry `FileId`, and reuses the same `comemo` cache across compiles → incremental fast. Stored in `tauri::State<Mutex<HashMap<SessionId, TypstSession>>>` keyed by a UUID returned at `typst_open`. Dropped on `typst_close` or when the document is closed in the UI.

### Invoke commands

```rust
#[tauri::command] fn typst_open(path: String) -> Result<SessionId, TypstError>;
#[tauri::command] fn typst_compile(
    session_id: SessionId,
    source: String,                // the in-memory buffer (may differ from disk)
) -> Result<CompileResult, TypstError>;
#[tauri::command] fn typst_close(session_id: SessionId);
```

```rust
struct CompileResult {
    pages: Vec<String>,            // one SVG string per page
    diagnostics: Vec<Diag>,
    elapsed_ms: u32,
}
struct Diag {
    severity: Severity,            // Error | Warning
    message: String,
    range: Range,                  // start/end line+col
    file: Option<String>,          // None = entry file
}
```

**Cancellation.** The frontend cancels by simply not awaiting a previous `typst_compile` once a newer one is in flight. Because `comemo` short-circuits unchanged work, the older invocation finishes quickly anyway; no explicit cancellation tokens in v1.

**Error model.** Compile failures are *not* `Err` — they come back as `Ok(CompileResult { pages: [], diagnostics: [...] })`. `Err(TypstError)` is reserved for I/O failures, font catastrophes, or panics caught at the boundary.

## 5. Frontend side

### Typst source highlighting

Use the small `codemirror-lang-typst` grammar (MIT, tiny npm dep) or port it inline. Highlighting is purely cosmetic; the truthy parse for diagnostics comes from the Rust side via `typst_compile`.

### Compile driver (`src/format/typst-driver.ts`)

```ts
export interface TypstDriver {
  open(path: string): Promise<void>;                 // -> typst_open
  compile(source: string): Promise<CompileResult>;   // raw invoke, no debouncing here
  close(): Promise<void>;
}
```

A small hook `useTypstCompile` does:

1. CodeMirror `EditorView.updateListener` on `docChanged` → 300 ms debounce.
2. On fire: invoke `typst_compile`. If a newer invocation starts before this one resolves, discard the result on return.
3. On result: push SVGs to the preview-pane store; push diagnostics into CodeMirror via a `setDiagnosticsEffect` (a small custom `StateEffect` consumed by a dedicated linter field — *not* `@codemirror/lint`, to keep deps lean).

### Preview pane (`src/ui/preview-pane.ts`)

One DOM element appended next to the editor host, hidden by default. Layout via CSS grid on the window root: `grid-template-columns: minmax(0, 1fr) <pane-width>;` with `<pane-width>` 0 when closed, persisted (default 50% of window width) when open. Resizable via a draggable splitter (`src/ui/preview-splitter.ts`).

Pane contents depend on format:

- **Typst.** Stacked `<div class="typst-page">` per page, each containing the SVG string inserted via the existing `sanitizeSvg` helper (DOMPurify with `USE_PROFILES: { svg, svgFilters, html }`). The scroll container handles paging; CSS adds subtle page-break visuals and a page-number-on-hover. Zoom (Cmd-+ / Cmd-- / Cmd-0) adjusts a CSS scale on the pane.
- **Markdown.** Existing markdown-it render → `sanitizeHtml` → inserted into the pane. Uses the same stylesheet the export pipeline uses, so the pane *is* "what export would produce." Math via the same KaTeX path; Mermaid via the same async pipeline.

### Mode × pane visibility rules

- Cmd-E toggles reading ↔ edit mode (unchanged for `.md`; for `.typ`, reading mode hides source and opens the pane full-width).
- Cmd-J toggles the preview pane in edit mode only. No-op in reading mode (a small UX hint shows: "already showing the rendered view").
- Pane state is **per-format, persisted in settings**: `previewPane: { markdown: boolean; typst: boolean }`, default `{ markdown: false, typst: true }`. Rationale: opening a `.typ` for the first time should show pages immediately; opening a `.md` shouldn't surprise existing users.

### Error display

- Errors → red wavy underline at the diagnostic range (CodeMirror `Decoration.mark`). Hover shows the message.
- A small "N errors" badge appears in the preview-pane header when `diagnostics.length > 0`. Clicking jumps to the first error.
- If a compile fails entirely (no pages), the pane shows the *previous* successful pages dimmed, with the error list overlaid — so the user doesn't lose their bearings while fixing a typo. Standard live-typesetting UX.

### Sidebar, open, new

The folder sidebar (#109) already lists files; it needs to surface `.typ` alongside `.md`. `list_markdown_files` is renamed `list_documents` and returns both formats (with a `kind` field). The "New File" menu grows two entries:

- "New Markdown File" — ⌘N (preserves current behavior).
- "New Typst File" — ⇧⌘N. Seed content: `= Document title\n\n` (parallel to the empty seed for `.md`).

### i18n

All new strings ("Show preview pane", "Hide preview pane", "New Typst file", error severities, "N errors", "Compiling…", "Compiled in {ms} ms", "Downloading {package}…") routed through `t()` per CLAUDE.md.

## 6. File lifecycle parity

`.typ` files participate in every lifecycle feature `.md` files do, with these specifics:

- **Extension recognition.** Single source of truth in `src/format/index.ts` (`isSupportedExtension(path)`) consumed by: open-dialog filter, folder sidebar listing, file-association handling, recents filtering, watcher acceptance, recovery restore.
- **Save / write.** `src/shell/files.ts` already calls `markSelfWrite()` before writing; no change. It writes whatever string the editor holds, format-agnostic.
- **Watcher reconciliation.** Unchanged. External edit while clean → silent reload + recompile. External edit while dirty → existing modal. Sibling-file watching is *out of scope* (see §1).
- **Crash recovery.** `write_recovery` dumps the buffer every 5 s while dirty. The payload already carries the path; the restore prompt on `main` window startup re-detects format from the path and reopens accordingly. No schema change.
- **Auto-save.** Same 1 s debounce, same `diverged` skip. Independent of the *compile* debounce — they don't interact.
- **Recents.** In-app `src/shell/recents.ts` unchanged (path-based, format-agnostic). macOS `recents_os.rs` (NSDocumentController) — `.typ` declared as a document kind in `CFBundleDocumentTypes` so the OS recents list picks them up.
- **File association.** `tauri.conf.json` → `bundle.macOS.fileAssociations` gains a `.typ` entry with role `Editor`, MIME `text/x-typst`. `lib.rs`'s `RunEvent::Opened` handler is already format-agnostic — it forwards the path; the frontend bootstrap (`src/main.ts`) detects format and routes. Linux/Windows file association follows the same trajectory as Markdown's current state (not yet wired; see ROADMAP sub-spec D).
- **Multi-window.** `New Window` with `?file=foo.typ` → secondary window opens the Typst file with its own `TypstSession`. No recovery in secondaries (existing rule).
- **Bundled sample.** `sample.typ` ships next to `sample.md` in `src/assets/`. Contents deliberately tiny (title, paragraph, math display, one heading) so the first preview compile is fast.
- **Mobile.** All Typst paths gated `#[cfg(desktop)]`; mobile-bootstrap refuses `.typ` with "Typst documents aren't supported on mobile yet."

## 7. Keybindings, UI surface, settings

### Keybindings

| Shortcut | Where | Action |
| --- | --- | --- |
| Cmd-E | both formats | Toggle reading ↔ edit mode (unchanged) |
| **Cmd-J** | edit mode, both formats | **Toggle preview pane (new)** |
| Cmd-S | both | Save (unchanged) |
| ⌘N | global | New Markdown File (unchanged) |
| ⇧⌘N | global | New Typst File (new) |
| Cmd-+ / Cmd-- | preview pane focused | Zoom preview (Typst only) |
| Cmd-0 | preview pane focused | Reset Typst zoom to 100% |

Cmd-J chosen because: free in our context (no terminal panel like VS Code), single letter so safe on Swedish keyboard (per the project's no-`\`/`[`/`]`/`/`-in-shortcuts rule), and avoids the Cmd-R-reload collision in Tauri dev mode.

### Menu surface (macOS menu bar)

- **View → Show Preview Pane** (⌘J), toggleable, checkmark reflects the per-format setting.
- **File → New** branches into "New Markdown File" (⌘N) and "New Typst File" (⇧⌘N).

### Command palette / right-click

Both surfaces (when added; not in this spec) get "Toggle preview pane," enabled only in edit mode.

### Settings additions (`src/shell/settings.ts`)

```ts
type Settings = {
  // existing fields...
  previewPane: { markdown: boolean; typst: boolean };  // default: { markdown: false, typst: true }
  previewPaneWidth: number;                            // default: 0.5 (fraction of window)
  typstZoom: number;                                   // default: 1.0
};
```

Changes to `previewPane.*` and `previewPaneWidth` dispatch `refreshDecorationsEffect` to keep the existing pattern uniform.

### Status bar

A small indicator on the right of the status bar shows compile status while a `.typ` is open:

- "Compiling…" (spinner) during in-flight compile.
- "Compiled in 142 ms" (transient, 2 s fade) after success.
- "1 error" (clickable, jumps to first diagnostic) when failing.

No status indicator for `.md` (the pane updates instantly).

## 8. Performance & scope limits

### Targets (not strict SLAs)

- 5-page doc, plain text + headings, M-series Mac: < 80 ms warm recompile (cache hit), < 400 ms cold compile (first open).
- 50-page doc with one image and a math display: < 250 ms warm, < 1.5 s cold.
- Memory ceiling per open `.typ`: ~150 MB resident (typst compiler + fontdb + cached comemo entries). Acceptable on desktop; mobile gating protects phones.

### Backpressure

If a compile takes longer than the next debounce window, the in-flight result is discarded on return. Queue depth never exceeds 1.

### Pre-flight font load

On `typst_open`, font discovery runs once and is cached for the session. First-time open on a system with many fonts may be slow — surfaced via "Compiling…" status.

### Package fetch

Network only on first use of an `@preview/...` package. Surfaces as "Downloading @preview/cetz@0.2.2…" in the status bar. Cached forever under `$DATA_DIR/typst/packages/`. No proxy support in v1.

### Bridge payload

SVG strings per compile can grow large for image-heavy docs. We don't preemptively optimize. Documented as a known limit; mitigation paths (per-page diffing, base64-PNG for raster pages) exist but are not in this spec.

## 9. Testing strategy

### Rust (`src-tauri/src/typst/`)

- Unit tests in `commands.rs` against a temp dir + minimal `.typ` fixture: `typst_open` → `typst_compile` → `typst_close` happy path; syntax error returns diagnostics not `Err`; missing-import returns a structured diagnostic.
- `ViewerWorld` resolver tests: sibling import, sibling image, missing package error.
- Package resolver: mock downloader, asserts cache hit on second resolve. Live-network test gated `#[ignore]`.

### Frontend (Vitest, jsdom)

- `src/format/index.ts` extension detection.
- Compile driver: debounce semantics, stale-result discard.
- Preview pane: pane open/close per format, settings persistence, width persistence.
- Diagnostic field: applying/clearing `setDiagnosticsEffect`, hover content.

### E2E (Playwright, serial)

- Open `sample.typ` → preview pane visible, page rendered.
- Edit `.typ`: insert syntax error → status bar shows "1 error", red gutter mark; fix it → recovery to green.
- Cmd-J toggles pane on `.md` and `.typ`, persisting across reload.
- File association: simulate `file-open-request` for a `.typ` (existing helper from #107).
- Visual-regression: one screenshot baseline of `sample.typ` rendered.

### Snapshot fixtures

`tests/typst/fixtures/sample.typ` plus a few error-case fixtures (unclosed brace, missing import, missing package).

## 10. Risks & known gaps

- **`@preview` packages need network.** If the user is offline and triggers a package they haven't cached, the doc fails compile until they're online. Acceptable; surfaced as a diagnostic.
- **Imported siblings aren't watched.** External edits to imported files won't refresh the preview until the entry file changes. Listed as a v1 gap; revisit if it bites in real use.
- **SVG payload size.** Big image-heavy docs may push bridge payloads into the megabytes per compile. Not optimized in v1.
- **Font loading time on first open** for systems with thousands of fonts. Visible in the status bar; acceptable.
- **Renaming `list_markdown_files`** is a Rust-side API rename — affects all existing callers. Must be done atomically with frontend updates.

## 11. Open questions for plan-writing time

- Exact `codemirror-lang-typst` dependency choice vs porting the grammar inline — defer to plan.
- Preview-pane reading-mode UI cue for Cmd-J no-op — defer to plan / implementation.
- Whether the per-format `previewPane` setting should also be remembered per-file or only per-format — defaulting to per-format for now.
