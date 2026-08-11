# Session, startup, and open-routing — design

**Date:** 2026-08-11
**Status:** Approved, ready for planning

## Problem

Launching Märklig should be unsurprising:

- `md <directory>` raises the window already showing that directory, or opens a
  new window for it.
- `md <file>` raises the window whose tree contains that file and opens the file
  there, or opens a new window rooted at the file's directory with the file
  loaded.
- A cold start with no arguments reopens exactly what was open last time.
- A cold start with arguments reopens exactly what was open last time **plus**
  routes the argument by the two rules above.
- No duplicate windows, ever.

None of this is reliably true today.

## Current behaviour and its defects

`md` is a shell script (`commands/cli_tool.rs`) that runs `open -a <bundle>
<abs paths>`. macOS delivers those as `RunEvent::Opened`, which is buffered into
`PENDING_OPEN_PATHS` on cold launch or emitted to the `main` window as
`file-open-request` while running.

Warm routing lives in `src/main.ts`: `routeToFolder` for directories,
`deepestContainingFolder` for files, both against `folderByLabel` — a map only
the `main` window maintains, kept in sync by a broadcast/re-announce handshake.

Cold start is a different path entirely. `loadAndApplySession()` spawns one
window per persisted `windowSession:<label>` entry, then `resolveInitial()`
picks the main window's document by the priority chain:

```
recovery → CLI arg → buffered Opened → 500ms wait → session folder
         → session file → recents[0] → open dialog
```

Two open paths that disagree. The defects follow from that:

1. **Cold start with arguments hijacks the main window.** The argument is
   resolved above the session in `resolveInitial`, so the main window's own
   restored folder and file are discarded. `md B.md` after a session where main
   showed project A loses A entirely.

2. **Cold start with arguments duplicates a window.** The argument never
   consults `folderByLabel` or the session, so when a restored secondary already
   covers the argument's folder you get two windows on it.

