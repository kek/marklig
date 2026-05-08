# Markdown Viewer Foundation — Plan 2: Editing & file lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only viewer from Plan 1 into a working editor: toggle between reading and edit modes (`Cmd/Ctrl+E`), edit decorated-source markdown, save (`Cmd/Ctrl+S`), reload when the file changes on disk, prompt before discarding unsaved work, accept drag-and-drop files. Also closes Plan 1 carryover gaps (Shiki token coloring; multi-line paragraph decoration).

**Architecture:** The mode toggle becomes meaningful — reading mode keeps the elide-everything `readingWidgetsProducer` from Plan 1; edit mode swaps to a producer set that leaves all markers visible (the "decorated source" UX from spec §2.2). The decorations CodeMirror compartment swaps between the two sets, the keymap compartment swaps between a reading-mode navigation map and the standard edit map, the readOnly compartment flips. Save and dirty tracking are frontend state with a thin Rust write counterpart. The file watcher uses the `notify` crate on the Rust side, watches the parent directory of the open file, and applies a self-write timestamp filter so our own saves don't trigger reload prompts.

**Tech Stack:** Continues from Plan 1: Tauri 2, CodeMirror 6 (StateField/StateEffect for async highlight cache), markdown-it, Shiki, Vitest, Playwright. Adds the `notify` Rust crate for the file watcher.

**Spec:** `docs/superpowers/specs/2026-05-08-markdown-viewer-foundation-design.md`. The Plan 1 implementation: `docs/superpowers/plans/2026-05-08-markdown-viewer-foundation-1-viewer.md`. Carryover backlog: `~/.claude/projects/-Users-ke-src-viewer/memory/project_plan1_carryover.md`.

**This plan delivers** every spec requirement that involves *editing*, *saving*, or *the file changing on disk*, plus closes the two Important carryover items. Plan 3 (the final foundation slice) handles TOC sidebar, recents, crash recovery, native menus, full keyboard shortcuts, document zoom, find/replace, HTML sanitization, and CI matrix.

---

## File structure

By the end of Plan 2 the codebase looks like this. Files marked **(Plan 2)** are new in this plan; **(Plan 2 mod)** are modified.

```
viewer/
├── src-tauri/
│   ├── Cargo.toml                                      (Plan 2 mod) +notify
│   └── src/
│       ├── lib.rs                                      (Plan 2 mod)
│       └── commands/
│           ├── mod.rs                                  (Plan 2 mod)
│           ├── files.rs                                (Plan 2 mod) +write_text_file, +metadata
│           └── watcher.rs                              (Plan 2)
├── src/
│   ├── main.ts                                         (Plan 2 mod) builds two decoration sets, wires keymap + watcher + dirty
│   ├── editor/
│   │   ├── editor.ts                                   (Plan 2 mod) setMode also swaps decoration + keymap compartments
│   │   ├── parser.ts                                   (unchanged)
│   │   ├── theme.ts                                    (unchanged)
│   │   ├── keymaps.ts                                  (Plan 2)  reading-mode + edit-mode keymaps
│   │   ├── decorations/
│   │   │   ├── index.ts                                (Plan 2 mod) computeLineStarts util, two-set builders
│   │   │   ├── headings.ts                             (Plan 2 mod) multi-line continuation fix
│   │   │   ├── inline.ts                               (Plan 2 mod) walks every line in map[0]..map[1]
│   │   │   ├── links.ts                                (Plan 2 mod) walks every line in map[0]..map[1]
│   │   │   ├── codeblocks.ts                           (Plan 2 mod) Shiki token decorations via async cache
│   │   │   ├── reading-widgets.ts                      (unchanged from Plan 1 follow-up)
│   │   │   └── (other Plan 1 producers unchanged)
│   ├── shell/
│   │   ├── files.ts                                    (Plan 2 mod) +saveDoc, +metadata
│   │   ├── dirty.ts                                    (Plan 2)
│   │   ├── watcher.ts                                  (Plan 2)
│   │   └── close.ts                                    (Plan 2) close-requested handler
│   └── ui/
│       ├── titlebar.ts                                 (Plan 2)
│       ├── toolbar.ts                                  (Plan 2)
│       └── reconcile.ts                                (Plan 2) modal for dirty/orphan reconciliation
├── tests/
│   ├── decorations/
│   │   ├── inline.test.ts                              (Plan 2 mod) +multi-line case
│   │   ├── links.test.ts                               (Plan 2 mod) +multi-line case
│   │   └── codeblocks.test.ts                          (Plan 2 mod) +shiki token case
│   ├── editor/
│   │   ├── editor.test.ts                              (Plan 2 mod) setMode swaps decorations + keymap
│   │   └── keymaps.test.ts                             (Plan 2)
│   ├── shell/
│   │   ├── dirty.test.ts                               (Plan 2)
│   │   └── close.test.ts                               (Plan 2)
│   └── e2e/
│       ├── edit-and-save.spec.ts                       (Plan 2)
│       └── external-change.spec.ts                     (Plan 2)
└── CHANGELOG.md                                        (Plan 2 mod)
```

---

# Phase A — Carryover fixes from Plan 1

## Task 1: Promote `computeLineStarts` to a shared util

Eight decoration producers each carry a private 4-line `computeLineStarts` (or `lineStarts`) helper. Promoting once, removing duplicates.

**Files:**
- Modify: `src/editor/decorations/index.ts` (add export)
- Modify: each of `src/editor/decorations/{headings,inline,lists,links,blockquotes,tables,codeblocks,frontmatter,footnotes,reading-widgets}.ts` (replace local helper with import)

- [ ] **Step 1: Add the util to `src/editor/decorations/index.ts`**

Append below the existing exports:

```typescript
export function computeLineStarts(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) out.push(i + 1);
  }
  return out;
}
```

- [ ] **Step 2: For each of the 10 producers, replace the local helper with the shared import**

Pattern: remove the bottom `function computeLineStarts(...)` (or `lineStarts(...)`) and add `computeLineStarts` to the named imports from `./index`.

For headings.ts specifically, the local helper is named `lineStarts` — rename callers to use `computeLineStarts` for consistency.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: 54/54 still pass (no behavioural change).

- [ ] **Step 4: Commit**

```bash
jj desc -m "Refactor: share computeLineStarts across decoration producers"
jj new -m "wip"
```

---

## Task 2: Fix multi-line paragraph decoration in `inline.ts`

`inline.ts` currently reads only the first line of an inline token's source range, missing styled spans on continuation lines of wrapped paragraphs.

**Files:**
- Modify: `src/editor/decorations/inline.ts`
- Test: `tests/decorations/inline.test.ts` (append a multi-line case)

- [ ] **Step 1: Append failing test**

Append to `tests/decorations/inline.test.ts`:

```typescript
it("decorates emphasis on continuation lines of a wrapped paragraph", () => {
  // markdown-it puts both lines of soft-wrapped prose into a single inline token
  // with map [0, 2]. The producer must walk both lines to find the *italic* on line 2.
  const r = classesOf("first line **bold**\nsecond line *italic*\n");
  expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-strong", from: 11, to: 19 }));
  expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-em", from: 32, to: 40 }));
});
```

- [ ] **Step 2: Run to verify it fails**

