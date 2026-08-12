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
cargo test --workspace --no-fail-fast                        # Rust suite (CI's gate)
cargo clippy --workspace --all-targets --no-deps -- -D warnings   # CI's clippy gate
```

Run the Rust commands **from the repo root**, and pass `--workspace`. `src-tauri`
is one of two workspace members (`Cargo.toml`), so running them inside
`src-tauri/` silently omits `crates/marklig-sync-core` — 68 tests instead of 102.
For the same reason there is exactly **one lockfile, `Cargo.lock` at the root**,
and it is the only place to read this repo's resolved Rust dependencies from. A
second, stale `src-tauri/Cargo.lock` was tracked here until it was deleted; it
had been frozen since before the workspace existed and answered dependency
questions confidently and wrongly (it listed none of the 13 typst crates the
real resolution pulls in).

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

`lib.rs` listens for `RunEvent::Opened` for file-association launches; there is no frontend event for this any more. Before the session has restored, the paths are buffered into `PENDING_OPEN_PATHS`; `RunEvent::Ready` restores the session and then routes the buffer itself through `session::open_paths`. A warm launch (app already running) routes immediately instead of buffering. See "Session, launch, and open-routing" below.

### File lifecycle (`src/shell/`)

- **Save** (`files.ts`) calls `watcherHandle.markSelfWrite()` *before* writing, so the watcher swallows the resulting fs event instead of treating it as an external change.
- **Watcher reconciliation** (`watcher.ts` + `ui/reconcile.ts`): clean buffer + external change → silent reload preserving scrollTop; dirty buffer + external change → modal (reload / keep-mine / cancel); file removed externally → orphan notice and `currentPath = null`. A user's "keep mine" sets `diverged = true`, which then warns on next save. The listener first discards any event whose `path` isn't the one that watcher was installed for — `emit_to(label, …)` does **not** scope a global `listen()` (see #145), so every window receives every window's watcher events and would otherwise reconcile a file it doesn't have open. Windows that *do* have the file open all still reload: each has its own watcher, so each gets an event spelled the way it asked for the path.
- **Crash recovery** (`recovery.ts`): every 5s while dirty, the buffer is dumped via `write_recovery`. At restore, each dump is paired with the window that owns its file (via `?dump=` — see "Session, launch, and open-routing" below); an unclaimed dump gets a window of its own. No window scans the whole recovery store. Save / explicit discard clears the dump.
- **Auto-save** is debounced 1000 ms after the last edit; skipped while `diverged` so it doesn't pop the "save anyway?" modal mid-typing.
- **Multi-window**: every window, including `main`, boots entirely from its URL query parameters — there is no first-window special case left in the frontend. See "Session, launch, and open-routing" below for who sets those parameters and when.

### Session, launch, and open-routing (`src-tauri/src/session/`)

There is **no privileged `main` window** and no window in `tauri.conf.json`.
Rust creates every window at `RunEvent::Ready` and owns all routing:

- `store.rs` — `<app_data>/session.json`, atomic writes, one-time migration
  off the old `windowSession:*` plugin-store keys.
- `registry.rs` — the live `label → WindowEntry` map. It is *also* what gets
  serialized, so the routing map and the session file cannot drift apart.
- `router.rs` — pure decision: `Focus | Adopt | Spawn`. No Tauri types, no I/O;
  `resolve_folder_root` is injected, which is what makes the whole routing
  table unit-testable.
- `launch.rs` — the restore plan: dedupe by folder (newest wins), reconcile
  against disk, pair crash dumps to the window owning each file. **It can
  never return an empty plan** — with no declarative window, that guard is the
  only thing standing between a corrupt `session.json` and a window-less app.

`RunEvent::Opened` fires *before* `setup` on macOS cold launch, so the restore
runs at `Ready` — and it **routes before it creates**: build the plan, seed a
registry from that plan, route the buffered arguments against it, fold each
decision back into the plan, and only then create the windows (raising them
afterwards). The order is load-bearing. `emit_to` resolves against listeners
registered when JS calls `listen()`, so a window that has not booted yet has
none and the event is **silently dropped** — no queue, no replay. Anything
aimed at a not-yet-created window must therefore travel in its URL, which is
what folding does; only genuinely pre-existing windows are sent events. The
same split applies warm: in `md a.md b.md`, the second path folds into the
first's spawn rather than being emitted at a webview that is still loading.
`spawn_window` seeds the registry **synchronously** from the entry it already
holds rather than waiting for the webview to report — that wait was the race
that made cold-start arguments behave differently from warm ones.

The frontend decides nothing about startup. Every window reads `?folder=`,
`?file=`, `?scrollTop=`, `?mode=`, `?dump=`, `?reveal=`, and `?sidebar=` and loads exactly
that; `src/shell/session-client.ts` only reports state back. `?sidebar=` is
three-state — `true` / `false` / absent — and absent means "no preference
recorded, fall back to the default heuristic," not "hidden"; don't collapse
it to a boolean. `emit_to` still does not scope a global `listen()` in Tauri
v2, so `viewer:open-file`, `viewer:adopt-folder`, and `viewer:reveal-path` all
carry their target label in the payload — do not "simplify" that away (see
#145).

Four commands drive this from the frontend: `session_report` (state changed),
`session_forget` (window closed deliberately), `session_open_paths` (route an
open request), and `session_new_window` — `File → New Window` deliberately
does **not** go through the router; the user asked for a window, not a
document, so it always spawns.

### Export & sanitization (`src/export/`)

`buildHtmlExport` produces a self-contained HTML doc (inlined export stylesheet + KaTeX CSS via Vite `?inline` query). Math is pre-extracted with the same regex used by `decorations/math.ts`, rendered through `katex.renderToString`, and re-substituted *after* markdown-it tokenizes so math source isn't double-tokenized.

**Sanitization is mandatory for every innerHTML path:**
- markdown-it HTML (export, copy-as-HTML) → `sanitizeHtml` (DOMPurify, default html profile)
- KaTeX HTML output → `sanitizeHtml`
- Mermaid SVG → injected **raw** (NOT `sanitizeSvg`): it is our own first-party Mermaid render of the user's diagram (mermaid runs with `securityLevel: "strict"` on the source), so it's trusted. DOMPurify's `sanitizeSvg` **strips** Mermaid's `<foreignObject>` HTML labels, which would silently drop flowchart node/edge text — so both the reading-view widget (`src/editor/decorations/mermaid.ts`) and the export (`src/export/html.ts`) inject the raw SVG. `sanitizeSvg` remains for any untrusted SVG paths.

The reading view itself doesn't innerHTML the document — it stays text + CM widgets — so the architectural guarantee from REQUIREMENTS §6 holds even before the sanitizer runs.

Print uses a hidden same-process iframe + `contentWindow.print()` (Tauri's webview doesn't reliably forward `window.print()` from a popup). PDF currently goes through the OS print dialog's Save-as-PDF — there's no native Rust-side webview-to-PDF path.

### Sync crypto (workspace crate)

`crates/marklig-sync-core` holds the E2E-encrypted pairing handshake,
the per-file envelope, and the sync op log format. Pure Rust; no
dependency on Tauri. Wired into `src-tauri/Cargo.toml` as a path dep
and compiles for `aarch64-linux-android` via the Tauri Android build
chain.

Three modules:

- `pair`: Noise XK handshake (via `snow`), QR payload codec
  (`marklig-pair://v1/…`), and HKDF-SHA256 derivation of the long-term
  `PairKey` + stable `PairId` from the handshake hash.