3. **Cold start with a file gives no project root.** `resolveInitial` returns
   `folder: null` for the argument, buffered, and launched cases, while the warm
   path roots the window at `resolveFolderRoot(doc)` (issue #142). The same
   command produces two different windows depending on whether the app was
   already running.

4. **`md <anything>` is a no-op once `main` is closed.** macOS keeps the app
   alive with only secondary windows. Rust falls back to emitting at an
   arbitrary surviving window, but the `file-open-request` handler opens with
   `if (!isMainWindow()) return;`, so the event is dropped.

5. **`firstMarkdownArg()` is dead code.** It invokes `plugin:cli|argv`, but
   `tauri-plugin-cli` is in neither `Cargo.toml` nor the capabilities. It always
   throws and returns null. Harmless on macOS, where arguments arrive via
   `RunEvent::Opened`; it means Linux and Windows have no argv path at all.

6. **Session-restore dedupe has a hole.** `dedupeSessionByFolder` runs over all
   entries including the main window's, but the spawn loop skips the main
   window's label. When main's entry loses the timestamp tiebreak for a folder,
   the surviving secondary is spawned *and* main restores the same folder via
   `sessionFallbackFolder`.

7. **An empty session is not treated as empty.** Closing each window with the
   red X removes its entry (`close.ts`). Quitting after that leaves no session,
   and the next launch falls through to `recents[0]`, reopening a file the user
   deliberately closed.

## Decisions

| Question | Decision |
|---|---|
| Cold start with arguments | Restore the previous session verbatim, then route the argument through the same router the running app uses |
| Empty session | One window, welcome buffer. Drop the `recents[0]` and open-dialog fallbacks |
| Router ownership | Move the window→folder registry and all routing into Rust |
| Session persistence | Rust-owned `session.json`; Rust creates every window; drop the declarative window from `tauri.conf.json` |
| `md <subdir>` of an open root | Focus the containing window, **keep** its root, reveal the subdirectory in its tree |
| Crash recovery | Route each dump to the window that owns its file; unclaimed dumps get their own window |

## Architecture

### One registry, one router, in Rust

New module `src-tauri/src/session/`, four files with one job each:

| File | Owns | Depends on |
|---|---|---|
| `store.rs` | `session.json` under `app_data` — serde types, atomic write, one-time migration from the `windowSession:*` plugin-store keys | nothing app-specific |
| `registry.rs` | `HashMap<label, WindowState>` for live windows: `{ folder, path, dirty, x, y, w, h, scroll, mode }` | `store.rs` types |
| `router.rs` | Pure `route(request, &registry) -> Route`. No Tauri types, no I/O | `registry.rs` types only |
| `launch.rs` | The cold-start sequence: plan → spawn → apply pending paths | all three |

The registry is simultaneously the live routing map *and* what gets serialized.
That collapses today's two sources of truth — the JS `folderByLabel` and the
`windowSession:*` keys — into one, which is what removes the announce handshake,
the `dedupeSessionByFolder` tiebreak hole, and the two-writer race the
per-window keys were introduced to work around.

`dirty` is reported by the frontend and exists for one purpose: the adopt rules
below must not steal a window holding an unsaved scratch buffer.

### Launch runs at `Ready`, not `setup`

`RunEvent::Opened` fires before `setup` on macOS cold launch, so the restore
cannot live in `setup` — it would decide before knowing the arguments.

```
setup()              read session.json (migrate on first run)
                     stash the plan in managed state
                     create NO windows
RunEvent::Opened     LAUNCH_DONE ? router.handle(paths)
                                 : PENDING.push(paths)
RunEvent::Ready      plan = restore_plan()
                     for entry in plan: spawn_window(entry)
                     LAUNCH_DONE = true
                     for paths in PENDING.drain(): router.handle(paths)
```

`app.windows[]` comes out of `tauri.conf.json` so nothing exists before that
decision, and `main` stops being a label with meaning.

The load-bearing detail: `spawn_window` inserts into the registry
**synchronously**, from the entry Rust already holds. It does not wait for the
webview to boot and report. By the time the pending paths are routed, every
restored window's folder is already known. That is what makes cold-start-with-
arguments behave identically to warm, with no timing window and no 500 ms wait.

### Routing table

Every open request — CLI argument, Finder, drag-onto-dock, in-app Switch
Project, folder drag-drop — becomes one call:

```rust
struct OpenRequest { paths: Vec<PathBuf>, origin: Origin }
enum Origin  { External, InApp { requesting: String } }
enum Target  { Directory(PathBuf), File(PathBuf) }
enum Route   { Focus { label, load, reveal }, Adopt { label, folder, load }, Spawn { folder, file } }
```

Paths are canonicalized, classified, and routed **one at a time**, with the
registry updated between each. So `md a.md b.md` in one folder lands both in one
window, where today's drag-drop path spawns per extra file.

Classification: a path that is a directory becomes `Directory`; a path with a
supported document extension becomes `File` (whether or not it exists — the `md`
script already touches missing Markdown paths); anything else is ignored.

**`Target::Directory(d)`**

| # | Condition | Route |
|---|---|---|
| 1 | a live window's folder `== d` | `Focus` |
| 2 | a live window's folder is an **ancestor** of `d` (deepest wins) | `Focus` + `reveal: d` |
| 3 | origin is in-app and the requesting window is blank | `Adopt { folder: d }` |
| 4 | exactly one live window, and it is blank | `Adopt { folder: d }` |
| 5 | — | `Spawn { folder: d }` |

**`Target::File(f)`**

| # | Condition | Route |
|---|---|---|
| 1 | a live window's current `path == f` | `Focus` |
| 2 | a live window's folder **contains** `f` (deepest wins) | `Focus` + `load: f` |
| 3 | origin is in-app and the requesting window is blank | `Adopt { folder: resolve_folder_root(f), load: f }` |
| 4 | exactly one live window, and it is blank | same as 3 |
| 5 | — | `Spawn { folder: resolve_folder_root(f), file: f }` |

*Blank* means `folder == None && path == None && !dirty`.

`Focus` always raises the target window — unminimize, then `set_focus` — even
when the target is the requesting window itself, where it is a harmless no-op.
Rust does **not** `set_focus` before routing; the routing decision is the sole
source of focus (issue #137).

`Spawn { folder }` with no file passes only `?folder=` to the new window. The
per-project fallback chain (last-in-project → root README → welcome) stays in
`src/shell/project-fallback.ts` and runs frontend-side, as it does today.
`resolve_folder_root` is already a Rust command and is called from the router.

Rule 4 in the file table fixes defect 3: `md notes.md` on an empty session
adopts the single welcome window **and roots it at the file's folder**, so cold
and warm produce the same window.

Containment is decided on canonical path segments, not `startsWith`, so
`/proj/docs` does not contain `/proj/docs-old/x.md` — the same rule
`deepestContainingFolder` uses today.

**Accepted consequence.** `md ~/proj` while a window is rooted at `~/proj/docs`
finds no *containing* window and spawns, leaving a `~/proj` window and a
`~/proj/docs` window overlapping. Narrowing a window's root is out of scope by
decision; re-rooting upward is the same move in the other direction. A new
window is the honest answer. This is the one case where two windows still cover
overlapping trees.

### Frontend

`bootstrap()` stops deciding anything. Rust sets every window's URL params —
`?folder=&file=&scroll=&mode=&dump=` — and `resolveInitial` collapses to "read
params, load doc". The priority chain moves into `launch.rs`.

- New `src/shell/session-client.ts`: `reportWindowState()` on tick and on
  change, `forgetWindow(label)` on deliberate close, `requestOpen(paths, origin)`
  for in-app switches.
- `window-session.ts` shrinks to the reporter. `loadWindowSession`,
  `saveWindowSession`, `clearWindowSession`, `upsertEntry`, `removeEntry`, and
  `dedupeSessionByFolder` are removed.
- `window-state.ts` folds into the same report; the `viewer.window.<label>` keys
  are retired with it. One persistence path instead of two.
- `viewer:open-file` stays, now emitted from Rust, and **keeps** the
  label-in-payload addressing. `emitTo` genuinely does not scope a global
  `listen()` in Tauri v2; that workaround is load-bearing, not incidental.
- New `viewer:reveal-path` listener for rule 2's subdirectory reveal: expand the
  path in the folder tree and scroll it into view, without changing the root.
- Recovery: `launch.rs` pairs dumps to entries and passes `?dump=`. The window
  loads it and marks dirty. `maybeRestoreFromRecovery` loses its
  `isMainWindow()` gate.

Three new commands — `session_report`, `session_forget`, `session_open_paths` —
all `#[cfg(desktop)]`. `take_pending_open_paths` is removed from the desktop
handler chain and kept for mobile.

Removed from the frontend: `folderByLabel`, `viewer:window-folder`,
`viewer:request-folder-announce`, `viewer:window-closed`, the `isMainWindow()`
routing gates, `waitForOpenRequest`, `takePendingOpenPaths`, and
`firstMarkdownArg`.

### Migration

On first launch after the change, `store.rs` reads any `windowSession:*` and
`viewer.window.*` keys from the plugin store, writes an equivalent
`session.json`, and deletes them. A user upgrading mid-session keeps their
windows.

## Error handling

- **Corrupt or unreadable `session.json`** → treated as an empty session.
- **Zero-window plan for any reason** → one welcome window. `launch.rs` can
  never produce zero windows; removing the declarative window makes this the
  only guard against a window-less app.
- **A restored entry's file is gone** → the window still opens, rooted at its
  folder, running the existing per-project fallback chain (last-in-project →
  root README → welcome). A restored entry whose *folder* is gone drops the
  folder and falls back to the recorded file; if that is gone too, the entry is
  dropped. No modal on launch, matching #122.
- **Spawn failure for one entry** → logged, other entries continue.
- **Routing a path that is neither a directory nor a supported document** →
  ignored silently, as today.

## Testing

`router.rs` is pure and table-driven, so the routing tables above become its
test file directly — including the cases currently in
`tests/shell/project-routing.test.ts`, ported rather than dropped.

`store.rs`: migration from the plugin-store shape, atomic write, corrupt file
yields an empty session.

`launch.rs`: restore-plan tests — folder dedupe keeping the newest timestamp,
dump pairing, and empty-plan-yields-one-welcome-window.

Cold launch with arguments is a multi-process scenario Playwright cannot drive,
so it goes in `src-tauri/tests/session_launch.rs` against a temporary
`app_data`, in the style of `mdns_discovery.rs` — a wrong route must fail the
suite rather than pass quietly. Covered scenarios:

- Cold, empty session, no arguments → one welcome window.
- Cold, empty session, `md <file>` → one window rooted at the file's folder.
- Cold, session {A, B}, no arguments → exactly two windows, A and B.
- Cold, session {A, B}, `md <file in B>` → two windows; B focused with the file.
- Cold, session {A, B}, `md <C>` → three windows; C focused.
- Cold, session {A}, `md <subdir of A>` → one window, root unchanged, reveal
  emitted.
- Warm equivalents of each, asserting the same window counts.
- Session containing two entries for the same folder → one window.

## Out of scope

- `tauri-plugin-cli` / real argv handling on Linux and Windows (issue #61 owns
  platform verification; `md` is macOS-only today).
- Narrowing or widening an existing window's root in response to `md <dir>`.
- Any change to the sync, watcher, or export subsystems.