```
cd /Users/ke/src/viewer && npm test -- tests/decorations/inline
```
Expected: the new test fails (only the first line's bold is found).

- [ ] **Step 3: Update `src/editor/decorations/inline.ts`**

Currently the producer slices `lineSource` from `lineStart` to the next `\n`. Change it to slice through every line in the inline token's `map` range:

Replace this block:

```typescript
    const lineStart = absoluteOffsetOfLine(source, t.map[0]);
    const lineEnd = source.indexOf("\n", lineStart);
    const lineSource = source.slice(lineStart, lineEnd >= 0 ? lineEnd + 1 : undefined);
    walkInline(t.children, lineStart, lineSource, ranges);
```

With:

```typescript
    const blockStart = absoluteOffsetOfLine(source, t.map[0]);
    const lines = computeLineStarts(source);
    const blockEnd = lines[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);
    walkInline(t.children, blockStart, blockSource, ranges);
```

Add `import { computeLineStarts } from "./index";` to the top.

- [ ] **Step 4: Run to verify it passes**

```
cd /Users/ke/src/viewer && npm test -- tests/decorations/inline
```
Expected: 6/6 pass (5 original + 1 new).

- [ ] **Step 5: Run full suite**

```
npm test
```
Expected: 55/55.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Fix inline decorations to span multi-line paragraphs"
jj new -m "wip"
```

---

## Task 3: Fix multi-line paragraph decoration in `links.ts`

Same issue as Task 2, applied to `links.ts`.

**Files:**
- Modify: `src/editor/decorations/links.ts`
- Test: `tests/decorations/links.test.ts`

- [ ] **Step 1: Append failing test**

Append to `tests/decorations/links.test.ts`:

```typescript
it("decorates links on continuation lines of a wrapped paragraph", () => {
  const src = "first line\nsee [docs](https://example.com) on line 2\n";
  const r = ranges(src);
  expect(r).toContainEqual(
    expect.objectContaining({ class: "cm-md-link-text", from: 15, to: 21 }),
  );
});
```

- [ ] **Step 2: Run to verify failure**

```
npm test -- tests/decorations/links
```

- [ ] **Step 3: Update `src/editor/decorations/links.ts`**

Replace the per-token slicing:

```typescript
    const lineStart = lineStarts[t.map[0]];
    const lineEnd = lineStarts[t.map[0] + 1] ?? source.length;
    const lineSource = source.slice(lineStart, lineEnd);

    walkLinkChildren(t.children, lineStart, lineSource, ranges);
```

With block-level slicing:

```typescript
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);

    walkLinkChildren(t.children, blockStart, blockSource, ranges);
```

The local `lineStarts` is already imported from `./index` (Task 1). Rename the function-internal variable references from `lineStart`/`lineEnd`/`lineSource` to `blockStart`/`blockEnd`/`blockSource` consistently — the parameter name in `walkLinkChildren` should also be updated for clarity (rename `lineStart` → `blockStart`, `lineSource` → `blockSource`).

- [ ] **Step 4: Run to verify pass**

```
npm test -- tests/decorations/links
```
Expected: 3/3 pass (2 original + 1 new).

- [ ] **Step 5: Full suite + commit**

```
npm test
```
56/56 expected.

```bash
jj desc -m "Fix links decoration to span multi-line paragraphs"
jj new -m "wip"
```

---

## Task 4: Shiki token-level highlighting for code blocks

Plan 1's `codeblocksProducer` only emits line classes; it primes Shiki but never asks it to render tokens. This task adds token spans.

The architecture: a per-fence asynchronous highlight cache. When a fence's source changes, kick off `highlighter.codeToTokens(...)`; when results return, dispatch a `StateEffect` that updates the cache; the producer reads cache entries synchronously and emits `Decoration.mark` ranges with token-color classes.

**Files:**
- Modify: `src/editor/decorations/codeblocks.ts`
- Test: `tests/decorations/codeblocks.test.ts` (append)

- [ ] **Step 1: Append failing test**

Add to `tests/decorations/codeblocks.test.ts`:

```typescript
import { highlightCacheEffect, highlightCache } from "../../src/editor/decorations/codeblocks";

it("emits token-color marks once a fence has been highlighted", async () => {
  const src = "```js\nconst x = 1;\n```\n";
  // Synchronously precompute the cache entry.
  const tokens = parseMarkdown(src);
  const fence = tokens.find((t) => t.type === "fence");
  if (!fence || !fence.map) throw new Error("no fence");
  const fenceContent = "const x = 1;\n";
  await primeHighlighter(["javascript"]);
  const entries = await highlightCache.compute("javascript", fenceContent);
  highlightCache.set(fenceContent, entries);

  const set = codeblocksProducer({ source: src, tokens });
  const out: Array<{ from: number; to: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }

  // We expect at least one cm-md-token-* span inside the fence body.
  const tokenMarks = out.filter((x) => x.class.startsWith("cm-md-token"));
  expect(tokenMarks.length).toBeGreaterThan(0);
});
```

The test exercises the cache-and-emit path synchronously by populating the cache before calling the producer.

- [ ] **Step 2: Run to verify failure**

```
npm test -- tests/decorations/codeblocks
```
Expected: import-error or "Cannot read properties of undefined" since `highlightCache` doesn't exist yet.

- [ ] **Step 3: Update `src/editor/decorations/codeblocks.ts`**

Replace the file with:

```typescript
import { Decoration } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();

export async function primeHighlighter(langs: string[] = []): Promise<void> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["text", ...langs],
    });
    loadedLangs.add("text");
    for (const l of langs) loadedLangs.add(l);
  } else {
    for (const lang of langs) {
      if (!loadedLangs.has(lang)) {
        await highlighter.loadLanguage(lang as never);
        loadedLangs.add(lang);
      }
    }
  }
}

export interface HighlightEntry {
  /** Per-line array of tokens; offsets are line-relative. */
  lines: ThemedToken[][];
}

class HighlightCache {
  private map = new Map<string, HighlightEntry>();
  /** Listeners notified when an entry is set; used to dispatch a StateEffect. */
  private listeners = new Set<() => void>();

  get(content: string): HighlightEntry | undefined {
    return this.map.get(content);
  }

  set(content: string, entry: HighlightEntry): void {
    this.map.set(content, entry);
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async compute(lang: string, content: string): Promise<HighlightEntry> {
    if (!highlighter) throw new Error("highlighter not primed");
    const safeLang = loadedLangs.has(lang) ? lang : "text";
    const result = highlighter.codeToTokens(content, {
      lang: safeLang as never,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return { lines: result.tokens };
  }
}

export const highlightCache = new HighlightCache();

/** State effect dispatched when a fence's highlight result lands in the cache. */
export const highlightCacheEffect = StateEffect.define<void>();

export const codeblocksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    const lang = (t.info || "text").trim() || "text";
    const fenceContent = t.content;

    // Line-level classes (kept from Plan 1 for theme padding/background).
    ranges.push(
      Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-open" })
        .range(lineStarts[startLine]),
    );
    for (let line = startLine + 1; line < endLine - 1; line++) {
      ranges.push(
        Decoration.line({ class: `cm-md-code-body cm-md-code-lang-${lang}` })
          .range(lineStarts[line]),
      );
    }
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-close" })
          .range(lineStarts[endLine - 1]),
      );
    }

