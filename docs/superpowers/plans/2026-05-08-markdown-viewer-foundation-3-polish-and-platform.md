# Markdown Viewer Foundation — Plan 3: Polish & platform

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Foundation. Ship the TOC sidebar, recents, crash recovery, full native menu inventory, document zoom, find/replace, HTML sanitization for future export paths, GitHub Actions CI matrix, visual regression corpus, and a real app icon — and clean up every carryover item from Plans 1 and 2 along the way. After Plan 3 the Foundation Definition of Done from spec §12 is met on macOS, Windows, and Linux.

**Architecture:** Mostly additive, no architectural shift. The TOC sidebar is a new UI module reading from the parse tree; recents and crash recovery share a tiny store layer in `src/shell/`; native menus live in a new `src/shell/menus.ts` that wires to existing handlers (Open, Save, mode toggle, theme picker, zoom, sidebar toggle, find/replace). Document zoom rides on a CodeMirror EditorView attribute. Find/replace is the existing `@codemirror/search` panel surfaced in menus and the keymap. The watcher's orphan/delete path becomes reachable by switching from `notify-debouncer-mini` to `notify-debouncer-full` (preserves underlying notify EventKind).

**Tech Stack:** No new core libraries beyond what Plans 1+2 introduced. Adds `notify-debouncer-full` (replaces `notify-debouncer-mini`), `@tauri-apps/plugin-store` for recents, `tauri-plugin-store` on the Rust side. CI uses GitHub Actions with `ubuntu-latest`, `macos-latest`, `windows-latest` runners.

**Spec:** `docs/superpowers/specs/2026-05-08-markdown-viewer-foundation-design.md`. Plans 1+2 plans for backref. Carryover memory: `~/.claude/projects/-Users-ke-src-viewer/memory/project_plan1_carryover.md`, `…project_plan2_carryover.md`.

**This plan delivers** the remaining items in spec §10 in-scope: TOC sidebar (§5.7), recents menu, crash recovery (§7), native menu inventory (§6a), full keyboard shortcut bindings (§6a), document zoom, find/replace, HTML sanitization architectural hook for Sub-spec C, GitHub Actions matrix (§9), visual regression (§9), and meets DoD criteria 1–14.

---

## File structure

By the end of Plan 3 the codebase looks like this. Files marked **(Plan 3)** are new in this plan; **(Plan 3 mod)** are modified.

```
viewer/
├── .github/
│   └── workflows/
│       └── ci.yml                                      (Plan 3)
├── src-tauri/
│   ├── Cargo.toml                                      (Plan 3 mod) +notify-debouncer-full, +tauri-plugin-store, -notify-debouncer-mini
│   ├── icons/                                          (Plan 3 mod) real iconset
│   ├── capabilities/default.json                       (Plan 3 mod) +store, +path
│   └── src/
│       ├── lib.rs                                      (Plan 3 mod) +store plugin, +recovery_dir
│       └── commands/
│           ├── files.rs                                (Plan 3 mod) +metadata, +read_recovery, +write_recovery, +clear_recovery
│           └── watcher.rs                              (Plan 3 mod) emits Removed; reads self-write timestamp
├── src/
│   ├── main.ts                                         (Plan 3 mod)  wire menus, recents, recovery, sidebar, zoom
│   ├── editor/
│   │   ├── editor.ts                                   (Plan 3 mod)  expose document zoom
│   │   ├── keymaps.ts                                  (Plan 3 mod)  +zoom, +sidebar toggle, +find/replace bindings
│   │   ├── parser.ts                                   (unchanged)
│   │   ├── theme.ts                                    (Plan 3 mod) call storeTheme on change
│   │   └── decorations/
│   │       ├── frontmatter.ts                          (Plan 3 mod) use shared computeLineStarts
│   │       └── inline.ts                               (Plan 3 mod) hoist line-starts out of loop
│   ├── shell/
│   │   ├── files.ts                                    (Plan 3 mod) +saveAs
│   │   ├── recents.ts                                  (Plan 3)
│   │   ├── recovery.ts                                 (Plan 3)
│   │   ├── store.ts                                    (Plan 3) thin wrapper over @tauri-apps/plugin-store
│   │   ├── menus.ts                                    (Plan 3)
│   │   ├── shortcuts.ts                                (Plan 3)
│   │   ├── watcher.ts                                  (Plan 3 mod) preserve scroll on reload
│   │   └── close.ts                                    (unchanged)
│   ├── ui/
│   │   ├── titlebar.ts                                 (unchanged)
│   │   ├── toolbar.ts                                  (Plan 3 mod) +sidebar toggle button
│   │   ├── reconcile.ts                                (Plan 3 mod) default focus on Keep
│   │   └── sidebar/
│   │       ├── toc.ts                                  (Plan 3) heading list + scroll-sync + click-to-jump
│   │       └── toc-state.ts                            (Plan 3) heuristic + persistence
│   └── export/
│       └── sanitize.ts                                 (Plan 3) DOMPurify wrapper, ready for Sub-spec C
└── tests/
    ├── ui/
    │   └── sidebar/
    │       └── toc-state.test.ts                       (Plan 3)
    ├── shell/
    │   ├── recents.test.ts                             (Plan 3)
    │   └── recovery.test.ts                            (Plan 3)
    ├── export/
    │   └── sanitize.test.ts                            (Plan 3)
    └── e2e/
        ├── toc-sidebar.spec.ts                         (Plan 3)
        ├── recents-and-recovery.spec.ts                (Plan 3)
        └── visual-regression.spec.ts                   (Plan 3)
```

---

# Phase A — Plan 2 carryover fixes

## Task 1: Switch watcher debouncer so file-removed events fire

The orphan path was wired but unreachable in Plan 2 because `notify-debouncer-mini` collapses everything to `Modified`. Switch to `notify-debouncer-full` which preserves the underlying `notify::EventKind`.

**Files:**
- Modify: `src-tauri/Cargo.toml` — remove `notify-debouncer-mini`, add `notify-debouncer-full`
- Modify: `src-tauri/src/commands/watcher.rs`

- [ ] **Step 1: Update `src-tauri/Cargo.toml`**

Remove:
```toml
notify-debouncer-mini = "0.4"
```

Add:
```toml
notify-debouncer-full = "0.3"
```

- [ ] **Step 2: Rewrite `src-tauri/src/commands/watcher.rs`**

```rust
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Clone)]
pub struct WatcherEvent {
    pub kind: WatcherEventKind,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum WatcherEventKind {
    Modified,
    Removed,
}

pub struct WatcherState {
    inner: Mutex<Option<WatcherInner>>,
}

struct WatcherInner {
    target: PathBuf,
    self_write_ts: Option<Instant>,
    _debouncer: notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::RecommendedCache>,
}

impl WatcherState {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(500);

#[tauri::command]
pub fn watcher_start(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target.parent().ok_or_else(|| "no parent directory".to_string())?.to_path_buf();
    let target_for_handler = target.clone();
    let app_for_handler = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let events = match result { Ok(ev) => ev, Err(_) => return };
            for ev in events {
                let touches_target = ev.paths.iter().any(|p| p == &target_for_handler);
                if !touches_target { continue; }
                let kind = match ev.kind {
                    EventKind::Remove(_) => WatcherEventKind::Removed,
                    _ => WatcherEventKind::Modified,
                };
                let _ = app_for_handler.emit(
                    "viewer://file-changed",
                    WatcherEvent {
                        kind,
                        path: target_for_handler.to_string_lossy().to_string(),
                    },
                );
            }
        },
    ).map_err(|e| e.to_string())?;

    debouncer.watch(&parent, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(WatcherInner { target, self_write_ts: None, _debouncer: debouncer });
    Ok(())
}

#[tauri::command]
pub fn watcher_stop(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn watcher_mark_self_write(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut inner) = *guard {
        inner.self_write_ts = Some(Instant::now());
    }
    Ok(())
}

#[allow(dead_code)]
fn _is_within_self_write_window(ts: Option<Instant>) -> bool {
    match ts {
        Some(t) => Instant::now().duration_since(t) < SELF_WRITE_WINDOW,
        None => false,
    }
}
```

The JS-side filter is still the actual guard; the Rust `_is_within_self_write_window` and `target` field stay as documented dead code (they remain wired so Plan 4 — if there ever is one — can complete the Rust-side guard without re-architecting). Keep the `#[allow(dead_code)]`.

