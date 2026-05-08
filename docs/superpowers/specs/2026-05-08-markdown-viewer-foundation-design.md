# Markdown viewer — Sub-spec A: Foundation

**Date:** 2026-05-08
**Status:** Approved (pending written review)
**Scope:** First of six sub-specs that together deliver REQUIREMENTS.md v1. This one establishes the foundation; later sub-specs (B–F) bolt onto it.

---

## 1. Why a sub-spec at all

REQUIREMENTS.md is a v1 with the surface area of roughly six independent feature areas. Designing all of them in one document produces shallow coverage everywhere. This document therefore narrows scope to the **foundation**: the parts that every later sub-spec depends on.

The other five planned sub-specs:

- **B. Rich content** — Math (KaTeX), Mermaid, image rendering and remote-image policy, full HTML sanitization story.
- **C. Export & print** — PDF, self-contained HTML, print pipeline.
- **D. OS integration** — File associations, drag-drop, Recents-from-OS, native menu polish, optional folder/project tree, multi-window UX.
- **E. Settings, updater, privacy controls** — Preferences UI, auto-update channel, network privacy toggles.
- **F. A11y & i18n polish** — WCAG audit, screen reader pass, i18n string extraction.

This spec is intentionally silent on those areas except where the foundation must leave room for them.

## 2. Foundational decisions

### 2.1 Tech stack

- **Tauri** for the desktop shell. Rust core, OS-native webview for rendering. Chosen over Electron for binary size (~10–15 MB vs ~80–150 MB) and over native-per-OS for total cost; chosen over Qt because typography is the product's signature surface and CSS-driven typography is more flexible than Qt's text engine.
- **TypeScript + Vite** for the frontend.
- **CodeMirror 6** as the editor surface (and as the reading-mode surface — see §4).
- **markdown-it** for parsing, with the GFM-relevant plugins (tables, task-lists, strikethrough, footnotes, definition lists).
- **Shiki** for code-fence syntax highlighting. TextMate grammars; same output as VS Code; native light + dark theme support; lazy language loading.
- **DOMPurify** for HTML sanitization on the reading-mode rendering path.

### 2.2 Editor model: decorated source

The defining UX decision. In **reading mode** the document is fully rendered prose. In **edit mode**:

- Every source character stays visible — `## Heading` shows the `## `, `**bold**` shows the asterisks, `[text](url)` shows the brackets and parens.
- Visual styling is *layered on top* of the source. The heading line uses heading typography even though the `##` is still visible. `**bold**` is rendered bold in place — asterisks and inner text both. `*italic*` is italicized including the asterisks. Inline code is monospace-on-tinted-background, backticks intact.
- **Source wins on conflict.** Where a rendering would normally elide source markers, we keep them.

This is implemented as decoration ranges over the source — never source replacements. Inline source is always there to be edited; the styling is purely visual overlay.

### 2.3 Reading mode is the same editor

There is no separate "preview pane" or React-rendered HTML view. Reading mode is the same CodeMirror instance with `readOnly: true` and a different decoration set. The reading-mode decorations include widget decorations that *replace* certain spans visually (the rendered link without parens/brackets, the rendered code block without the triple-backtick fence) — but the underlying source is untouched, so:

- Scroll position is preserved across mode switches automatically.
- Mode toggle is two compartment reconfigures; no reflow, no reload.
- Typography is mechanically identical between reading and editing.

### 2.4 One window per document

Multi-tab is out of scope for the foundation. Each Markdown file gets its own native window. Folder/project tree and tab UX are Sub-spec D.

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│ Tauri shell (Rust)                                  │
│   - window, native menus                            │
│   - OS dialogs (open, save-as)                      │
│   - filesystem (scoped to picked paths)             │
│   - close-requested event                           │
│   - app data dir (recents, recovery buffers)        │
└────────────────────┬────────────────────────────────┘
                     │ Tauri IPC