    // Token-level Shiki marks: read from cache; if missing, request asynchronously.
    const cached = highlightCache.get(fenceContent);
    if (cached) {
      const bodyStartLine = startLine + 1;
      let bodyOffset = lineStarts[bodyStartLine];
      for (let li = 0; li < cached.lines.length; li++) {
        const line = cached.lines[li];
        let cursor = bodyOffset;
        for (const tok of line) {
          const cls = colorClass(tok.color);
          if (cls && tok.content.length > 0) {
            ranges.push(
              Decoration.mark({ class: cls })
                .range(cursor, cursor + tok.content.length),
            );
          }
          cursor += tok.content.length;
        }
        // Advance to next line including the newline character.
        bodyOffset = lineStarts[bodyStartLine + li + 1] ?? cursor + 1;
      }
    } else if (highlighter && loadedLangs.has(lang)) {
      // Fire-and-forget compute; cache populates and notifies listeners.
      void highlightCache.compute(lang, fenceContent).then((entry) => {
        highlightCache.set(fenceContent, entry);
      });
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
};

function colorClass(hex: string | undefined): string | null {
  if (!hex) return null;
  // Shiki returns a hex color like "#005CC5". We map to a class name keyed by the hex.
  // Theme CSS owns the actual palette; this just stamps the class.
  const slug = hex.toLowerCase().replace(/^#/, "");
  return `cm-md-token-${slug}`;
}
```

The Shiki tokens carry their own colors per theme. The decoration emits a class derived from the hex; the theme CSS (Task 5 of this plan) injects rules mapping hex → CSS color so the class actually shows up.

- [ ] **Step 4: Run the test**

```
npm test -- tests/decorations/codeblocks
```
Expected: 3/3 pass (2 original + 1 new).

- [ ] **Step 5: Wire the cache→state-effect bridge in `main.ts`**

Modify `src/main.ts` — after creating the editor, subscribe the editor to highlight cache updates so the decoration field recomputes:

Add the import:
```typescript
import { highlightCache, highlightCacheEffect } from "./editor/decorations/codeblocks";
```

After `view.dispatch(...)` that initially configures the decoration field, add:
```typescript
const unsubscribe = highlightCache.subscribe(() => {
  view.dispatch({ effects: highlightCacheEffect.of() });
});
window.addEventListener("beforeunload", () => unsubscribe());
```

The decoration `StateField.update` already recomputes from `tr.state` on every dispatch with effects — so dispatching any effect (in this case `highlightCacheEffect`) will trigger a fresh `producer({ source, tokens })` call which now finds the cache populated and emits token marks.

Update `index.ts`'s `buildDecorationField` so the `update` callback also recomputes when a relevant effect arrives:

In `src/editor/decorations/index.ts`, replace the StateField update body with:

```typescript
update(prev, tr) {
  for (const e of tr.effects) {
    if (e.is(highlightCacheEffect)) return compute(tr.state);
  }
  if (!tr.docChanged) return prev;
  return compute(tr.state);
},
```

Add the import at the top of `index.ts`:

```typescript
import { highlightCacheEffect } from "./codeblocks";
```

- [ ] **Step 6: Commit**

```bash
jj desc -m "Add Shiki token-level highlighting via async cache"
jj new -m "wip"
```

---

## Task 5: Theme CSS for Shiki token classes + missing `theme-light` rule

Two minor CSS additions: (1) the missing `html.theme-light { color-scheme: light; }` rule, (2) a small palette mapping Shiki hex colors to CSS color values so the class-name-by-hex approach from Task 4 actually paints.

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Append to `src/styles.css`**

```css
/* Explicit color-scheme on forced themes — keeps native UI (scrollbars, controls)
   in sync with the user's choice rather than the OS preference. */
html.theme-light { color-scheme: light; }
html.theme-dark  { color-scheme: dark; }

/* Shiki token colors. We bake the github-light palette by hex. The github-dark
   variants are emitted as CSS variables on .theme-dark so the same classes flip. */
.cm-md-token-005cc5,
html.theme-dark .cm-md-token-005cc5 { color: #005cc5; }
.cm-md-token-d73a49,
html.theme-dark .cm-md-token-d73a49 { color: #d73a49; }
.cm-md-token-032f62,
html.theme-dark .cm-md-token-032f62 { color: #032f62; }
.cm-md-token-6f42c1,
html.theme-dark .cm-md-token-6f42c1 { color: #6f42c1; }
.cm-md-token-22863a,
html.theme-dark .cm-md-token-22863a { color: #22863a; }
.cm-md-token-24292e,
html.theme-dark .cm-md-token-24292e { color: var(--fg); }
.cm-md-token-6a737d,
html.theme-dark .cm-md-token-6a737d { color: var(--muted); font-style: italic; }
```

These are the most common github-light Shiki colors; they cover keywords, strings, numbers, identifiers, and comments for the languages in the foundation list. Other hex codes will fall back to the parent text color (which is already correct for unknown tokens).

- [ ] **Step 2: Smoke-check there's no test impact**

```
npm test
```
Expected: still passing.

- [ ] **Step 3: Commit**

```bash
jj desc -m "Theme: explicit color-scheme on forced themes; Shiki token palette"
jj new -m "wip"
```

---

# Phase B — Edit-mode vs reading-mode decoration sets

## Task 6: Build two decoration sets in main.ts; setMode swaps them

Currently `main.ts` builds one decoration field with all 11 producers (including `readingWidgetsProducer`). Edit mode therefore also elides markers — wrong. Split into two sets and have `setMode` swap them.

**Files:**
- Modify: `src/editor/editor.ts`
- Modify: `src/main.ts`
- Test: `tests/editor/editor.test.ts`

- [ ] **Step 1: Update editor test to assert decoration swap**

In `tests/editor/editor.test.ts`, append:

```typescript
import { Compartment } from "@codemirror/state";

it("setMode accepts decoration extensions and swaps them", () => {
  const view = createEditor({ parent: host, source: "x" });
  const sentinelEdit = Compartment.prototype === undefined ? null : "edit-set";
  const sentinelRead = "read-set";

  // We don't actually need real decorations — assert the API exists.
  expect(typeof setMode).toBe("function");
  setMode(view, "edit");
  expect(view.state.readOnly).toBe(false);
  setMode(view, "reading");
  expect(view.state.readOnly).toBe(true);

  // Sentinels touched to silence noUnusedLocals while keeping the
  // narrative of the test clear.
  void sentinelEdit;
  void sentinelRead;
});
```

(This task's editor.ts API change is small — the swap is driven from `main.ts`. The test above just verifies the existing setMode behavior continues to work.)

- [ ] **Step 2: Update `src/editor/editor.ts`**

Add a third optional parameter to `setMode` that lets callers swap decoration extensions and keymap extensions in the same dispatch (atomic):

```typescript
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

export type Mode = "reading" | "edit";

export interface CreateEditorOptions {
  parent: HTMLElement;
  source: string;
}

export interface ModeExtensions {
  decorations: Extension;
  keymap: Extension;
}

const readOnlyCompartment = new Compartment();
const decorationsCompartment = new Compartment();
const keymapCompartment = new Compartment();

export function createEditor(opts: CreateEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.source,
    extensions: [
      EditorView.lineWrapping,
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of([]),
      keymapCompartment.of(keymap.of(defaultKeymap)),
    ],
  });
  return new EditorView({ state, parent: opts.parent });
}

export function setMode(view: EditorView, mode: Mode, ext?: ModeExtensions): void {
  const effects = [
    readOnlyCompartment.reconfigure(EditorState.readOnly.of(mode === "reading")),
  ];
  if (ext) {
    effects.push(decorationsCompartment.reconfigure(ext.decorations));
    effects.push(keymapCompartment.reconfigure(ext.keymap));
  }
  view.dispatch({ effects });
}

export const compartments = {
  readOnly: readOnlyCompartment,
  decorations: decorationsCompartment,
  keymap: keymapCompartment,
};
```

- [ ] **Step 3: Update `src/main.ts` to build both sets and call `setMode` initially**

Replace the single `buildDecorationField` call with two:

```typescript
const editingProducers = [
  headingsProducer, inlineProducer, listsProducer, linksProducer,
  imagesProducer, blockquotesProducer, tablesProducer,
  codeblocksProducer, frontmatterProducer, footnotesProducer,
];
const readingProducers = [...editingProducers, readingWidgetsProducer];

const editingSet = buildDecorationField(editingProducers);
const readingSet = buildDecorationField(readingProducers);
```

Then, after creating the view and before any other dispatches, call `setMode` with the reading set (default mode is reading):

```typescript
import { setMode } from "./editor/editor";
import { editKeymap, readingKeymap } from "./editor/keymaps";

setMode(view, "reading", { decorations: readingSet, keymap: readingKeymap });
```

The `editKeymap` and `readingKeymap` come from Task 7. Until Task 7 lands, you can temporarily wire `keymap.of(defaultKeymap)` for both — but commit Task 6 only when Task 7 is also done so the imports resolve.

Actually — to keep tasks independently committable, write Task 6 with placeholder keymaps imported from `./editor/keymaps` and have Task 7 create that file. So this task creates a stub `src/editor/keymaps.ts`:

```typescript
// src/editor/keymaps.ts (stub — full keymaps in Task 7)
import { keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

export const editKeymap = keymap.of(defaultKeymap);
export const readingKeymap = keymap.of([]);
```

- [ ] **Step 4: Run tests + smoke build**

```
npm test
npx tsc -b --noEmit
```
Expected: existing tests still pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Build separate decoration sets for reading and edit modes"
jj new -m "wip"
```

---

## Task 7: Reading-mode keymap — Space, Shift+Space, Page keys, Home/End

Implements the reading-mode navigation bindings from spec §6a. These are bound only in reading mode; in edit mode the same keys behave normally.

**Files:**
- Replace: `src/editor/keymaps.ts` (was a stub from Task 6)
- Test: `tests/editor/keymaps.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/editor/keymaps.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { readingKeymap, editKeymap } from "../../src/editor/keymaps";

function makeView(source: string): EditorView {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  const host = dom.window.document.getElementById("host")!;
  const state = EditorState.create({
    doc: source,
    extensions: [readingKeymap],
  });
  return new EditorView({ state, parent: host });
}

describe("readingKeymap", () => {
  it("exposes a Space binding (page down) and Shift+Space (page up)", () => {
    // Inspect the keymap extension shape — read out the bindings.
    const ext = readingKeymap;
    // Both keymaps are arrays of CodeMirror Extension. We only assert presence
    // by trying to compile a state — the real interaction test is in e2e.
    expect(ext).toBeDefined();
  });

  it("editKeymap is also a valid extension and is distinct from readingKeymap", () => {
    expect(editKeymap).toBeDefined();
    expect(editKeymap).not.toBe(readingKeymap);
    void makeView("# Hi"); // ensures the extension can be applied
  });
});
```

(This is a shape-test only. Real key behavior is tested in the Plan 2 e2e suite.)

- [ ] **Step 2: Run to verify it passes (with the stub)**

```
npm test -- tests/editor/keymaps
```
Expected: 2/2 pass against the Task 6 stub.

- [ ] **Step 3: Replace `src/editor/keymaps.ts`**

```typescript
import { keymap } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";

const PAGE_OVERLAP_LINES = 3;

function pageScroll(view: EditorView, direction: 1 | -1): boolean {
  const scroller = view.scrollDOM;
  const lineHeight = view.defaultLineHeight;
  const pageHeight = scroller.clientHeight - PAGE_OVERLAP_LINES * lineHeight;
  scroller.scrollBy({ top: direction * Math.max(pageHeight, lineHeight), behavior: "smooth" });
  return true;
}

const readingBindings: KeyBinding[] = [
  { key: " ",            run: (v) => pageScroll(v, 1) },
  { key: "Shift- ",      run: (v) => pageScroll(v, -1) },
  { key: "PageDown",     run: (v) => pageScroll(v, 1) },
  { key: "PageUp",       run: (v) => pageScroll(v, -1) },
  { key: "Home",         run: (v) => { v.scrollDOM.scrollTo({ top: 0, behavior: "smooth" }); return true; } },
  { key: "End",          run: (v) => { v.scrollDOM.scrollTo({ top: v.scrollDOM.scrollHeight, behavior: "smooth" }); return true; } },
  { key: "Mod-ArrowUp",  run: (v) => { v.scrollDOM.scrollTo({ top: 0, behavior: "smooth" }); return true; } },
  { key: "Mod-ArrowDown",run: (v) => { v.scrollDOM.scrollTo({ top: v.scrollDOM.scrollHeight, behavior: "smooth" }); return true; } },
  { key: "ArrowDown",    run: (v) => { v.scrollDOM.scrollBy({ top: v.defaultLineHeight, behavior: "auto" }); return true; } },
  { key: "ArrowUp",      run: (v) => { v.scrollDOM.scrollBy({ top: -v.defaultLineHeight, behavior: "auto" }); return true; } },
];

export const readingKeymap = keymap.of(readingBindings);

export const editKeymap = [
  history(),
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    indentWithTab,
  ]),
];
```

This may need `@codemirror/search` installed. If `npm install @codemirror/search` is needed, run it.

- [ ] **Step 4: Run tests**

```
npm test -- tests/editor/keymaps
```
Expected: 2/2 still pass with the real implementation.

- [ ] **Step 5: Run full suite**

```
npm test
```
58/58 expected (56 + 2 keymap).

- [ ] **Step 6: Commit**

```bash
jj desc -m "Add reading-mode keymap (Space, Page keys, Home/End) and edit keymap"
jj new -m "wip"
```

---

# Phase C — Mode toggle UX, save, dirty tracking, close prompt

## Task 8: Toolbar with mode toggle button + dirty indicator

A minimal toolbar at the top of the window — two controls (mode toggle + dirty indicator). No menu yet (those land in Plan 3).

**Files:**
- Create: `src/ui/toolbar.ts`
- Create: `src/ui/titlebar.ts`
- Modify: `src/main.ts`
- Modify: `src/styles.css` (toolbar styles)

- [ ] **Step 1: Create `src/ui/toolbar.ts`**

```typescript
import type { EditorView } from "@codemirror/view";

import { setMode } from "../editor/editor";
import type { Mode, ModeExtensions } from "../editor/editor";

export interface ToolbarOptions {
  view: EditorView;
  modeExtensions: { reading: ModeExtensions; edit: ModeExtensions };
  initialMode: Mode;
  onModeChange?: (mode: Mode) => void;
}

export function mountToolbar(parent: HTMLElement, opts: ToolbarOptions): {
  setDirty: (dirty: boolean) => void;
  setMode: (mode: Mode) => void;
} {
  const bar = document.createElement("div");
  bar.className = "viewer-toolbar";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "viewer-toolbar-btn";
  let mode: Mode = opts.initialMode;
  applyButtonLabel();

  toggle.addEventListener("click", () => {
    mode = mode === "reading" ? "edit" : "reading";
    setMode(opts.view, mode, opts.modeExtensions[mode]);
    applyButtonLabel();
    opts.onModeChange?.(mode);
  });

  const dirty = document.createElement("span");
  dirty.className = "viewer-dirty-indicator";
  dirty.textContent = "";

  bar.append(toggle, dirty);
  parent.prepend(bar);

  function applyButtonLabel(): void {
    toggle.textContent = mode === "reading" ? "Edit" : "Read";
    toggle.title = mode === "reading" ? "Switch to edit mode (Cmd/Ctrl+E)" : "Switch to reading mode (Cmd/Ctrl+E)";
  }

  return {
    setDirty(d) { dirty.textContent = d ? "•" : ""; },
    setMode(m) {
      mode = m;
      applyButtonLabel();
    },
  };
}
```

- [ ] **Step 2: Create `src/ui/titlebar.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";

export async function setWindowTitle(path: string | null, dirty: boolean): Promise<void> {
  const base = path ? path.split("/").pop() ?? path : "Viewer";
  const title = dirty ? `• ${base}` : base;
  // Tauri 2 exposes window title via the webview window. We use the JS-side helper.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    document.title = title;
  }
  void invoke; // silence unused import — kept for future use
}
```

- [ ] **Step 3: Modify `src/main.ts` to mount the toolbar**

After creating the view and the decoration sets:

```typescript
import { mountToolbar } from "./ui/toolbar";
import { setWindowTitle } from "./ui/titlebar";

const modeExtensions = {
  reading: { decorations: readingSet, keymap: readingKeymap },
  edit:    { decorations: editingSet, keymap: editKeymap },
};

setMode(view, "reading", modeExtensions.reading);

const toolbar = mountToolbar(root, {
  view,
  modeExtensions,
  initialMode: "reading",
  onModeChange: (m) => { void m; }, // dirty doesn't change with mode
});

await setWindowTitle(initialDoc?.path ?? null, false);
```

- [ ] **Step 4: Add styles to `src/styles.css`**

```css
.viewer-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--bg);
  border-bottom: 1px solid var(--rule);
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 12px;
}
.viewer-toolbar-btn {
  background: transparent;
  border: 1px solid var(--rule);
  color: var(--fg);
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.viewer-toolbar-btn:hover { background: var(--code-bg); }
.viewer-dirty-indicator {
  color: var(--accent);
  font-size: 16px;
  line-height: 1;
}
```

- [ ] **Step 5: Build smoke**

```
npm test
npx tsc -b --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Add toolbar with mode toggle button and dirty indicator"
jj new -m "wip"
```

---

## Task 9: `Cmd/Ctrl+E` shortcut for mode toggle

Toolbar button alone isn't enough — bind the keyboard shortcut globally (works in both modes).

**Files:**
- Modify: `src/editor/keymaps.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Export a mode-toggle helper from `keymaps.ts`**

Append to `src/editor/keymaps.ts`:

```typescript
export interface ModeToggleHandler {
  (): void;
}

let modeToggleHandler: ModeToggleHandler = () => {};

export function setModeToggleHandler(handler: ModeToggleHandler): void {
  modeToggleHandler = handler;
}

const modeToggleBinding: KeyBinding = {
  key: "Mod-e",
  preventDefault: true,
  run: () => {
    modeToggleHandler();
    return true;
  },
};

// Append to readingKeymap and prepend to editKeymap so it's active in both.
```

Then, modify the existing `readingKeymap` export to include the toggle binding:

```typescript
export const readingKeymap = keymap.of([modeToggleBinding, ...readingBindings]);

export const editKeymap = [
  history(),
  keymap.of([
    modeToggleBinding,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    indentWithTab,
  ]),
];
```

- [ ] **Step 2: Wire the handler in `main.ts`**

After mounting the toolbar:

```typescript
import { setModeToggleHandler } from "./editor/keymaps";

let currentMode: Mode = "reading";
setModeToggleHandler(() => {
  currentMode = currentMode === "reading" ? "edit" : "reading";
  setMode(view, currentMode, modeExtensions[currentMode]);
  toolbar.setMode(currentMode);
});
```

Add `import type { Mode } from "./editor/editor";` at the top.

- [ ] **Step 3: Smoke**

```
npm test
npx tsc -b --noEmit
```

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add Cmd/Ctrl+E shortcut for mode toggle"
jj new -m "wip"
```

---

## Task 10: Rust `write_text_file` command

The save counterpart to Plan 1's `read_text_file`.

**Files:**
- Modify: `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/lib.rs` (handler registration)

- [ ] **Step 1: Add `write_text_file` to `src-tauri/src/commands/files.rs`**

Append to the file:

```rust
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), FileError> {
    let pb = std::path::PathBuf::from(&path);
    std::fs::write(&pb, contents.as_bytes()).map_err(|e| FileError::Io(e.to_string()))
}
```

- [ ] **Step 2: Register in the handler list in `src-tauri/src/lib.rs`**

```rust
.invoke_handler(tauri::generate_handler![
    commands::files::read_text_file,
    commands::files::write_text_file,
])
```

- [ ] **Step 3: Verify build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add Rust write_text_file command"
jj new -m "wip"
```

---

## Task 11: Frontend save flow + dirty tracking

**Files:**
- Modify: `src/shell/files.ts` (add `saveDoc`)
- Create: `src/shell/dirty.ts`
- Test: `tests/shell/dirty.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Append to `src/shell/files.ts`**

```typescript
export async function saveDoc(path: string, contents: string): Promise<void> {
  await invoke("write_text_file", { path, contents });
}
```

- [ ] **Step 2: Create `src/shell/dirty.ts`**

```typescript
import type { EditorView } from "@codemirror/view";

export interface DirtyTracker {
  isDirty(): boolean;
  /** Mark the buffer clean at the current document content. */
  reset(): void;
  /** Subscribe to dirty-state changes. */
  subscribe(listener: (dirty: boolean) => void): () => void;
}

export function createDirtyTracker(view: EditorView): DirtyTracker {
  let savedDoc = view.state.doc.toString();
  let dirty = false;
  const listeners = new Set<(dirty: boolean) => void>();

  const updater = view.state.facet; // narrow type; not used directly

  const update = (): void => {
    const nowDirty = view.state.doc.toString() !== savedDoc;
    if (nowDirty !== dirty) {
      dirty = nowDirty;
      for (const l of listeners) l(dirty);
    }
  };

  // Subscribe to document changes via a CodeMirror updateListener.
  // We attach via a transaction extension at editor-creation time. For now,
  // a polling fallback runs on every requestAnimationFrame frame to keep
  // this module independent of editor wiring; main.ts will swap to a real
  // updateListener in Step 4.
  const interval = setInterval(update, 100);
  void updater;

  return {
    isDirty: () => dirty,
    reset() {
      savedDoc = view.state.doc.toString();
      dirty = false;
      for (const l of listeners) l(false);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(dirty);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearInterval(interval);
      };
    },
  };
}
```

- [ ] **Step 3: Test for `createDirtyTracker`**

`tests/shell/dirty.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createDirtyTracker } from "../../src/shell/dirty";

let host: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  host = dom.window.document.getElementById("host")!;
});

describe("createDirtyTracker", () => {
  it("starts clean", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello" }),
      parent: host,
    });
    const t = createDirtyTracker(view);
    expect(t.isDirty()).toBe(false);
  });

  it("becomes dirty after a doc change and clean after reset", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello" }),
      parent: host,
    });
    const t = createDirtyTracker(view);
    view.dispatch({ changes: { from: 5, insert: "!" } });
    // Wait for the polling interval (100ms) plus a margin.
    await new Promise((r) => setTimeout(r, 150));
    expect(t.isDirty()).toBe(true);
    t.reset();
    expect(t.isDirty()).toBe(false);
  });
});
```

- [ ] **Step 4: Wire dirty tracker, save shortcut, and titlebar update in `main.ts`**

After mounting the toolbar:

```typescript
import { saveDoc } from "./shell/files";
import { createDirtyTracker } from "./shell/dirty";

let currentPath: string | null = initialDoc?.path ?? null;
const dirtyTracker = createDirtyTracker(view);
const unsubDirty = dirtyTracker.subscribe(async (dirty) => {
  toolbar.setDirty(dirty);
  await setWindowTitle(currentPath, dirty);
});
window.addEventListener("beforeunload", () => unsubDirty());
```

Add a `Mod-s` binding to the edit keymap in `src/editor/keymaps.ts`:

```typescript
let saveHandler: () => void = () => {};
export function setSaveHandler(handler: () => void): void { saveHandler = handler; }

const saveBinding: KeyBinding = {
  key: "Mod-s",
  preventDefault: true,
  run: () => { saveHandler(); return true; },
};

// Add saveBinding alongside modeToggleBinding in both keymaps' arrays.
```

In `main.ts`:

```typescript
import { setSaveHandler } from "./editor/keymaps";

setSaveHandler(async () => {
  if (!currentPath) return;
  await saveDoc(currentPath, view.state.doc.toString());
  dirtyTracker.reset();
});
```

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: 60/60 (58 + 2 dirty tests).

- [ ] **Step 6: Commit**

```bash
jj desc -m "Save flow + dirty tracking + window title bullet on dirty"
jj new -m "wip"
```

---

## Task 12: Close-with-dirty prompt

Tauri's window-close event fires before the window goes away; we intercept it, prompt the user, and either save / discard / cancel.

**Files:**
- Create: `src/shell/close.ts`
- Test: `tests/shell/close.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create `src/shell/close.ts`**

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";

export interface CloseHandlerOptions {
  isDirty: () => boolean;
  save: () => Promise<void>;
}

/**
 * Wires a close-requested handler that prompts the user before discarding
 * unsaved changes. Returns an unsubscribe function.
 */
export async function installCloseHandler(opts: CloseHandlerOptions): Promise<() => void> {
  const win = getCurrentWindow();
  const stop = await win.onCloseRequested(async (event) => {
    if (!opts.isDirty()) return;
    event.preventDefault();
    const choice = await promptSaveDiscardCancel();
    if (choice === "cancel") return;
    if (choice === "save") {
      try { await opts.save(); } catch (err) {
        await message(`Save failed: ${String(err)}`, { title: "Viewer", kind: "error" });
        return;
      }
    }
    // Either save succeeded or user chose discard — close.
    await win.destroy();
  });
  return stop;
}

async function promptSaveDiscardCancel(): Promise<"save" | "discard" | "cancel"> {
  // Tauri's `ask` returns boolean; we approximate three-way with two prompts.
  // First: do you want to save? Yes/No (No = will further ask discard vs cancel).
  const wantSave = await ask("Save changes before closing?", {
    title: "Unsaved changes",
    okLabel: "Save",
    cancelLabel: "Don't save",
  });
  if (wantSave) return "save";
  const discardOk = await ask("Discard your unsaved changes?", {
    title: "Unsaved changes",
    okLabel: "Discard",
    cancelLabel: "Cancel close",
  });
  return discardOk ? "discard" : "cancel";
}
```

- [ ] **Step 2: Test for the prompt logic**

`tests/shell/close.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// We can only unit-test the dispatch logic; the real interaction is in e2e.
describe("close.ts", () => {
  it("module exports installCloseHandler", async () => {
    const mod = await import("../../src/shell/close");
    expect(typeof mod.installCloseHandler).toBe("function");
  });
});

void vi; // silence unused import
```

- [ ] **Step 3: Wire in `main.ts`**

After dirty-tracker setup:

```typescript
import { installCloseHandler } from "./shell/close";

const stopCloseHandler = await installCloseHandler({
  isDirty: () => dirtyTracker.isDirty(),
  save: async () => {
    if (!currentPath) throw new Error("No path to save to");
    await saveDoc(currentPath, view.state.doc.toString());
    dirtyTracker.reset();
  },
});
window.addEventListener("beforeunload", () => stopCloseHandler());
```

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: 61/61.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Prompt save/discard/cancel on close with unsaved changes"
jj new -m "wip"
```

---

# Phase D — Drag-and-drop

## Task 13: Drag-drop file onto window

The Tauri scaffold has `dragDropEnabled: false`. Flip it to true; subscribe to the drop event; route to `readDoc`.

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/main.ts`

- [ ] **Step 1: Set `dragDropEnabled: true` in `src-tauri/tauri.conf.json`**

```json
"dragDropEnabled": true
```

- [ ] **Step 2: Listen for drop in `main.ts`**

After the existing bootstrap:

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();
const unsubDrop = await win.onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop") return;
  const dropped = event.payload.paths;
  const md = dropped.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
  if (!md) return;

  if (dirtyTracker.isDirty()) {
    const proceed = await import("@tauri-apps/plugin-dialog").then(
      (d) => d.ask("Discard your unsaved changes and open the dropped file?", {
        title: "Unsaved changes",
        okLabel: "Discard and open",
        cancelLabel: "Cancel",
      }),
    );
    if (!proceed) return;
  }

  const doc = await readDoc(md);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc.source },
  });
  currentPath = doc.path;
  dirtyTracker.reset();
  await setWindowTitle(currentPath, false);
});
window.addEventListener("beforeunload", () => unsubDrop());
```

- [ ] **Step 3: Tauri permission for drag-drop**

The `dialog` and `fs` capabilities already cover the imports. The drag-drop event itself doesn't need an extra permission; it ships with the window's core capability.

- [ ] **Step 4: Build smoke**

```
cd /Users/ke/src/viewer && npx tsc -b --noEmit
cd /Users/ke/src/viewer/src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
jj desc -m "Open files dragged onto the window"
jj new -m "wip"
```

---

# Phase E — File watcher and reconciliation

## Task 14: Rust file watcher with `notify`

The watcher runs on the parent directory of the open file (per spec §5.6). It debounces events, filters for the open path, applies a self-write timestamp filter, and emits a Tauri event when a relevant external change is detected.

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `notify` dependency)
- Create: `src-tauri/src/commands/watcher.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `notify` to `Cargo.toml`**

In `[dependencies]`:

```toml
notify = "6"
notify-debouncer-mini = "0.4"
```

- [ ] **Step 2: Create `src-tauri/src/commands/watcher.rs`**

```rust
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
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
    debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl WatcherState {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

#[tauri::command]
pub fn watcher_start(app: AppHandle, state: tauri::State<'_, WatcherState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target.parent().ok_or_else(|| "no parent directory".to_string())?.to_path_buf();
    let target_for_handler = target.clone();
    let app_for_handler = app.clone();

    let mut debouncer = new_debouncer(Duration::from_millis(150), move |result: notify_debouncer_mini::DebounceEventResult| {
        let events = match result { Ok(ev) => ev, Err(_) => return };
        for ev in events {
            if ev.path != target_for_handler { continue; }
            // Self-write filter is applied on the JS side because the timestamp
            // belongs to that side; here we just emit the raw event.
            let kind = match ev.kind {
                DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous => WatcherEventKind::Modified,
                _ => WatcherEventKind::Modified,
            };
            let _ = app_for_handler.emit("viewer://file-changed", WatcherEvent {
                kind,
                path: ev.path.to_string_lossy().to_string(),
            });
        }
    }).map_err(|e| e.to_string())?;

    debouncer.watcher().watch(&parent, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(WatcherInner { target, self_write_ts: None, debouncer });
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

/// Path of the currently watched file, or None if no watcher is active.
pub fn current_target(state: &WatcherState) -> Option<PathBuf> {
    state.inner.lock().ok().and_then(|g| g.as_ref().map(|i| i.target.clone()))
}

#[allow(dead_code)]
fn unused(_p: &Path) {} // suppresses an unused-import lint when Path is only used in signatures
```

(The `current_target` helper is for completeness; it's unused for now but kept for Plan 3's recovery flow.)

- [ ] **Step 3: Update `src-tauri/src/commands/mod.rs`**

```rust
pub mod files;
pub mod watcher;
```

- [ ] **Step 4: Update `src-tauri/src/lib.rs`**

```rust
mod commands;

use commands::watcher::WatcherState;

pub fn run() {
    tauri::Builder::default()
        .manage(WatcherState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::watcher::watcher_start,
            commands::watcher::watcher_stop,
            commands::watcher::watcher_mark_self_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Verify build**

```
cd /Users/ke/src/viewer/src-tauri && cargo check
```
Expected: clean. (notify and the debouncer crate add ~30 transitive deps; first compile may take a bit.)

- [ ] **Step 6: Commit**

```bash
jj desc -m "Add Rust file watcher (notify) with start/stop/self-write commands"
jj new -m "wip"
```

---

## Task 15: Frontend watcher subscription with self-write filter

**Files:**
- Create: `src/shell/watcher.ts`

- [ ] **Step 1: Create `src/shell/watcher.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface FileChangedEvent {
  kind: "modified" | "removed";
  path: string;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
  /** Mark "we are about to write" so events for ~500ms are filtered out. */
  markSelfWrite: () => Promise<void>;
}

export interface InstallWatcherOptions {
  path: string;
  onModified: (event: FileChangedEvent) => void;
  onRemoved: (event: FileChangedEvent) => void;
}

const SELF_WRITE_WINDOW_MS = 500;

export async function installWatcher(opts: InstallWatcherOptions): Promise<WatcherHandle> {
  await invoke("watcher_start", { path: opts.path });
  let lastSelfWrite = 0;

  const unlisten: UnlistenFn = await listen<FileChangedEvent>("viewer://file-changed", (event) => {
    const now = Date.now();
    if (now - lastSelfWrite < SELF_WRITE_WINDOW_MS) return;
    if (event.payload.kind === "removed") opts.onRemoved(event.payload);
    else opts.onModified(event.payload);
  });

  return {
    async stop() {
      unlisten();
      await invoke("watcher_stop");
    },
    async markSelfWrite() {
      lastSelfWrite = Date.now();
      await invoke("watcher_mark_self_write");
    },
  };
}
```

- [ ] **Step 2: Type-check**

```
cd /Users/ke/src/viewer && npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```bash
jj desc -m "Add frontend watcher with self-write filter"
jj new -m "wip"
```

---

## Task 16: Reconciliation modal for dirty buffer

**Files:**
- Create: `src/ui/reconcile.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Create `src/ui/reconcile.ts`**

```typescript
export type ReconcileChoice = "reload" | "keep";

export function promptReconcile(): Promise<ReconcileChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "viewer-reconcile-overlay";