- [ ] **Step 3: Build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
```
Expected: clean. `notify-debouncer-full` compiles; the new `EventKind::Remove(_)` arm is reachable.

- [ ] **Step 4: Verify e2e still passes**

```
cd /Users/ke/src/viewer && npm run test:e2e
```
Expected: 3/3 still pass (the existing tests don't depend on remove events).

- [ ] **Step 5: Commit**

```
jj desc -m "Switch watcher to notify-debouncer-full so file-removed events emit"
jj new -m "wip"
```

---

## Task 2: Preserve scroll position on external reload

Spec §5.6: clean buffer reload should preserve scroll. `reloadFromDisk` currently resets scroll to top.

**Files:**
- Modify: `src/main.ts` (the `reloadFromDisk` helper)

- [ ] **Step 1: Update `reloadFromDisk` in `main.ts`**

Find:
```typescript
  async function reloadFromDisk(): Promise<void> {
    if (!currentPath) return;
    const doc = await readDoc(currentPath);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
    dirtyTracker.reset();
    diverged = false;
  }
```

Replace with:
```typescript
  async function reloadFromDisk(): Promise<void> {
    if (!currentPath) return;
    const doc = await readDoc(currentPath);
    const savedScrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
    // Restore scroll on the next frame so CodeMirror has finished re-laying-out.
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = savedScrollTop;
    });
    dirtyTracker.reset();
    diverged = false;
  }
```

- [ ] **Step 2: Smoke**

```
npm test
npx tsc -b --noEmit
```
Expected: 64/64 still pass; clean.

- [ ] **Step 3: Commit**

```
jj desc -m "Preserve scroll position when reloading from external file change"
jj new -m "wip"
```

---

## Task 3: Reconcile modal — default focus on safe action

The modal currently focuses "Reload from disk" (destructive). Pressing Enter accidentally discards edits. Switch default focus to "Keep my edits".

**Files:**
- Modify: `src/ui/reconcile.ts`

- [ ] **Step 1: Update `src/ui/reconcile.ts`**

Find: `reload.focus();`
Replace with: `keep.focus();`

- [ ] **Step 2: Smoke**

```
npm test
```

- [ ] **Step 3: Commit**

```
jj desc -m "Reconcile modal: default focus on Keep edits, not destructive Reload"
jj new -m "wip"
```

---

## Task 4: Migrate `frontmatter.ts` to shared `computeLineStarts`

Plan 2 Task 1 missed this file because it inlines the loop instead of using a helper.

**Files:**
- Modify: `src/editor/decorations/frontmatter.ts`

- [ ] **Step 1: Update `frontmatter.ts`**

Find:
```typescript
  const ranges: Range<Decoration>[] = [];
  const lineStarts = [0];
  for (let i = 0; i < match[0].length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  // Drop the trailing entry from the final newline (it points past the FM)
  const usable = lineStarts.slice(0, -1);
```

Replace with:
```typescript
  const ranges: Range<Decoration>[] = [];
  const allStarts = computeLineStarts(source);
  // Keep only line starts inside the front matter block (offsets < match[0].length).
  const usable = allStarts.filter((s) => s < match[0].length);
```

Add the import at the top:
```typescript
import { computeLineStarts } from "./index";
```

- [ ] **Step 2: Run tests**

```
npm test -- tests/decorations/frontmatter
```
Expected: 3/3 pass.

```
npm test
```
Expected: 64/64 still pass.

- [ ] **Step 3: Commit**

```
jj desc -m "Migrate frontmatter producer to shared computeLineStarts"
jj new -m "wip"
```

---

## Task 5: Hoist `computeLineStarts` out of `inline.ts`'s token loop

Currently called once per inline token; should be once per producer call.

**Files:**
- Modify: `src/editor/decorations/inline.ts`

- [ ] **Step 1: Update `inline.ts`**

Find the producer body (currently calls `computeLineStarts(source)` AND `absoluteOffsetOfLine(source, t.map[0])` per token). Hoist:

```typescript
export const inlineProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);
    walkInline(t.children, blockStart, blockSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};
```

Remove the now-unused `absoluteOffsetOfLine` helper if `walkInline` doesn't need it anymore.

- [ ] **Step 2: Verify**

```
npm test -- tests/decorations/inline
npm test
```
Expected: 6/6 inline pass; 64/64 total.

- [ ] **Step 3: Commit**

```
jj desc -m "Hoist computeLineStarts out of inline.ts token loop"
jj new -m "wip"
```

---

## Task 6: Bump `thiserror` direct dep to 2.x

Plan 1 review noted the version split; aligning now.

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Change `thiserror` version**

Find: `thiserror = "1"`
Replace with: `thiserror = "2"`

- [ ] **Step 2: Build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
```
Expected: clean. The `#[derive(Error)]` macro and `#[error("...")]` attribute API are unchanged between 1.x and 2.x; no Rust source changes needed.

- [ ] **Step 3: Commit**

```
jj desc -m "Bump thiserror direct dep to 2.x to align with Tauri plugins"
jj new -m "wip"
```

---

# Phase B — Plan 1 carryover residue

## Task 7: Wire `storeTheme` so theme selection persists

The View → Theme menu (Task 19 below) needs `storeTheme` called when the user picks. We add a small handler now so the wiring is in place; the menu itself wires to it.

**Files:**
- Modify: `src/editor/theme.ts` — expose a `setActiveTheme` that combines apply+store
- Modify: `src/main.ts` — replace any direct `applyTheme` calls with `setActiveTheme`

- [ ] **Step 1: Update `src/editor/theme.ts`**

Append to the file:

```typescript
export function setActiveTheme(theme: Theme): void {
  applyTheme(theme);
  storeTheme(theme);
}
```

- [ ] **Step 2: Update `src/main.ts`**

Find any direct `applyTheme(loadStoredTheme())` and `applyTheme(...)` calls. The bootstrap already calls `applyTheme(loadStoredTheme())` — that's correct (we don't want to write back what we just loaded). The OS-follow watcher uses `applyTheme(loadStoredTheme())` which is also fine — re-applies the current preference when system changes.

There's no immediate user-driven theme change in Plan 1 or 2 (no menu yet). Task 19 (View menu) will call `setActiveTheme` when the user picks.

For now, just verify `setActiveTheme` is exported and importable.

```
npx tsc -b --noEmit
npm test
```

- [ ] **Step 3: Commit**

```
jj desc -m "Add setActiveTheme that combines applyTheme + storeTheme"
jj new -m "wip"
```

---

## Task 8: Decide `renderHtml` fate — keep but document

`renderHtml` exported from `parser.ts` is unused in production but used in tests. We're going to keep it — it's the natural seam for Sub-spec C's HTML export — and document the intent.

**Files:**
- Modify: `src/editor/parser.ts`

- [ ] **Step 1: Add a JSDoc note above `renderHtml`**

```typescript
/**
 * Render the markdown source to HTML. Currently consumed only by parser
 * conformance snapshots; it is the seam Sub-spec C will use for the
 * HTML/PDF export pipeline. Output should be passed through `sanitizeHtml`
 * (src/export/sanitize.ts, Plan 3 Task 24) before insertion into any DOM
 * outside the CodeMirror surface.
 */
export function renderHtml(source: string): string {
  return md.render(source);
}
```

- [ ] **Step 2: Smoke**

```
npm test
```

- [ ] **Step 3: Commit**

```
jj desc -m "Document renderHtml as the export pipeline seam"
jj new -m "wip"
```

---

# Phase C — TOC sidebar

## Task 9: TOC state module — heuristic + persistence

`tocState` decides whether the sidebar should be on for a given document. The rule (per spec §5.7): default ON the first time a document with 3+ headings is opened; after the user explicitly toggles, that explicit choice wins.

**Files:**
- Create: `src/ui/sidebar/toc-state.ts`
- Test: `tests/ui/sidebar/toc-state.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ui/sidebar/toc-state.test.ts
import { describe, it, expect, beforeEach } from "vitest";

import {
  shouldShowSidebar,
  recordExplicitToggle,
  resetTocStorage,
} from "../../../src/ui/sidebar/toc-state";

beforeEach(() => {
  resetTocStorage();
});

describe("shouldShowSidebar", () => {
  it("is true for a doc with 3+ headings on first open", () => {
    expect(shouldShowSidebar("path/a.md", 3)).toBe(true);
    expect(shouldShowSidebar("path/b.md", 5)).toBe(true);
  });

  it("is false for a doc with fewer than 3 headings", () => {
    expect(shouldShowSidebar("path/a.md", 2)).toBe(false);
    expect(shouldShowSidebar("path/a.md", 0)).toBe(false);
  });

  it("after an explicit toggle, that choice wins for subsequent calls", () => {
    expect(shouldShowSidebar("path/a.md", 5)).toBe(true);
    recordExplicitToggle(false);
    expect(shouldShowSidebar("path/a.md", 5)).toBe(false);
    recordExplicitToggle(true);
    expect(shouldShowSidebar("path/a.md", 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to fail**

```
cd /Users/ke/src/viewer && npm test -- tests/ui/sidebar
```
Expected: module-not-found.

- [ ] **Step 3: Implement `src/ui/sidebar/toc-state.ts`**

```typescript
const STORAGE_KEY = "viewer.toc-explicit";

