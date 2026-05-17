# Mobile companion — Step 3: Library + recents UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "always opens sample.md / share-sheet target" launch behavior with a **library home** that lists recently-opened files, lets the user tap one to open it, and shows an empty-state CTA when nothing is in recents. After opening a document, a back-button takes the user back to the library. This is the gate for shipping **v2.0-alpha** (Android standalone reader — sync arrives in steps 4–7).

**Architecture:** A minimal router (`library | document`) in `mobile-bootstrap.ts`. Recents are stored as `Array<{uri, displayName, lastOpenedMs}>` via `tauri-plugin-store`. Each share-sheet open and each in-app tap appends/updates the list (dedupe on URI, bound to last 20). The library view is plain HTML + minimal CSS — no framework, matches the desktop's vanilla approach. Document view stays the existing CodeMirror editor mount.

**Tech stack additions:** None. Re-uses `tauri-plugin-store` (already in deps), `@tauri-apps/plugin-fs.readTextFile`, and the deep-link wiring from step 2.

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §10 (library view wireframe). §11 step 3.

**VCS note:** This repository is a Jujutsu (`.jj/`) repo. Commits use `jj`, not raw `git`.

---

## Scope boundaries

In scope:
- Library home (recents + paired-folders section).
- Recents list persisted across launches.
- Tap-to-open from library, back-to-library from document.
- Empty state when no recents — CTA card invites pairing (currently a no-op; v2.1+ wires the actual pairing flow).
- Share-sheet flow continues to work, with the opened file added to recents.
- Android system back button: library → app closes; document → library.

Out of scope (later steps or v2.1+):
- SAF folder picker / library indexer (the "synced folders" UI surface beyond the empty CTA).
- Pairing UX itself (step 5 + 7).
- Sync / crypto (steps 4–7).
- Multi-document view, search, settings — v2.0 keeps things minimal.

---

## File structure

```
viewer/
├── src/
│   ├── mobile-bootstrap.ts                   (mod) router; library mount; document mount; back-button
│   ├── shell/
│   │   ├── mobile-recents.ts                 (NEW) persisted recents store helper
│   │   └── store.ts                          (used) underlying tauri-plugin-store
│   ├── ui/
│   │   └── mobile-library.ts                 (NEW) renders the library home
│   ├── styles-mobile.css                     (NEW) mobile-only styles (library list, layout)
│   └── i18n/strings.ts                       (mod) new mobile keys (library.title, library.empty, etc.)
├── tests/
│   └── shell/
│       └── mobile-recents.test.ts            (NEW) unit tests for the recents store (mocked store)
├── docs/images/
│   └── android-step3-library.png             (NEW) smoke screenshot for the PR
├── CLAUDE.md                                 (mod) note the router + recents
└── ROADMAP.md                                (mod) flip step 3 → ✅
```

---

## Task 1: i18n keys

**Files:**
- Modify: `src/i18n/strings.ts`

- [ ] **Step 1: Mobile keys**

Add to the `EN` object (near the end, before the closing `} as const`):

```ts
// Mobile companion (v2.0)
"mobile.library.title": "Märklig",
"mobile.library.recents": "Recent files",
"mobile.library.empty": "Open a Markdown file from the share sheet or pair with a desktop to see it here.",
"mobile.library.pair_cta": "Pair with a desktop",
"mobile.library.pair_unavailable": "Pairing arrives in v2.1.",
"mobile.library.back": "Back to library",
```