- `envelope`: per-file ChaCha20-Poly1305 with HKDF-derived keys
  (`info = b"file:" || folder_id || relpath`). 12-byte nonce + tag.
- `ops`: append-only sync op log (`OpLog` — JSONL + flat blob store under
  `<app_data>/sync/<pair>/<folder>/`) + Lamport clock + deterministic
  conflict resolution. Used on the wire since the live-push-sync
  implementation (issue #97).

**ABI stability:** HKDF salt / info strings and the `marklig-pair://v1/`
QR payload format are part of the wire ABI — once a phone is in the
wild with a derived pair key, changing them invalidates every paired
device. Bump the `-v1` suffix as a deliberate migration when changing.

Tests live alongside the crate (`crates/marklig-sync-core/tests/`).
The crate is wired up on both sides: `pairing.rs` and `pairing_ws.rs`
(desktop pairing + transport), `sync_log.rs` / `sync_watcher.rs` (op log
and live push), and `commands/mobile_pairing.rs` / `commands/mobile_sync.rs`
(phone side).

**Pairing discovery** (`src-tauri/src/mdns.rs`) announces
`_marklig-sync._tcp` — instance name, `WS_PORT`, TXT `proto=ws` — for as
long as the pairing WS server's listener is bound (not just while a pairing
modal is open: a reconnecting phone asks whether *sync* is reachable), and
offers `mdns_browse_peers` / `mdns_resolve_instance` for finding a desktop
by name. Announce answerability, not liveness: a desktop whose bind failed
must stay silent, or a phone resolves it and abandons a stored address that
still worked.