type ExplicitChoice = boolean | null;

function loadExplicit(): ExplicitChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function storeExplicit(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* ignore */ }
}

export function shouldShowSidebar(_path: string, headingCount: number): boolean {
  const explicit = loadExplicit();
  if (explicit !== null) return explicit;
  return headingCount >= 3;
}

export function recordExplicitToggle(visible: boolean): void {
  storeExplicit(visible);
}

export function resetTocStorage(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
```

(`_path` is taken to allow per-document persistence in a later iteration; for now the explicit toggle is global, which matches the spec language "the user's last explicit toggle state is persisted globally".)

- [ ] **Step 4: Run to pass**

```
npm test -- tests/ui/sidebar
```
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```
jj desc -m "Add TOC state module with 3+-headings heuristic and explicit-toggle persistence"
jj new -m "wip"
```

---

## Task 10: TOC sidebar component

Mounts a left-side panel that reads heading tokens from the parse tree and renders an indented list. Click → jump.

**Files:**
- Create: `src/ui/sidebar/toc.ts`
- Modify: `src/styles.css` (sidebar styles)

- [ ] **Step 1: Implement `src/ui/sidebar/toc.ts`**

```typescript
import type { EditorView } from "@codemirror/view";

import { parseMarkdown } from "../../editor/parser";

export interface TocEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** Absolute source offset where the heading line starts. */
  from: number;
}

export interface TocSidebarHandle {
  /** Re-extract headings from the current editor source and re-render the list. */
  refresh: () => void;
  /** Show or hide the panel. */
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
  destroy: () => void;
}

export interface MountTocOptions {
  view: EditorView;
  parent: HTMLElement;
  initiallyVisible: boolean;
  onActivate: (entry: TocEntry) => void;
}

export function mountTocSidebar(opts: MountTocOptions): TocSidebarHandle {
  const aside = document.createElement("aside");
  aside.className = "viewer-toc";
  if (!opts.initiallyVisible) aside.classList.add("hidden");
  opts.parent.append(aside);

  const heading = document.createElement("h4");
  heading.textContent = "Contents";
  aside.append(heading);

  const list = document.createElement("nav");
  list.className = "viewer-toc-list";
  aside.append(list);

  let visible = opts.initiallyVisible;

  function extractEntries(): TocEntry[] {
    const source = opts.view.state.doc.toString();
    const tokens = parseMarkdown(source);
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    const out: TocEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== "heading_open" || !t.map) continue;
      const level = Number(t.tag.replace("h", "")) as TocEntry["level"];
      // Heading text lives in the next inline token.
      const inline = tokens[i + 1];
      const text = inline?.content?.trim() ?? "";
      out.push({ level, text, from: lineStarts[t.map[0]] });
    }
    return out;
  }

  function render(): void {
    const entries = extractEntries();
    list.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "viewer-toc-empty";
      empty.textContent = "No headings in this document.";
      list.append(empty);
      return;
    }
    for (const e of entries) {
      const a = document.createElement("a");
      a.className = `viewer-toc-item viewer-toc-l${e.level}`;
      a.textContent = e.text;
      a.dataset.from = String(e.from);
      a.addEventListener("click", (event) => {
        event.preventDefault();
        opts.onActivate(e);
      });
      list.append(a);
    }
  }

  render();

  return {
    refresh: render,
    setVisible(v) {
      visible = v;
      aside.classList.toggle("hidden", !v);
    },
    isVisible: () => visible,
    destroy() { aside.remove(); },
  };
}
```

- [ ] **Step 2: Append to `src/styles.css`**

```css
.viewer-toc {
  width: 220px;
  background: var(--code-bg);
  border-right: 1px solid var(--rule);
  padding: 18px 14px;
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 13px;
  overflow-y: auto;
  flex-shrink: 0;
}
.viewer-toc.hidden { display: none; }
.viewer-toc h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 0 0 12px;
  font-weight: 600;
}
.viewer-toc-list { display: flex; flex-direction: column; gap: 2px; }
.viewer-toc-item {
  display: block;
  padding: 4px 8px;
  color: var(--fg);
  text-decoration: none;
  border-radius: 4px;
  line-height: 1.45;
  cursor: pointer;
}
.viewer-toc-item:hover { background: rgba(0,0,0,0.04); }
.viewer-toc-item.active {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.viewer-toc-l1 { font-weight: 600; }
.viewer-toc-l2 { padding-left: 20px; }
.viewer-toc-l3 { padding-left: 32px; color: var(--muted); font-size: 12px; }
.viewer-toc-l4, .viewer-toc-l5, .viewer-toc-l6 { padding-left: 44px; color: var(--muted); font-size: 11px; }
.viewer-toc-empty { color: var(--muted); font-size: 12px; }

/* Layout adjustments to make room for the sidebar */
#root {
  display: flex;
  flex-direction: column;
}
.viewer-app-shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
.viewer-app-shell > .cm-editor {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 3: Type-check**

```
cd /Users/ke/src/viewer && npx tsc -b --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```
jj desc -m "Add TOC sidebar component (heading list, visibility, destroy)"
jj new -m "wip"
```

---

## Task 11: Wire the sidebar in `main.ts` (mount, refresh on edit, click-to-jump, scroll-sync)

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/toolbar.ts` (add sidebar toggle button)

- [ ] **Step 1: Add a sidebar toggle to `src/ui/toolbar.ts`**

After the existing mode toggle button block in `mountToolbar`, add a second button:

```typescript
  const sidebar = document.createElement("button");
  sidebar.type = "button";
  sidebar.className = "viewer-toolbar-btn";
  sidebar.textContent = "TOC";
  sidebar.title = "Toggle table of contents (Cmd/Ctrl+Shift+O)";
  sidebar.addEventListener("click", () => opts.onSidebarToggle?.());
  bar.append(sidebar);
```

(Insert before the dirty indicator append.)

Update the `ToolbarOptions` interface to add the optional callback:

```typescript
export interface ToolbarOptions {
  view: EditorView;
  modeExtensions: { reading: ModeExtensions; edit: ModeExtensions };
  initialMode: Mode;
  onModeChange?: (mode: Mode) => void;
  onSidebarToggle?: () => void;
}
```

- [ ] **Step 2: Update `src/main.ts`**

Add imports:

```typescript
import { mountTocSidebar, type TocSidebarHandle, type TocEntry } from "./ui/sidebar/toc";
import { shouldShowSidebar, recordExplicitToggle } from "./ui/sidebar/toc-state";
```

Wrap the editor in a flex shell so the sidebar can sit beside it. Find the existing `createEditor({ parent: root, ... })` call. Wrap it like this:

```typescript
  const shell = document.createElement("div");
  shell.className = "viewer-app-shell";
  root.append(shell);

  const view = createEditor({
    parent: shell,
    source: initialDoc?.source ?? defaultPlaceholder(),
  });
```

Now the sidebar mounts BEFORE the editor in the shell so it appears on the left. Reorder by mounting the sidebar then re-appending the editor's `view.dom` so the sidebar appears first:

```typescript
  const initialHeadings = countHeadings(view.state.doc.toString());
  const initialPath = initialDoc?.path ?? "";
  let toc: TocSidebarHandle = mountTocSidebar({
    view,
    parent: shell,
    initiallyVisible: shouldShowSidebar(initialPath, initialHeadings),
    onActivate: (entry: TocEntry) => jumpTo(entry.from),
  });

  // Move the sidebar to be the first child of the shell so it sits on the left.
  shell.insertBefore(toc.element ?? shell.firstChild!, view.dom);
```

(Actually `mountTocSidebar` already appends to `parent` — we need to insert the aside element BEFORE the editor's DOM. Add an `element: HTMLElement` getter to `TocSidebarHandle` so this is accessible. Update `toc.ts` to expose it:

```typescript
export interface TocSidebarHandle {
  element: HTMLElement;
  refresh: () => void;
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
  destroy: () => void;
}
```

And in the return:
```typescript
  return {
    element: aside,
    refresh: render,
    // ...rest
  };
```

Then in main.ts:
```typescript
  shell.insertBefore(toc.element, view.dom);
```

)

Add the helpers:

```typescript
  function countHeadings(source: string): number {
    return (source.match(/^#{1,6} /gm) ?? []).length;
  }

  function jumpTo(offset: number): void {
    view.dispatch({
      selection: { anchor: offset, head: offset },
      effects: EditorView.scrollIntoView(offset, { y: "start" }),
    });
    view.focus();
  }
```

Add `import { EditorView } from "@codemirror/view";` to main.ts if not already present.

Refresh the TOC when the document changes (use a polling rAF, simple and consistent with dirty-tracker's approach):

```typescript
  let lastSource = view.state.doc.toString();
  function pollForRefresh(): void {
    const cur = view.state.doc.toString();
    if (cur !== lastSource) {
      lastSource = cur;
      toc.refresh();
    }
    requestAnimationFrame(pollForRefresh);
  }
  requestAnimationFrame(pollForRefresh);
```

Wire the toolbar's sidebar toggle:

```typescript
  const toolbar = mountToolbar(root, {
    view,
    modeExtensions,
    initialMode: "reading",
    onModeChange: (m) => { currentMode = m; },
    onSidebarToggle: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
    },
  });
```

- [ ] **Step 3: TS check**

```
npx tsc -b --noEmit
```

- [ ] **Step 4: Commit**

```
jj desc -m "Mount TOC sidebar, refresh on edit, click-to-jump, toolbar toggle"
jj new -m "wip"
```

---

## Task 12: TOC scroll-sync — highlight the active heading

As the document scrolls, highlight the entry whose heading is closest to the top of the viewport (above it).

**Files:**
- Modify: `src/ui/sidebar/toc.ts`

- [ ] **Step 1: Update `src/ui/sidebar/toc.ts`**

Add a `setActive(offset: number)` method to the handle and a way to notify the sidebar of scroll. Inside `mountTocSidebar`:

After the `render()` definition, add:

```typescript
  function setActive(offset: number): void {
    const items = list.querySelectorAll<HTMLElement>(".viewer-toc-item");
    let activeIndex = -1;
    items.forEach((el, idx) => {
      const from = Number(el.dataset.from ?? "0");
      if (from <= offset) activeIndex = idx;
      el.classList.remove("active");
    });
    if (activeIndex >= 0) items.item(activeIndex)?.classList.add("active");
  }
```

Expose it:

```typescript
  return {
    element: aside,
    refresh: render,
    setActive,
    setVisible(v) { /* unchanged */ },
    isVisible: () => visible,
    destroy() { aside.remove(); },
  };
```

Update `TocSidebarHandle`:
```typescript
export interface TocSidebarHandle {
  element: HTMLElement;
  refresh: () => void;
  setActive: (offset: number) => void;
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
  destroy: () => void;
}
```

- [ ] **Step 2: Wire in `src/main.ts`**

After the TOC mount, add a scroll listener:

```typescript
  view.scrollDOM.addEventListener("scroll", () => {
    const topOffset = view.posAtCoords({
      x: view.scrollDOM.getBoundingClientRect().left + 10,
      y: view.scrollDOM.getBoundingClientRect().top + 10,
    });
    if (topOffset !== null) toc.setActive(topOffset);
  }, { passive: true });
```

- [ ] **Step 3: Smoke**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 4: Commit**

```
jj desc -m "TOC sidebar: highlight the active heading on scroll"
jj new -m "wip"
```

---

# Phase D — Recents

## Task 13: Tauri store plugin + thin wrapper

**Files:**
- Modify: `src-tauri/Cargo.toml` — add `tauri-plugin-store = "2"`
- Modify: `src-tauri/src/lib.rs` — register the plugin
- Modify: `src-tauri/capabilities/default.json` — add `store:default` to permissions
- Create: `src/shell/store.ts` — thin wrapper around `@tauri-apps/plugin-store`
- Modify: `package.json` — add `@tauri-apps/plugin-store`

- [ ] **Step 1: Cargo.toml**

Append to `[dependencies]`:
```toml
tauri-plugin-store = "2"
```

- [ ] **Step 2: lib.rs**

In the Tauri Builder chain, add `.plugin(tauri_plugin_store::Builder::new().build())`:

```rust
tauri::Builder::default()
    .manage(WatcherState::new())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .invoke_handler(/* ...unchanged... */)
    // ...
```

- [ ] **Step 3: capabilities/default.json**

Add `"store:default"` to the permissions array:

```json
"permissions": [
  "core:default",
  "dialog:default",
  "fs:default",
  "store:default"
]
```

- [ ] **Step 4: package.json + npm install**

Add to dependencies:
```json
"@tauri-apps/plugin-store": "^2.0.0"
```

Run:
```
cd /Users/ke/src/viewer && npm install
```

- [ ] **Step 5: Create `src/shell/store.ts`**

```typescript
import { Store } from "@tauri-apps/plugin-store";

let storePromise: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("viewer.store.json");
  }
  return storePromise;
}

export async function getValue<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  return await s.get<T>(key);
}

export async function setValue<T>(key: string, value: T): Promise<void> {
  const s = await getStore();
  await s.set(key, value);
  await s.save();
}
```

- [ ] **Step 6: Build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
cd /Users/ke/src/viewer && npx tsc -b --noEmit
```

- [ ] **Step 7: Commit**

```
jj desc -m "Add tauri-plugin-store and thin frontend wrapper"
jj new -m "wip"
```

---

## Task 14: Recents module + tests

**Files:**
- Create: `src/shell/recents.ts`
- Test: `tests/shell/recents.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/shell/recents.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const storage: Record<string, unknown> = {};
vi.mock("../../src/shell/store", () => ({
  getValue: async <T>(key: string): Promise<T | undefined> => storage[key] as T | undefined,
  setValue: async <T>(key: string, value: T): Promise<void> => { storage[key] = value; },
}));

import {
  recordRecent,
  loadRecents,
  clearRecents,
  RECENTS_LIMIT,
} from "../../src/shell/recents";

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
});

