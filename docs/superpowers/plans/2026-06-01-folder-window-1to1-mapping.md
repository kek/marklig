# 1:1 Folder ↔ Window Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Switch Project (and `md <dir>`) route to the window that already owns a folder — focus it, adopt it into an unclaimed window, or spawn a new one — instead of replacing the current sidebar.

**Architecture:** A pure decision function (`decideProjectRoute`) encodes the focus/adopt/spawn rule and is unit-tested without Tauri. A thin router in the main window (`routeToFolder`) applies the decision against real `WebviewWindow`s using the existing `folderByLabel` map. Switch Project emits a request event the main window handles; the `md <dir>` directory branch calls the same router. A pure `dedupeSessionByFolder` hardens session restore against duplicate folders.

**Tech Stack:** TypeScript (strict), Tauri 2 (`@tauri-apps/api` window + event), Vitest (jsdom), markdown app frontend in `src/`.

This repo is a **Jujutsu** repo (`.jj/` exists). Use the `jujutsu` skill for every commit — `jj desc -m "…"` on the working copy, then `jj new` to start the next task. Do NOT run raw `git commit`. Commit messages: imperative, sentence case, no trailing period.

---

## File Structure

- **Create** `src/shell/project-routing.ts` — pure helpers `decideProjectRoute` and `dedupeSessionByFolder`, plus the `ProjectRoute` type. No Tauri imports, so tests don't need a window. Imports the `WindowSessionEntry` type from `./window-session` (type-only).
- **Create** `tests/shell/project-routing.test.ts` — unit tests for both helpers.
- **Modify** `src/main.ts` — emit the switch-project request from `openProject`; add `viewer:switch-project-request` + `viewer:adopt-folder` listeners; add `routeToFolder` and `raiseWindow`; change `spawnNewWindow` signature and its callers; add `folderFromUrlQuery`; add the folder branch in `resolveInitial`; call `dedupeSessionByFolder` in `loadAndApplySession`.
- **Modify** `CHANGELOG.md` — Unreleased entry.

---

## Task 1: Pure decision function `decideProjectRoute`

**Files:**
- Create: `src/shell/project-routing.ts`
- Test: `tests/shell/project-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shell/project-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideProjectRoute } from "../../src/shell/project-routing";

describe("decideProjectRoute", () => {
  it("focuses another window that already owns the target folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/b",
      folderByLabel: new Map([
        ["main", "/proj/b"],
        ["window-2", "/proj/a"],
      ]),
    });
    expect(route).toEqual({ kind: "focus", label: "window-2" });
  });

  it("focuses the requesting window when it already owns the target", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/a",
      folderByLabel: new Map([["main", "/proj/a"]]),
    });
    expect(route).toEqual({ kind: "focus", label: "main" });
  });

  it("adopts when the target is unowned and the requesting window has no folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: null,
      folderByLabel: new Map([["main", null]]),
    });
    expect(route).toEqual({ kind: "adopt" });
  });

  it("spawns when the target is unowned and the requesting window owns a different folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: "/proj/b",
      folderByLabel: new Map([["main", "/proj/b"]]),
    });
    expect(route).toEqual({ kind: "spawn" });
  });

  it("adopts into an empty map when the requesting window has no folder", () => {
    const route = decideProjectRoute({
      target: "/proj/a",
      requestingLabel: "main",
      requestingFolder: null,
      folderByLabel: new Map(),
    });
    expect(route).toEqual({ kind: "adopt" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/project-routing.test.ts`
Expected: FAIL — cannot resolve `../../src/shell/project-routing`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shell/project-routing.ts`:

```ts
/**
 * Pure routing decision for "switch to folder X" (issue #100). Kept free of
 * Tauri imports so it is unit-testable without a real window. The router in
 * main.ts turns this decision into focus / adopt / spawn actions.
 */

export type ProjectRoute =
  | { kind: "focus"; label: string }
  | { kind: "adopt" }
  | { kind: "spawn" };