**The instance name is derived once and never twice.** `instance_name()` is
private to `mdns.rs`, reads `gethostname(2)` (via the `hostname` crate —
`$HOSTNAME` and `$HOST` are unset for an app launched from Finder or the
Dock, which gave every desktop the same name), and is reachable only through
`announce_this_desktop`. Anything that needs to *name* this desktop — the QR
in `pairing_start` — reads `SyncAnnouncer::announced_instance_name()`, the
name actually on the wire. Do not reintroduce a second derivation: mdns-sd
renames a colliding announcement per RFC 6762 §9 (`<name> (2)`, adopted from
`DaemonEvent::NameChange`), and a recomputed name would then be the
*neighbour's*, so the QR would send a phone to the wrong desktop.

`src-tauri/tests/mdns_discovery.rs` exercises all of this over real
multicast, including negative guards and a genuine two-daemon name
collision, so a resolve that quietly matches the wrong peer fails the suite
rather than passing. The **phone** prefers its stored `host` and resolves
the instance name only once a dial fails (`src/shell/mobile-sync-client.ts`,
`dialTarget`).

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
chain now also covers pairing and sync (`mobile_pairing_start`,
`mobile_sync_now`, `mobile_read_synced_file`, `mobile_unpair`,
`mobile_apply_sync_op`) and mDNS resolution (`mdns_browse_peers`,
`mdns_resolve_instance`) alongside `take_pending_open_paths`. `pub fn run()`
carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]` so Tauri's
Android JNI entry point is generated. When adding new commands, default
to gating them desktop-only unless they're explicitly designed for both —
Android does not have an FS watcher and does not have NSDocumentController.

On the frontend, `src/main.ts` forks at the bottom on `isMobile()`
(from `src/platform.ts`): mobile dynamically imports
`src/mobile-bootstrap.ts`, which renders the existing decoration
producer set in reading mode.

`mobile-bootstrap.ts` carries a tiny 2-state router (`library` /
`document`):

- **Library route.** Mounts the vanilla-DOM library home from
  `src/ui/mobile-library.ts`, listing recent files from
  `src/shell/mobile-recents.ts` (persisted in `tauri-plugin-store`
  under `mobile.recents`). Tap-to-open re-routes to the document.
- **Document route.** Mounts CodeMirror with the reading-mode
  decoration set. A back-bar appears only when the document has a
  `uriForRecents` (i.e. the user reached it via a share or by tapping
  a recent) so a fresh-install user reading the bundled `sample.md`
  isn't trapped on an empty library.

Share-sheet flow: `tauri-plugin-deep-link` configured with
`scheme: ["file", "content"]` in `plugins.deep-link.mobile`
(`tauri.conf.json`). `MainActivity.onCreate` forwards the launch
intent through `onNewIntent` so cold-launch share targets aren't
dropped. `@tauri-apps/plugin-fs.readTextFile` resolves `content://`
URIs via SAF on Android.

Mobile-only styles live in `src/styles-mobile.css`, imported from
`mobile-bootstrap.ts` so desktop builds don't pull them in. The
back-bar and library padding honor `env(safe-area-inset-top)` so
content isn't hidden behind the system status bar
(`enableEdgeToEdge()` is on).

`npm run tauri:android:dev` runs the dev loop (requires `NDK_HOME` and a
running emulator or connected device — see README "Android" section).

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