If a Swedish locale file exists alongside `EN`, mirror the keys. (Currently the codebase is EN-only per Sub-spec F's i18n foundation.)

**Commit:** `jj desc -m "Add mobile library i18n keys"`, then `jj new`.

---

## Task 2: Recents store helper

**Files:**
- Create: `src/shell/mobile-recents.ts`

- [ ] **Step 1: API**

```ts
import { getValue, setValue } from "./store";

export interface MobileRecent {
  uri: string;
  displayName: string;
  lastOpenedMs: number;
}

const KEY = "mobile.recents";
const MAX = 20;

export async function loadRecents(): Promise<MobileRecent[]> {
  const raw = (await getValue<MobileRecent[]>(KEY)) ?? [];
  return Array.isArray(raw) ? raw : [];
}

export async function recordRecent(entry: Omit<MobileRecent, "lastOpenedMs">): Promise<void> {
  const list = await loadRecents();
  const filtered = list.filter((r) => r.uri !== entry.uri);
  const next: MobileRecent = { ...entry, lastOpenedMs: Date.now() };
  const out = [next, ...filtered].slice(0, MAX);
  await setValue(KEY, out);
}

export async function clearRecents(): Promise<void> {
  await setValue(KEY, []);
}
```

`displayName` is what we show in the list — for content URIs, derive it from the URI's last segment after URL-decoding (Tauri's plugin-fs gives us no metadata API for this; the URI's `_display_name` query param or the URL-decoded last path segment is the pragmatic fallback).

- [ ] **Step 2: Display-name derivation**

Add a helper:

```ts
export function uriDisplayName(uri: string): string {
  // content://... URIs often carry the filename in their last segment
  // after a decode. file://... URIs are paths. Fall back to the raw URI.
  try {
    const decoded = decodeURIComponent(uri);
    const lastSlash = decoded.lastIndexOf("/");
    if (lastSlash >= 0 && lastSlash < decoded.length - 1) {
      return decoded.slice(lastSlash + 1);
    }
    return decoded;
  } catch {
    return uri;
  }
}
```

**Commit:** `jj desc -m "Add mobile recents store helper"`, then `jj new`.

---

## Task 3: Mobile library view component

**Files:**
- Create: `src/ui/mobile-library.ts`

- [ ] **Step 1: Render**

```ts
import { t } from "../i18n/strings";
import type { MobileRecent } from "../shell/mobile-recents";

export interface MobileLibraryHandlers {
  onOpenRecent: (uri: string) => void;
  onPairTap: () => void;
}

export function mountMobileLibrary(
  root: HTMLElement,
  recents: MobileRecent[],
  handlers: MobileLibraryHandlers,
): void {
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mobile-library";

  const title = document.createElement("h1");
  title.className = "mobile-library__title";
  title.textContent = t("mobile.library.title");
  wrap.appendChild(title);

  if (recents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "mobile-library__empty";
    empty.textContent = t("mobile.library.empty");
    wrap.appendChild(empty);

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "mobile-library__pair-cta";
    cta.textContent = t("mobile.library.pair_cta");
    cta.onclick = () => handlers.onPairTap();
    wrap.appendChild(cta);
  } else {
    const h2 = document.createElement("h2");
    h2.className = "mobile-library__section";
    h2.textContent = t("mobile.library.recents");
    wrap.appendChild(h2);

    const list = document.createElement("ul");
    list.className = "mobile-library__list";
    for (const r of recents) {
      const li = document.createElement("li");
      li.className = "mobile-library__item";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mobile-library__item-btn";
      btn.onclick = () => handlers.onOpenRecent(r.uri);
      const name = document.createElement("span");
      name.className = "mobile-library__item-name";
      name.textContent = r.displayName;
      const when = document.createElement("span");
      when.className = "mobile-library__item-when";
      when.textContent = formatRelative(r.lastOpenedMs);
      btn.appendChild(name);
      btn.appendChild(when);
      li.appendChild(btn);
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  root.appendChild(wrap);
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

The pair CTA is a placeholder — it just shows a transient note ("pairing arrives in v2.1"). Step 5+ replaces this with the real pairing modal.

**Commit:** `jj desc -m "Add mobile library view"`, then `jj new`.

---

## Task 4: Mobile styles

**Files:**
- Create: `src/styles-mobile.css`
- Modify: `index.html` (import the stylesheet lazily, or inline-import from mobile-bootstrap.ts)

- [ ] **Step 1: Stylesheet**

Match the desktop typography vibe — generous spacing, restrained palette. Keep it simple:

```css
.mobile-library {
  padding: 24px 20px 32px;
  max-width: 720px;
  margin: 0 auto;
}
.mobile-library__title { font-size: 2rem; margin: 0 0 12px; }
.mobile-library__section { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin: 24px 0 8px; }
.mobile-library__list { list-style: none; padding: 0; margin: 0; }
.mobile-library__item { margin: 0; }
.mobile-library__item-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  width: 100%; padding: 14px 12px; background: transparent; border: 0;
  text-align: left; cursor: pointer; color: inherit;
  border-bottom: 1px solid var(--border-subtle, rgba(127,127,127,0.18));
}
.mobile-library__item-btn:active { background: rgba(127,127,127,0.08); }
.mobile-library__item-name { font-size: 1rem; }
.mobile-library__item-when { font-size: 0.8rem; opacity: 0.6; }
.mobile-library__empty { opacity: 0.7; line-height: 1.5; margin: 16px 0; }
.mobile-library__pair-cta {
  display: inline-block; margin-top: 8px; padding: 12px 16px;
  background: var(--accent, #4f6df0); color: white;
  border: 0; border-radius: 8px; font-size: 1rem; cursor: pointer;
}

.mobile-document {
  /* Editor mount uses the rest of the screen. */
}
.mobile-document__back {
  position: sticky; top: 0; left: 0; z-index: 10;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px;
  background: var(--bg, white); color: inherit;
  border: 0; border-bottom: 1px solid var(--border-subtle, rgba(127,127,127,0.18));
  font-size: 0.9rem; cursor: pointer; width: 100%;
}
```

- [ ] **Step 2: Import**

In `src/mobile-bootstrap.ts`, near other CSS imports:

```ts
import "./styles-mobile.css";
```

Vite will inline at build time.

**Commit:** `jj desc -m "Add mobile-only stylesheet (library + back button)"`, then `jj new`.

---

## Task 5: Wire the router in mobile-bootstrap

**Files:**
- Modify: `src/mobile-bootstrap.ts`

- [ ] **Step 1: Router state**

Refactor `mobileBootstrap` to:

1. Read recents.
2. If a deep-link arrived at cold-launch, jump straight to document view rendering that URI (don't show the library first).
3. Otherwise, if recents is non-empty, show the library.
4. Otherwise, show the bundled `sample.md` directly as before (so first-launch users still see something rendered, not just an empty library — they need to know the app works).

Sketch:

```ts
type Route =
  | { kind: "library" }
  | { kind: "document"; source: string; uriForRecents?: string };

let currentRoute: Route;
let currentView: EditorView | null = null;

async function renderRoute(route: Route): Promise<void> {
  currentRoute = route;
  if (currentView) { currentView.destroy(); currentView = null; }
  root.innerHTML = "";

  if (route.kind === "library") {
    const recents = await loadRecents();
    mountMobileLibrary(root, recents, {
      onOpenRecent: async (uri) => {
        try {
          const source = await readTextFile(uri);
          await recordRecent({ uri, displayName: uriDisplayName(uri) });
          await renderRoute({ kind: "document", source, uriForRecents: uri });
        } catch (err) {
          console.error("failed to reopen recent", uri, err);
        }
      },
      onPairTap: () => {
        const note = document.createElement("p");
        note.className = "mobile-library__pair-unavailable";
        note.textContent = t("mobile.library.pair_unavailable");
        root.appendChild(note);
      },
    });
  } else {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mobile-document__back";
    backBtn.textContent = "← " + t("mobile.library.back");
    backBtn.onclick = () => void renderRoute({ kind: "library" });
    root.appendChild(backBtn);

    const editorMount = document.createElement("div");
    root.appendChild(editorMount);
    currentView = createReadingEditorIn(editorMount, route.source);
    if (route.uriForRecents) {
      await recordRecent({ uri: route.uriForRecents, displayName: uriDisplayName(route.uriForRecents) });
    }
  }
}
```

Where `createReadingEditorIn(parent, source)` is the existing EditorView setup, factored out so we can re-create it on each route change.

- [ ] **Step 2: Initial route selection**

```ts
const initial = await getCurrentDeepLinkUrls();
if (initial && initial.length > 0) {
  const source = await readTextFile(initial[0]);
  await renderRoute({ kind: "document", source, uriForRecents: initial[0] });
} else {
  const recents = await loadRecents();
  if (recents.length === 0) {
    await renderRoute({ kind: "document", source: sampleSource });
  } else {
    await renderRoute({ kind: "library" });
  }
}
```

- [ ] **Step 3: Warm-launch path**

```ts
await onOpenUrl(async (urls) => {
  if (urls.length === 0) return;
  try {
    const source = await readTextFile(urls[0]);
    await renderRoute({ kind: "document", source, uriForRecents: urls[0] });
  } catch (err) {
    console.error("failed to open URI", urls[0], err);
  }
});
```

- [ ] **Step 4: Android back-button hook**

```ts
window.addEventListener("popstate", () => {
  if (currentRoute.kind === "document") {
    void renderRoute({ kind: "library" });
  }
});
// Push a state on each route change so back-button has something to pop.
// In renderRoute: if route.kind === "document", history.pushState({}, "");
```

Alternative if `popstate` doesn't fire reliably on Tauri's Android WebView: handle the system back in Kotlin via `OnBackPressedCallback` and forward to a Tauri event.

**Commit:** `jj desc -m "Wire mobile router with library / document routes"`, then `jj new`.

---

## Task 6: Unit tests for recents

**Files:**
- Create: `tests/shell/mobile-recents.test.ts`

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the underlying store
vi.mock("../../src/shell/store", () => {
  let state: Record<string, unknown> = {};
  return {
    getValue: vi.fn(async (k: string) => state[k]),
    setValue: vi.fn(async (k: string, v: unknown) => { state[k] = v; }),
    __reset: () => { state = {}; },
  };
});

import { loadRecents, recordRecent, clearRecents, uriDisplayName } from "../../src/shell/mobile-recents";
import * as store from "../../src/shell/store";

describe("mobile-recents", () => {
  beforeEach(() => {
    (store as unknown as { __reset: () => void }).__reset();
  });

  it("starts empty", async () => {
    expect(await loadRecents()).toEqual([]);
  });

  it("records and reads back", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    const list = await loadRecents();
    expect(list).toHaveLength(1);
    expect(list[0].uri).toBe("content://a");
    expect(list[0].displayName).toBe("a.md");
  });

  it("dedupes by URI, freshest first", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    await recordRecent({ uri: "content://b", displayName: "b.md" });
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    const list = await loadRecents();
    expect(list.map((r) => r.uri)).toEqual(["content://a", "content://b"]);
  });

  it("caps at MAX entries", async () => {
    for (let i = 0; i < 30; i++) {
      await recordRecent({ uri: `content://${i}`, displayName: `${i}.md` });
    }
    const list = await loadRecents();
    expect(list).toHaveLength(20);
    expect(list[0].uri).toBe("content://29");
  });

  it("clears", async () => {
    await recordRecent({ uri: "content://a", displayName: "a.md" });
    await clearRecents();
    expect(await loadRecents()).toEqual([]);
  });
});