┌────────────────────┴────────────────────────────────┐
│ Webview frontend (TypeScript)                       │
│   - editor (CodeMirror 6)                           │
│   - parser (markdown-it)                            │
│   - decorations (per-construct plugins)             │
│   - syntax highlighter (Shiki)                      │
│   - theme system (CSS variables)                    │
│   - dirty state, recovery scheduler                 │
└─────────────────────────────────────────────────────┘
```

The Rust shell is intentionally thin — a stateless bridge for the OS. All document state, parsing, rendering, and UX live frontend-side. The editor source of truth is the CodeMirror state.

## 4. Components

| Component | Role | Library / approach |
|---|---|---|
| Editor surface | Decorated-source editor; same instance powers reading mode | CodeMirror 6 with three compartments: `readOnly`, `decorations`, and `keymap` (the reading-mode keymap binds Space/Shift+Space/PageUp/PageDown etc. for paged scrolling) |
| Markdown parser | Tokenize source into a structure decorations and the renderer can use | markdown-it + GFM plugins |
| Decoration plugins | Per-construct CodeMirror plugins that read parse tree, output `DecorationSet` | One file per construct (see §8) |
| Reading-mode widgets | Widget decorations that replace selected spans for full rendering (e.g. images in later sub-specs, code-block visual chrome) | CodeMirror widget decorations |
| Syntax highlighter | Code-fence highlighting in both modes | Shiki, lazy language loading |
| Theme system | Light, dark, OS-follow | CSS custom properties; theme switch is a class flip on `<html>`; `prefers-color-scheme` media query for OS-follow |
| Mode toggle | Reader ↔ editor | Two compartment reconfigures: flip `readOnly`, swap decoration set |
| TOC sidebar | Togglable panel listing the document's headings; click to jump; scroll-sync highlights the current section | Derived from the parse tree; same panel works in reading and edit mode |
| Edit operations | Undo, redo, cut, copy, paste, select all, find, replace, indent/outdent, multi-line selection | CodeMirror 6's built-in commands + search panel (already production-grade) |
| File I/O | Open dialog, save, drag-drop onto window, OS "Open With" | Tauri dialog plugin + Tauri FS plugin (path-scoped) + window drag-drop event |
| File watcher | Detect when the open file changes on disk and update the buffer | Rust-side `notify` crate watching the file's parent directory; Tauri event to the frontend; frontend reconciles |
| Recents | Last 10 opened files | Tauri store plugin → JSON in app data dir |
| Crash recovery | Periodic dirty-buffer dump | Frontend timer; Rust handles the FS write to `<app-data>/recovery/` |

## 5. Data flow

### 5.1 Open file

1. OS or user → Tauri (open-with arg, dialog result, or drop event)
2. Tauri sends path to frontend
3. Frontend reads via FS plugin
4. markdown-it parses source into a token stream cached on the doc state
5. CodeMirror initializes with source + decoration plugins active + `readOnly: true`
6. Reading mode visible

### 5.2 Toggle mode

1. Keyboard shortcut (`Cmd/Ctrl + E`) or menu/toolbar action
2. Reconfigure `readOnly` compartment (true ↔ false)
3. Reconfigure `decorations` compartment (reading-set ↔ edit-set)
4. Reconfigure `keymap` compartment (reading-mode keymap ↔ edit-mode keymap — see §6a for the reading-mode bindings)
5. Cursor placed at top of viewport (edit-mode entry); no scroll change

The two decoration sets share most of their logic; they differ in:
- Edit set keeps inline markers visible with styling.
- Reading set uses widget decorations to elide marker characters in the rendered output.
- Edit set shows code-fence open/close lines as text; reading set hides them under a styled wrapper.

### 5.3 Edit

1. CodeMirror update transaction
2. Incremental markdown-it reparse on the affected range (or whole-doc reparse — markdown-it is fast enough that we measure before optimizing)
3. Decoration plugins emit updated `DecorationSet`
4. Dirty flag set; window title gets a bullet indicator

### 5.4 Save

1. `Cmd/Ctrl + S`
2. Frontend asks Tauri to write the buffer to the original path
3. Dirty flag cleared on success; toast on failure

### 5.5 Quit / close with unsaved changes

1. Tauri `close-requested` event
2. Frontend shows native confirm: Save / Discard / Cancel
3. Save → §5.4 then close. Discard → close. Cancel → veto.

### 5.6 External file change

When the open file is modified on disk by another process (another editor, a `git pull`, a `sed` script):

1. **Watcher.** Rust side uses the `notify` crate to watch the *parent directory* of the open file (per-file watching is unreliable on every OS because many editors save via atomic rename). Each window has its own watcher.
2. **Self-write filter.** Whenever the frontend asks Rust to save, Rust records a "self-write expected" timestamp on that window's watcher. Watcher events within 500 ms of that timestamp on the same path are dropped — those are our own write echoing back.
3. **Debounce.** External events are debounced ~150 ms to coalesce the delete/create pair that atomic-rename saves emit.
4. **Reconciliation in the frontend** depends on buffer state:
   - **Clean buffer.** Reload the file content into the editor. Preserve scroll position and (best-effort) cursor position by line+column. A brief, subtle inline notice fades in for ~2 s: "Reloaded from disk".
   - **Dirty buffer.** Show a modal prompt: *"This file was changed on disk. Your unsaved edits and the new content cannot both be kept. [Reload from disk] [Keep my edits]"*. Cancel is implicit by clicking outside / pressing Escape and equals "Keep my edits". If the user keeps their edits, the buffer enters a *diverged* state: the next save attempt shows a confirm — *"Saving will overwrite the version on disk. [Save anyway] [Cancel]"*.
   - **File deleted/moved.** The buffer goes into an *orphaned* state: title gets a strikethrough indicator, dirty flag is forced on, save is disabled until the user picks Save As to a new path. A non-blocking notice explains the situation.
5. **Window focus.** The watcher runs whether the window is focused or not; reconciliation prompts queue and only render once the window gets focus, so a user returning to the app sees one prompt rather than a stack.

The watcher is on by default with no UI to disable it in the foundation. A toggle to disable auto-reload (for users who edit on filesystems with noisy watchers) is part of Sub-spec E's settings UI; until that ships, no UI references the toggle and the watcher always runs.

### 5.7 TOC sidebar

A togglable panel on the left edge of the window listing the document's headings (H1–H6) indented by depth.

- **Default state.** ON the first time a document is opened *if* it has 3 or more headings; otherwise OFF. After the user explicitly toggles it for a given window/document, that explicit choice is the new default — we don't keep auto-applying the heuristic.
- **Persistence.** The user's last explicit toggle state is persisted globally; it becomes the default for documents *the user has not previously interacted with*, modulated by the 3-headings heuristic.
- **Behavior in reading mode.** Click an entry → smooth-scroll the document to that heading.
- **Behavior in edit mode.** Click an entry → move the cursor to that heading's source line and bring it into view.
- **Scroll-sync.** As the document scrolls, the TOC entry corresponding to the topmost visible heading is highlighted.
- **Empty state.** A document with zero headings renders the panel as a quiet "No headings in this document" line, *only when the user has manually toggled the panel on*. The auto-default never opens an empty TOC.
- **Source.** Built from markdown-it's heading tokens; rebuilt on every reparse.

## 6. The decoration scheme

The heart of the design. Each row describes the visible result in **edit mode** for a given source construct.

| Source | Edit-mode rendering |
|---|---|
| `# H1` line | Whole line in H1 typography. The `# ` prefix stays visible in H1 type. |
| `## H2` line | Same logic, H2 type. (Through `######` H6.) |
| `**bold**` | Four asterisks and inner text all bold. |
| `*italic*` / `_italic_` | Asterisks/underscores and inner text all italic. |
| `` `code` `` | Backticks and code in monospace, with code-block tinted background. |
| `~~strike~~` | Tildes and inner text all strikethrough. |
| `[text](url)` | Brackets/parens visible. Inner `text` styled as link color + underline. URL in muted monospace. |
| `![alt](url)` | Same as link; no image preview in edit mode. (Image rendering in reading mode is in scope; image-fetch policy is Sub-spec B.) |
| ` ```lang\n…\n``` ` | Triple-backtick lines and language tag visible in monospace. Code lines syntax-highlighted by Shiki. Background tint over the whole block. |
| `\| a \| b \|` table | Pipes stay visible. Column-alignment decoration adds whitespace so columns line up. Header separator row stays as text. |
| `> quote` | `> ` prefix visible. Indent + left border applied to wrapped lines. |
| `- list` / `* list` / `1. list` | Marker visible. Hanging indent applied so wrapped lines align. |
| Task list `- [ ] item` / `- [x] item` | Brackets visible. Checkbox icon overlay is **not** in scope here (it implies an interaction); a plain styled `[ ]` / `[x]` is fine. |
| Footnote ref `[^1]` and footnote def | Source visible, ref and def styled in link color. |
| Definition list | Term styled bold, definition indented; markers visible. |
| Reference link `[text][ref]` and link def `[ref]: url` | All visible; ref/def cross-linked styling. |
| Front matter (YAML/TOML at top of file) | Recognized; rendered as a small monospace block; not styled as body content. |

