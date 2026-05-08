# Markdown Viewer Foundation — Plan 1: Read-only viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Tauri desktop app that opens a `.md` file (via OS "Open With", drag-drop is plan 2, or CLI arg) and renders it in beautiful, themed read-only mode using a CodeMirror 6 editor configured with decoration plugins for every CommonMark + GFM construct.

**Architecture:** Tauri (Rust shell) + Vite + TypeScript frontend. Document is a single CodeMirror 6 EditorView with three compartments (`readOnly`, `decorations`, `keymap`) — this plan locks the editor into reading mode (`readOnly: true` + reading-set decorations + reading-mode keymap stub). markdown-it parses the source; per-construct decoration plugins translate the parse tree into CodeMirror `DecorationSet`s. The Rust shell is a thin FS bridge — open file, read bytes, return.

**Tech Stack:** Tauri 2.x, Rust (stable, edition 2024), TypeScript 5.x, Vite 5.x, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-markdown`), markdown-it 14.x with `markdown-it-task-lists`, `markdown-it-footnote`, `markdown-it-deflist`, Shiki 1.x, DOMPurify 3.x. Tests: Vitest 1.x, Playwright 1.x, jsdom.

**Spec:** `docs/superpowers/specs/2026-05-08-markdown-viewer-foundation-design.md` — read it before starting any task.

**This plan delivers:** a runnable desktop app that, when launched with a `.md` path as its argument, opens a window showing the document rendered with full CommonMark + GFM, light/dark/OS-follow themes, and per-construct decorations matching §6 of the spec. Editing, save, sidebar, watcher, recents, full menus, and CI matrix are deferred to Plans 2 and 3.

---

## File structure

By the end of Plan 1 the repo looks like this. Files marked **(Plan 1)** are created in this plan; **(later)** are placeholders we leave for Plans 2 and 3 to fill in.

```
viewer/
├── package.json                                        (Plan 1)
├── tsconfig.json                                       (Plan 1)
├── vite.config.ts                                      (Plan 1)
├── vitest.config.ts                                    (Plan 1)
├── playwright.config.ts                                (Plan 1)
├── index.html                                          (Plan 1)
├── .gitignore                                          (already exists)
├── src-tauri/
│   ├── Cargo.toml                                      (Plan 1)
│   ├── tauri.conf.json                                 (Plan 1)
│   ├── build.rs                                        (Plan 1)
│   └── src/
│       ├── main.rs                                     (Plan 1)
│       ├── lib.rs                                      (Plan 1)
│       └── commands/
│           └── files.rs                                (Plan 1)   # read_text_file
├── src/
│   ├── main.ts                                         (Plan 1)
│   ├── styles.css                                      (Plan 1)
│   ├── editor/
│   │   ├── editor.ts                                   (Plan 1)
│   │   ├── parser.ts                                   (Plan 1)
│   │   ├── theme.ts                                    (Plan 1)
│   │   └── decorations/
│   │       ├── index.ts                                (Plan 1)
│   │       ├── headings.ts                             (Plan 1)
│   │       ├── inline.ts                               (Plan 1)
│   │       ├── lists.ts                                (Plan 1)
│   │       ├── links.ts                                (Plan 1)
│   │       ├── images.ts                               (Plan 1)
│   │       ├── blockquotes.ts                          (Plan 1)
│   │       ├── tables.ts                               (Plan 1)
│   │       ├── codeblocks.ts                           (Plan 1)
│   │       ├── frontmatter.ts                          (Plan 1)
│   │       ├── footnotes.ts                            (Plan 1)
│   │       └── reading-widgets.ts                      (Plan 1)
│   ├── shell/
│   │   ├── files.ts                                    (Plan 1)
│   │   ├── recents.ts                                  (later)
│   │   ├── recovery.ts                                 (later)
│   │   ├── watcher.ts                                  (later)
│   │   ├── menus.ts                                    (later)
│   │   └── shortcuts.ts                                (later)
│   └── ui/
│       ├── titlebar.ts                                 (later)
│       ├── toolbar.ts                                  (later)
│       └── sidebar/                                    (later)
└── tests/
    ├── parser/
    │   ├── parser.test.ts                              (Plan 1)
    │   └── fixtures/                                   (Plan 1)
    ├── decorations/
    │   ├── headings.test.ts                            (Plan 1)
    │   ├── inline.test.ts                              (Plan 1)
    │   ├── lists.test.ts                               (Plan 1)
    │   ├── links.test.ts                               (Plan 1)
    │   ├── images.test.ts                              (Plan 1)
    │   ├── blockquotes.test.ts                         (Plan 1)
    │   ├── tables.test.ts                              (Plan 1)
    │   ├── codeblocks.test.ts                          (Plan 1)
    │   ├── frontmatter.test.ts                         (Plan 1)
    │   └── footnotes.test.ts                           (Plan 1)
    └── e2e/
        └── open-and-render.spec.ts                     (Plan 1)
```

**Boundary discipline:** every file in `decorations/` exports a single `DecorationSource` factory function. They never import each other. They share types via `decorations/index.ts`. Plan 2's edit-mode decorations will be variants of these same files — the Plan 1 factories are the source of truth for the reading-mode behavior; the edit-mode code added in Plan 2 will be in the same files, exposed as separate factory functions.

---

# Phase 1 — Project scaffold

## Task 1: Initialize Node + Tauri 2 project skeleton

**Files:**
- Create: `viewer/package.json`
- Create: `viewer/tsconfig.json`
- Create: `viewer/vite.config.ts`
- Create: `viewer/index.html`
- Create: `viewer/src/main.ts`
- Create: `viewer/src/styles.css`
- Create: `viewer/src-tauri/Cargo.toml`
- Create: `viewer/src-tauri/tauri.conf.json`
- Create: `viewer/src-tauri/build.rs`
- Create: `viewer/src-tauri/src/main.rs`
- Create: `viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "viewer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@codemirror/lang-markdown": "^6.3.0",
    "@codemirror/language": "^6.10.3",
    "@codemirror/state": "^6.4.1",
    "@codemirror/view": "^6.34.1",
    "@tauri-apps/api": "^2.1.1",
    "@tauri-apps/plugin-dialog": "^2.0.1",
    "@tauri-apps/plugin-fs": "^2.0.2",
    "dompurify": "^3.2.0",
    "markdown-it": "^14.1.0",
    "markdown-it-deflist": "^3.0.0",
    "markdown-it-footnote": "^4.0.0",
    "markdown-it-task-lists": "^2.1.1",
    "shiki": "^1.24.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "@tauri-apps/cli": "^2.1.0",
    "@types/dompurify": "^3.0.5",
    "@types/markdown-it": "^14.1.2",
    "@types/node": "^22.9.0",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```typescript
import { defineConfig } from "vite";

const tauriHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: tauriHost ?? false,
    hmr: tauriHost
      ? { protocol: "ws", host: tauriHost, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Viewer</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/main.ts` (placeholder)**

```typescript
const root = document.getElementById("root");
if (root) {
  root.textContent = "Viewer loading…";
}
```

- [ ] **Step 6: Create `src/styles.css`**

```css
:root {
  color-scheme: light dark;
}

html, body, #root {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
}
```

- [ ] **Step 7: Create `src-tauri/Cargo.toml`**

```toml
[package]
name = "viewer"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"

[lib]
name = "viewer_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
thiserror = "1"
```

- [ ] **Step 8: Create `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 9: Create `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Viewer",
  "version": "0.1.0",
  "identifier": "com.viewer.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Viewer",
        "width": 1000,
        "height": 760,
        "minWidth": 480,
        "minHeight": 320,
        "fileDropEnabled": false
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  }
}
```

- [ ] **Step 10: Create `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    viewer_lib::run();
}
```

- [ ] **Step 11: Create `src-tauri/src/lib.rs`**

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 12: Install dependencies**

Run: `cd viewer && npm install`
Expected: completes without errors. A `node_modules/` and `package-lock.json` appear.

- [ ] **Step 13: Smoke-test the dev build**

Run: `cd viewer && npm run tauri:dev`
Expected: a window opens titled "Viewer" showing "Viewer loading…". Quit the window when verified.

- [ ] **Step 14: Commit**

```bash
jj desc -m "Scaffold Tauri 2 + Vite + TypeScript project"
jj new -m "wip"
```

---

## Task 2: Set up Vitest + Playwright test infrastructure

**Files:**
- Create: `viewer/vitest.config.ts`
- Create: `viewer/playwright.config.ts`
- Create: `viewer/tests/parser/.gitkeep` (placeholder so `tests/` is committable)

- [ ] **Step 1: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    globals: false,
    reporters: ["default"],
  },
});
```