describe("uriDisplayName", () => {
  it("extracts filename from a content URI with encoded filename", () => {
    expect(uriDisplayName("content://media/external/file/123/My%20Doc.md")).toBe("My Doc.md");
  });
  it("extracts filename from a file URI", () => {
    expect(uriDisplayName("file:///sdcard/Download/foo.md")).toBe("foo.md");
  });
  it("falls back to the raw URI when no slash", () => {
    expect(uriDisplayName("opaque")).toBe("opaque");
  });
});
```

**Commit:** `jj desc -m "Unit tests for mobile recents helper"`, then `jj new`.

---

## Task 7: Smoke on device

**Files:** none (verification)

- [ ] **Step 1: First-launch behavior**

Force-stop the app, clear app data:
```bash
adb shell am force-stop se.karleklund.marklig
adb shell pm clear se.karleklund.marklig
```
Launch from launcher. Expected: bundled `sample.md` renders (no library) — verifies the empty-recents fallback.

- [ ] **Step 2: Open via share sheet — recents populates**

```bash
adb shell am start -n se.karleklund.marklig/.MainActivity \
  -a android.intent.action.VIEW \
  -d content://media/external/file/<id> \
  -t text/markdown --grant-read-uri-permission
```

Document renders. Tap the back button. Expected: library home with one entry corresponding to the just-opened file.

- [ ] **Step 3: Tap-to-reopen**

Tap the entry. Expected: document re-renders.

- [ ] **Step 4: Persistence**

Force-stop, relaunch. Expected: library shows the entry (NOT the sample). Step 1's empty-recents fallback should no longer fire.

- [ ] **Step 5: Capture artifacts**

```bash
adb exec-out screencap -p > docs/images/android-step3-library.png
```

Attach to the PR.

**Commit:** None for verification — fixes land as their own commits.

---

## Task 8: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: CLAUDE.md note**

Append to the "Mobile target" section:

```markdown
Mobile bootstrap has a tiny router (`library` / `document`). Recents
persist via `tauri-plugin-store` (`src/shell/mobile-recents.ts`). The
library view is plain DOM (`src/ui/mobile-library.ts`) with
mobile-only CSS in `src/styles-mobile.css`. The Android system back
button is wired via `popstate`.
```

- [ ] **Step 2: ROADMAP step 3 → ✅**

**Commit:** `jj desc -m "Document mobile router + recents store"`, then `jj new`.

---

## Final checks

- [ ] All steps committed on `issue-70-mobile-step3` stacked on step-2.
- [ ] Desktop build untouched (`cargo check`, `tsc -b --noEmit`).
- [ ] `npm test` — new tests pass; existing don't regress.
- [ ] On-device smoke (tasks 7.1–7.4) passes.
- [ ] PR opened against `trunk` (or stacked on step-2's PR).

## What this plan does NOT deliver

- SAF folder picker / paired-folder enumeration (step 5+).
- Pairing modal (step 5+).
- Sync (steps 4–7).
- iOS.
- Settings UI on phone (deferred — v2.0 keeps it minimal).