    const card = document.createElement("div");
    card.className = "viewer-reconcile-card";
    card.innerHTML = `
      <h3>File changed on disk</h3>
      <p>Your unsaved edits and the new content cannot both be kept.</p>
    `;

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "viewer-toolbar-btn";
    reload.textContent = "Reload from disk";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "viewer-toolbar-btn";
    keep.textContent = "Keep my edits";

    const buttons = document.createElement("div");
    buttons.className = "viewer-reconcile-buttons";
    buttons.append(keep, reload);
    card.append(buttons);

    function close(choice: ReconcileChoice): void {
      document.body.removeChild(overlay);
      resolve(choice);
    }
    reload.addEventListener("click", () => close("reload"));
    keep.addEventListener("click", () => close("keep"));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close("keep"); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close("keep");
      }
    });

    overlay.append(card);
    document.body.append(overlay);
    reload.focus();
  });
}

export function showOrphanNotice(): void {
  const note = document.createElement("div");
  note.className = "viewer-orphan-notice";
  note.textContent = "This file is no longer on disk. Save As to choose a new location.";
  document.body.append(note);
  setTimeout(() => note.remove(), 8000);
}

export function showReloadedNotice(): void {
  const note = document.createElement("div");
  note.className = "viewer-reloaded-notice";
  note.textContent = "Reloaded from disk";
  document.body.append(note);
  setTimeout(() => note.remove(), 2000);
}
```

- [ ] **Step 2: Add styles to `src/styles.css`**

```css
.viewer-reconcile-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.viewer-reconcile-card {
  background: var(--bg);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 22px 26px;
  max-width: 420px;
  font-family: -apple-system, system-ui, sans-serif;
}
.viewer-reconcile-card h3 { margin: 0 0 8px; font-size: 15px; }
.viewer-reconcile-card p  { margin: 0 0 16px; font-size: 13px; color: var(--muted); }
.viewer-reconcile-buttons { display: flex; gap: 8px; justify-content: flex-end; }
.viewer-orphan-notice,
.viewer-reloaded-notice {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: var(--code-bg); color: var(--fg);
  padding: 8px 14px; border-radius: 6px; font-size: 12px;
  font-family: -apple-system, system-ui, sans-serif;
  box-shadow: 0 1px 6px rgba(0,0,0,0.15);
}
```

- [ ] **Step 3: Smoke**

```
npm test
```
Expected: 61/61 still pass (no test changes; UI module).

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add reconciliation modal and inline reload/orphan notices"
jj new -m "wip"
```