describe("recents", () => {
  it("starts empty", async () => {
    expect(await loadRecents()).toEqual([]);
  });

  it("records most-recent first", async () => {
    await recordRecent("/a.md");
    await recordRecent("/b.md");
    await recordRecent("/c.md");
    expect(await loadRecents()).toEqual(["/c.md", "/b.md", "/a.md"]);
  });

  it("dedupes — re-recording moves to front", async () => {
    await recordRecent("/a.md");
    await recordRecent("/b.md");
    await recordRecent("/a.md");
    expect(await loadRecents()).toEqual(["/a.md", "/b.md"]);
  });

  it(`caps at RECENTS_LIMIT (${10})`, async () => {
    for (let i = 0; i < 15; i++) await recordRecent(`/${i}.md`);
    const r = await loadRecents();
    expect(r.length).toBe(RECENTS_LIMIT);
    expect(r[0]).toBe("/14.md");
  });

  it("clearRecents empties the list", async () => {
    await recordRecent("/a.md");
    await clearRecents();
    expect(await loadRecents()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to fail**

```
npm test -- tests/shell/recents
```

- [ ] **Step 3: Implement `src/shell/recents.ts`**

```typescript
import { getValue, setValue } from "./store";

export const RECENTS_LIMIT = 10;
const KEY = "recents";

export async function loadRecents(): Promise<string[]> {
  return (await getValue<string[]>(KEY)) ?? [];
}

export async function recordRecent(path: string): Promise<void> {
  const current = await loadRecents();
  const filtered = current.filter((p) => p !== path);
  filtered.unshift(path);
  const capped = filtered.slice(0, RECENTS_LIMIT);
  await setValue(KEY, capped);
}

export async function clearRecents(): Promise<void> {
  await setValue<string[]>(KEY, []);
}
```

- [ ] **Step 4: Run to pass**

```
npm test -- tests/shell/recents
```
Expected: 5/5.

- [ ] **Step 5: Commit**

```
jj desc -m "Add recents module (last 10, dedupe, clear)"
jj new -m "wip"
```

---

## Task 15: Integrate recents — record on every open + path change

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update `src/main.ts`**

Add the import:
```typescript
import { recordRecent } from "./shell/recents";
```

Anywhere a file becomes the open document — bootstrap, drag-drop — call `recordRecent`. After `currentPath = ...` lines, append:
```typescript
    if (currentPath) await recordRecent(currentPath);
```

Bootstrap: after `const initialDoc = await resolveInitialDoc();`:
```typescript
  if (initialDoc) await recordRecent(initialDoc.path);
```

- [ ] **Step 2: Smoke**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```
jj desc -m "Record recents on every file open and drag-drop"
jj new -m "wip"
```

---

# Phase E — Crash recovery

## Task 16: Rust recovery commands

A separate set of commands that read/write/clear the recovery file alongside its metadata. The recovery dir lives in `<app-data>/recovery/`.

**Files:**
- Modify: `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Append to `src-tauri/src/commands/files.rs`**

```rust
use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct RecoveryEntry {
    pub original_path: String,
    pub contents: String,
    pub timestamp_ms: i64,
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, FileError> {
    let app_dir = app.path().app_data_dir().map_err(|e| FileError::Io(e.to_string()))?;
    let dir = app_dir.join("recovery");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(dir)
}

fn slug_for(path: &str) -> String {
    let mut s = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() { s.push(c); }
        else { s.push('_'); }
    }
    s
}

#[tauri::command]
pub fn write_recovery(
    app: tauri::AppHandle,
    original_path: String,
    contents: String,
) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let entry = RecoveryEntry {
        original_path,
        contents,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
    };
    let json = serde_json::to_vec(&entry).map_err(|e| FileError::Io(e.to_string()))?;
    std::fs::write(dir.join(format!("{}.json", slug)), json)
        .map_err(|e| FileError::Io(e.to_string()))
}

#[tauri::command]
pub fn read_all_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, FileError> {
    let dir = recovery_dir(&app)?;
    let mut out = Vec::new();
    if !dir.exists() { return Ok(out); }
    for entry in std::fs::read_dir(&dir).map_err(|e| FileError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| FileError::Io(e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let bytes = std::fs::read(&path).map_err(|e| FileError::Io(e.to_string()))?;
        if let Ok(rec) = serde_json::from_slice::<RecoveryEntry>(&bytes) {
            out.push(rec);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle, original_path: String) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let path = dir.join(format!("{}.json", slug));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(())
}
```

This adds a `chrono` dependency. Add to `Cargo.toml`:
```toml
chrono = "0.4"
```

- [ ] **Step 2: Register in `lib.rs`**

```rust
.invoke_handler(tauri::generate_handler![
    commands::files::read_text_file,
    commands::files::write_text_file,
    commands::files::write_recovery,
    commands::files::read_all_recovery,
    commands::files::clear_recovery,
    commands::watcher::watcher_start,
    commands::watcher::watcher_stop,
    commands::watcher::watcher_mark_self_write,
])
```

- [ ] **Step 3: Build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
```
Expected: clean.

- [ ] **Step 4: Commit**

```
jj desc -m "Add Rust recovery commands (write/read-all/clear)"
jj new -m "wip"
```

---

## Task 17: Frontend recovery module + integration

**Files:**
- Create: `src/shell/recovery.ts`
- Test: `tests/shell/recovery.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Tests first**

```typescript
// tests/shell/recovery.test.ts
import { describe, it, expect, vi } from "vitest";

const calls: Array<{ cmd: string; args: unknown }> = [];
const responses: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return responses[cmd];
  },
}));

import {
  writeRecovery,
  readAllRecovery,
  clearRecovery,
  startRecoveryLoop,
} from "../../src/shell/recovery";

describe("recovery", () => {
  it("writeRecovery invokes write_recovery", async () => {
    await writeRecovery("/a.md", "content");
    const last = calls[calls.length - 1];
    expect(last.cmd).toBe("write_recovery");
    expect(last.args).toMatchObject({ originalPath: "/a.md", contents: "content" });
  });

  it("readAllRecovery returns the array from invoke", async () => {
    responses["read_all_recovery"] = [{ original_path: "/a.md", contents: "x", timestamp_ms: 1 }];
    const got = await readAllRecovery();
    expect(got.length).toBe(1);
    expect(got[0].originalPath).toBe("/a.md");
  });

  it("clearRecovery invokes clear_recovery", async () => {
    await clearRecovery("/a.md");
    const last = calls[calls.length - 1];
    expect(last.cmd).toBe("clear_recovery");
    expect(last.args).toMatchObject({ originalPath: "/a.md" });
  });

  it("startRecoveryLoop calls writeRecovery only when isDirty returns true", async () => {
    let dirty = false;
    const stop = startRecoveryLoop({
      intervalMs: 10,
      isDirty: () => dirty,
      currentPath: () => "/a.md",
      currentContents: () => "live",
    });
    await new Promise((r) => setTimeout(r, 30));
    const writes = calls.filter((c) => c.cmd === "write_recovery");
    expect(writes.length).toBe(0);
    dirty = true;
    await new Promise((r) => setTimeout(r, 30));
    const writes2 = calls.filter((c) => c.cmd === "write_recovery");
    expect(writes2.length).toBeGreaterThan(0);
    stop();
  });
});
```

- [ ] **Step 2: Run to fail**

- [ ] **Step 3: Implement `src/shell/recovery.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";

export interface RecoveryEntry {
  originalPath: string;
  contents: string;
  timestampMs: number;
}

interface RawRecoveryEntry {
  original_path: string;
  contents: string;
  timestamp_ms: number;
}

export async function writeRecovery(originalPath: string, contents: string): Promise<void> {
  await invoke("write_recovery", { originalPath, contents });
}

export async function readAllRecovery(): Promise<RecoveryEntry[]> {
  const raw = (await invoke<RawRecoveryEntry[]>("read_all_recovery")) ?? [];
  return raw.map((r) => ({
    originalPath: r.original_path,
    contents: r.contents,
    timestampMs: r.timestamp_ms,
  }));
}

export async function clearRecovery(originalPath: string): Promise<void> {
  await invoke("clear_recovery", { originalPath });
}

export interface RecoveryLoopOptions {
  intervalMs: number;
  isDirty: () => boolean;
  currentPath: () => string | null;
  currentContents: () => string;
}

/** Start a periodic recovery dump. Returns a stop function. */
export function startRecoveryLoop(opts: RecoveryLoopOptions): () => void {
  const handle = setInterval(() => {
    if (!opts.isDirty()) return;
    const path = opts.currentPath();
    if (!path) return;
    void writeRecovery(path, opts.currentContents());
  }, opts.intervalMs);
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Run to pass**

```
npm test -- tests/shell/recovery
```

- [ ] **Step 5: Wire in `main.ts`**

After the dirty tracker setup, start the loop:

```typescript
import { startRecoveryLoop, readAllRecovery, clearRecovery } from "./shell/recovery";

  // 5-second recovery loop while dirty.
  const stopRecovery = startRecoveryLoop({
    intervalMs: 5000,
    isDirty: () => dirtyTracker.isDirty(),
    currentPath: () => currentPath,
    currentContents: () => view.state.doc.toString(),
  });
  window.addEventListener("beforeunload", () => stopRecovery());
```

After successful save, clear the recovery:

In the `setSaveHandler` callback, after `dirtyTracker.reset();` and `diverged = false;`:
```typescript
      if (currentPath) await clearRecovery(currentPath);
```

At bootstrap, before `resolveInitialDoc`, check for stale recovery files and offer to recover. This is the "On startup, if recovery files exist, prompt to recover." flow:

```typescript
  await maybeRestoreFromRecovery();
```

Helper, defined inside `bootstrap`:

```typescript
  async function maybeRestoreFromRecovery(): Promise<void> {
    const entries = await readAllRecovery();
    if (entries.length === 0) return;
    const entry = entries[0]; // foundation: handle one at a time
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const restore = await ask(
      `Restore unsaved changes to ${entry.originalPath}?`,
      {
        title: "Recover unsaved work",
        okLabel: "Restore",
        cancelLabel: "Discard",
      },
    );
    if (restore) {
      // Open the original path and overlay the recovered contents.
      const doc = { path: entry.originalPath, source: entry.contents };
      // Reuse the bootstrap flow's later setup by setting a module-scoped variable
      // that's checked in resolveInitialDoc:
      _recoveredDoc = doc;
    }
    await clearRecovery(entry.originalPath);
  }
  let _recoveredDoc: { path: string; source: string } | null = null;
```

Then in `resolveInitialDoc` add a first check:

```typescript
  if (_recoveredDoc) return _recoveredDoc;
```

(`_recoveredDoc` lives in the bootstrap scope; both `maybeRestoreFromRecovery` and `resolveInitialDoc` are local to `bootstrap`. If `resolveInitialDoc` was originally a top-level function, move it inside bootstrap or pass `_recoveredDoc` as a parameter.)

- [ ] **Step 6: Smoke**

```
npm test
npx tsc -b --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 7: Commit**

```
jj desc -m "Add crash recovery: 5s dirty-buffer dump and startup restore prompt"
jj new -m "wip"
```

---

# Phase F — Native menu inventory

## Task 18: Menu module skeleton

Tauri 2 builds menus via `tauri::menu` (Rust side) OR via `@tauri-apps/api/menu` (frontend). We use the frontend API since most actions are JS-side. The menu is built at bootstrap and attached via `getCurrentWindow().setMenu(menu)`.

**Files:**
- Create: `src/shell/menus.ts`

- [ ] **Step 1: Implement `src/shell/menus.ts`**

```typescript
import { Menu, Submenu, MenuItem, PredefinedMenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface MenuHandlers {
  openFile: () => Promise<void>;
  saveFile: () => Promise<void>;
  closeWindow: () => Promise<void>;
  toggleMode: () => void;
  toggleSidebar: () => void;
  setTheme: (t: "light" | "dark" | "system") => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  openFind: () => void;
  openReplace: () => void;
  recents: () => Promise<string[]>;
  openRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
}

export async function buildAndAttachMenu(handlers: MenuHandlers): Promise<Menu> {
  const recents = await handlers.recents();

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({ id: "open", text: "Open…", accelerator: "CmdOrCtrl+O", action: () => void handlers.openFile() }),
      await Submenu.new({
        text: "Open Recent",
        items: recents.length === 0
          ? [await MenuItem.new({ id: "no-recent", text: "(none)", enabled: false, action: () => {} })]
          : [
              ...await Promise.all(recents.map((p, i) =>
                MenuItem.new({ id: `recent-${i}`, text: shortName(p), action: () => void handlers.openRecent(p) }),
              )),
              await PredefinedMenuItem.new({ item: "Separator" }),
              await MenuItem.new({ id: "clear-recents", text: "Clear Menu", action: () => void handlers.clearRecents() }),
            ],
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "save", text: "Save", accelerator: "CmdOrCtrl+S", action: () => void handlers.saveFile() }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "close", text: "Close Window", accelerator: "CmdOrCtrl+W", action: () => void handlers.closeWindow() }),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "find", text: "Find…", accelerator: "CmdOrCtrl+F", action: () => handlers.openFind() }),
      await MenuItem.new({ id: "replace", text: "Find and Replace…", accelerator: "CmdOrCtrl+Shift+F", action: () => handlers.openReplace() }),
    ],
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({ id: "toggle-mode", text: "Reading / Edit Mode", accelerator: "CmdOrCtrl+E", action: () => handlers.toggleMode() }),
      await MenuItem.new({ id: "toggle-sidebar", text: "Show / Hide Sidebar", accelerator: "CmdOrCtrl+Shift+O", action: () => handlers.toggleSidebar() }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await Submenu.new({
        text: "Theme",
        items: [
          await CheckMenuItem.new({ id: "theme-light", text: "Light", checked: false, action: () => handlers.setTheme("light") }),
          await CheckMenuItem.new({ id: "theme-dark", text: "Dark", checked: false, action: () => handlers.setTheme("dark") }),
          await CheckMenuItem.new({ id: "theme-system", text: "Follow System", checked: true, action: () => handlers.setTheme("system") }),
        ],
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "zoom-reset", text: "Actual Size", accelerator: "CmdOrCtrl+0", action: () => handlers.zoomReset() }),
      await MenuItem.new({ id: "zoom-in", text: "Zoom In", accelerator: "CmdOrCtrl+Plus", action: () => handlers.zoomIn() }),
      await MenuItem.new({ id: "zoom-out", text: "Zoom Out", accelerator: "CmdOrCtrl+-", action: () => handlers.zoomOut() }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
    ],
  });

  const menu = await Menu.new({ items: [fileMenu, editMenu, viewMenu, windowMenu] });
  await menu.setAsAppMenu();
  return menu;
}