### Reading-mode differences

The same source displayed with a different decoration set:

- Inline marker characters (`*`, `_`, `` ` ``, `#`, `[`, `]`, `(`, `)`, `>`, list bullets) are elided via widget decorations.
- Code fences hide the triple-backtick lines and language tag; the highlighted code remains.
- Tables render as proper HTML tables (still backed by source pipes underneath the widget).
- Images in reading mode render as actual images (subject to remote-image policy from Sub-spec B; for the foundation, only local relative/absolute file paths are loaded).
- Front matter is collapsed to nothing visible.

## 6a. Menus, toolbar, and keyboard shortcuts

Everything visible in the foundation works fully. No dead menu items, no buttons that lead to "coming soon", no preferences pane stubs. Features that aren't ready for foundation are simply not exposed in the UI; they appear when their sub-spec ships.

### Native menu bar (foundation contents only)

| Menu | Item | Action |
|---|---|---|
| **File** | Open… | OS file picker; opens the chosen file in this window if untouched, otherwise in a new window |
| | Open Recent ▸ | Submenu of last-10 recents; "Clear Menu" entry at the bottom |
| | Save | Save buffer to original path |
| | Close Window | Standard close, with the unsaved-changes prompt if dirty |
| **Edit** | Undo / Redo | CodeMirror history |
| | Cut / Copy / Paste / Select All | Standard |
| | Find… | Open the search panel |
| | Find and Replace… | Open the search panel in replace mode |
| **View** | Reading Mode / Edit Mode | Mode toggle; the active mode is checkmarked |
| | Show Sidebar / Hide Sidebar | TOC toggle |
| | Theme ▸ Light / Dark / Follow System | Theme picker; active item checkmarked |
| | Actual Size / Zoom In / Zoom Out | Document zoom; reading and edit mode honor it |
| **Window** | Minimize / Zoom | OS-standard |
| **Help** | (empty in foundation; Help menu items live in later sub-specs) | The Help menu does not exist in foundation. Help content arrives with the sub-specs that introduce it. |

### Toolbar

Three controls only:

1. Reading/Edit toggle
2. Sidebar (TOC) toggle
3. (Optional) saved/dirty indicator next to the title

No empty toolbar slots, no overflow menu, no settings cog.

### Default keyboard shortcuts

All shortcuts use letters, digits, function keys, or the Enter/Backspace/Tab/arrow family. None depend on US-only punctuation keys.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + O` | Open… |
| `Cmd/Ctrl + S` | Save |
| `Cmd/Ctrl + W` | Close window |
| `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` | Undo / Redo |
| `Cmd/Ctrl + X` / `C` / `V` / `A` | Cut / Copy / Paste / Select All |
| `Cmd/Ctrl + F` | Find |
| `Cmd/Ctrl + Shift + F` | Find and Replace |
| `Cmd/Ctrl + E` | Toggle reading ↔ edit mode |
| `Cmd/Ctrl + Shift + O` | Toggle TOC sidebar (O = "outline") |
| `Cmd/Ctrl + 0` / `+` / `-` | Reset / increase / decrease document zoom |

**Reading-mode-only navigation** (these keys behave normally in edit mode):

| Shortcut | Action |
|---|---|
| `Space` | Page down (one viewport, with a small overlap of ~3 lines so the reader doesn't lose context) |
| `Shift + Space` | Page up |
| `Page Down` / `Page Up` | Same as `Space` / `Shift + Space` |
| `↓` / `↑` | Line scroll |
| `Home` / `End` (or `Cmd + ↑` / `Cmd + ↓` on macOS) | Jump to top / bottom of document |

These are wired through a reading-mode-only keymap that's swapped in alongside the `readOnly` and decoration compartments (§5.2). In edit mode the same keys do their text-editing thing — Space inserts a space, Page Down moves the cursor by a page, etc.

### Settings posture (foundation)

The foundation has no Settings/Preferences window. Settings UI is Sub-spec E, and we deliberately do not stub it. The settings that *do* exist in the foundation (theme choice, recents list, sidebar last-state) are reachable through working menu items or are managed automatically. When Sub-spec E ships, it adds the Settings window and surfaces the same values there; until then, the menu paths are the truth.

## 7. Robustness

- **Malformed Markdown** — markdown-it never throws on user input. Worst case: text renders as text. The UI never blocks on parse error.
- **File too large** — soft cap at 50 MB. Above the cap, open in read-only with a banner. Below, always allow editing.
- **Filesystem errors** — Rust-side errors surface as non-blocking toasts; the in-memory buffer is preserved.
- **External changes to the open file** — see §5.6. Clean buffers reload silently; dirty buffers prompt; deleted/moved files orphan the buffer rather than discard it.
- **Watcher loops** — every save we initiate is filtered out of the watcher (§5.6 step 2); a misconfigured watcher cannot create a save-reload loop.
- **Crash recovery** — every 5 seconds, if the buffer is dirty, frontend asks Rust to write to `<app-data>/recovery/<doc-id>.md` plus a metadata file pointing at the original path. On startup, if recovery files exist, prompt to recover.
- **HTML safety (foundation slice)** — DOMPurify on the reading-mode rendered HTML before insertion. Full HTML safety story (script/JS URL handling, sandboxed image loads, copied-HTML sanitization) is Sub-spec B. The foundation does not aim to be the final word on safety; it does aim to leave no in-document `<script>` reachable.

## 8. File layout

```
viewer/
├── src-tauri/
│   ├── src/main.rs                  # window, menus, FS commands, recovery write
│   ├── tauri.conf.json
│   └── Cargo.toml
├── src/
│   ├── main.ts                      # entry; bootstraps editor and IPC
│   ├── editor/
│   │   ├── editor.ts                # CodeMirror config, compartments, mode toggle
│   │   ├── parser.ts                # markdown-it instance + GFM plugins
│   │   ├── theme.ts                 # light/dark CSS-variable themes
│   │   └── decorations/
│   │       ├── inline.ts            # bold, italic, code, strike
│   │       ├── headings.ts
│   │       ├── lists.ts             # bullets, ordered, task lists
│   │       ├── links.ts             # links, autolinks, images, footnotes, refs
│   │       ├── tables.ts
│   │       ├── codeblocks.ts        # fenced code + Shiki integration
│   │       ├── blockquotes.ts
│   │       ├── frontmatter.ts
│   │       └── reading-widgets.ts   # widget decorations specific to reading mode
│   ├── shell/
│   │   ├── files.ts                 # Tauri FS bridge wrappers
│   │   ├── recents.ts
│   │   ├── recovery.ts
│   │   ├── watcher.ts               # external file-change reconciliation (§5.6)
│   │   ├── menus.ts                 # native menu definitions (File/Edit/View/Window)
│   │   └── shortcuts.ts             # keyboard shortcut bindings
│   └── ui/
│       ├── titlebar.ts              # dirty indicator
│       ├── toolbar.ts               # mode toggle + sidebar toggle
│       └── sidebar/
│           ├── toc.ts               # heading list, scroll-sync, click-to-jump
│           └── toc-state.ts         # toggle persistence, 3+-headings heuristic
├── tests/
│   ├── decorations/                 # per-construct unit tests
│   ├── conformance/                 # CommonMark + GFM corpus snapshots
│   └── e2e/                         # Playwright (Tauri webview)
└── docs/superpowers/specs/          # this document and siblings
```

Each `decorations/*.ts` is a small, focused unit: takes a parse tree slice, returns a `DecorationSet`, ships with its own unit tests. New constructs in later sub-specs (math blocks in Sub-spec B, etc.) become new files alongside, not edits to existing ones.

## 9. Testing

| Layer | What | How |
|---|---|---|
| Decoration plugins | For each construct, the resulting decoration ranges | Vitest unit tests; small fixture inputs, snapshot or explicit assertion |
| Markdown conformance | Full CommonMark spec + curated GFM corpus | Vitest snapshot tests on `parse → render` output |
| Editor interaction | Open, type, mode toggle, save, dirty quit prompt | Playwright driving the Tauri build |
| Visual regression | Reading + edit mode, light + dark, against a fixed corpus of representative documents | Playwright screenshots, diffed per PR |
| Cross-platform CI | Build + test matrix | GitHub Actions: macos-latest, windows-latest, ubuntu-latest |

## 10. Scope

### In scope (foundation)

Everything in this list ships fully working — no stub menus, no empty preferences pane, no half-features.

- Open existing `.md` / `.markdown` / `.mdx` / `.mdown` from OS file picker, drag-drop, "Open With"
- Render in reading mode with full CommonMark + GFM
- Toggle to edit mode (decorated source) and back, scroll-preserving
- Save (Cmd/Ctrl + S) over the original path; close-window prompt on dirty
- Reading-mode navigation keys: Space / Shift+Space / Page keys / arrows / Home / End for paged and line scrolling
- Standard editing operations (undo/redo, cut/copy/paste/select-all, find, find-and-replace, indent/outdent, multi-line selection)
- Light theme, dark theme, OS-follow — switchable from the View menu
- Document zoom (in/out/reset)
- Code-fence syntax highlighting (Shiki, common languages: JS/TS, Python, Go, Rust, Java, C/C++, shell, JSON, YAML, SQL, HTML/CSS, Markdown)
- Image rendering in reading mode for **local** paths only (relative or absolute). Remote-image policy (load / placeholder / off) and the security sandboxing around image fetches are Sub-spec B.
- Togglable TOC sidebar (auto-on for 3+ headings, persisted thereafter)
- Auto-reload on external file change (clean buffer reloads silently with a "Reloaded from disk" notice; dirty buffer prompts the user; deleted/moved file orphans the buffer for Save As)
- Recents menu (last 10) with "Clear Menu"
- Crash recovery
- Native menu bar on each platform with the items listed in §6a — every item works, none are stubs
- Builds and runs on macOS, Windows, and Linux via Tauri

### Out of scope (deferred to other sub-specs)

- New blank document; advanced window management (per-window menu state, session restore, window cycling) → D. The foundation does open one window per opened file; what's deferred is the polish around multi-window state.
- Math, Mermaid, image fetch policy → B
- PDF/HTML export, print → C
- File associations, native menu polish, OS-integrated Recents, drag-drop for folders → D
- Settings UI, auto-update, network privacy toggles → E
- A11y audit, i18n string extraction → F
- Code-signing, installers, packaging polish → D

## 11. Open assumptions

These are the assumptions the design rests on. None of them are validated yet; if any is wrong, we revise.

1. **markdown-it is fast enough** for whole-document reparse on every keystroke up to ~1 MB of source. We measure during implementation; if not, we move to incremental reparse on the affected range. We do not pre-optimize.
2. **CodeMirror 6 decorations can express everything in §6** without falling back to source replacement. The harder cases (table column alignment, hanging indents on wrapped lines) need a small spike during implementation to confirm.
3. **Tauri's webview consistency** is acceptable across the three platforms for the typography target. Tauri uses WebKit on macOS, WebView2 (Chromium) on Windows, WebKitGTK on Linux. We accept small per-platform rendering differences; if the gap is too wide we revisit Electron-with-bundled-Chromium in a follow-up decision.

## 12. Definition of done

The foundation is complete when, on macOS, Windows, and Linux:

1. The user can open a `.md` file via the OS file picker and see it rendered in reading mode within ~300 ms (REQUIREMENTS §5.1).
2. The user can press `Cmd/Ctrl + E` to enter edit mode; the visual transition is instant and the scroll position is preserved.
3. Edit mode shows decorated source as specified in §6.
4. The user can edit, press `Cmd/Ctrl + S`, and the file on disk reflects the change.
5. Closing the window with unsaved changes prompts; Cancel actually cancels.
6. Light, dark, and OS-follow themes all work and survive a mid-document theme switch without losing scroll or selection.
7. The TOC sidebar opens automatically the first time a document with 3+ headings is opened, hides when toggled, and the choice persists.
8. With the document open in this app, modifying the file from another tool (e.g. `echo "edit" >> file.md`) updates the buffer within ~1 s. If the buffer is clean, the reload is silent with a brief "Reloaded from disk" notice and scroll position preserved. If the buffer is dirty, a modal prompts the user before any data is overwritten.
9. Saving from this app does **not** trigger a spurious "file changed on disk" prompt (self-write filter, §5.6).
10. Every item in every menu (§6a) does what its label says. No disabled-only menu items, no "Coming soon" entries, no greyed-out submenus. Every keyboard shortcut listed in §6a is wired and active.
11. Every default keyboard shortcut works on a Swedish keyboard layout (and any other layout that shares the US-letter positions). No shortcut depends on US-only punctuation keys.
12. In reading mode, Space pages down by one viewport (with a small overlap), and Shift+Space pages up. Page Up/Page Down, arrows, and Home/End all scroll as a reader expects. In edit mode these same keys insert text or move the cursor as normal.
13. A document containing `<script>` in HTML passthrough renders without executing it.
14. The full Vitest + Playwright suite passes on the GitHub Actions matrix.