- [ ] **Step 2: Create `playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
```

- [ ] **Step 3: Verify Vitest runs (with no tests yet)**

Run: `cd viewer && npm test`
Expected: exits 0 with "No test files found".

- [ ] **Step 4: Install Playwright browsers**

Run: `cd viewer && npx playwright install chromium`
Expected: chromium downloaded. (We'll write the actual e2e harness in Task 22.)

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add Vitest + Playwright test configuration"
jj new -m "wip"
```

---

# Phase 2 — Markdown parsing

## Task 3: Parser wrapper

The parser is the first non-trivial unit of code. Every decoration plugin reads its output, so locking down the API early prevents churn later.

**Files:**
- Create: `viewer/src/editor/parser.ts`
- Test: `viewer/tests/parser/parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/parser/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../../src/editor/parser";

describe("parseMarkdown", () => {
  it("returns an empty token list for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("parses a level-1 heading", () => {
    const tokens = parseMarkdown("# Hello");
    const heading = tokens.find((t) => t.type === "heading_open");
    expect(heading).toBeDefined();
    expect(heading?.tag).toBe("h1");
  });

  it("parses GFM tables", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const tokens = parseMarkdown(md);
    expect(tokens.some((t) => t.type === "table_open")).toBe(true);
  });

  it("parses task lists", () => {
    const md = "- [x] done\n- [ ] todo\n";
    const tokens = parseMarkdown(md);
    const checkbox = tokens.find((t) => t.type === "html_inline" && t.content.startsWith("<input"));
    expect(checkbox).toBeDefined();
  });

  it("parses footnotes", () => {
    const md = "Text[^1]\n\n[^1]: Note\n";
    const tokens = parseMarkdown(md);
    expect(tokens.some((t) => t.type === "footnote_ref")).toBe(true);
  });

  it("parses definition lists", () => {
    const md = "Term\n: Definition\n";
    const tokens = parseMarkdown(md);
    expect(tokens.some((t) => t.type === "dl_open")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/parser`
Expected: FAIL with "Cannot find module '../../src/editor/parser'".

- [ ] **Step 3: Implement `src/editor/parser.ts`**

```typescript
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";
import deflist from "markdown-it-deflist";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
})
  .use(taskLists, { enabled: false, label: false })
  .use(footnote)
  .use(deflist);

export type MdToken = Token;

export function parseMarkdown(source: string): MdToken[] {
  if (source.length === 0) return [];
  return md.parse(source, {});
}

export function renderHtml(source: string): string {
  return md.render(source);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/parser`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add markdown-it parser wrapper with GFM, footnotes, deflist"
jj new -m "wip"
```

---

## Task 4: CommonMark + GFM conformance corpus snapshots

A small, hand-picked corpus is enough for Plan 1 (the full CommonMark spec corpus is large; we add it in Plan 3 polish). We snapshot the rendered HTML to detect regressions.

**Files:**
- Create: `viewer/tests/parser/fixtures/headings.md`
- Create: `viewer/tests/parser/fixtures/lists.md`
- Create: `viewer/tests/parser/fixtures/inline.md`
- Create: `viewer/tests/parser/fixtures/code.md`
- Create: `viewer/tests/parser/fixtures/table.md`
- Create: `viewer/tests/parser/fixtures/footnote.md`
- Modify: `viewer/tests/parser/parser.test.ts` (append)

- [ ] **Step 1: Create fixtures**

```markdown
<!-- tests/parser/fixtures/headings.md -->
# H1
## H2
### H3
#### H4
##### H5
###### H6
```

```markdown
<!-- tests/parser/fixtures/lists.md -->
- one
- two
  - nested
- three

1. ordered
2. items

- [x] done
- [ ] todo
```

```markdown
<!-- tests/parser/fixtures/inline.md -->
**bold** and *italic* and ***both*** and `code` and ~~strike~~.

A [link](https://example.com) and a <https://example.com/auto>.
```

````markdown
<!-- tests/parser/fixtures/code.md -->
Some text.

```js
const x = 1;
```

A `inline` ref.
````

```markdown
<!-- tests/parser/fixtures/table.md -->
| Col A | Col B |
|-------|-------|
| one   | two   |
| three | four  |
```

```markdown
<!-- tests/parser/fixtures/footnote.md -->
Text[^1] and another[^longer].

[^1]: First note.
[^longer]: A longer note that spans
    multiple lines.
```

- [ ] **Step 2: Append a snapshot test to `tests/parser/parser.test.ts`**

```typescript
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { renderHtml } from "../../src/editor/parser";

describe("renderHtml conformance", () => {
  const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;
  const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".md"));

  for (const fixture of fixtures) {
    it(`renders ${fixture}`, () => {
      const source = readFileSync(join(fixtureDir, fixture), "utf8");
      expect(renderHtml(source)).toMatchSnapshot();
    });
  }
});
```

- [ ] **Step 3: Generate the initial snapshots**

Run: `npm test -- tests/parser`
Expected: 6 new tests pass with "1 snapshot written" each. A `tests/parser/__snapshots__/parser.test.ts.snap` file appears.

- [ ] **Step 4: Eyeball the snapshots**

Open `tests/parser/__snapshots__/parser.test.ts.snap` and confirm the rendered HTML looks right (e.g. headings 1–6, list items, code blocks with `<code class="language-js">`, table with `<table><thead>…`). If anything looks wrong, fix the fixture or the parser config and regenerate.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add markdown rendering conformance snapshots for core constructs"
jj new -m "wip"
```

---

# Phase 3 — CodeMirror editor scaffold

## Task 5: Editor module with three compartments

**Files:**
- Create: `viewer/src/editor/editor.ts`
- Test: `viewer/tests/editor/editor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/editor/editor.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { createEditor, setMode } from "../../src/editor/editor";

describe("createEditor", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    host = dom.window.document.getElementById("host")!;
  });

  it("creates a read-only editor seeded with source", () => {
    const view = createEditor({ parent: host, source: "# Hello" });
    expect(view.state.doc.toString()).toBe("# Hello");
    expect(view.state.readOnly).toBe(true);
  });

  it("setMode('edit') flips readOnly to false", () => {
    const view = createEditor({ parent: host, source: "x" });
    setMode(view, "edit");
    expect(view.state.readOnly).toBe(false);
  });

  it("setMode('reading') flips readOnly back to true", () => {
    const view = createEditor({ parent: host, source: "x" });
    setMode(view, "edit");
    setMode(view, "reading");
    expect(view.state.readOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/editor`
Expected: FAIL with "Cannot find module '../../src/editor/editor'".

- [ ] **Step 3: Implement `src/editor/editor.ts`**

```typescript
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

export type Mode = "reading" | "edit";

export interface CreateEditorOptions {
  parent: HTMLElement;
  source: string;
}

const readOnlyCompartment = new Compartment();
const decorationsCompartment = new Compartment();
const keymapCompartment = new Compartment();

export function createEditor(opts: CreateEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.source,
    extensions: [
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of([]),
      keymapCompartment.of(keymap.of(defaultKeymap)),
    ],
  });
  return new EditorView({ state, parent: opts.parent });
}

export function setMode(view: EditorView, mode: Mode): void {
  view.dispatch({
    effects: readOnlyCompartment.reconfigure(
      EditorState.readOnly.of(mode === "reading"),
    ),
  });
}

export const compartments = {
  readOnly: readOnlyCompartment,
  decorations: decorationsCompartment,
  keymap: keymapCompartment,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/editor`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add CodeMirror editor module with three compartments"
jj new -m "wip"
```

---

## Task 6: Decoration plugin contract

This task locks down the shared interface every per-construct plugin in Phase 4 will satisfy. A decoration plugin is a function `(state) => DecorationSet` that uses the cached parse tree to emit decorations.

**Files:**
- Create: `viewer/src/editor/decorations/index.ts`

- [ ] **Step 1: Implement the contract**

```typescript
// src/editor/decorations/index.ts
import { StateField } from "@codemirror/state";
import type { Extension, EditorState } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import { parseMarkdown, type MdToken } from "../parser";

export interface DecorationContext {
  source: string;
  tokens: MdToken[];
}

export type DecorationProducer = (ctx: DecorationContext) => DecorationSet;

export function buildDecorationField(
  producers: DecorationProducer[],
): Extension {
  const compute = (state: EditorState): DecorationSet => {
    const source = state.doc.toString();
    const tokens = parseMarkdown(source);
    const ctx: DecorationContext = { source, tokens };
    let merged = Decoration.none;
    for (const producer of producers) {
      merged = merged.update({ add: producer(ctx).iter() ? [...iterDecos(producer(ctx))] : [] });
    }
    return merged;
  };

  const field = StateField.define<DecorationSet>({
    create: compute,
    update(prev, tr) {
      if (!tr.docChanged) return prev;
      return compute(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
}

function* iterDecos(set: DecorationSet) {
  const cursor = set.iter();
  while (cursor.value !== null) {
    yield { from: cursor.from, to: cursor.to, value: cursor.value };
    cursor.next();
  }
}

export type { DecorationSet };
export { Decoration };
```

The "merge" approach above is intentionally simple: each producer returns a set, and we walk them. CodeMirror's `Decoration.set` will be the canonical merge surface; in Phase 4 (Task 7 onward) we'll refactor to call `Decoration.set(allRanges)` once at the end. For now this gives us a working contract.

- [ ] **Step 2: Smoke-build to verify TS types**

Run: `cd viewer && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
jj desc -m "Add decoration plugin contract and shared field builder"
jj new -m "wip"
```

---

# Phase 4 — Decoration plugins

Every plugin in this phase follows the same shape:

1. A test file under `tests/decorations/<name>.test.ts` that calls the producer with synthetic source + parse output and asserts the resulting decoration ranges.
2. A producer module under `src/editor/decorations/<name>.ts` exporting a function matching `DecorationProducer`.

The pattern for each plugin's test is:

```typescript
import { Decoration } from "../../src/editor/decorations/index";
import { parseMarkdown } from "../../src/editor/parser";
import { producer } from "../../src/editor/decorations/<name>";

const source = "..."; // construct under test
const tokens = parseMarkdown(source);
const set = producer({ source, tokens });

// Walk the set and assert specific from/to ranges and class names.
const ranges: Array<{ from: number; to: number; class: string }> = [];
const cursor = set.iter();
while (cursor.value) {
  ranges.push({
    from: cursor.from,
    to: cursor.to,
    class: (cursor.value.spec as { class?: string }).class ?? "",
  });
  cursor.next();
}

expect(ranges).toEqual([/* expected ranges */]);
```

Plugins emit *line decorations* (whole-line styling like heading typography or blockquote indent) and *mark decorations* (inline styling like bold). We use `Decoration.line({ class })` and `Decoration.mark({ class })` accordingly. CSS classes are namespaced: `cm-md-heading-1`, `cm-md-bold`, etc. The CSS itself lives in `theme.ts` (Task 18).

---

## Task 7: Headings decoration

**Files:**
- Create: `viewer/src/editor/decorations/headings.ts`
- Test: `viewer/tests/decorations/headings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/headings.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { headingsProducer } from "../../src/editor/decorations/headings";

function rangesOf(source: string) {
  const tokens = parseMarkdown(source);
  const set = headingsProducer({ source, tokens });
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
  return out;
}

describe("headingsProducer", () => {
  it("emits a line decoration for each ATX heading 1-6", () => {
    const source = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n";
    expect(rangesOf(source)).toEqual([
      { from: 0,  to: 0,  class: "cm-md-heading cm-md-heading-1" },
      { from: 5,  to: 5,  class: "cm-md-heading cm-md-heading-2" },
      { from: 11, to: 11, class: "cm-md-heading cm-md-heading-3" },
      { from: 18, to: 18, class: "cm-md-heading cm-md-heading-4" },
      { from: 26, to: 26, class: "cm-md-heading cm-md-heading-5" },
      { from: 35, to: 35, class: "cm-md-heading cm-md-heading-6" },
    ]);
  });

  it("ignores text without headings", () => {
    expect(rangesOf("just a paragraph\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/decorations/headings`
Expected: FAIL with "Cannot find module .../headings".

- [ ] **Step 3: Implement `src/editor/decorations/headings.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { DecorationSet, Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

export const headingsProducer: DecorationProducer = ({ source, tokens }) => {
  const lines = lineStarts(source);
  const ranges: Range<Decoration>[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || !t.map) continue;
    const level = Number(t.tag.replace("h", "")); // h1 → 1
    const lineIndex = t.map[0];
    const from = lines[lineIndex];
    ranges.push(
      Decoration.line({
        class: `cm-md-heading cm-md-heading-${level}`,
      }).range(from),
    );
  }

  return Decoration.set(ranges, /* sort */ true);
};

function lineStarts(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) out.push(i + 1);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/decorations/headings`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add headings decoration producer"
jj new -m "wip"
```

---

## Task 8: Inline decorations (bold, italic, code, strikethrough)

**Files:**
- Create: `viewer/src/editor/decorations/inline.ts`
- Test: `viewer/tests/decorations/inline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/inline.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { inlineProducer } from "../../src/editor/decorations/inline";

function classesOf(source: string) {
  const tokens = parseMarkdown(source);
  const set = inlineProducer({ source, tokens });
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
  return out;
}

describe("inlineProducer", () => {
  it("marks **bold** spans (markers + content)", () => {
    const r = classesOf("a **bold** b\n");
    expect(r).toEqual([{ from: 2, to: 10, class: "cm-md-strong" }]);
  });

  it("marks *italic* spans", () => {
    const r = classesOf("a *em* b\n");
    expect(r).toEqual([{ from: 2, to: 6, class: "cm-md-em" }]);
  });

  it("marks `code` spans", () => {
    const r = classesOf("a `c` b\n");
    expect(r).toEqual([{ from: 2, to: 5, class: "cm-md-code-inline" }]);
  });

  it("marks ~~strike~~ spans", () => {
    const r = classesOf("a ~~s~~ b\n");
    expect(r).toEqual([{ from: 2, to: 7, class: "cm-md-strike" }]);
  });

  it("handles nested emphasis", () => {
    const r = classesOf("***both***\n");
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-strong" }));
    expect(r).toContainEqual(expect.objectContaining({ class: "cm-md-em" }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/inline`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/editor/decorations/inline.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";

export const inlineProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const lineStart = absoluteOffsetOfLine(source, t.map[0]);
    const lineSource = source.slice(lineStart, source.indexOf("\n", lineStart) + 1 || undefined);
    walkInline(t.children, lineStart, lineSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, /* sort */ true);
};

function walkInline(
  children: Token[],
  lineStart: number,
  lineSource: string,
  ranges: Range<Decoration>[],
): void {
  let cursor = 0;
  type OpenSpan = { className: string; openIdx: number; openLen: number };
  const stack: OpenSpan[] = [];

  for (let i = 0; i < children.length; i++) {
    const t = children[i];
    if (t.type === "text" || t.type === "html_inline") {
      const idx = lineSource.indexOf(t.content, cursor);
      if (idx >= 0) cursor = idx + t.content.length;
    } else if (t.type === "code_inline") {
      const literal = "`" + t.content + "`";
      const idx = lineSource.indexOf(literal, cursor);
      if (idx >= 0) {
        ranges.push(
          Decoration.mark({ class: "cm-md-code-inline" })
            .range(lineStart + idx, lineStart + idx + literal.length),
        );
        cursor = idx + literal.length;
      }
    } else if (t.type === "strong_open" || t.type === "em_open" || t.type === "s_open") {
      const className =
        t.type === "strong_open" ? "cm-md-strong" :
        t.type === "em_open"     ? "cm-md-em" :
                                   "cm-md-strike";
      const markerLen = t.markup.length; // e.g. "**" or "_" or "~~"
      const idx = lineSource.indexOf(t.markup, cursor);
      stack.push({ className, openIdx: idx, openLen: markerLen });
      if (idx >= 0) cursor = idx + markerLen;
    } else if (t.type === "strong_close" || t.type === "em_close" || t.type === "s_close") {
      const open = stack.pop();
      if (!open || open.openIdx < 0) continue;
      const closeMarker = t.markup;
      const closeIdx = lineSource.indexOf(closeMarker, cursor);
      if (closeIdx < 0) continue;
      const from = lineStart + open.openIdx;
      const to = lineStart + closeIdx + closeMarker.length;
      ranges.push(Decoration.mark({ class: open.className }).range(from, to));
      cursor = closeIdx + closeMarker.length;
    }
  }
}

function absoluteOffsetOfLine(source: string, lineIndex: number): number {
  let i = 0;
  let line = 0;
  while (line < lineIndex && i < source.length) {
    if (source.charCodeAt(i) === 10) line++;
    i++;
  }
  return i;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/inline`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add inline decorations producer (bold, italic, code, strike)"
jj new -m "wip"
```

---

## Task 9: Lists decoration (bullets, ordered, task lists)

**Files:**
- Create: `viewer/src/editor/decorations/lists.ts`
- Test: `viewer/tests/decorations/lists.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/lists.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { listsProducer } from "../../src/editor/decorations/lists";

function classesOnLines(source: string): Array<{ line: number; class: string }> {
  const tokens = parseMarkdown(source);
  const set = listsProducer({ source, tokens });
  const out: Array<{ line: number; class: string }> = [];
  const lines = computeLines(source);
  const cursor = set.iter();
  while (cursor.value) {
    const line = lines.findIndex((start) => start === cursor.from);
    out.push({
      line,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

function computeLines(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

describe("listsProducer", () => {
  it("marks bullet list lines with cm-md-list-bullet", () => {
    const r = classesOnLines("- one\n- two\n");
    expect(r).toEqual([
      { line: 0, class: "cm-md-list cm-md-list-bullet" },
      { line: 1, class: "cm-md-list cm-md-list-bullet" },
    ]);
  });

  it("marks ordered list lines with cm-md-list-ordered", () => {
    const r = classesOnLines("1. one\n2. two\n");
    expect(r.every((x) => x.class === "cm-md-list cm-md-list-ordered")).toBe(true);
  });

  it("marks task list lines with cm-md-list-task and -done", () => {
    const r = classesOnLines("- [x] done\n- [ ] todo\n");
    expect(r[0].class).toContain("cm-md-list-task");
    expect(r[0].class).toContain("cm-md-list-task-done");
    expect(r[1].class).toContain("cm-md-list-task");
    expect(r[1].class).not.toContain("cm-md-list-task-done");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/lists`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/editor/decorations/lists.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

export const listsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);
  let listKind: "bullet" | "ordered" | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "bullet_list_open") listKind = "bullet";
    else if (t.type === "ordered_list_open") listKind = "ordered";
    else if (t.type === "bullet_list_close" || t.type === "ordered_list_close") listKind = null;
    else if (t.type === "list_item_open" && t.map && listKind) {
      const lineIndex = t.map[0];
      const lineStart = lineStarts[lineIndex];
      const lineEnd = lineStarts[lineIndex + 1] ?? source.length;
      const lineText = source.slice(lineStart, lineEnd);
      const taskMatch = /^\s*[-*+]\s+\[([ xX])\]/.exec(lineText);
      let className = `cm-md-list cm-md-list-${listKind}`;
      if (taskMatch) {
        className = `cm-md-list cm-md-list-task${
          taskMatch[1].toLowerCase() === "x" ? " cm-md-list-task-done" : ""
        }`;
      }
      ranges.push(Decoration.line({ class: className }).range(lineStart));
    }
  }

  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/lists`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add lists decoration producer (bullets, ordered, task lists)"
jj new -m "wip"
```

---

## Task 10: Links decoration

**Files:**
- Create: `viewer/src/editor/decorations/links.ts`
- Test: `viewer/tests/decorations/links.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/links.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { linksProducer } from "../../src/editor/decorations/links";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = linksProducer({ source, tokens });
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
  return out;
}

describe("linksProducer", () => {
  it("decorates link text and url separately", () => {
    const r = ranges("see [docs](https://example.com) here\n");
    // "see " is 0..4, "[docs]" is 4..10, "(https://example.com)" is 10..31
    expect(r).toEqual([
      { from: 4,  to: 10, class: "cm-md-link-text" },
      { from: 10, to: 31, class: "cm-md-link-url"  },
    ]);
  });

  it("decorates autolinks", () => {
    const r = ranges("see https://example.com here\n");
    const auto = r.find((x) => x.class === "cm-md-link-auto");
    expect(auto).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/links`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/editor/decorations/links.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";

export const linksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const lineStart = lineStarts[t.map[0]];
    const lineEnd = lineStarts[t.map[0] + 1] ?? source.length;
    const lineSource = source.slice(lineStart, lineEnd);

    walkLinkChildren(t.children, lineStart, lineSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};

function walkLinkChildren(
  children: Token[],
  lineStart: number,
  lineSource: string,
  out: Range<Decoration>[],
): void {
  let cursor = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type === "link_open" && !isImageContext(children, i)) {
      // Find the [text](url) span literally in the source.
      const text = collectTextUntilClose(children, i + 1, "link_close");
      const literal = "[" + text + "]";
      const textIdx = lineSource.indexOf(literal, cursor);
      if (textIdx < 0) continue;
      const textFrom = lineStart + textIdx;
      const textTo = lineStart + textIdx + literal.length;
      out.push(Decoration.mark({ class: "cm-md-link-text" }).range(textFrom, textTo));
      // The url span is from the next "(" to its matching ")".
      const urlStart = lineSource.indexOf("(", textIdx + literal.length);
      if (urlStart >= 0) {
        const urlEnd = lineSource.indexOf(")", urlStart);
        if (urlEnd > urlStart) {
          out.push(
            Decoration.mark({ class: "cm-md-link-url" })
              .range(lineStart + urlStart, lineStart + urlEnd + 1),
          );
          cursor = urlEnd + 1;
        }
      }
    } else if (c.type === "text" && /^https?:\/\/\S+/.test(c.content)) {
      // markdown-it linkified autolink; tokens come as link_open/text/link_close
      // — handled above. This branch is a fallback for raw URLs.
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) {
        out.push(
          Decoration.mark({ class: "cm-md-link-auto" })
            .range(lineStart + idx, lineStart + idx + c.content.length),
        );
        cursor = idx + c.content.length;
      }
    } else if (c.type === "link_open" && children[i - 1]?.type !== "image") {
      // already handled
    } else if (c.type === "text") {
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) cursor = idx + c.content.length;
    }
  }
}

function collectTextUntilClose(children: Token[], start: number, close: string): string {
  let out = "";
  for (let i = start; i < children.length; i++) {
    if (children[i].type === close) break;
    if (children[i].type === "text") out += children[i].content;
  }
  return out;
}

function isImageContext(_children: Token[], _i: number): boolean {
  // markdown-it represents images as a single 'image' token, not link_open;
  // so link_open is never image context. Hook left in for clarity.
  return false;
}

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/links`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add links decoration producer (inline + autolinks)"
jj new -m "wip"
```

---

## Task 11: Images decoration

Image source stays visible (decoration only); the actual image is rendered by the reading-mode widget plugin (Task 17).

**Files:**
- Create: `viewer/src/editor/decorations/images.ts`
- Test: `viewer/tests/decorations/images.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/images.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { imagesProducer } from "../../src/editor/decorations/images";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = imagesProducer({ source, tokens });
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
  return out;
}

describe("imagesProducer", () => {
  it("marks image source spans", () => {
    const r = ranges("see ![alt](./pic.png) here\n");
    expect(r).toEqual([{ from: 4, to: 21, class: "cm-md-image" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/images`
Expected: FAIL.

- [ ] **Step 3: Implement `src/editor/decorations/images.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

const IMAGE_REGEX = /!\[[^\]]*\]\([^)]*\)/g;

export const imagesProducer: DecorationProducer = ({ source }) => {
  const ranges: Range<Decoration>[] = [];
  for (const match of source.matchAll(IMAGE_REGEX)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    ranges.push(Decoration.mark({ class: "cm-md-image" }).range(from, to));
  }
  return Decoration.set(ranges, true);
};
```

(We use a regex here rather than the parse tree because markdown-it represents images as a single inline token whose `content` field is the alt text — reconstructing the source span from tokens is more code than the regex. Both approaches yield the same answer for the cases the spec demands.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/images`
Expected: 1 test PASSES.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add images decoration producer"
jj new -m "wip"
```

---

## Task 12: Blockquotes decoration

**Files:**
- Create: `viewer/src/editor/decorations/blockquotes.ts`
- Test: `viewer/tests/decorations/blockquotes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/blockquotes.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { blockquotesProducer } from "../../src/editor/decorations/blockquotes";

function lines(source: string) {
  const tokens = parseMarkdown(source);
  const set = blockquotesProducer({ source, tokens });
  const out: number[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push(cursor.from);
    cursor.next();
  }
  return out;
}

describe("blockquotesProducer", () => {
  it("marks each blockquote line", () => {
    const source = "> a\n> b\nc\n";
    expect(lines(source)).toEqual([0, 4]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/blockquotes`
Expected: FAIL.

- [ ] **Step 3: Implement `src/editor/decorations/blockquotes.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

export const blockquotesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "blockquote_open") {
      depth++;
      if (t.map) {
        for (let line = t.map[0]; line < t.map[1]; line++) {
          ranges.push(
            Decoration.line({ class: "cm-md-blockquote" }).range(lineStarts[line]),
          );
        }
      }
    } else if (t.type === "blockquote_close") {
      depth--;
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(deduplicate(ranges), true);
};

function deduplicate(ranges: Range<Decoration>[]): Range<Decoration>[] {
  const seen = new Set<number>();
  return ranges.filter((r) => {
    if (seen.has(r.from)) return false;
    seen.add(r.from);
    return true;
  });
}

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/blockquotes`
Expected: 1 test PASSES.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add blockquotes decoration producer"
jj new -m "wip"
```

---

## Task 13: Tables decoration

In edit mode the pipes stay visible (this is what the producer does). Column alignment as visual whitespace and the reading-mode rendered-table widget are added in Task 17.

**Files:**
- Create: `viewer/src/editor/decorations/tables.ts`
- Test: `viewer/tests/decorations/tables.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/tables.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { tablesProducer } from "../../src/editor/decorations/tables";

function lineClasses(source: string) {
  const tokens = parseMarkdown(source);
  const set = tablesProducer({ source, tokens });
  const out: Array<{ from: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

describe("tablesProducer", () => {
  it("marks every line of a GFM table with cm-md-table", () => {
    const r = lineClasses("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.class.includes("cm-md-table"))).toBe(true);
  });

  it("marks header row with cm-md-table-header", () => {
    const r = lineClasses("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r[0].class).toContain("cm-md-table-header");
    expect(r[1].class).toContain("cm-md-table-separator");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/tables`
Expected: FAIL.

- [ ] **Step 3: Implement `src/editor/decorations/tables.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

export const tablesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "table_open" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    for (let line = startLine; line < endLine; line++) {
      let cls = "cm-md-table";
      if (line === startLine) cls += " cm-md-table-header";
      if (line === startLine + 1) cls += " cm-md-table-separator";
      ranges.push(
        Decoration.line({ class: cls }).range(lineStarts[line]),
      );
    }
  }

  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/tables`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add tables decoration producer"
jj new -m "wip"
```

---

## Task 14: Code block decoration with Shiki

This is the most involved decoration plugin: it must syntax-highlight the contents of fenced code blocks using Shiki, while leaving the fence markers as plain text.

**Files:**
- Create: `viewer/src/editor/decorations/codeblocks.ts`
- Test: `viewer/tests/decorations/codeblocks.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/codeblocks.test.ts
import { describe, it, expect, beforeAll } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { codeblocksProducer, primeHighlighter } from "../../src/editor/decorations/codeblocks";

beforeAll(async () => {
  await primeHighlighter(["javascript"]);
});

function classes(source: string) {
  const tokens = parseMarkdown(source);
  const set = codeblocksProducer({ source, tokens });
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
  return out;
}

describe("codeblocksProducer", () => {
  it("marks fence lines with cm-md-code-fence", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    const fences = r.filter((x) => x.class.includes("cm-md-code-fence"));
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it("marks code body lines with cm-md-code-body", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    expect(r.some((x) => x.class.includes("cm-md-code-body"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/codeblocks`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/editor/decorations/codeblocks.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";
import { createHighlighter, type Highlighter } from "shiki";

import type { DecorationProducer } from "./index";

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

export const codeblocksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    const lang = (t.info || "text").trim() || "text";

    // Open fence (the line with ```lang)
    ranges.push(
      Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-open" })
        .range(lineStarts[startLine]),
    );
    // Body lines
    for (let line = startLine + 1; line < endLine - 1; line++) {
      ranges.push(
        Decoration.line({ class: `cm-md-code-body cm-md-code-lang-${lang}` })
          .range(lineStarts[line]),
      );
    }
    // Close fence
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-close" })
          .range(lineStarts[endLine - 1]),
      );
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

(Note: the per-token highlight colors from Shiki are applied through CSS-class injection in Task 19's `reading-widgets.ts` — for the line-level decoration we just stamp a `cm-md-code-lang-<lang>` class so the theme's monospace styling kicks in. Token-level Shiki spans land on top through a separate widget pass in Task 17.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/codeblocks`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add code block decoration producer with Shiki priming"
jj new -m "wip"
```

---

## Task 15: Front matter decoration

**Files:**
- Create: `viewer/src/editor/decorations/frontmatter.ts`
- Test: `viewer/tests/decorations/frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/frontmatter.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { frontmatterProducer } from "../../src/editor/decorations/frontmatter";

function ranges(source: string) {
  const tokens = parseMarkdown(source);
  const set = frontmatterProducer({ source, tokens });
  const out: Array<{ from: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

describe("frontmatterProducer", () => {
  it("marks YAML front matter at the top of file", () => {
    const src = "---\ntitle: Hi\n---\n\n# Doc\n";
    const r = ranges(src);
    expect(r.map((x) => x.from)).toEqual([0, 4, 13]);
    expect(r.every((x) => x.class.includes("cm-md-frontmatter"))).toBe(true);
  });

  it("ignores --- that's not at line 0", () => {
    const src = "# Doc\n\n---\nhr above this\n";
    expect(ranges(src)).toEqual([]);
  });

  it("handles TOML front matter (+++)", () => {
    const src = "+++\ntitle = \"Hi\"\n+++\n\n# Doc\n";
    const r = ranges(src);
    expect(r).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/frontmatter`
Expected: FAIL.

- [ ] **Step 3: Implement `src/editor/decorations/frontmatter.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n(\1)\r?\n/;

export const frontmatterProducer: DecorationProducer = ({ source }) => {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match || match.index !== 0) return Decoration.set([]);

  const ranges: Range<Decoration>[] = [];
  const lineStarts = [0];
  for (let i = 0; i < match[0].length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  // Drop the trailing empty entry from the final newline
  const usable = lineStarts.slice(0, -1);
  for (const start of usable) {
    ranges.push(Decoration.line({ class: "cm-md-frontmatter" }).range(start));
  }
  return Decoration.set(ranges, true);
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/frontmatter`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add front matter decoration producer (YAML and TOML)"
jj new -m "wip"
```

---

## Task 16: Footnotes and definition lists decoration

**Files:**
- Create: `viewer/src/editor/decorations/footnotes.ts`
- Test: `viewer/tests/decorations/footnotes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/footnotes.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { footnotesProducer } from "../../src/editor/decorations/footnotes";

function classes(source: string) {
  const tokens = parseMarkdown(source);
  const set = footnotesProducer({ source, tokens });
  const out: string[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push((cursor.value.spec as { class?: string }).class ?? "");
    cursor.next();
  }
  return out;
}

describe("footnotesProducer", () => {
  it("marks footnote references and definitions", () => {
    const src = "Text[^1]\n\n[^1]: Note\n";
    const cls = classes(src);
    expect(cls).toContain("cm-md-footnote-ref");
    expect(cls).toContain("cm-md-footnote-def");
  });

  it("marks definition list terms and definitions", () => {
    const src = "Term\n: Definition\n";
    const cls = classes(src);
    expect(cls).toContain("cm-md-deflist-term");
    expect(cls).toContain("cm-md-deflist-def");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/footnotes`
Expected: FAIL.

- [ ] **Step 3: Implement `src/editor/decorations/footnotes.ts`**

```typescript
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

const FOOTNOTE_REF_RE = /\[\^[^\]]+\]/g;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/m;

export const footnotesProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  // Footnote refs: regex over the source (avoid touching definitions).
  for (const match of source.matchAll(FOOTNOTE_REF_RE)) {
    if (match.index === undefined) continue;
    const lineIdx = lineFor(lineStarts, match.index);
    const lineStart = lineStarts[lineIdx];
    const lineSource = source.slice(lineStart, lineStarts[lineIdx + 1] ?? source.length);
    if (FOOTNOTE_DEF_RE.test(lineSource) && lineSource.startsWith(match[0])) {
      ranges.push(
        Decoration.mark({ class: "cm-md-footnote-def" })
          .range(match.index, match.index + match[0].length),
      );
    } else {
      ranges.push(
        Decoration.mark({ class: "cm-md-footnote-ref" })
          .range(match.index, match.index + match[0].length),
      );
    }
  }

  // Definition lists from token stream.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "dt_open" && t.map) {
      ranges.push(
        Decoration.line({ class: "cm-md-deflist-term" }).range(lineStarts[t.map[0]]),
      );
    } else if (t.type === "dd_open" && t.map) {
      for (let line = t.map[0]; line < t.map[1]; line++) {
        ranges.push(
          Decoration.line({ class: "cm-md-deflist-def" }).range(lineStarts[line]),
        );
      }
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(dedupe(ranges), true);
};

function dedupe(ranges: Range<Decoration>[]): Range<Decoration>[] {
  const seen = new Set<string>();
  return ranges.filter((r) => {
    const key = `${r.from}:${r.to}:${(r.value.spec as { class?: string }).class}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function lineFor(lineStarts: number[], offset: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/footnotes`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add footnotes and definition lists decoration producer"
jj new -m "wip"
```

---

# Phase 5 — Reading-mode widgets

## Task 17: Reading-mode widget decorations

In reading mode the editor is `readOnly: true` and we apply *widget* decorations that visually replace certain spans: link brackets/parens become invisible, image source becomes an `<img>`, code-fence open/close lines become invisible (the body retains highlighting), and front matter collapses to nothing.

The underlying source is untouched — the widgets just paint over it.

**Files:**
- Create: `viewer/src/editor/decorations/reading-widgets.ts`
- Test: `viewer/tests/decorations/reading-widgets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decorations/reading-widgets.test.ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { readingWidgetsProducer } from "../../src/editor/decorations/reading-widgets";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = readingWidgetsProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("readingWidgetsProducer", () => {
  it("hides link brackets and url, keeping inner text", () => {
    const r = specs("[t](u)\n");
    // First widget elides "[" before t; second elides "](u)" after t.
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide"));
    expect(hides.length).toBeGreaterThanOrEqual(2);
  });

  it("emits an image widget for ![alt](path)", () => {
    const r = specs("![a](./p.png)\n");
    expect(r.some((x) => (x.spec as { widget?: unknown }).widget !== undefined)).toBe(true);
  });

  it("hides code fence lines but not body", () => {
    const r = specs("```\nx\n```\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide-line"));
    expect(hides.length).toBe(2); // open + close
  });

  it("hides front matter entirely", () => {
    const r = specs("---\ntitle: x\n---\n\n# Doc\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide-line"));
    expect(hides.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/decorations/reading-widgets`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/editor/decorations/reading-widgets.ts`**

```typescript
import { Decoration, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/view";

import type { DecorationProducer } from "./index";

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  override toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-reading-image";
    img.loading = "lazy";
    img.decoding = "async";
    return img;
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
}

const ELIDE_INLINE = Decoration.replace({ class: "cm-md-reading-elide" });
const ELIDE_LINE = Decoration.replace({ class: "cm-md-reading-elide-line", block: true });

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)]*)\)/g;
const FRONT_MATTER_RE = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n/;

export const readingWidgetsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  // Front matter: replace each line with a block elide.
  const fm = FRONT_MATTER_RE.exec(source);
  if (fm && fm.index === 0) {
    let p = 0;
    while (p < fm[0].length) {
      const nl = source.indexOf("\n", p);
      if (nl < 0) break;
      ranges.push(ELIDE_LINE.range(p, nl + 1));
      p = nl + 1;
    }
  }

  // Code fence open/close: replace those lines.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const openFrom = lineStarts[t.map[0]];
    const openTo = lineStarts[t.map[0] + 1] ?? source.length;
    ranges.push(ELIDE_LINE.range(openFrom, openTo));
    const closeFrom = lineStarts[t.map[1] - 1];
    const closeTo = lineStarts[t.map[1]] ?? source.length;
    ranges.push(ELIDE_LINE.range(closeFrom, closeTo));
  }

  // Images: replace ![alt](url) with an <img>.
  for (const match of source.matchAll(IMAGE_RE)) {
    if (match.index === undefined) continue;
    const alt = match[1];
    const src = match[2];
    ranges.push(
      Decoration.replace({ widget: new ImageWidget(src, alt) })
        .range(match.index, match.index + match[0].length),
    );
  }

  // Links: hide [ before, ](url) after.
  for (const match of source.matchAll(LINK_RE)) {
    if (match.index === undefined) continue;
    const openBracket = match.index;          // [
    const closeBracket = match.index + 1 + match[1].length; // ]
    const closeParen = match.index + match[0].length;
    ranges.push(ELIDE_INLINE.range(openBracket, openBracket + 1));
    ranges.push(ELIDE_INLINE.range(closeBracket, closeParen));
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/decorations/reading-widgets`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add reading-mode widget decorations (links, images, fences, frontmatter)"
jj new -m "wip"
```

---

# Phase 6 — Theme system

## Task 18: CSS variable themes

**Files:**
- Modify: `viewer/src/styles.css` (overwrite)
- Create: `viewer/src/editor/theme.ts`

- [ ] **Step 1: Write `src/styles.css` with light + dark CSS variables**

```css
:root {
  color-scheme: light dark;
  --bg: #fdfdfa;
  --fg: #1a1a1a;
  --muted: #888;
  --rule: #e5e2d8;
  --code-bg: #efece4;
  --link: #2c5d8a;
  --accent: #b03060;
  --serif: "Iowan Old Style", "Charter", Georgia, serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
}

html.theme-dark {
  color-scheme: dark;
  --bg: #15161a;
  --fg: #e6e3da;
  --muted: #888;
  --rule: #2a2c33;
  --code-bg: #20232b;
  --link: #7fb3e8;
  --accent: #f08bb6;
}

html, body, #root {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

/* CodeMirror reset — we control all visuals through .cm-md-* classes. */
.cm-editor { background: var(--bg); height: 100%; }
.cm-editor .cm-scroller {
  font-family: var(--serif);
  font-size: 16px;
  line-height: 1.65;
  padding: 32px max(48px, calc((100% - 720px) / 2));
}
.cm-editor .cm-content { color: var(--fg); }

/* Headings */
.cm-md-heading           { font-weight: 600; letter-spacing: -0.01em; }
.cm-md-heading-1         { font-size: 28px; margin: 18px 0 8px; }
.cm-md-heading-2         { font-size: 22px; margin: 16px 0 6px; }
.cm-md-heading-3         { font-size: 18px; margin: 14px 0 6px; }
.cm-md-heading-4         { font-size: 16px; margin: 12px 0 4px; }
.cm-md-heading-5         { font-size: 15px; color: var(--muted); }
.cm-md-heading-6         { font-size: 14px; color: var(--muted); }

/* Inline */
.cm-md-strong            { font-weight: 700; }
.cm-md-em                { font-style: italic; }
.cm-md-strike            { text-decoration: line-through; text-decoration-color: var(--muted); }
.cm-md-code-inline       { font-family: var(--mono); font-size: 0.9em;
                            background: var(--code-bg); padding: 1px 5px; border-radius: 3px; }

/* Lists */
.cm-md-list              { padding-left: 0; }
.cm-md-list-task-done    { color: var(--muted); }

/* Links */
.cm-md-link-text         { color: var(--link); text-decoration: underline;
                            text-decoration-color: rgba(44,93,138,0.4); text-underline-offset: 2px; }
.cm-md-link-url          { color: var(--muted); font-family: var(--mono); font-size: 0.85em; }
.cm-md-link-auto         { color: var(--link); text-decoration: underline; }
.cm-md-image             { color: var(--muted); font-family: var(--mono); font-size: 0.9em; }

/* Blockquotes */
.cm-md-blockquote        { border-left: 3px solid var(--rule); padding-left: 12px;
                            color: var(--muted); font-style: italic; }

/* Tables — line-level only in Plan 1; richer table layout in Plan 3. */
.cm-md-table             { font-family: var(--mono); font-size: 0.9em; }
.cm-md-table-header      { font-weight: 700; }
.cm-md-table-separator   { color: var(--muted); }

/* Code blocks */
.cm-md-code-fence        { font-family: var(--mono); font-size: 0.85em; color: var(--muted); }
.cm-md-code-body         { font-family: var(--mono); font-size: 0.9em; background: var(--code-bg); }

/* Front matter */
.cm-md-frontmatter       { font-family: var(--mono); font-size: 0.8em; color: var(--muted);
                            background: var(--code-bg); }

/* Footnotes / deflist */
.cm-md-footnote-ref,
.cm-md-footnote-def      { color: var(--link); font-size: 0.85em; }
.cm-md-deflist-term      { font-weight: 600; }
.cm-md-deflist-def       { padding-left: 16px; }

/* Reading-mode widget elides */
.cm-md-reading-elide      { display: none; }
.cm-md-reading-elide-line { display: none; }
.cm-md-reading-image      { max-width: 100%; height: auto; display: block; margin: 16px 0; }
```

- [ ] **Step 2: Implement `src/editor/theme.ts`**

```typescript
export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "viewer.theme";

export function applyTheme(theme: Theme): void {
  const html = document.documentElement;
  html.classList.remove("theme-light", "theme-dark");
  if (theme === "system") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    html.classList.add(mq.matches ? "theme-dark" : "theme-light");
  } else {
    html.classList.add(`theme-${theme}`);
  }
}

export function loadStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export function storeTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
```

- [ ] **Step 3: Quick smoke test (manual via dev build will come in Task 22; for now type-check)**

Run: `cd viewer && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add light/dark CSS variable themes and theme.ts helpers"
jj new -m "wip"
```

---

## Task 19: Theme unit tests

**Files:**
- Create: `viewer/tests/editor/theme.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/editor/theme.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { applyTheme, loadStoredTheme, storeTheme } from "../../src/editor/theme";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  globalThis.localStorage = dom.window.localStorage;
  // jsdom doesn't implement matchMedia; stub a non-dark default.
  (globalThis.window as { matchMedia?: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe("applyTheme", () => {
  it("adds theme-light when theme is light", () => {
    applyTheme("light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  });

  it("adds theme-dark when theme is dark", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
  });

  it("falls back to light when system prefers light", () => {
    applyTheme("system");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  });
});

describe("storage helpers", () => {
  it("round-trips theme through localStorage", () => {
    storeTheme("dark");
    expect(loadStoredTheme()).toBe("dark");
  });

  it("returns 'system' when nothing is stored", () => {
    expect(loadStoredTheme()).toBe("system");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/editor/theme`
Expected: 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
jj desc -m "Add theme module tests"
jj new -m "wip"
```

---

# Phase 7 — Open file and render

## Task 20: Rust file-read command

We don't use Tauri's FS plugin scopes for arbitrary paths in Plan 1 (paths come from the dialog or CLI arg, both of which we trust). We add a tiny custom command that reads a UTF-8 text file and returns the bytes. Plan 2 will reuse this for save and watch as a starting point.

**Files:**
- Create: `viewer/src-tauri/src/commands/files.rs`
- Modify: `viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Implement `src-tauri/src/commands/files.rs`**

```rust
use serde::Serialize;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum FileError {
    #[error("io error: {0}")]
    Io(String),
    #[error("not utf-8: {0}")]
    NotUtf8(String),
    #[error("file too large: {0} bytes")]
    TooLarge(u64),
}

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, FileError> {
    let pb = PathBuf::from(&path);
    let meta = std::fs::metadata(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    if meta.len() > MAX_BYTES {
        return Err(FileError::TooLarge(meta.len()));
    }
    let bytes = std::fs::read(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| FileError::NotUtf8(e.to_string()))
}
```

- [ ] **Step 2: Wire the command in `src-tauri/src/lib.rs`**

```rust
mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Add `src-tauri/src/commands/mod.rs`**

```rust
pub mod files;
```

- [ ] **Step 4: Verify the Rust build compiles**

Run: `cd viewer/src-tauri && cargo check`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add Rust read_text_file command with size cap"
jj new -m "wip"
```

---

## Task 21: Frontend file open + buffer wiring

**Files:**
- Create: `viewer/src/shell/files.ts`
- Modify: `viewer/src/main.ts`

- [ ] **Step 1: Implement `src/shell/files.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface OpenedDoc {
  path: string;
  source: string;
}

export async function openFileViaDialog(): Promise<OpenedDoc | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx", "mdown"] },
    ],
  });
  if (typeof picked !== "string") return null;
  return readDoc(picked);
}

export async function readDoc(path: string): Promise<OpenedDoc> {
  const source = await invoke<string>("read_text_file", { path });
  return { path, source };
}
```

- [ ] **Step 2: Rewrite `src/main.ts` to wire everything together**

```typescript
import { createEditor, compartments } from "./editor/editor";
import { buildDecorationField } from "./editor/decorations";
import { headingsProducer } from "./editor/decorations/headings";
import { inlineProducer } from "./editor/decorations/inline";
import { listsProducer } from "./editor/decorations/lists";
import { linksProducer } from "./editor/decorations/links";
import { imagesProducer } from "./editor/decorations/images";
import { blockquotesProducer } from "./editor/decorations/blockquotes";
import { tablesProducer } from "./editor/decorations/tables";
import { codeblocksProducer, primeHighlighter } from "./editor/decorations/codeblocks";
import { frontmatterProducer } from "./editor/decorations/frontmatter";
import { footnotesProducer } from "./editor/decorations/footnotes";
import { readingWidgetsProducer } from "./editor/decorations/reading-widgets";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog } from "./shell/files";
import { getMatches } from "@tauri-apps/api/cli";

async function bootstrap(): Promise<void> {
  applyTheme(loadStoredTheme());
  watchSystemTheme(() => applyTheme(loadStoredTheme()));

  await primeHighlighter([
    "javascript", "typescript", "python", "go", "rust",
    "java", "c", "cpp", "shell", "json", "yaml", "sql",
    "html", "css", "markdown",
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  root.innerHTML = "";

  const initialDoc = await resolveInitialDoc();

  const view = createEditor({
    parent: root,
    source: initialDoc?.source ?? defaultPlaceholder(),
  });

  // Reading-mode decoration set: the structural producers + the reading widgets.
  view.dispatch({
    effects: compartments.decorations.reconfigure(
      buildDecorationField([
        headingsProducer,
        inlineProducer,
        listsProducer,
        linksProducer,
        imagesProducer,
        blockquotesProducer,
        tablesProducer,
        codeblocksProducer,
        frontmatterProducer,
        footnotesProducer,
        readingWidgetsProducer,
      ]),
    ),
  });
}

async function resolveInitialDoc() {
  // CLI arg path (Tauri exposes argv via the cli plugin; if not configured,
  // this returns undefined and we fall back to the open dialog).
  try {
    const matches = await getMatches();
    const arg = matches.args?.path?.value;
    if (typeof arg === "string" && arg.length > 0) {
      return await readDoc(arg);
    }
  } catch {
    // cli plugin not active; fine.
  }
  return await openFileViaDialog();
}

function defaultPlaceholder(): string {
  return "# Welcome to Viewer\n\nNo document opened. Use **File → Open** in Plan 3 once the menu lands.\n";
}

bootstrap().catch((err) => {
  console.error("bootstrap failed", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Failed to start: ${String(err)}`;
  }
});
```

(`getMatches` requires `tauri-plugin-cli` — we'll add it as a no-op fallback in Step 3 so Plan 1 still works without configuring CLI parsing.)

- [ ] **Step 3: Make CLI argument optional (no plugin needed in Plan 1)**

Replace the `getMatches`-based block with a simpler "first non-flag argv entry that ends in .md" approach until Plan 3 wires the cli plugin. Update `src/main.ts`:

```typescript
async function resolveInitialDoc() {
  const argPath = await firstMarkdownArg();
  if (argPath) return await readDoc(argPath);
  return await openFileViaDialog();
}

async function firstMarkdownArg(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const argv = await invoke<string[]>("plugin:cli|argv").catch(() => null);
    if (!argv) return null;
    return argv.find((a) => /\.(md|markdown|mdx|mdown)$/i.test(a)) ?? null;
  } catch {
    return null;
  }
}
```

Remove the `import { getMatches } from "@tauri-apps/api/cli";` line from the top of the file. The fallback gracefully returns null on any error.

- [ ] **Step 4: Type-check the frontend**

Run: `cd viewer && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Wire frontend bootstrap: theme + decorations + open-file dialog"
jj new -m "wip"
```

---

## Task 22: End-to-end Playwright smoke test

**Files:**
- Create: `viewer/tests/e2e/open-and-render.spec.ts`
- Create: `viewer/tests/e2e/fixtures/sample.md`

- [ ] **Step 1: Create a fixture document**

```markdown
<!-- tests/e2e/fixtures/sample.md -->
# Sample Document

A paragraph with **bold**, *italic*, and `code`.

## Lists

- one
- two
  - nested
- three

## Code

```js
const x = 42;
```

## Table

| a | b |
|---|---|
| 1 | 2 |
```

- [ ] **Step 2: Write the Playwright spec**

```typescript
// tests/e2e/open-and-render.spec.ts
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
  // Wait for vite to be reachable.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) process.kill(-viteProc.pid);
});

test("renders headings and code from a sample doc", async ({ page }) => {
  // Stub the Tauri invoke for read_text_file by intercepting the page load.
  await page.addInitScript(() => {
    const sample = `# Sample Document\n\n- a\n- b\n\n\`\`\`js\nconst x = 42;\n\`\`\`\n`;
    // Mock @tauri-apps/api/core invoke before main.ts runs.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "read_text_file") return sample;
        if (cmd === "plugin:cli|argv") return [];
        return null;
      },
    };
    // And the dialog plugin: pretend the user picked our sample path.
    (window as unknown as { __TAURI_DIALOG__?: unknown }).__TAURI_DIALOG__ = {
      open: async () => "/virtual/sample.md",
    };
  });

  await page.goto(APP_URL);

  // The heading should be visible with H1 typography (font-size 28px from theme).
  const h1 = page.locator(".cm-md-heading-1");
  await expect(h1).toBeVisible();

  // A code-body line is present.
  await expect(page.locator(".cm-md-code-body")).toBeVisible();

  // A list line is present.
  await expect(page.locator(".cm-md-list-bullet")).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e test**

Run: `cd viewer && npm run test:e2e`
Expected: the test passes. (If it fails because Vite is slow to start, increase the wait loop in `beforeAll`.)

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add Playwright e2e smoke test for open-and-render flow"
jj new -m "wip"
```

---

## Task 23: Manual integration verification

This is a non-automated checklist task — run through it locally to confirm Plan 1 produces the experience the spec calls for. Plan 2 will replace some of these manual steps with automated UI interaction tests.

- [ ] **Step 1: Run the app with the sample fixture**

```bash
cd viewer
npm run tauri:dev
```

When the file dialog appears, pick `tests/e2e/fixtures/sample.md`.

- [ ] **Step 2: Eyeball the rendering**

Confirm visually:
- The H1 is large and bold; H2 is smaller bold.
- The list items render with proper indentation; nested items step in further.
- `**bold**` is bold. `*italic*` is italic. `` `code` `` has the tinted background.
- The code block body is monospace with a tinted background; the triple-backtick fence lines are hidden in reading mode (the body still appears).
- The table renders, even if just as monospace text in Plan 1.
- The image source `![]( )` syntax in fixtures with images shows as muted monospace text *and* the image renders below it (Task 17 widget).
- Dragging the OS theme between light and dark flips the page color within ~100 ms.

- [ ] **Step 3: Quit the app, then commit a CHANGELOG entry capturing what's shippable**

Run: create `CHANGELOG.md` with:

```markdown
# Changelog

## [0.1.0] - 2026-05-08 — Plan 1: Read-only viewer

Foundation Sub-spec A, Plan 1 of 3 complete.

### Added
- Tauri 2.x desktop shell with Vite + TypeScript frontend
- markdown-it parser with GFM, footnotes, deflist, and task-list plugins
- CodeMirror 6 editor with three compartments (readOnly, decorations, keymap)
- Decoration plugins for headings, inline (bold/italic/code/strike), lists,
  links, images, blockquotes, tables, code blocks (Shiki), front matter,
  footnotes, definition lists
- Reading-mode widget decorations: hides link brackets and parens, renders
  images, hides code fences and front matter
- Light, dark, and OS-follow themes via CSS custom properties
- Rust read_text_file command with 50 MB cap
- Frontend bootstrap that opens a file via OS dialog or CLI arg
- Vitest unit tests for parser, theme, every decoration producer
- Playwright e2e smoke test for open-and-render flow

### Not yet (Plan 2)
- Edit mode and decorated-source styling overlays
- Mode toggle and reading-mode keymap (Space/Shift+Space etc.)
- Save and dirty tracking
- Drag-drop, file watcher, reconciliation

### Not yet (Plan 3)
- TOC sidebar
- Recents menu and crash recovery
- Native menu inventory and full keyboard shortcuts
- Document zoom, find/replace
- HTML sanitization hardening
- GitHub Actions CI matrix
- Visual regression corpus
```

- [ ] **Step 4: Commit**

```bash
jj desc -m "Plan 1 complete: read-only Markdown viewer with themed rendering

- Tauri 2 + Vite + TS scaffold
- markdown-it parser (CommonMark + GFM + footnotes + deflist)
- CodeMirror 6 with three compartments
- 11 decoration producers covering every CommonMark/GFM construct in §6
- Light/dark/OS-follow themes
- Reading-mode widget decorations
- File open via dialog or CLI arg
- Vitest + Playwright tests"
jj new -m "wip"
```

---

# Self-review

Quick gut check that Plan 1 covers what it should and doesn't lie:

**Spec coverage check:** Plan 1 maps to spec §2.1 (tech stack), §3 (architecture, frontend half), §4 components rows for editor/parser/decorations/syntax-highlighter/theme system/decoration plugins, §5.1 (open file flow), §6 (decoration scheme — reading-mode rows), §6's "Reading-mode differences" subsection, and §11 assumption 1 (markdown-it speed validated incidentally as we run on real corpus). Plan 1 deliberately excludes §5.2/5.3/5.4/5.5/5.6 (mode toggle, edit, save, close, watcher), §5.7 (TOC), §6a (menus + shortcuts beyond the bootstrap), §7 (most robustness — file-too-large is in Task 20), and DoD criteria 2/3/4/5/6/7/8/9/10/11/12/13. Those are explicitly Plans 2 and 3.

**Placeholder scan:** every test file has real assertions, every module has real code, every command has the expected output written down. There is one design judgment in Task 14 (Shiki token-level coloring deferred to a later task in Plan 1) — I left the line-level decoration in but punted token-level coloring. That was inconsistent. **Fix inline:** Task 14 produces line-level classes only (`cm-md-code-body`), and full Shiki token coloring will be added in Plan 2 alongside the editor-mode highlighting work where the same machinery is reused. The CSS in Task 18 styles the body with a tinted background and monospace; that's the visible Plan 1 result.

**Type consistency:** `DecorationProducer` is defined in `decorations/index.ts` (Task 6) and every per-construct file imports it. `parseMarkdown` returns `MdToken[]` consistently (Task 3 → consumed in Task 6 onward). `compartments` exported from `editor.ts` (Task 5) is consumed by `main.ts` (Task 21). No drift.

**Self-review fix:** I noticed Task 6's `buildDecorationField` has a bug — the merge loop calls `producer(ctx)` twice. Replacing with a single-pass implementation:

Looking at this again, the cleaner pattern is to call each producer once and concatenate ranges. Update Task 6 step 1 implementation to:

```typescript
import { StateField } from "@codemirror/state";
import type { Extension, EditorState, Range } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import { parseMarkdown, type MdToken } from "../parser";

export interface DecorationContext {
  source: string;
  tokens: MdToken[];
}

export type DecorationProducer = (ctx: DecorationContext) => DecorationSet;

export function buildDecorationField(
  producers: DecorationProducer[],
): Extension {
  const compute = (state: EditorState): DecorationSet => {
    const source = state.doc.toString();
    const tokens = parseMarkdown(source);
    const ctx: DecorationContext = { source, tokens };
    const allRanges: Range<Decoration>[] = [];
    for (const producer of producers) {
      const set = producer(ctx);
      const cursor = set.iter();
      while (cursor.value) {
        allRanges.push(cursor.value.range(cursor.from, cursor.to));
        cursor.next();
      }
    }
    allRanges.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(allRanges, true);
  };

  return StateField.define<DecorationSet>({
    create: compute,
    update(prev, tr) {
      if (!tr.docChanged) return prev;
      return compute(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export type { DecorationSet };
export { Decoration };
```

(Use this version when implementing Task 6 step 1.)

---

# Execution handoff

Plan 1 complete and saved to `docs/superpowers/plans/2026-05-08-markdown-viewer-foundation-1-viewer.md`.

Two execution options for Plan 1:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

After Plan 1 ships, Plan 2 (Editing & file lifecycle) and Plan 3 (Polish & platform) will be written and executed in turn.

**Which approach for Plan 1?**