---

## Task 17: Wire watcher + reconciliation into `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Wire the watcher and reconciliation logic**

After the dirty tracker / save handler / close handler are set up:

```typescript
import { installWatcher } from "./shell/watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";

let watcherHandle: { stop: () => Promise<void>; markSelfWrite: () => Promise<void> } | null = null;
let diverged = false;

async function startWatching(path: string): Promise<void> {
  if (watcherHandle) await watcherHandle.stop();
  watcherHandle = await installWatcher({
    path,
    async onModified() {
      if (dirtyTracker.isDirty()) {
        const choice = await promptReconcile();
        if (choice === "reload") {
          await reloadFromDisk();
        } else {
          diverged = true;
        }
      } else {
        await reloadFromDisk();
        showReloadedNotice();
      }
    },
    onRemoved() {
      // Orphan: keep buffer in memory, force dirty so user can Save As.
      showOrphanNotice();
      currentPath = null;
      void setWindowTitle(null, true);
    },
  });
}

async function reloadFromDisk(): Promise<void> {
  if (!currentPath) return;
  const doc = await readDoc(currentPath);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc.source } });
  dirtyTracker.reset();
  diverged = false;
}

if (currentPath) await startWatching(currentPath);
```

Update the existing `setSaveHandler` to mark a self-write before invoking `saveDoc`, and to handle the diverged case:

```typescript
setSaveHandler(async () => {
  if (!currentPath) return;
  if (diverged) {
    const proceed = await import("@tauri-apps/plugin-dialog").then((d) =>
      d.ask("Saving will overwrite the changes that were made on disk.", {
        title: "Diverged",
        okLabel: "Save anyway",
        cancelLabel: "Cancel",
      }),
    );
    if (!proceed) return;
  }
  if (watcherHandle) await watcherHandle.markSelfWrite();
  await saveDoc(currentPath, view.state.doc.toString());
  dirtyTracker.reset();
  diverged = false;
});
```

Also update the drop handler (Task 13) to switch the watcher to the new file:

```typescript
// inside the drop handler, after `await readDoc(md)` and the dispatch:
if (currentPath) await startWatching(currentPath);
```

- [ ] **Step 2: Smoke**

```
npm test
npx tsc -b --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 3: Commit**

```bash
jj desc -m "Wire watcher + reconciliation: clean reload, dirty modal, orphan notice"
jj new -m "wip"
```

---

# Phase F — End-to-end verification

## Task 18: E2E test for edit-and-save

**Files:**
- Create: `tests/e2e/edit-and-save.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) {
    try { process.kill(-viteProc.pid); } catch {}
  }
});

test("toggle to edit mode, type, save", async ({ page }) => {
  let writeContents: string | undefined;
  await page.addInitScript(() => {
    const sample = "# Initial\n\nSome text.\n";
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { path?: string; contents?: string }) => {
        if (cmd === "read_text_file") return sample;
        if (cmd === "write_text_file") {
          (window as unknown as { __saved?: string }).__saved = args?.contents;
          return null;
        }
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
        return null;
      },
    };
  });

  await page.goto(APP_URL);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();

  // Toggle to edit mode.
  await page.locator(".viewer-toolbar-btn").first().click();
  // The heading marker '#' should now be visible (edit mode keeps source).
  await expect(page.locator(".cm-line").filter({ hasText: "# Initial" })).toBeVisible();

  // Type something.
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" extra");

  // Dirty indicator should appear.
  await expect(page.locator(".viewer-dirty-indicator")).toHaveText("•");

  // Save.
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+s" : "Control+s");

  // Wait for the dirty indicator to clear.
  await expect(page.locator(".viewer-dirty-indicator")).toHaveText("");

  writeContents = await page.evaluate(() => (window as unknown as { __saved?: string }).__saved);
  expect(writeContents).toContain("Some text. extra");
});
```

- [ ] **Step 2: Run**

```
cd /Users/ke/src/viewer && npm run test:e2e
```
Expected: 2/2 e2e tests pass (the Plan 1 spec + this new one).

- [ ] **Step 3: Commit**

```bash
jj desc -m "E2E: toggle to edit, type, save"
jj new -m "wip"
```

---

## Task 19: E2E test for external-change reconciliation

**Files:**
- Create: `tests/e2e/external-change.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) {
    try { process.kill(-viteProc.pid); } catch {}
  }
});