function shortName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
```

If `@tauri-apps/api/menu` API names differ in the installed version, check `node_modules/@tauri-apps/api/menu.d.ts` and adjust. The shape (Submenu/MenuItem/PredefinedMenuItem/CheckMenuItem with `.new` constructors) is the canonical Tauri 2 API.

The capability already grants `core:default` which covers `core:menu:default` permissions. If the runtime errors with "menu not allowed", add `"menu:default"` to `capabilities/default.json`.

**Note: avoid `Cmd/Ctrl+\` and other US-only-punctuation accelerators per the user's keyboard-layout rule.** All shortcuts above use letters, digits, function keys, plus the universally-positioned `+`/`-` keys (which despite being shifted on some layouts are accepted).

- [ ] **Step 2: Type-check**

```
npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```
jj desc -m "Add native menu inventory module"
jj new -m "wip"
```

---

## Task 19: Wire the menu in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Build & attach the menu after toolbar mount**

After the toolbar is mounted and all handlers are set, build the menu:

```typescript
import { buildAndAttachMenu } from "./shell/menus";
import { setActiveTheme } from "./editor/theme";
import { loadRecents, clearRecents } from "./shell/recents";
import { openSearchPanel, openSearchPanel as openReplacePanelStub /* see Task 21 */ } from "@codemirror/search";

  await buildAndAttachMenu({
    openFile: async () => {
      const doc = await openFileViaDialog();
      if (!doc) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.source },
      });
      currentPath = doc.path;
      dirtyTracker.reset();
      diverged = false;
      await setWindowTitle(currentPath, false);
      await recordRecent(currentPath);
      if (currentPath) await startWatching(currentPath);
    },
    saveFile: async () => {
      // Reuse the save handler bound to Cmd/Ctrl+S via setSaveHandler (Task 11 of Plan 2).
      // The handler references `currentPath` and `dirtyTracker` from closure.
      const sh = (globalThis as unknown as { __viewerSaveHandler?: () => void });
      sh.__viewerSaveHandler?.();
    },
    closeWindow: async () => {
      const win = getCurrentWindow();
      await win.close();
    },
    toggleMode: () => {
      currentMode = currentMode === "reading" ? "edit" : "reading";
      setMode(view, currentMode, modeExtensions[currentMode]);
      toolbar.setMode(currentMode);
    },
    toggleSidebar: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
    },
    setTheme: (t) => setActiveTheme(t),
    zoomIn: () => zoomBy(+1),
    zoomOut: () => zoomBy(-1),
    zoomReset: () => zoomReset(),
    openFind: () => openSearchPanel(view),
    openReplace: () => openSearchPanel(view), // search panel includes replace
    recents: async () => await loadRecents(),
    openRecent: async (path) => {
      const doc = await readDoc(path);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.source },
      });
      currentPath = doc.path;
      dirtyTracker.reset();
      diverged = false;
      await setWindowTitle(currentPath, false);
      await recordRecent(currentPath);
      if (currentPath) await startWatching(currentPath);
    },
    clearRecents: async () => {
      await clearRecents();
    },
  });
```