/**
 * Decide how to route a project switch.
 *
 *   1. A live window already owns `target`     → focus it (may be the
 *      requesting window itself, which the router treats as a no-op).
 *   2. Target unowned, requesting window blank  → adopt the folder in place.
 *   3. Target unowned, requesting window claimed → spawn a new window.
 *
 * `target` is assumed already canonical; the caller canonicalizes both the
 * target and the map values before calling.
 */
export function decideProjectRoute(input: {
  target: string;
  requestingLabel: string;
  requestingFolder: string | null;
  folderByLabel: ReadonlyMap<string, string | null>;
}): ProjectRoute {
  for (const [label, folder] of input.folderByLabel) {
    if (folder === input.target) return { kind: "focus", label };
  }
  if (input.requestingFolder === null) return { kind: "adopt" };
  return { kind: "spawn" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shell/project-routing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add decideProjectRoute for folder-to-window routing (#100)"
jj new
```

---

## Task 2: Pure session-restore dedupe `dedupeSessionByFolder`

**Files:**
- Modify: `src/shell/project-routing.ts`
- Test: `tests/shell/project-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/shell/project-routing.test.ts`:

```ts
import { dedupeSessionByFolder } from "../../src/shell/project-routing";
import type { WindowSessionEntry } from "../../src/shell/window-session";

function entry(p: Partial<WindowSessionEntry>): WindowSessionEntry {
  return {
    label: "main",
    path: null,
    x: 0,
    y: 0,
    width: 1000,
    height: 760,
    scrollTop: 0,
    mode: "reading",
    folder: null,
    timestampMs: 0,
    ...p,
  };
}

describe("dedupeSessionByFolder", () => {
  it("keeps the newest entry when two windows share a folder", () => {
    const older = entry({ label: "window-2", folder: "/proj/a", timestampMs: 100 });
    const newer = entry({ label: "main", folder: "/proj/a", timestampMs: 200 });
    const out = dedupeSessionByFolder([older, newer]);
    expect(out).toEqual([newer]);
  });

  it("leaves entries with distinct folders untouched", () => {
    const a = entry({ label: "main", folder: "/proj/a", timestampMs: 1 });
    const b = entry({ label: "window-2", folder: "/proj/b", timestampMs: 2 });
    const out = dedupeSessionByFolder([a, b]);
    expect(out).toEqual([a, b]);
  });

  it("never dedupes blank (null-folder) windows against each other", () => {
    const a = entry({ label: "main", folder: null, timestampMs: 1 });
    const b = entry({ label: "window-2", folder: null, timestampMs: 2 });
    const out = dedupeSessionByFolder([a, b]);
    expect(out).toHaveLength(2);
  });

  it("preserves input order of the surviving entries", () => {
    const a = entry({ label: "main", folder: "/proj/a", timestampMs: 1 });
    const b = entry({ label: "window-2", folder: null, timestampMs: 2 });
    const c = entry({ label: "window-3", folder: "/proj/c", timestampMs: 3 });
    const out = dedupeSessionByFolder([a, b, c]);
    expect(out).toEqual([a, b, c]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/project-routing.test.ts`
Expected: FAIL — `dedupeSessionByFolder` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/shell/project-routing.ts`:

```ts
import type { WindowSessionEntry } from "./window-session";

/**
 * Drop duplicate folders from a restorable session set, keeping the newest
 * entry (by timestampMs) per folder. Blank windows (folder null/undefined) are
 * never deduped against each other. Survivor order matches input order.
 *
 * Live routing already guarantees a 1:1 folder→window mapping, so this only
 * matters for a stale / legacy / corrupted store (#100 safety net).
 */
export function dedupeSessionByFolder(
  entries: readonly WindowSessionEntry[],
): WindowSessionEntry[] {
  // Winner per folder: highest timestampMs.
  const winnerByFolder = new Map<string, WindowSessionEntry>();
  for (const e of entries) {
    if (!e.folder) continue;
    const cur = winnerByFolder.get(e.folder);
    if (!cur || e.timestampMs > cur.timestampMs) winnerByFolder.set(e.folder, e);
  }
  return entries.filter((e) => {
    if (!e.folder) return true;
    return winnerByFolder.get(e.folder) === e;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shell/project-routing.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add dedupeSessionByFolder restore safety net (#100)"
jj new
```

---

## Task 3: Generalize `spawnNewWindow` to accept a folder

**Files:**
- Modify: `src/main.ts` (the `spawnNewWindow` definition near line 2007, and its callers at lines 1276, 1587, 1653)

This task has no new unit test — `spawnNewWindow` constructs a `WebviewWindow`, which is exercised by the existing Playwright multi-window e2e specs. Verify with `tsc`.

- [ ] **Step 1: Change the signature and body**

Replace the `spawnNewWindow` function (currently):

```ts
async function spawnNewWindow(initialFile?: string): Promise<void> {
  const label = await nextWindowLabel();
  const url = initialFile
    ? `/?file=${encodeURIComponent(initialFile)}`
    : "/";
  const win = new WebviewWindow(label, {
```

with:

```ts
async function spawnNewWindow(
  opts: { file?: string; folder?: string } = {},
): Promise<void> {
  const label = await nextWindowLabel();
  let url = "/";
  if (opts.folder) {
    url = `/?folder=${encodeURIComponent(opts.folder)}`;
  } else if (opts.file) {
    url = `/?file=${encodeURIComponent(opts.file)}`;
  }
  const win = new WebviewWindow(label, {
```

(Leave the rest of the function body unchanged.)

- [ ] **Step 2: Update the three callers**

- Line ~1276: `newWindow: async () => { await spawnNewWindow(); },` — unchanged (no-arg call still valid).
- Line ~1587: change `await spawnNewWindow(docFiles[i]);` → `await spawnNewWindow({ file: docFiles[i] });`
- Line ~1653: change `await spawnNewWindow(doc);` → `await spawnNewWindow({ file: doc });`

- [ ] **Step 3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Generalize spawnNewWindow to open a folder root (#100)"
jj new
```

---

## Task 4: Read `?folder=` in `resolveInitial`

**Files:**
- Modify: `src/main.ts` (`fileFromUrlQuery` neighborhood near line 2095, and the secondary-window branch of `resolveInitial` near line 1700)

- [ ] **Step 1: Add `folderFromUrlQuery`**

Directly below the existing `fileFromUrlQuery` function, add:

```ts
function folderFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("folder");
    return f && f.length > 0 ? f : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Consult it in `resolveInitial`**

In `resolveInitial`, immediately after the `urlFile` block (the `const urlFile = fileFromUrlQuery(); if (urlFile) { … }` at line ~1700-1707) and **before** the `if (!isMainWindow()) return { doc: null, folder: null };` line, insert:

```ts
  // A window spawned for a project (issue #100) carries its folder root as a
  // query param. Returning it here lets the caller run the per-project
  // fallback chain to choose the initial file and sidebar root.
  const urlFolder = folderFromUrlQuery();
  if (urlFolder) return { doc: null, folder: urlFolder };
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Resolve initial folder from ?folder= query param (#100)"
jj new
```

---

## Task 5: Add `raiseWindow` and `routeToFolder` in the main window

**Files:**
- Modify: `src/main.ts` (import `decideProjectRoute` from `./shell/project-routing`; add helpers inside the bootstrap scope where `folderByLabel`, `selfLabel`, `spawnNewWindow`, and `setCurrentFolder` are in scope — i.e. as inner functions near `setCurrentFolder`, around line 815, OR as closures that capture `folderByLabel`. Place them right after `setCurrentFolder`.)

`routeToFolder` and `raiseWindow` reference `folderByLabel`, `setCurrentFolder` (for the adopt loopback within the same window), `spawnNewWindow`, and `emitTo`/`WebviewWindow`. Define them as inner functions in the same scope as `setCurrentFolder`.

This task wires logic exercised by e2e; verify with `tsc`. No new unit test (the decision is already covered by Task 1).

- [ ] **Step 1: Add the import**

At the top of `src/main.ts`, with the other `./shell/...` imports, add:

```ts
import { decideProjectRoute, dedupeSessionByFolder } from "./shell/project-routing";
```

(`dedupeSessionByFolder` is used in Task 6; importing both now keeps one edit.)

- [ ] **Step 2: Add `raiseWindow` and `routeToFolder`**

Immediately after the `setCurrentFolder` function definition (after its closing brace near line 870), add:

```ts
  /** Raise a window to the foreground: unminimize if needed, then focus.
   * Implements issue #100's "always raise + focus" for a window that may be
   * minimized, hidden, or on another Space. */
  async function raiseWindow(label: string): Promise<void> {
    const w = await WebviewWindow.getByLabel(label);
    if (!w) return;
    try {
      if (await w.isMinimized()) await w.unminimize();
    } catch {
      // isMinimized/unminimize unsupported or window vanished — focus anyway.
    }
    await w.setFocus();
  }

  /** Route a "switch to folder" request (issue #100). The main window owns
   * folderByLabel and is the sole decision-maker, mirroring file-open-request.
   *   - target already shown by a live window → raise + focus it;
   *   - requesting window is unclaimed        → adopt the folder in place;
   *   - otherwise                              → spawn a new window for it. */
  async function routeToFolder(
    target: string,
    requestingLabel: string,
  ): Promise<void> {
    target = await canonicalizePath(target);

    // Prune stale labels (a closed window can lag the map by a frame) so a
    // focus decision never targets a dead window. Same guard the
    // file-open-request handler uses.
    for (const [label, folder] of [...folderByLabel]) {
      if (folder !== target) continue;
      if (!(await WebviewWindow.getByLabel(label))) folderByLabel.delete(label);
    }

    const route = decideProjectRoute({
      target,
      requestingLabel,
      requestingFolder: folderByLabel.get(requestingLabel) ?? null,
      folderByLabel,
    });

    if (route.kind === "focus") {
      if (route.label !== requestingLabel) await raiseWindow(route.label);
      return;
    }
    if (route.kind === "adopt") {
      await emitTo(requestingLabel, "viewer:adopt-folder", target);
      return;
    }
    await spawnNewWindow({ folder: target });
  }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add raiseWindow and routeToFolder router (#100)"
jj new
```

---

## Task 6: Wire events — emit request, handle request, adopt, unify md, dedupe restore

**Files:**
- Modify: `src/main.ts` (`openProject` handler line ~1340; main-window listener block near the `file-open-request` listener ~1605; the `file-open-request` directory branch ~1622-1628; an adopt listener; `loadAndApplySession` ~1818)

- [ ] **Step 1: `openProject` emits the request instead of switching in place**

Change (line ~1340):

```ts
    openProject: async (path) => { await setCurrentFolder(path, { replaceBuffer: true }); },
```

to:

```ts
    openProject: async (path) => {
      // Don't switch in place — let the main window route to the right window
      // (focus existing / adopt here / spawn new). See issue #100.
      void emit("viewer:switch-project-request", { folder: path, fromLabel: selfLabel });
    },
```

- [ ] **Step 2: Add an adopt listener (every window)**

Near the other per-window `listen(...)` calls in the bootstrap (e.g. just after the `viewer:window-folder`/`viewer:window-closed` block around line 918), add:

```ts
  const unsubAdoptFolder = await listen<string>("viewer:adopt-folder", (e) => {
    void setCurrentFolder(e.payload, { replaceBuffer: true });
  });
  window.addEventListener("beforeunload", () => unsubAdoptFolder());
```

- [ ] **Step 3: Add the main-window switch-project-request listener**

Immediately after the `file-open-request` listener's `window.addEventListener("beforeunload", () => unsubFileOpen());` line (~1656), add:

```ts
  const unsubSwitchProject = await listen<{ folder: string; fromLabel: string }>(
    "viewer:switch-project-request",
    async (e) => {
      if (!isMainWindow()) return;
      await routeToFolder(e.payload.folder, e.payload.fromLabel);
    },
  );
  window.addEventListener("beforeunload", () => unsubSwitchProject());
```

- [ ] **Step 4: Unify the `md <dir>` directory branch with the router**

In the `file-open-request` listener's directory branch (~1611-1631), replace the whole match/spawn body:

```ts
      const dir = await canonicalizePath(paths[0]);
      let matchedLabel: string | null = null;
      for (const [label, folder] of folderByLabel) {
        if (folder !== dir) continue;
        const w = await WebviewWindow.getByLabel(label);
        if (w) { matchedLabel = label; break; }
        folderByLabel.delete(label);
      }
      if (matchedLabel) {
        if (matchedLabel !== selfLabel) {
          const w = await WebviewWindow.getByLabel(matchedLabel);
          await w?.setFocus();
        }
      } else {
        await dispatchToFocused({ type: "openProject", path: dir });
      }
      return;
```

with:

```ts
      // Same routing as in-app Switch Project: focus existing window, adopt
      // into the (blank) main window, or spawn. See issue #100.
      await routeToFolder(paths[0], selfLabel);
      return;
```

(`routeToFolder` canonicalizes internally, so the local `dir` canonicalization is no longer needed here.)

- [ ] **Step 5: Dedupe the restore set**

In `loadAndApplySession`, the loop that spawns secondary windows iterates
`session.windows`. Change the loop source to the deduped list. Find:

```ts
  for (const entry of session.windows) {
    if (entry.label === myLabel) continue;
    if (entry.path && !(await pathExists(entry.path))) continue;
    await spawnRestoredWindow(entry);
  }
```

and change the first line to iterate the deduped set:

```ts
  for (const entry of dedupeSessionByFolder(session.windows)) {
    if (entry.label === myLabel) continue;
    if (entry.path && !(await pathExists(entry.path))) continue;
    await spawnRestoredWindow(entry);
  }
```

- [ ] **Step 6: Type-check + full unit suite**

Run: `npx tsc -b --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: all tests pass (prior count + the 9 new `project-routing` tests).

- [ ] **Step 7: Commit**

```bash
jj desc -m "Route Switch Project and md <dir> to the owning window (#100)"
jj new
```

---

## Task 7: Changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an Unreleased entry**

Under the `## [Unreleased]` heading's `### Changed` (or `### Added` if more apt) list, add a bullet matching the file's existing style:

```markdown
- Switching projects now maps one folder to one window: if a window already shows that folder it is raised and focused, a window with no folder open adopts it in place, and otherwise a new window opens for it. `md <dir>` from the shell follows the same routing. (#100)
```

- [ ] **Step 2: Commit**

```bash
jj desc -m "Add changelog entry for 1:1 folder-window mapping (#100)"
jj new
```

---

## Task 8: Manual verification & PR

**Files:** none (verification only)

- [ ] **Step 1: Build-time checks**

Run: `npx tsc -b --noEmit` → exit 0.
Run: `npm test` → all pass.

- [ ] **Step 2: Manual multi-window smoke (tauri:dev)**

Run `npm run tauri:dev` and verify:
1. Open folder A. Switch Project → folder B: a **new window** opens for B; window A's sidebar is unchanged.
2. From either window, Switch Project → folder A: window A is **raised + focused** (no new window, no replaced sidebar). Minimize A first and repeat — it unminimizes.
3. New blank window (Cmd-N), then Switch Project → folder C: the blank window **adopts** C in place (no extra window).
4. `md <dirAlreadyOpen>` from a shell focuses the owning window; `md <newDir>` spawns one.

- [ ] **Step 3: Open the PR**

Create a bookmark, push, and open a PR against `trunk` referencing #100. Per the jujutsu skill:

```bash
jj bookmark create issue-100-folder-window-mapping -r @-
jj git push -b issue-100-folder-window-mapping
gh pr create --base trunk --title "One folder maps to one window (#100)" --body "<summary; Closes #100>"
```

(The bookmark is created at `@-` because `@` is the empty working-copy commit left by the final `jj new`.)

---

## Self-Review Notes

- **Spec coverage:** decision rule → Task 1; restore dedupe → Task 2; folder spawn → Tasks 3-4; raise+focus + router → Task 5; event wiring + `md` unification → Task 6; changelog → Task 7; manual checks → Task 8. All spec sections covered.
- **Type consistency:** `ProjectRoute`, `decideProjectRoute`, `dedupeSessionByFolder`, `routeToFolder`, `raiseWindow`, `spawnNewWindow({ file?, folder? })`, `folderFromUrlQuery` used consistently across tasks.
- **No placeholders:** every code step shows full code.
```
