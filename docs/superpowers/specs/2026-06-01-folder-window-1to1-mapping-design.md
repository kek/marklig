# Design: 1:1 folder ↔ window mapping (#100)

## Problem

Opening another folder via **Switch Project** (`Cmd-R`, the Projects menu, or
Recent Projects) replaces the *current* window's sidebar tree and buffer. There
is no concept of "the window for folder X", so a user with two projects open
must remember which window holds which sidebar. Running `md <dir>` from a shell
has the same ambiguity for the directory case when no window already shows it.

We want the (folder root → window) relationship to be 1:1 and persistent:

- **Switch Project**: if a live window already shows that folder root → raise +
  focus it. If the requesting window has no folder yet → adopt the folder in
  place. Otherwise → spawn a new window for it. Never replace an existing
  sidebar.
- **`md <dir>` / Finder "Open With…" on a folder**: same routing.

Depends on folder-path canonicalization (#99), shipped via #133 —
`setCurrentFolder` already canonicalizes, and the routing map is keyed on
canonical paths.

## Non-goals

- Titlebar project name — that is #98 (separate PR).
- Routing of single *file* opens into blank windows — the existing
  `file-open-request` file branch is unchanged. This spec only governs
  folder/project switching.

## Architecture

The main window is the sole routing decision-maker: it already owns
`folderByLabel` (`src/main.ts:753`), a `Map<window label, folder root>`
populated from `viewer:window-folder` broadcasts, and the existing
`file-open-request` listener already uses it to focus-or-spawn. We reuse that
exact pattern for project switching.

Two new pieces of logic, both small:

1. A **pure decision function** that encodes the entire behavioral spec and is
   unit-tested without Tauri.
2. A thin **router** in the main window that applies the decision against real
   windows.

Both the in-app Switch Project path and the `md <dir>` directory path call the
router, unifying the two entry points.

### Decision function (pure)

```ts
type ProjectRoute =
  | { kind: "focus"; label: string } // a live window already owns `target`
  | { kind: "adopt" }                // requesting window is unclaimed (folder === null)
  | { kind: "spawn" };               // requesting window already owns a different folder

function decideProjectRoute(input: {
  target: string;                       // canonical folder being switched to
  requestingLabel: string;              // label of the window that invoked the switch
  requestingFolder: string | null;      // that window's current folder root
  folderByLabel: ReadonlyMap<string, string | null>;
}): ProjectRoute;
```

Rules, in order:

1. If any entry in `folderByLabel` has `folder === target` → `{ kind: "focus", label }`.
   (When that label *is* `requestingLabel`, it is still a focus result — the
   router treats focusing the already-correct window as a no-op.)
2. Else if `requestingFolder === null` → `{ kind: "adopt" }`.
3. Else → `{ kind: "spawn" }`.

This is the whole spec in one testable place. `target` is assumed already
canonical (the router canonicalizes before calling).

### Router (main window)

`routeToFolder(target, requestingLabel)`:

1. `target = await canonicalizePath(target)`.
2. Resolve `requestingFolder` — for the in-app path this is the
   `viewer:switch-project-request` payload; the router reads the live
   `folderByLabel.get(requestingLabel)` as the source of truth (defaulting to
   `null` when absent).
3. Walk `folderByLabel` to find a live window for `target`, using the same
   verify-before-route + prune-stale loop the `file-open-request` handler uses
   (an entry whose `WebviewWindow.getByLabel` returns nothing is deleted and
   skipped — the map can lag a closed window by a frame).
4. Call `decideProjectRoute(...)` and apply:
   - **focus** → if `label !== requestingLabel`, raise the window
     (`raiseWindow(label)`: unminimize if minimized, then `setFocus()`);
     otherwise no-op.
   - **adopt** → `emitTo(requestingLabel, "viewer:adopt-folder", target)`. That
     window's listener calls the existing
     `setCurrentFolder(target, { replaceBuffer: true })` — today's behavior,
     now reached only when the window has no folder.
   - **spawn** → `spawnNewWindow({ folder: target })`.

### Wiring

- **New event** `viewer:switch-project-request` with payload
  `{ folder: string; fromLabel: string }`. The focused window's `openProject`
  handler (`src/main.ts:1340`) emits this **instead of** calling
  `setCurrentFolder` directly:
  ```ts
  openProject: async (path) => {
    void emit("viewer:switch-project-request", { folder: path, fromLabel: selfLabel });
  },
  ```
- **Main-window listener** for `viewer:switch-project-request` (gated by
  `isMainWindow()`, installed next to the existing `file-open-request`
  listener) → `routeToFolder(payload.folder, payload.fromLabel)`. Unsubscribe on
  `beforeunload`, matching the other listeners.
- **New event** `viewer:adopt-folder` (payload: the canonical folder string).
  Every window listens; on receipt it calls
  `setCurrentFolder(folder, { replaceBuffer: true })`.
- **`file-open-request` directory branch** (`src/main.ts:1622-1628`): replace
  the current `dispatchToFocused({ type: "openProject", path: dir })` (which
  adopts into the focused window) with `routeToFolder(dir, selfLabel)`. This
  unifies `md <dir>` with in-app switching — focus existing, adopt if the main
  window is unclaimed, else spawn. The matched-window focus that branch already
  does is subsumed by the router's focus case.

### Folder-only window spawn

`spawnNewWindow` currently takes an optional `initialFile` → `?file=…`. Extend
it to also accept a folder:

```ts
async function spawnNewWindow(opts?: { file?: string; folder?: string }): Promise<void>
```

- `folder` present → URL `/?folder=<encodeURIComponent(canonical)>`.
- `file` present → `/?file=…` (unchanged).
- neither → `/` (blank, unchanged).

Existing callers that pass a bare file string are updated to
`spawnNewWindow({ file })`.

Bootstrap already handles a folder result: `resolveInitial` returns
`{ doc: null, folder }` and the caller runs the project-fallback chain (last-in-
project → root README → welcome) to pick the initial file and sidebar root. Add
a `folderFromUrlQuery()` read in the **secondary-window** branch of
`resolveInitial` (alongside the existing `fileFromUrlQuery()` at
`src/main.ts:1700`):

```ts
const urlFolder = folderFromUrlQuery();
if (urlFolder) return { doc: null, folder: urlFolder };
```

Because a folder-spawned window starts with `folder` set, the project-fallback
chain in the cold-start path resolves the initial file inside that project.

### 1:1 safety net on session restore

Live routing guarantees no two windows share a folder, so persisted session
entries are already distinct in normal operation. As defense against a
stale/legacy/corrupted store, `loadAndApplySession` (`src/main.ts:1818+`)
dedupes entries by canonical folder before spawning: group restorable entries by
folder, keep the newest by `timestampMs`, drop the rest. Entries with
`folder == null` (blank windows) are never deduped against each other. This is a
pure helper (`dedupeSessionByFolder(entries)`) so it is unit-testable.

### Raise + focus helper

`raiseWindow(label)`: look up the window; if `await win.isMinimized()`, call
`win.unminimize()`; then `win.setFocus()`. Used by the router's focus case.
Implements the issue's "always raise + focus" for minimized / hidden / other-
Space windows.

## Data flow

```
Switch Project (Cmd-R / menu / recent)  in window W
        │  emit viewer:switch-project-request { folder, fromLabel: W }
        ▼
main window listener ── routeToFolder(folder, W)
        │  canonicalize, look up folderByLabel (verify+prune)
        ▼
decideProjectRoute
   ├── focus L≠W  → raiseWindow(L)
   ├── focus L==W → no-op
   ├── adopt      → emitTo(W, viewer:adopt-folder, folder) → setCurrentFolder(replace)
   └── spawn      → spawnNewWindow({ folder })  →  new window bootstraps with ?folder=
```

`md <dir>` enters at the main window's `file-open-request` directory branch and
calls the same `routeToFolder(dir, selfLabel)`.

## Error handling

- **Stale map entry** (window closed, broadcast not yet processed): the verify-
  before-route loop deletes the entry and continues, so routing never focuses a
  dead label. Same guard the file path already uses.
- **Spawn failure**: `WebviewWindow` emits `tauri://error`; logged as today, no
  user-facing modal.
- **Folder gone on restore**: existing `loadAndApplySession` /
  `resolveInitial` logic already drops missing folders silently (#122 ACs);
  dedupe runs before that check and does not change it.
- **Canonicalization failure**: `canonicalizePath` falls back to its existing
  behavior; routing degrades to string compare on whatever it returns. No new
  failure mode.

## Testing

**Unit (mirrored under `tests/`):**
- `decideProjectRoute` truth table:
  - target owned by another window → focus that label;
  - target owned by the requesting window → focus requestingLabel (router no-op);
  - target unowned + requesting folder null → adopt;
  - target unowned + requesting folder set → spawn;
  - empty map → adopt if requesting null, else spawn.
- `dedupeSessionByFolder`: two entries same folder → newest kept; distinct
  folders untouched; multiple `null`-folder entries all retained; ordering
  preserved for survivors.

**Regression:** existing multi-window e2e specs
(`playwright.config.ts` runs them serially) guard window spawning / restore.

## Files touched

- `src/main.ts` — `openProject` emits the request; new
  `viewer:switch-project-request` + `viewer:adopt-folder` listeners; `routeToFolder`,
  `raiseWindow`; `spawnNewWindow` signature; `folderFromUrlQuery`;
  `resolveInitial` folder-query branch; `loadAndApplySession` dedupe call.
- New module for the pure helpers (e.g. `src/shell/project-routing.ts`):
  `decideProjectRoute`, `dedupeSessionByFolder` — kept out of `main.ts` so they
  are importable by tests without pulling in Tauri.
- `tests/shell/project-routing.test.ts` — unit tests for both helpers.
- `CHANGELOG.md` — Unreleased entry.
```