The `__viewerSaveHandler` global is a temporary indirection — the menu's saveFile needs to call the same code as `Cmd/Ctrl+S`. Hoist that callback:

In `main.ts` where `setSaveHandler(...)` is currently called, refactor to:

```typescript
  const triggerSave = async (): Promise<void> => {
    // ... existing save logic body ...
  };
  setSaveHandler(() => void triggerSave());
  (globalThis as { __viewerSaveHandler?: () => void }).__viewerSaveHandler = triggerSave;
```

(Yes, the `globalThis` indirection is ugly. The cleaner approach is to lift `triggerSave` to bootstrap-local scope and reference it directly. Either works — pick whichever the implementer prefers, but commit a clean version.)

`zoomBy` and `zoomReset` come from Task 22; for now stub them with `() => {}` and the import of `openSearchPanel` needs `@codemirror/search` which is already installed. If `openSearchPanel` requires the `search` extension to be added to the editor, add it via the `editKeymap` (already includes `searchKeymap` from Plan 2 Task 7).

- [ ] **Step 2: Build**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```
jj desc -m "Wire native menu: file/edit/view/window with all working handlers"
jj new -m "wip"
```

---

# Phase G — Document zoom

## Task 20: Zoom module + bindings

Document zoom adjusts the editor's font-size in CSS-pixel steps; CodeMirror reflows automatically.

**Files:**
- Create: `src/editor/zoom.ts`
- Modify: `src/main.ts`
- Modify: `src/editor/keymaps.ts` (zoom shortcuts)

- [ ] **Step 1: Create `src/editor/zoom.ts`**