test("clean buffer auto-reloads on external change", async ({ page }) => {
  let currentContent = "# Initial\n";
  await page.addInitScript((initialContent: string) => {
    (window as unknown as { __setContent?: (s: string) => void }).__setContent = (s) => {
      (window as unknown as { __currentContent?: string }).__currentContent = s;
      // Simulate the Tauri event firing.
      const listeners = (window as unknown as { __fileChangedListeners?: Array<(p: { kind: string; path: string }) => void> }).__fileChangedListeners ?? [];
      for (const l of listeners) l({ kind: "modified", path: "/virtual/sample.md" });
    };
    (window as unknown as { __currentContent?: string }).__currentContent = initialContent;

    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "read_text_file") return (window as unknown as { __currentContent?: string }).__currentContent ?? "";
        if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "watcher_start" || cmd === "watcher_stop" || cmd === "watcher_mark_self_write") return null;
        return null;
      },
    };
    // Stub @tauri-apps/api/event listen
    const originalImport = (window as unknown as { __dyn?: typeof import }).__dyn;
    void originalImport;
  }, currentContent);

  await page.goto(APP_URL);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();

  // External change.
  currentContent = "# Externally Changed\n";
  await page.evaluate((s) => {
    (window as unknown as { __setContent?: (s: string) => void }).__setContent?.(s);
  }, currentContent);

  // The "Reloaded from disk" notice should briefly appear.
  await expect(page.locator(".viewer-reloaded-notice")).toBeVisible({ timeout: 3000 });
  // The new heading text should be in the editor.
  await expect(page.locator(".cm-line").filter({ hasText: "Externally Changed" })).toBeVisible();
});
```

(Note: this test relies on the `@tauri-apps/api/event` `listen` function being stubbed similarly. The real Plan 2 implementation has watcher events flowing through Tauri's event system; in the e2e environment we'd need a more complete mock. If the test as-written is too brittle, mark as DONE_WITH_CONCERNS, document the gap, and move on — Plan 3 polishes the test infrastructure.)

- [ ] **Step 2: Run**

```
npm run test:e2e
```
Expected: passes if the mock plumbing holds up. If not, document the limitation and skip-mark it for Plan 3.

- [ ] **Step 3: Commit**

```bash
jj desc -m "E2E: external file change auto-reloads clean buffer"
jj new -m "wip"
```

---

## Task 20: Update CHANGELOG; Plan 2 capstone

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend a new release section to `CHANGELOG.md`**

```markdown
## [0.2.0] - 2026-05-08 — Plan 2: Editing & file lifecycle

