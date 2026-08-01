# Changelog

## [Unreleased]

### Added

- **Clickable reading-mode links** (#149). In reading mode, http/https `[text](url)` links and bare-URL autolinks are now rendered as a real semantic `<a>` element showing just the link text — the `[`, `]`, and `(url)` markup is hidden, consistent with how other markers are replaced via widgets. The anchor is announced as a link by screen readers and is keyboard-activatable; a plain click or Enter/Space opens the URL externally via `@tauri-apps/plugin-opener` rather than navigating in-app. The opener path re-validates the scheme, so only `http`/`https` can ever be opened (`javascript:`/`file:`/`data:` are rejected). Edit mode is unchanged — it keeps the muted-but-visible literal `[text](url)` syntax. Non-http(s) links (local `.md`, `#anchors`, `mailto:`) continue to be handled by the existing position-based click handler. New producer: `src/editor/decorations/reading-links.ts`.
- **Project name in the window title** (#98). When a folder is open in the sidebar, the window title now reads `<file-name> — <project-folder-name>` (e.g. `README.md — viewer`), so multi-window users with several projects open can tell windows apart even when the file names match. Falls back to the file name alone when no folder is open. `setWindowTitle` takes an optional project-folder argument plumbed from the per-window `currentFolder` state; the title also refreshes on project switch.
- **Mermaid diagrams in exports** (#56). Fenced `mermaid` blocks now render as inline SVG in the HTML export, the native PDF export, the print pipeline, and copy-as-HTML — previously they came out as their raw source, so an exported document didn't match the on-screen reader. Mermaid is async per-instance, so `buildHtmlExport` pre-renders every distinct diagram (deduped by source string) before the synchronous body pass, then substitutes the SVGs via the same placeholder mechanism math already used. Blocks are located with the same token + line-start logic as the live-preview producer, so the export renders exactly what the reader sees. A diagram that fails to parse degrades to its original code block rather than breaking the whole export.
- **Theme-aware code syntax highlighting** (#129, #130). Code blocks now use the `github-dark` token palette in dark mode and `github-light` in light mode. Shiki is primed with both themes, and each token mark carries a light class (`cm-md-token-<hex>`, unconditional) plus a dark class (`cm-md-tokdark-<hex>`, scoped under `html.theme-dark`), so a theme switch swaps palettes purely via the CSS cascade — no decoration recompute.

### Changed

- **One folder maps to one window** (#100). Switching projects no longer replaces the current window's sidebar. If a window already shows the picked folder it is raised and focused; a window with no folder open adopts it in place; otherwise a new window opens for that folder (loaded to the project's active file). `md <dir>` from the shell follows the same routing. The main window is the sole routing decision-maker (extending the existing per-window folder map), and session restore is deduped by folder so two windows can never reopen on the same project.

### Removed

- **`src-tauri/Cargo.lock`.** The root `Cargo.toml` declares the workspace (`src-tauri` + `crates/marklig-sync-core`), so cargo resolves at the repo root and this second lockfile was never consulted — and cargo will say so itself, not just the manifest: fill the orphan with garbage and `cargo metadata --locked --offline` run from *inside* `src-tauri/` still exits 0, while doing the same to the root lock fails with `failed to parse lock file at: <repo>/Cargo.lock`, named by that path from that same directory. It was not merely redundant but actively misleading: its last change in history predates the commit that created the workspace and it had been frozen ever since, so where the root lock resolves 13 typst-named packages it listed none — meaning a dependency question answered from it says this repo has no Typst dependency, in a repo that compiles Typst in-process (`src-tauri/src/typst/`) and declares `typst`, `typst-syntax`, `typst-svg` and `typst-kit`. Two readers reached that wrong conclusion from it within one hour, neither of them carelessly: it is exactly where you would look. Being tracked, every clone carried it. The root `Cargo.lock` is byte-identical after the deletion — nothing was re-resolved — and `cargo test --workspace`, vitest, Playwright and clippy all report counts unchanged. `CLAUDE.md` now names the root lock as the only one, and replaces its stale `cargo check # run from src-tauri/` line with the commands CI actually gates on, since running those one directory down omits `crates/marklig-sync-core` and reports 68 tests instead of 102 — the same confident wrong answer from the same instinct.
- **`buildHtmlExportSync`.** The synchronous export builder had no caller left in `src/` — copy-as-HTML, its only intended user, has gone through the async `buildHtmlExport` since Mermaid pre-rendering landed. It survived only as the subject of its own tests while three separate places (its own comment, the ROADMAP, and this changelog) cited it as evidence that copied documents still emit `mermaid` fences as source, which the app hasn't done for a while. The tests that used it were exercising the shared body-rendering pipeline — title escaping, the math placeholder passes, sanitization — and now assert the same things against `buildHtmlExport`.

### Fixed

- **An external edit no longer reloads the file in every *other* window.** With two windows open on different files, editing one window's file outside the app made every window reload. A window with unsaved edits got worse than a spurious reload: it was shown the reconcile modal and asked to choose between its own work and a change to a file it did not have open, where both answers are wrong — "reload from disk" discards the edits for nothing, and "keep my edits" sets `diverged`, which silently stops that window auto-reloading for the rest of the session. A *deletion* was worse still: `onRemoved` drops `currentPath` and clears the title, so deleting one window's file disowned the document in every other window. The backend was not at fault — `watcher_start` keys its watchers by window label and emits with `emit_to(label, …)`. This is the same delivery surprise as #145: a frontend `listen()` registers with `EventTarget::Any` and so receives an event whatever target `emit_to` named, and `installWatcher`'s handler then ignored the payload's `path` entirely and reloaded whatever that window happened to have open. It now drops any event whose `path` is not the path it was installed for. The guard asks "is this my *file*", not "is this my *window*", deliberately: two windows on one file both hold text that has just gone stale and both must refresh, so the property the reload depends on is the path, not the label. Because watchers are per-window and `watcher_start` echoes the path back exactly as the frontend asked for it — un-canonicalized, which is the #47 fix's doing — a window that opened the same file under a different spelling (through a symlink, say) ignores the other window's event and reloads on the one its own watcher emits: same outcome, one event later. Filtering on a window label carried in the payload, which is what #145 did for `viewer:open-file`, would also have worked, but only by way of that second watcher, and it would have needed a Rust change to answer a question the payload could already answer. The path comparison additionally closes a latent race that `installFolderWatcher` has always guarded against with the identical check on `viewer://folder-changed`: an event still in flight when a window switches documents can no longer reload the new document because of the old one's change. The regression test is one a single-window suite could not have expressed: two windows on *different* files, one external edit, and the assertion that the second window did not re-read its file **at all** — its `read_text_file` log is unchanged — rather than the weaker claim that the first window did reload. A fourth case pins the other half of the requirement, that two windows on the *same* file both still reload; it passes with or without the guard, which is how we know the other three are testing the guard and not the harness.
- **External edits to a file watched through a symlink now reload on Linux** (#47). The watcher canonicalized the watch target once and then compared incoming event paths against that single spelling verbatim, which quietly assumed every backend reports canonical paths. Only macOS does: FSEvents resolves symlinks, so a file watched as `/tmp/x/file.md` comes back as `/private/tmp/x/file.md` and the comparison held — which is why this passed locally for as long as the bug existed. Linux inotify reports the path **as it was watched**, joined with the changed entry's name, so every event for a file opened through a symlinked path failed the comparison and was dropped before it could be emitted: no `viewer://file-changed`, no silent reload of a clean buffer, exactly the #47 symptom that #99's canonicalization was supposed to have finished off. The handler now holds **both** spellings — the path as the frontend asked for it, and the resolved one — each computed once when the watch is established, and matches an event against either. Canonicalizing every incoming event instead was rejected: besides a `stat` chain per event on the notify callback thread, `canonicalize` fails on a path that no longer exists, which is precisely an `EventKind::Remove` — it would have bought symlink correctness by breaking deletion detection. Canonicalizing only on a failed match was rejected too: the watch is non-recursive on the target's *parent directory*, so every sibling's event arrives and misses, and while a file is being edited the misses (`.file.md.swp`, `file.md~`, atomic-save temp files, most already unlinked) are the common case — the miss path is the hot path. A target that isn't on disk yet now also gets a canonical spelling, resolved via its parent, where before it fell back to the raw path alone and so was invisible to FSEvents until reopened. If nothing resolves, matching degrades to the verbatim path rather than failing. Retargeting a symlink mid-watch remains unhandled and cannot be handled here: `inotify_add_watch` resolves to an inode once and the watch follows that inode, not the name, so no event for the new target is ever delivered whatever the comparison does. The regression test was previously `cfg_attr`-ignored on Linux with the diagnosis in the attribute; the ignore is gone, and it now calls the production predicate rather than a copy of it — a test that re-implements the comparison it pins cannot fail when the real comparison is wrong, which is how this survived. Three platform-independent unit tests cover the two spellings, the not-yet-created target, and the nothing-resolves fallback, giving the path comparison its first coverage on Windows.
- **Every desktop announces under its own name, and the QR always names the desktop that printed it.** `mdns::instance_name()` read `$HOSTNAME`/`$HOST`, neither of which is exported to a macOS app launched from Finder or the Dock — the launches Karl actually uses — so it fell back to `marklig` and every desktop announced `marklig-marklig`. Now it derives from `gethostname(2)` (the `hostname` crate, chosen over calling `libc` because `libc` has no `gethostname` on Windows). The derivation is a pure function of the raw hostname — first label only (`Karls-Mac.local` → `marklig-karls-mac`), non-UTF-8 read lossily, characters illegal in a DNS label collapsed to single `-`, truncated to a 63-byte label, falling back only for a hostname with nothing usable in it — so it is pinned by tests that never touch the process environment. The deeper half of the fix is that **the name is no longer computed twice**: while the announcement was up, `pairing_start` re-derived the name independently for the QR. When two desktops collided, mdns-sd renamed one per RFC 6762 §9 conflict resolution, and the renamed desktop's QR still carried the *original* name — which by then resolved to the other machine, so a phone could pair with the wrong desktop. `instance_name` is now private to `mdns.rs` and reachable only through `announce_this_desktop`; the announcer records the registered name, adopts `DaemonEvent::NameChange` renames from a monitor thread, and `pairing_start` reads `announced_instance_name()`. With nothing announced there is no name to read, and the QR carries none rather than guessing (the phone falls back to `host`, and `MobilePairingRecord` already omits an empty name). Covered by a real two-daemon collision test: the renamed desktop's QR name resolves to the renamed desktop.
- **Links inside table cells are now real, clickable anchors.** In reading mode the whole table is a rendered widget, so the position-based link click handler could never see a `[text](url)` inside a cell — the link showed as literal source text and clicks did nothing. The cell renderer now emits a semantic `<a>` (the label still gets bold/italic/code treatment; a quoted title is dropped from the href), and clicks are delegated from the table widget through the same classification/dispatch path as every other link — external URLs open via the OS opener, relative `.md` paths resolve against the current file and open in-app, `#anchors` scroll. Handlers reach the widget through a new `linkHandlersFacet` provided by `linkClickExtension`; cell HTML still passes through `sanitizeHtml`, which also neutralizes `javascript:` hrefs.
- **`md <file>` no longer opens the file in *every* window** (#145). With two or more windows open, opening a single file from the shell loaded it into all of them. Root cause: the per-window `viewer:open-file` (and `viewer:adopt-folder`) events were delivered with `emitTo(label, …)` on the assumption that only the named window's listener would fire — but in Tauri v2 a global `listen()` receives an event regardless of the `emitTo` target (verified: an `emitTo` to one label fired the handler in all five open windows). The regression surfaced now because #142's containment routing takes the `emitTo` path far more often than the old equality match, which usually spawned a fresh window instead. Both targeted events now carry the intended window label in their payload and every other window ignores a message not addressed to it, so exactly one window acts. (`md <dir>` adopting into a blank window was latently affected the same way — every window would have adopted the folder — and is fixed by the same change.)
- **`md <file>` opens in the window whose tree contains the file** (#142). Opening a single file from the shell matched an open window only when that window's folder *exactly equaled* the file's computed VCS root (`resolve_folder_root`), and on no match spawned a window showing the bare file with no sidebar. Two symptoms followed: a file under a window rooted at a *subfolder* of its repo (sidebar `/proj/docs`, repo `/proj`) computed `targetRoot = /proj`, missed the `/proj/docs` window, and spawned a duplicate; and when the file's repo-root matched a broader frontmost window (`main` at `/proj`) while a more specific window (`/proj/docs`) also contained it, the file landed in the broader/frontmost one. Routing is now by **containment, not equality**: among open windows whose sidebar folder is an ancestor of (or equal to) the file's canonical path, the deepest (most-specific) one wins and is raised. Containment is decided on canonical path *segments*, not a raw `startsWith`, so `/proj/docs` no longer captures `/proj/docs-old/x.md`. On no match the new window is now **rooted at the file's directory tree** (`resolve_folder_root`) *and* loads the file — `spawnNewWindow` carries both `?folder=` and `?file=`, and `resolveInitial` loads the file while rooting the sidebar at the folder — instead of a treeless bare-file window. The decision is extracted into a pure, Tauri-free `deepestContainingFolder` helper in `src/shell/project-routing.ts` (alongside `decideProjectRoute`) with unit coverage for exact match, subfolder containment, deepest-wins, the `/proj/docs` vs `/proj/docs-old` boundary, blank/empty maps, and no-match. The `md <dir>` directory branch (`routeToFolder`) is unchanged.
- **Session-restored windows are now found when routing `md .`** (#140). The main window's `folderByLabel` map (folder → window, the routing source of truth for #100) was built purely from live `viewer:window-folder` broadcasts. On session restore, main and the restored secondaries bootstrap concurrently, and a secondary's one-shot startup announce could fire *before* main attached its listener — so that window was dropped from the map permanently, with no replay. Running `md .` / switching project for a folder already open in a restored window then spawned a duplicate window instead of focusing the existing one (the sibling bug to #137, found while debugging it). Added a re-announce handshake: every window now also replies to a `viewer:request-folder-announce` event by re-emitting its *current* folder, and the main window fires that request once its listener is attached (and again after a short delay to catch windows that attach their own responder late). Convergence no longer depends on bootstrap order — every window announces unprompted on startup and answers requests, main both requests on attach and keeps recording late replies, and the map only ever gains/refreshes entries via idempotent `Map.set`. `decideProjectRoute` is unchanged; the bug was an incomplete map, not a routing-logic error.
- **`md .` on an already-open folder raises that folder's window** (#137). Re-running `md .` (or `md <dir>`) for a folder that already has a window foregrounded the app but left the wrong window frontmost. The actual root cause was a missing capability permission: `routeToFolder` correctly resolved the owning window and called `WebviewWindow.setFocus()`, but the desktop capability granted only `core:window:default` (which does not include `set_focus`), so every cross-window focus threw `set_focus not allowed by ACL` — and `raiseWindow` swallowed the rejection, so `open` activated the app while the owning window never raised. The capability now grants `core:window:allow-set-focus`, `allow-unminimize`, and `allow-is-minimized` (the three commands `raiseWindow` issues), with a regression test asserting the grant. Two routing fixes landed alongside: the Rust `RunEvent::Opened` handler now always emits `file-open-request` to `main` (the sole router) instead of whichever window was focused and no longer calls `set_focus()` itself, and the JS routing always raises the owning window even when it is the requester (so a folder owned by an unfocused main is brought forward). The single-`.md`-file open path got the same always-raise fix.
- **Folder paths are canonicalized to one identity** (#99). The same folder opened via different spellings — a symlinked path, a `..`-relative path, or the bare basename the CLI shim passes — was stored as different strings, breaking reflexive identity checks across recents, the sidebar root, the file-position cache, the window-routing map, and a pairing's synced-folders set. A new `canonicalize_path` command (`std::fs::canonicalize`) is now the single source of truth: `resolve_folder_root` returns canonical paths, `setCurrentFolder` and the file-open routing canonicalize before comparing or persisting, and pairing folder enable/disable both canonicalize (disable previously did not, so a folder enabled via one spelling could never be removed via another).
- **Aliased code-fence languages now highlight** (#129). A fence tagged with a short alias (` ```ts `, ` ```js `, ` ```py `, ` ```sh `) never matched the canonical language names Shiki loads, so highlighting was never requested and the block rendered with no colors in either theme. The fence tag is now resolved to its canonical Shiki id (via `bundledLanguagesInfo`) before the load gate and highlight request; unknown tags pass through unchanged.

## [0.12.0] - 2026-05-12 — Sub-spec F: reading-mode screen-reader audit

### Added

- **ARIA semantics on reading-mode body.** Headings, list items, blockquotes, and code-body lines now carry the appropriate `role` and (for headings) `aria-level` so screen readers navigate the document by structure. The first body line of a code fence carries an `aria-label` announcing the language; fence open/close lines are `aria-hidden`. VoiceOver, NVDA, and Orca can now jump heading-to-heading in reading mode (rotor / `H` key).
- **Opaque widget descriptions.** Mermaid and Graphviz diagrams expose `role="img"` + localized `aria-label` on success, `role="status"` + `aria-live="polite"` on first paint (so SRs announce when the diagram lands), and `role="region"` on the error path. Remote-image and broken-image placeholders gain `role="img"` with `aria-label` derived from the alt text.
- **Math as math.** KaTeX flipped from `output: "html"` to `output: "htmlAndMathml"` — every rendered expression now ships a `<math>` MathML subtree that screen readers read as mathematics, not letter-by-letter. Visual rendering unchanged.
- **`a11y.*` i18n namespace.** New keys under `a11y.*` in `src/i18n/strings.ts` for every AT-facing label, plus a `tA11y(key, params)` helper for `{lang}` / `{alt}` substitution.

### Fixed

- Decorative widgets (`BulletWidget`, `SoftBreakWidget`) no longer leak through to AT — both are now `aria-hidden="true"` so screen readers don't read out "bullet bullet bullet" or stray spaces.

### Test surface

- 10 new unit tests across 8 producer test files; existing tests unchanged.

## [0.11.0] - 2026-05-09 — More polish: auto-save, path readout, contrast, menu i18n

### Added

- **Auto-save** (opt-in) in Preferences. 1 s debounce on dirty-tracker notifications; only fires when a path is bound and the file isn't in the diverged state (so it never pops the "save anyway?" modal mid-typing).
- **Toolbar path readout**: shows the file basename next to the dirty indicator; full path in the title attribute.
- **Folder filter input** above the file list — case-insensitive substring match.
- **Resizable sidebar** with persisted width (drag handle, keyboard nudges, 160–480 px clamp).
- **Window state persistence**: per-window size + position via the Tauri store, restored early in bootstrap to avoid a default-sized flash.

### Fixed / improved

- WCAG AA contrast: light-mode `--muted` raised from `#888` (~3.4:1) to `#666` (~5.9:1); dark-mode equivalent raised to `#999` (~8.0:1).
- Auto-save respects divergence state — won't fire if the file changed externally; waits for the user to resolve via the reconcile flow.
- Long path readout in toolbar shows basename only (full path on hover) — leading-directory truncation isn't useful at-a-glance.
- Menu strings migrated to i18n: every `File`/`Edit`/`View`/`Window`/`Help`/app-submenu label is now resolved via `t(menu.*)`. Adding a locale is now `Record<StringKey, string>` end-to-end.
- Reveal-in-FS menu label is platform-aware: "Reveal in Finder" / "Show in Explorer" / "Show in File Manager".
- WatcherInner.target's dead-code warning cleared with `#[allow(dead_code)]` and a docstring; cargo is now warning-free.

## [0.10.0] - 2026-05-09 — Editor ergonomics + perf

### Added

- **File menu**: `Save As…` (Cmd+Shift+S) writes through to a new path, rebinds `currentPath`, restarts the watcher, and records the new path in recents (and the macOS recents cache). `Reveal in Finder` shells out to `open -R` / `explorer /select,` / `xdg-open`.
- **Toolbar word/char count + reading-time** readout. `computeDocStats(source)` strips fenced code, inline code, HTML; counts via Unicode-aware `[\\p{L}\\p{N}][\\p{L}\\p{N}'\\-]*`. 200 wpm reading-time estimate. Wired through the existing `EditorView.updateListener` so it rides the same docChanged hook the TOC uses.
- **Resizable sidebar**. Drag handle on the right edge with min/max clamp (160–480 px), keyboard nudges via Arrow keys, persisted to `localStorage`. `body.viewer-resizing` forces the col-resize cursor and disables text selection during the drag.
- **Per-window state persistence**. Tiny in-app persister via the Tauri store keyed by `window.label`; `restoreWindowState` runs early in bootstrap so the user doesn't see a default-sized flash before the resize lands. Sanity-clamps reject sub-320×240 stored values.
- **Folder sidebar filter**. Substring search input above the file list — case-insensitive, instant.

### Fixed (perf)

- Large markdown files hung the app. Two compounding bugs: HighlightCache had no in-flight tracking (every cache.set re-fired Shiki for every still-pending fence), and pollTocRefresh / dirtyTracker re-stringified the whole document 60×/sec. Fixed via in-flight de-dupe + EditorView.updateListener-driven hooks. Dirty tracker now compares (length, FNV-1a hash) instead of holding the full saved string.

## [0.9.0] - 2026-05-09 — Sub-spec D continues: per-window watcher, drag-drop, OS-level Recents

### Added

- **Per-window file watcher.** `WatcherState` is now `Mutex<HashMap<String, WatcherInner>>` keyed by `window.label()`. Each window owns its own watcher; `watcher_start`/`_stop`/`_mark_self_write` operate per window. Events use `emit_to(label, …)` so a file change reaches only the originating window — broadcasting would let window A react to window B's events.
- **Drag-drop refinements.** Drop a folder onto the window → opens it in the folder sidebar (`is_directory()` Rust command + first-path inspection in the drop handler). Drop multiple `.md` files → first opens in the current window via the dirty-prompt flow; the rest each spawn a new window pre-loaded with their file (forwarded as `?file=…` URL query, read in `resolveInitialDoc` before the recovery / last-opened chain).
- **macOS OS-level Recents.** New `register_recent_document` command calls `NSDocumentController.noteNewRecentDocumentURL` on macOS via `objc2-app-kit`. Surfaces opened files in the Dock right-click menu, Spotlight's Recent source, etc. Hop to main thread via `AppHandle::run_on_main_thread` since `NSDocumentController` is main-thread-only. Wired into `recordRecent`. Windows / Linux equivalents stubbed.

### Fixed

- Reading-mode tables broke short header words like "Stage" character-by-character when columns were squeezed. Root cause: `EditorView.lineWrapping` puts `overflow-wrap: anywhere` on `.cm-content`, and that cascaded into table cells. Restored normal word-boundary breaking on `th`/`td`, plus `white-space: nowrap` on headers and `overflow-x: auto` on the table wrapper.

## [0.8.0] - 2026-05-09 — Sub-spec D: folder tree, multi-window, last-file restore

### Added

- **Re-open last file on launch.** `resolveInitialDoc` consults `recents[0]` (already kept up-to-date by `recordRecent` on every successful open) before falling back to the open dialog. Order: recovery dump → CLI argv → file-association → last-opened (NEW) → dialog. If the last-opened file is gone, the chain silently falls through.
- **Folder tree sidebar.** New `File → Open Folder…` action; the chosen path becomes the "current folder" — persisted via the Tauri store and restored on launch. Rust `list_markdown_files(root)` recursively walks for `.md`/`.markdown`/`.mdx`/`.mdown` files, skipping `node_modules`/`.git`/`target`/`dist`/`build`/`out`/dotfiles/etc.; capped at depth 6 and 5,000 entries to prevent runaway scans. Frontend `ui/sidebar/folder.ts` mounts a section above the TOC with a flat list of `<button>` entries; click activates via `openWithDirtyPrompt`. Active file highlighted with `aria-current="true"`.
- **Multi-window** (`Cmd+N` → File → New Window). Spawns additional viewer windows via `WebviewWindow` with sequential `window-N` labels. The capability scope was widened from `["main"]` to `["main", "window-*"]`. Secondary windows are blank slates — `isMainWindow()` gates the recovery prompt, last-opened restore, and file-association handler.

### Known limitations

- The Rust file watcher is global-state `Mutex<WatcherInner>`; only the most-recently-started watcher is active. Two windows editing different files won't both auto-reload. Reading mode is unaffected.
- Recents and currentFolder are app-wide rather than per-window.
- OS-level Recents integration (macOS `LSRecentDocuments`, Windows Jump List, Linux `RecentManager`) is still pending.

## [0.7.0] - 2026-05-09 — Sub-spec F partial; further reading-mode polish

### Added (Sub-spec F: a11y + i18n foundation)

- **Modal accessibility.** All three modals (preferences, shortcuts, reconcile) now have `role="dialog"` (or `alertdialog` for reconcile), `aria-modal`, `aria-labelledby` (and `aria-describedby` for reconcile). Tab cycles inside the card and never escapes; closing returns focus to whatever held it before open.
- **Reduced-motion support.** The three smooth-scroll calls in `editor/keymaps.ts` (page scroll, top, bottom) check `prefers-reduced-motion` and use instant scrolling when the user has it set.
- **i18n foundation** (`src/i18n/strings.ts`). Typed source-of-truth English string table with a `t(key)` lookup; locales install via `setLocaleStrings(map)`. Migrated user-facing strings from the three modals, the orphan/reloaded notices, and the dirty-discard confirmation. Menu strings still hardcoded — the pattern is established and they can sweep in a follow-up. 4 unit tests cover defaults, override, per-key fallback, revert.
- **Keyboard-navigable TOC sidebar.** Items are now `<button>` elements (were hrefless `<a>`s, invisible to keyboard nav). Active item carries `aria-current="location"`; `<nav>` is labelled by the "Contents" heading. Visible `:focus-visible` outline (accent color) on TOC items and toolbar buttons.

### Fixed

- Click-to-position drift in reading mode, round 2. Several block widgets (HR, math block, Mermaid, image placeholder, table) used `margin` for vertical breathing room. CM6's heightmap doesn't measure margin, so every widget shifted following lines downward by N px below where CM thought they were — cumulative, so triple-clicks landed N paragraphs off. All converted to `padding` (HR + table widgets now wrap their inner element in a `<div>` that carries the padding).
- `drawSelection()` regression in reading mode: drawn cursor showing despite the previous `caret-color: transparent` rule (drawSelection paints its own `.cm-cursor`, ignores caret-color), and selection rectangles painting blocky over widget gaps. Gated `drawSelection()` behind a new selection compartment — edit mode keeps it, reading mode reverts to native browser selection.
- Cmd+Plus zoom-in failed on Swedish (and any layout where `+` is unshifted). Both the Tauri menu accelerator and CodeMirror's `Mod-+` keymap interpret `+` as "Shift + US `=`". A new window-level keydown handler matches `event.key` directly — layout-independent.
- F1 / Cmd+, repeated presses stacking modal overlays and dimming the page cumulatively. Both modals now no-op when any modal is already open.

### Test surface

- 123 unit tests across 26 files (was 119/25).

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