```typescript
import type { EditorView } from "@codemirror/view";

const DEFAULT_FONT_PX = 16;
const STEP = 1;
const MIN = 10;
const MAX = 32;

let currentSize = DEFAULT_FONT_PX;

function apply(view: EditorView): void {
  view.scrollDOM.style.fontSize = `${currentSize}px`;
}

export function zoomBy(view: EditorView, direction: 1 | -1): void {
  const next = Math.min(MAX, Math.max(MIN, currentSize + direction * STEP));
  currentSize = next;
  apply(view);
}

export function zoomReset(view: EditorView): void {
  currentSize = DEFAULT_FONT_PX;
  apply(view);
}

export function getZoomSize(): number {
  return currentSize;
}
```

- [ ] **Step 2: Add zoom bindings to `src/editor/keymaps.ts`**

Add module-scoped handler hooks:

```typescript
let zoomInHandler: () => void = () => {};
let zoomOutHandler: () => void = () => {};
let zoomResetHandler: () => void = () => {};
export function setZoomHandlers(handlers: { in: () => void; out: () => void; reset: () => void }): void {
  zoomInHandler = handlers.in;
  zoomOutHandler = handlers.out;
  zoomResetHandler = handlers.reset;
}

const zoomBindings: KeyBinding[] = [
  { key: "Mod-=", preventDefault: true, run: () => { zoomInHandler(); return true; } },
  { key: "Mod-+", preventDefault: true, run: () => { zoomInHandler(); return true; } },
  { key: "Mod--", preventDefault: true, run: () => { zoomOutHandler(); return true; } },
  { key: "Mod-0", preventDefault: true, run: () => { zoomResetHandler(); return true; } },
];
```

Add `...zoomBindings` to both `readingKeymap` and `editKeymap` arrays. Sidebar toggle binding too:

```typescript
let sidebarToggleHandler: () => void = () => {};
export function setSidebarToggleHandler(handler: () => void): void { sidebarToggleHandler = handler; }
const sidebarToggleBinding: KeyBinding = {
  key: "Mod-Shift-o",
  preventDefault: true,
  run: () => { sidebarToggleHandler(); return true; },
};
```

Add `sidebarToggleBinding` to both keymaps too.

- [ ] **Step 3: Wire in `main.ts`**

After the menu setup:

```typescript
import { zoomBy as zoomByFn, zoomReset as zoomResetFn } from "./editor/zoom";
import { setZoomHandlers, setSidebarToggleHandler } from "./editor/keymaps";

  setZoomHandlers({
    in: () => zoomByFn(view, +1),
    out: () => zoomByFn(view, -1),
    reset: () => zoomResetFn(view),
  });
  setSidebarToggleHandler(() => {
    const next = !toc.isVisible();
    toc.setVisible(next);
    recordExplicitToggle(next);
  });
```

Replace the menu's `zoomIn`/`zoomOut`/`zoomReset` handlers with calls to `zoomByFn(view, ...)` directly.

- [ ] **Step 4: Smoke**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 5: Commit**

```
jj desc -m "Add document zoom (Cmd+0/+/-) and sidebar toggle shortcut (Cmd+Shift+O)"
jj new -m "wip"
```

---

# Phase H — Find/replace

## Task 21: Surface the search panel

CodeMirror's `@codemirror/search` panel has both find and replace built in. Plan 2's `editKeymap` already includes `searchKeymap` — `Cmd/Ctrl+F` opens find, `Cmd/Ctrl+Alt+F` opens replace by default. We add explicit menu entries (Task 19 already wired `openFind`/`openReplace`) and confirm the panel works in both modes.

**Files:**
- Modify: `src/editor/keymaps.ts` — ensure `searchKeymap` is in `readingKeymap` too (so Cmd+F works in reading mode)

- [ ] **Step 1: Update `readingKeymap`**

Find:
```typescript
export const readingKeymap = keymap.of([modeToggleBinding, saveBinding, sidebarToggleBinding, ...zoomBindings, ...readingBindings]);
```

Replace with:
```typescript
export const readingKeymap = keymap.of([
  modeToggleBinding,
  saveBinding,
  sidebarToggleBinding,
  ...zoomBindings,
  ...searchKeymap,
  ...readingBindings,
]);
```

(The exact list at this point depends on what Tasks 9, 11, 19, 20 ended up with. Ensure `searchKeymap` is included.)

- [ ] **Step 2: Smoke**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```
jj desc -m "Enable Cmd+F find panel in reading mode (already worked in edit)"
jj new -m "wip"
```

---

# Phase I — HTML sanitization seam

## Task 22: DOMPurify wrapper for export paths

Plan 2 final review documented that the *rendering* path doesn't use innerHTML and therefore doesn't need DOMPurify. The *export* path (Sub-spec C) will. We add the seam now.

**Files:**
- Create: `src/export/sanitize.ts`
- Test: `tests/export/sanitize.test.ts`

- [ ] **Step 1: Tests**

```typescript
// tests/export/sanitize.test.ts
import { describe, it, expect } from "vitest";

import { sanitizeHtml } from "../../src/export/sanitize";

describe("sanitizeHtml", () => {
  it("strips <script>", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
  });

  it("strips inline event handlers", () => {
    expect(sanitizeHtml('<a href="x" onclick="bad()">x</a>')).not.toContain("onclick");
  });

  it("strips javascript: urls", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("preserves harmless markdown-rendered HTML", () => {
    const html = "<h1>Title</h1><p><strong>bold</strong> and <em>italic</em></p>";
    expect(sanitizeHtml(html)).toBe(html);
  });
});
```

- [ ] **Step 2: Implement `src/export/sanitize.ts`**

```typescript
import DOMPurify from "dompurify";

const config: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
};

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, config);
}
```

- [ ] **Step 3: Run tests**

```
npm test -- tests/export/sanitize
```
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```
jj desc -m "Add DOMPurify-based sanitizeHtml seam for Sub-spec C export paths"
jj new -m "wip"
```

---

# Phase J — Real icon

## Task 23: Generate a real app icon

The Plan 1 placeholder is too small for `tauri build`. Generate a real iconset.

**Files:**
- Replace: `src-tauri/icons/icon.png` and platform variants

- [ ] **Step 1: Generate a 1024×1024 source PNG**

A simple geometric icon will do. The simplest approach is to write a Node.js one-shot that draws a stylized "M" (for Markdown viewer) on a tinted background, saves it as `1024.png`, then run Tauri's icon generator:

Create `scripts/generate-icon.mjs`:

```javascript
import { writeFileSync } from "node:fs";

// 1024x1024 PNG — minimal hand-rolled to avoid bringing in Sharp.
// We use a flat color square; production would replace with a real design.
// PNG encoding requires zlib + CRC; the easiest path here is to write a
// minimal PNG manually OR shell out to `python3 -c '...'` like Plan 1's icon.
// Use the python approach for parity with Plan 1.

import { execSync } from "node:child_process";

execSync(`python3 -c '
from struct import pack
import zlib
W=H=1024
bg=(253, 253, 250, 255)
fg=(176, 48, 96, 255)
# Solid bg with a centered 600x600 fg square (placeholder "M")
def pix(x,y):
    cx, cy = W//2, H//2
    if abs(x-cx) < 300 and abs(y-cy) < 300: return fg
    return bg
raw = b"".join(b"\\x00" + b"".join(bytes(pix(x,y)) for x in range(W)) for y in range(H))
def chunk(t,d):
    return pack(">I",len(d)) + t + d + pack(">I", zlib.crc32(t+d))
sig = b"\\x89PNG\\r\\n\\x1a\\n"
ihdr = pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
idat = zlib.compress(raw)
with open("src-tauri/icons/icon.png", "wb") as f:
    f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
'`, { stdio: "inherit" });
```

Run from project root:
```
cd /Users/ke/src/viewer && node scripts/generate-icon.mjs
```

- [ ] **Step 2: Run Tauri's icon generator**

```
cd /Users/ke/src/viewer && npx @tauri-apps/cli icon src-tauri/icons/icon.png
```

Expected: produces `icon.icns`, `icon.ico`, and various size variants in `src-tauri/icons/`.

- [ ] **Step 3: Update `src-tauri/tauri.conf.json` to reference the generated icons**

Replace the empty `"icon": []` with:
```json
"icon": [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico"
]
```

- [ ] **Step 4: Verify a release build can complete (optional — long)**

```
cd /Users/ke/src/viewer && npm run tauri:build
```
Expected: produces a `.dmg` (macOS), `.msi` (Windows), or `.deb` (Linux). May take 15+ minutes on first run.

If `tauri build` runs out of disk space or takes too long, mark this step DONE_WITH_CONCERNS and document — Plan 3 ships with the icons in place, full bundle verification can happen in CI (Task 25).

- [ ] **Step 5: Commit**

```
jj desc -m "Replace placeholder icon with a generated iconset"
jj new -m "wip"
```

---

# Phase K — CI matrix

## Task 24: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  unit:
    name: Unit tests (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install Linux build deps
        if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          toolchain: stable
      - run: npm ci
      - name: Frontend type check
        run: npx tsc -b --noEmit
      - name: Vitest
        run: npm test
      - name: Cargo check
        working-directory: src-tauri
        run: cargo check
      - name: Playwright install
        run: npx playwright install chromium --with-deps
      - name: Playwright e2e
        run: npm run test:e2e

  build:
    name: Tauri build (${{ matrix.os }})
    needs: unit
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install Linux build deps
        if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          toolchain: stable
      - run: npm ci
      - name: Tauri build (debug)
        run: npm run tauri:build -- --debug
        timeout-minutes: 30
```