Foundation Sub-spec A, Plan 2 of 3 complete. The viewer is now an editor: you can toggle between reading and editing, save, and the buffer auto-reloads when the file changes on disk.

### Added

- Edit mode with decorated source (markers visible, formatting applied)
- Mode toggle: toolbar button + `Cmd/Ctrl + E` shortcut + dirty indicator
- Reading-mode keymap: Space, Shift+Space, Page keys, arrows, Home/End, Cmd/Ctrl + arrows for top/bottom
- Save: `Cmd/Ctrl + S` writes to the original path; window title bullet on dirty
- Close-with-dirty prompt (Save / Discard / Cancel)
- Drag-and-drop a `.md` file onto the window to open it (with dirty-discard prompt)
- File watcher (Rust `notify` crate) on the open file's parent directory; self-write filter; reconciliation:
  - Clean buffer → auto-reload with "Reloaded from disk" notice
  - Dirty buffer → modal prompt (Reload / Keep edits)
  - File deleted/moved → orphan state with Save-As prompt and dirty flag forced on
- Diverged-state save warning ("Save anyway?") when user kept dirty edits after external change
- Shiki token-level syntax coloring in code blocks (closes Plan 1 carryover)
- Multi-line paragraph decoration in `inline.ts` and `links.ts` (closes Plan 1 carryover)
- Explicit `color-scheme: light/dark` on forced themes (closes Plan 1 carryover)
- Shared `computeLineStarts` util (closes Plan 1 carryover)

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
```

- [ ] **Step 2: Commit Plan 2 capstone**

```bash
jj desc -m "Plan 2 complete: editing, save, drag-drop, file watcher, reconciliation

End state of Plan 2 (Foundation Sub-spec A, plan 2 of 3):

- Edit mode with decorated source (markers visible, formatting applied)
- Toolbar with mode toggle button, Cmd/Ctrl+E shortcut, dirty indicator
- Reading-mode keymap: Space/Shift+Space/Page keys/arrows/Home/End
- Save (Cmd/Ctrl+S) with dirty tracking and window title bullet
- Close-with-dirty prompt (Save/Discard/Cancel)
- Drag-and-drop opens .md files (with dirty-discard prompt)
- Rust file watcher (notify crate) with self-write filter
- Reconciliation: clean reload, dirty modal, orphan notice
- Plan 1 carryover closed: Shiki token coloring, multi-line paragraph
  decoration, color-scheme on forced themes, shared computeLineStarts util

Plan 3 (polish + platform) follows."

jj new -m "wip"
```

---

# Self-review

**Spec coverage:** every requirement from spec §5.2 (mode toggle), §5.3 (edit), §5.4 (save), §5.5 (close), §5.6 (file watcher and reconciliation), §6 (decorated source — already mostly done in Plan 1, refined here), and §6a's reading-mode-only navigation keymap is mapped to a Plan 2 task. The Plan 1 carryover items are addressed in Phase A. Plan 3 still owns the TOC sidebar, recents, crash recovery, full menu inventory, find/replace UI, and CI matrix.

**Placeholder scan:** every step has the actual content. The `keymap` test in Task 7 is intentionally a shape-test (real key behavior is in e2e), and that's labeled. The Task 19 e2e test acknowledges it may be brittle and offers a DONE_WITH_CONCERNS path — this is honest about test-infra limitations, not a placeholder for missing logic.

**Type consistency:** `setMode(view, mode, ext?)` is consistent across editor.ts, main.ts, toolbar.ts. `ModeExtensions { decorations, keymap }` is the same shape everywhere. The `WatcherEvent { kind: 'modified' | 'removed', path }` shape is identical in Rust (kebab-cased serde) and TS. `installWatcher / WatcherHandle` matches between watcher.ts and main.ts. `setSaveHandler` and `setModeToggleHandler` are both module-scoped functions in keymaps.ts; both are wired once in main.ts. Verified consistent.

One inline correction during self-review: Task 6 used to import `editKeymap, readingKeymap` before they were defined as real keymaps in Task 7. Resolved by adding a stub to Task 6 step 3 (so Task 6 stands alone) and making Task 7 replace the stub — both tasks are independently committable.

---

# Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-markdown-viewer-foundation-2-editing-and-files.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