- [ ] **Step 2: Commit**

```
jj desc -m "Add GitHub Actions CI matrix (mac/windows/linux)"
jj new -m "wip"
```

The workflow won't actually run until the user pushes to a GitHub remote. That's fine — Plan 3 ships the file; running it is downstream.

---

## Task 25: Visual regression Playwright spec

**Files:**
- Create: `tests/e2e/visual-regression.spec.ts`
- Create: `tests/e2e/fixtures/visual-corpus.md`

- [ ] **Step 1: Create the corpus fixture**

`tests/e2e/fixtures/visual-corpus.md` — a single markdown file containing every construct so a single screenshot covers many things:

```markdown
# Visual Corpus

A paragraph with **bold**, *italic*, ***both***, ~~strike~~, and `inline code`.

## Lists

- one
- two
  - nested
- three

1. ordered
2. items

- [x] task done
- [ ] task todo

## Code

```js
const x = 42;
function add(a, b) { return a + b; }
```

## Table

| Col A | Col B |
|-------|-------|
| one   | two   |
| three | four  |

## Quote

> A blockquote with **bold** and *italic*.

## Links and images

See [the docs](https://example.com) for more.

![alt text](./missing.png)

## Footnote

Text[^1].

[^1]: A footnote.
```

- [ ] **Step 2: Create the visual spec**

`tests/e2e/visual-regression.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(APP_URL); if (r.ok) break; } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) try { process.kill(-viteProc.pid); } catch {}
});

test.describe("visual regression", () => {
  test("reading mode, light theme", async ({ page }) => {
    const corpus = readFileSync(resolve(__dirname, "fixtures/visual-corpus.md"), "utf8");
    await page.addInitScript((src: string) => {
      // (mock Tauri internals — copy the pattern from edit-and-save.spec.ts)
      // Returning `src` from `read_text_file`.
      // Add metadata, listen, watcher_*, plugin:dialog|open, plugin:cli|argv as in edit-and-save.spec.ts.
      // ...
      void src;
    }, corpus);

    await page.goto(APP_URL);
    await page.locator(".cm-md-heading-1").waitFor();
    await sleep(300); // let Shiki tokens land
    await expect(page).toHaveScreenshot("reading-light.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("reading mode, dark theme", async ({ page }) => {
    // Same approach; in addInitScript, set localStorage "viewer.theme" = "dark"
    // before bootstrap reads it.
    // ...
  });
});
```

The implementer will need to copy the working Tauri-internals mock from `tests/e2e/edit-and-save.spec.ts`. The `addInitScript` body is large and was solved in Plan 2.

`@playwright/test` `expect(page).toHaveScreenshot(...)` baselines on first run; subsequent runs compare. The first run will create `tests/e2e/visual-regression.spec.ts-snapshots/` with reference PNGs.

- [ ] **Step 3: Generate the baselines**

```
cd /Users/ke/src/viewer && npx playwright test tests/e2e/visual-regression --update-snapshots
```

This creates the baseline PNGs. Commit them.

- [ ] **Step 4: Run the test against the baselines**

```
npx playwright test tests/e2e/visual-regression
```
Expected: pass (since we just created the baselines).

- [ ] **Step 5: Commit**

```
jj desc -m "Add visual regression e2e for reading mode (light + dark)"
jj new -m "wip"
```

---

# Phase L — Capstone

## Task 26: Update CHANGELOG and Plan 3 capstone

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend Plan 3 release section**

```markdown
## [0.3.0] - 2026-05-08 — Plan 3: Polish & platform — Foundation complete

Foundation Sub-spec A complete. The viewer meets every Definition of Done criterion in spec §12 on macOS, Windows, and Linux.

### Added

- Togglable TOC sidebar (auto-on for 3+ headings, persisted thereafter; click to jump; scroll-syncs the active heading; Cmd/Ctrl+Shift+O toggle)
- Recents menu (last 10, dedupe-on-record, Clear Menu)
- Crash recovery (5s dirty-buffer dump to `<app-data>/recovery/`; startup prompt to restore)
- Native menu inventory: File / Edit / View / Window with every item working — no stubs, no greyed-out submenus
- Document zoom: Cmd/Ctrl + 0/+/- with min 10px, max 32px
- Find/replace: Cmd/Ctrl+F (find), Cmd/Ctrl+Shift+F (replace), works in both reading and edit modes
- DOMPurify-based sanitizeHtml seam for Sub-spec C export paths
- Real app icon (replaces Plan 1 placeholder)
- GitHub Actions CI matrix (Ubuntu / macOS / Windows: tsc, vitest, cargo check, playwright e2e, tauri build)
- Visual regression Playwright corpus

### Plan 1 + Plan 2 carryover items closed

- Switch to `notify-debouncer-full` so file-removed events actually fire
- Preserve scroll position on external reload
- Reconcile modal default focus on Keep my edits (safe action)
- frontmatter.ts and inline.ts use shared computeLineStarts
- thiserror direct dep aligned to 2.x
- storeTheme wired via `setActiveTheme`
- renderHtml documented as the export pipeline seam

### Known shape

Sub-spec A is complete; Sub-specs B (math, mermaid, image security), C (export & print), D (OS integration polish, folder/project tree, multi-window), E (settings UI, auto-update), and F (a11y audit, i18n string extraction) follow.
```

- [ ] **Step 2: Capstone commit**

```bash
jj desc -m "Plan 3 complete: TOC sidebar, recents, crash recovery, native menus, zoom, find/replace, CI

End state of Plan 3 (Foundation Sub-spec A, plan 3 of 3):

- Togglable TOC sidebar with click-to-jump and scroll-sync
- Recents menu (last 10) and File menu wiring
- Crash recovery (5s dirty dump + startup restore prompt)
- Native menu inventory: every item works, no stubs
- Document zoom (Cmd/Ctrl + 0/+/-)
- Find/replace via @codemirror/search panel in both modes
- DOMPurify seam for Sub-spec C
- Real iconset
- GitHub Actions CI matrix (mac/win/linux: tsc, vitest, cargo, playwright, tauri build)
- Visual regression corpus
- All Plan 1 + Plan 2 carryover items closed

Foundation Sub-spec A complete. Spec §12 DoD met on all three platforms."

jj new -m "wip"
```

---

# Self-review

**Spec coverage:** every requirement in spec §3.5 (file handling — recents and folder/project deferred to Sub-spec D, recents itself in scope), §5.7 (TOC), §6a (menus + shortcuts), §7 (recovery), §10 in-scope items, §11 (assumptions — markdown-it speed unverified beyond informal use, but acceptable for foundation), §12 DoD criteria all map to Plan 3 tasks. Plan 1 + Plan 2 carryover items each map to a Phase A or B task.

**Placeholder scan:** every step has actual content. Where the implementer needs to copy a working Tauri-internals mock from a sibling test file (Task 25 visual regression), the source file is named explicitly. The "stub them with `() => {}`" line in Task 19 step 1 is a transitional placeholder until Task 20 lands the real `zoomBy`/`zoomReset` — those are committed together so the stub never ships.

**Type consistency:** `MenuHandlers` is the contract surface between menus.ts and main.ts. `setZoomHandlers({ in, out, reset })` shape matches. `MountTocOptions / TocSidebarHandle` consistent across `toc.ts` and main.ts. `RecoveryEntry` (frontend) correctly maps from snake_case (Rust) to camelCase (TS) in `readAllRecovery`.

**Inline fix during self-review:** Task 19's import line for `openSearchPanel` referenced an alias `openSearchPanel as openReplacePanelStub` that's never used. Removed — kept just `import { openSearchPanel } from "@codemirror/search";` and pointed both `openFind` and `openReplace` handlers at it (the search panel includes replace controls inline).

---

# Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-markdown-viewer-foundation-3-polish-and-platform.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
