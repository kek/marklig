# Website Deploy Target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kek.github.io/marklig` as a fifth deploy target whose page is a live Märklig `EditorView` rendering `website/content.md`, deployed from GitHub Actions on every push to `trunk`.

**Architecture:** A new `src/website/bootstrap.ts` mirrors `src/mobile-bootstrap.ts` — same decoration producers, same editor module, same toolbar, same TOC sidebar. Content lives in `website/content.md` and is loaded via Vite's `?raw` import. A separate `vite.config.website.ts` aliases `src/shell/store.ts` to a localStorage-backed shim (`src/website/store-web.ts`) so transitive Tauri-Store imports (via `shell/settings → shell/store`) resolve to a browser-safe peer. No producer or shared module is modified.

**Tech Stack:** Vite (existing), CodeMirror 6 (existing), markdown-it (existing), GitHub Actions (`actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`).

**Spec:** `docs/superpowers/specs/2026-05-24-website-deploy-target-design.md`

**VCS:** This is a Jujutsu repo (`.jj/`). All commits use `jj`, never `git`. See the `jujutsu` skill if unfamiliar.

---

## File Structure

**Created:**
- `vite.config.website.ts` — website Vite config (root=website, base=/marklig/, alias for shell/store)
- `website/index.html` — thin HTML shell that mounts `#root` and loads the bootstrap
- `website/content.md` — marketing copy as real Markdown, rendered by the embedded editor
- `website/favicon.svg` — simple SVG favicon
- `website/og.png` — Open Graph image (reading-mode screenshot recovered from the orphan branch)
- `src/website/bootstrap.ts` — website entry, parallel to `src/mobile-bootstrap.ts`
- `src/website/store-web.ts` — localStorage-backed peer of `src/shell/store.ts` (Vite alias swaps it in for the website build only)
- `.github/workflows/pages.yml` — GitHub Pages deploy workflow
- `tests/website/bootstrap.test.ts` — vitest unit tests for the bootstrap
- `tests/website/content.test.ts` — vitest tests asserting required sections in `content.md`
- `tests/website/store-web.test.ts` — vitest tests for the localStorage shim

**Modified:**
- `package.json` — three new scripts (`website:dev`, `website:build`, `website:preview`)
- `.gitignore` — add `website/dist/`
- `README.md` — add a "Website" subsection under Develop

---

### Task 1: localStorage-backed store shim

This is the boundary piece that lets the website build inherit the desktop `shell/settings.ts` API without pulling in `@tauri-apps/plugin-store`. The shim exports the same surface as `src/shell/store.ts`.

**Files:**
- Create: `src/website/store-web.ts`
- Create: `tests/website/store-web.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/website/store-web.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getValue, setValue, deleteValue, listKeys } from "../../src/website/store-web";

describe("website store-web shim", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("setValue then getValue round-trips a string", async () => {
    await setValue("foo", "bar");
    expect(await getValue<string>("foo")).toBe("bar");
  });

  it("setValue then getValue round-trips a number", async () => {
    await setValue("n", 42);
    expect(await getValue<number>("n")).toBe(42);
  });

  it("setValue then getValue round-trips a boolean", async () => {
    await setValue("flag", true);
    expect(await getValue<boolean>("flag")).toBe(true);
  });

  it("getValue returns undefined for missing keys", async () => {
    expect(await getValue<string>("missing")).toBeUndefined();
  });

  it("deleteValue removes the key", async () => {
    await setValue("temp", "x");
    await deleteValue("temp");
    expect(await getValue<string>("temp")).toBeUndefined();
  });

  it("listKeys returns the set of stored keys", async () => {
    await setValue("a", 1);
    await setValue("b", 2);
    const keys = await listKeys();
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });

  it("values that fail to JSON-parse return undefined", async () => {
    localStorage.setItem("marklig.web.broken", "{not json");
    expect(await getValue<unknown>("broken")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/website/store-web.test.ts`
Expected: FAIL — module `../../src/website/store-web` does not exist.

- [ ] **Step 3: Create `src/website/store-web.ts`**

```ts
// localStorage-backed peer of src/shell/store.ts for the website deploy
// target. The Vite alias in vite.config.website.ts swaps this in for the
// shell/store module during the website build, so consumers upstream
// (src/shell/settings.ts → src/ui/sidebar/toc.ts) don't know they're
// talking to localStorage instead of Tauri Store.
//
// All four exports keep the original async signatures so callers in
// shell/settings.ts (which await them) work without modification.
//
// Keys are namespaced under `marklig.web.` to keep this storage island
// out of any other localStorage usage the page might pick up.

const NS = "marklig.web.";

export async function getValue<T>(key: string): Promise<T | undefined> {
  const raw = localStorage.getItem(NS + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function setValue<T>(key: string, value: T): Promise<void> {
  localStorage.setItem(NS + key, JSON.stringify(value));
}

export async function deleteValue(key: string): Promise<void> {
  localStorage.removeItem(NS + key);
}

export async function listKeys(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) out.push(k.slice(NS.length));
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/website/store-web.test.ts`
Expected: PASS — all seven tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add localStorage-backed store shim for website target"
jj new
```

---

### Task 2: Vite config + npm scripts + gitignore

**Files:**
- Create: `vite.config.website.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `vite.config.website.ts`**

```ts
import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite config for the marketing website (GitHub Pages deploy target).
// The website imports the same decoration producers + editor module the
// desktop app uses; see src/website/bootstrap.ts.
//
// The alias swaps src/shell/store.ts (Tauri-backed) for the
// localStorage-backed peer in src/website/store-web.ts. This lets
// shell/settings.ts and src/ui/sidebar/toc.ts work unmodified in a
// browser without @tauri-apps/plugin-store.
export default defineConfig({
  root: "website",
  base: "/marklig/",
  resolve: {
    alias: {
      // Both the bare path and any imports through ../shell/store resolve
      // to the website peer.
      [resolve(__dirname, "src/shell/store.ts")]: resolve(__dirname, "src/website/store-web.ts"),
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Add three scripts to `package.json`**

Insert these three lines in the `"scripts"` object immediately after the existing `"preview": "vite preview"` line:

```json
    "website:dev": "vite --config vite.config.website.ts",
    "website:build": "vite build --config vite.config.website.ts",
    "website:preview": "vite preview --config vite.config.website.ts",
```

- [ ] **Step 3: Add `website/dist/` to `.gitignore`**

Append a single line `website/dist/` to `.gitignore` (creating a trailing newline if needed).

- [ ] **Step 4: Verify the config wires up correctly by attempting a build**

Run: `npm run website:build`
Expected: a Vite error indicating `website/index.html` is missing (this confirms the config is wired before Task 3 creates the entry).

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add website Vite config with store alias, scripts, and gitignore"
jj new
```

---

### Task 3: Website HTML shell

**Files:**
- Create: `website/index.html`

- [ ] **Step 1: Create `website/index.html`**

```html
<!DOCTYPE html>
<html lang="en" data-mode="reading">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Märklig — Markdown that's beautiful to read</title>
    <meta
      name="description"
      content="A desktop Markdown reader and editor for macOS, Windows, and Linux."
    />
    <meta property="og:title" content="Märklig" />
    <meta
      property="og:description"
      content="Markdown that's beautiful to read."
    />
    <meta property="og:image" content="/marklig/og.png" />
    <link rel="icon" href="/marklig/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/website/bootstrap.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify the build now reports a different missing-entry error**

Run: `npm run website:build`
Expected: error refers to `/src/website/bootstrap.ts` (or a transitive module from there) rather than the HTML shell. This proves the shell is wired and Task 4 is up next.

- [ ] **Step 3: Commit**

```bash
jj desc -m "Add website index.html shell"
jj new
```

---

### Task 4: content.md with required sections

**Files:**
- Create: `website/content.md`
- Create: `tests/website/content.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/website/content.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";

const CONTENT_PATH = resolve(__dirname, "../../website/content.md");

describe("website/content.md", () => {
  it("exists on disk", () => {
    expect(existsSync(CONTENT_PATH)).toBe(true);
  });

  it("parses with markdown-it without throwing", () => {
    const md = new MarkdownIt();
    const src = readFileSync(CONTENT_PATH, "utf-8");
    expect(() => md.parse(src, {})).not.toThrow();
  });

  it("contains the required H2 sections", () => {
    const src = readFileSync(CONTENT_PATH, "utf-8");
    const required = [
      "## Reading-first",
      "## Full Markdown",
      "## Typst",
      "## Android companion",
      "## Sync",
      "## Roadmap",
      "## Install",
    ];
    for (const heading of required) {
      expect(src).toContain(heading);
    }
  });

  it("starts with the H1 + italic lede", () => {
    const src = readFileSync(CONTENT_PATH, "utf-8");
    expect(src.startsWith("# Märklig\n")).toBe(true);
    expect(src).toContain("*Markdown that's beautiful to read.*");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/website/content.test.ts`
Expected: FAIL — `website/content.md` does not exist.

- [ ] **Step 3: Create `website/content.md`**

```markdown
# Märklig

*Markdown that's beautiful to read.*

A desktop reader and editor for macOS, Windows, and Linux —
and a mobile reader for Android. Reading comes first.

This page is a Märklig `EditorView` rendering
[content.md](https://github.com/kek/marklig/blob/trunk/website/content.md) —
the same code that runs in the desktop app, with one of the same
decoration producers per Markdown construct. Click the edit icon in the
toolbar to switch this page to edit mode.

## Reading-first

Open a `.md` file and it renders immediately — serif body, generous
line height, comfortable measure. Switch to edit mode with one
keystroke; switch back to see the result. The source file stays
plain Markdown.

## Full Markdown

CommonMark + GFM tables, task lists, autolinks. KaTeX for `$inline$`
and `$$block$$` math. Mermaid and Graphviz diagrams. Syntax-highlighted
code via Shiki across 100+ languages. Footnotes, YAML/TOML front matter.

> What you write is what you get. What you read is what you wrote.

## Typst

Open a `.typ` file and Märklig compiles it in-process — real Typst,
real system fonts, real `@preview/*` package resolution with an
on-disk cache. The compiled pages render as SVG in a split preview
pane (edit mode) or full-width (reading mode). Compile progress and
timing live in the status bar; the last good pages stay dimmed while
a failing compile finishes so you don't lose your place.

## Android companion — work in progress

A read-only Android companion app shares the desktop renderer: same
CodeMirror 6 view, same decoration producers. Files arrive via the
Android share sheet (`file://` or `content://` URIs through SAF). A
small library home remembers what you've opened. iOS, edit-on-phone,
and a folder browser are explicitly out of scope for v2.0.

## Sync — work in progress

Keep your files in sync between desktop and phone. End-to-end
encrypted, over your local network — devices pair directly with no
accounts and no servers in between. LAN-only at first; off-network
sync via an untrusted relay lands in v2.1.

## Roadmap

| Feature                                         | Status                  |
|-------------------------------------------------|-------------------------|
| Decorated-source reading + editing              | shipped                 |
| Math, Mermaid, Graphviz                         | shipped                 |
| HTML export, print → PDF                        | shipped                 |
| File associations, multi-window, project tree   | shipped (macOS)         |
| Preferences, remote-image policy, find/replace  | shipped                 |
| A11y + i18n foundation                          | shipped                 |
| Typst format support                            | shipped                 |
| Android read-only companion                     | wip — steps 1–4 done    |
| Desktop ↔ phone sync (LAN, E2E)                 | wip — crypto core done  |
| macOS Quick Look                                | blocked on Dev ID       |
| Windows Jump List, Linux RecentManager          | future                  |
| Auto-updater                                    | future                  |
| Native PDF export (Rust-side)                   | future                  |
| Off-LAN sync (untrusted relay)                  | v2.1+                   |

## Install

No tagged releases yet — build from source. You'll need
[Rust](https://www.rust-lang.org/tools/install) (stable), Node.js 20+,
and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS.

```bash
git clone https://github.com/kek/marklig
cd marklig
npm install
npm run tauri:build
```

For Android, see the `tauri:android:dev` instructions in the README
(requires `NDK_HOME` and a connected device).

---

[github.com/kek/marklig](https://github.com/kek/marklig)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/website/content.test.ts`
Expected: PASS — all four assertions.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add website content.md with marketing copy and roadmap"
jj new
```

---

### Task 5: Bootstrap — minimal mount that renders an EditorView

This task creates the bootstrap function and verifies it mounts a real `EditorView` against a root element. Decoration producers, toolbar, and link-clicks are added in subsequent tasks.

**Files:**
- Create: `src/website/bootstrap.ts`
- Create: `tests/website/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/website/bootstrap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountWebsite } from "../../src/website/bootstrap";

const SAMPLE = `# Märklig\n\n*Markdown that's beautiful to read.*\n`;

describe("website bootstrap — base mount", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    document.documentElement.dataset.mode = "reading";
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("mounts a CodeMirror EditorView into the root element", () => {
    mountWebsite({ root, source: SAMPLE });
    expect(root.querySelector(".cm-editor")).not.toBeNull();
  });

  it("the editor content contains the source text", () => {
    mountWebsite({ root, source: SAMPLE });
    const content = root.querySelector(".cm-content");
    expect(content?.textContent).toContain("Märklig");
    expect(content?.textContent).toContain("Markdown that's beautiful to read.");
  });

  it("sets html[data-mode] to 'reading'", () => {
    mountWebsite({ root, source: SAMPLE });
    expect(document.documentElement.dataset.mode).toBe("reading");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: FAIL — module `../../src/website/bootstrap` does not exist.

- [ ] **Step 3: Create `src/website/bootstrap.ts`**

```ts
// Website bootstrap. Parallel to src/mobile-bootstrap.ts — same editor
// module + same decoration producers, different host environment.
//
// This file is built only by vite.config.website.ts. The Tauri-backed
// shell/store import is aliased to src/website/store-web.ts at build
// time so transitive imports via shell/settings → ui/sidebar/toc don't
// pull @tauri-apps/plugin-store into the bundle.

import type { EditorView } from "@codemirror/view";

import { createEditor } from "../editor/editor";

export interface MountWebsiteOptions {
  root: HTMLElement;
  source: string;
}

export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";
  return createEditor({ parent: opts.root, source: opts.source });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: PASS — all three assertions.

If a CodeMirror feature throws under jsdom (the existing test suite is the reference), inspect `tests/setup.ts` — it already shims `ResizeObserver` etc. The website bootstrap test should need no new shim.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add minimal website bootstrap that mounts an EditorView"
jj new
```

---

### Task 6: Install reading-mode decorations + edit/reading mode extensions

**Files:**
- Modify: `src/website/bootstrap.ts`

- [ ] **Step 1: Add failing tests for decoration installation and mode toggling**

Append the following describe block to `tests/website/bootstrap.test.ts`:

```ts
import { setMode } from "../../src/editor/editor";
import { buildReadingExtensions, buildEditExtensions } from "../../src/website/bootstrap";

describe("website bootstrap — modes", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("buildReadingExtensions returns decoration + keymap extensions", () => {
    const ext = buildReadingExtensions();
    expect(ext.decorations).toBeDefined();
    expect(ext.keymap).toBeDefined();
  });

  it("buildEditExtensions returns decoration + keymap extensions", () => {
    const ext = buildEditExtensions();
    expect(ext.decorations).toBeDefined();
    expect(ext.keymap).toBeDefined();
  });

  it("renders a typeset H1 (decoration applied, marker hidden)", () => {
    mountWebsite({ root, source: "# Märklig\n" });
    // In reading mode, headings get a heading-line class via the producer.
    // The exact selector mirrors src/editor/decorations/headings.ts output.
    const headingLine = root.querySelector(".cm-md-heading-1, .cm-line[class*='heading-1']");
    expect(headingLine).not.toBeNull();
  });

  it("switching to edit mode shows the raw '#' marker", () => {
    const view = mountWebsite({ root, source: "# Märklig\n" });
    setMode(view, "edit", buildEditExtensions());
    document.documentElement.dataset.mode = "edit";
    const content = root.querySelector(".cm-content");
    // Edit mode keeps markers visible (not replaced/hidden).
    expect(content?.textContent).toContain("# Märklig");
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: the three "base mount" tests still PASS; the four new ones FAIL with `buildReadingExtensions is not exported`.

- [ ] **Step 3: Update `src/website/bootstrap.ts` with the producer set and mode extensions**

Replace the entire file with:

```ts
// Website bootstrap. Parallel to src/mobile-bootstrap.ts — same editor
// module + same decoration producers, different host environment.
//
// This file is built only by vite.config.website.ts. The Tauri-backed
// shell/store import is aliased to src/website/store-web.ts at build
// time so transitive imports via shell/settings → ui/sidebar/toc don't
// pull @tauri-apps/plugin-store into the bundle.

import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

import { createEditor, setMode } from "../editor/editor";
import type { ModeExtensions } from "../editor/editor";
import {
  buildDecorationField,
  refreshDecorationsEffect,
} from "../editor/decorations";
import { readingKeymap, editKeymap } from "../editor/keymaps";

import { headingsProducer } from "../editor/decorations/headings";
import { inlineProducer } from "../editor/decorations/inline";
import { listsProducer } from "../editor/decorations/lists";
import { linksProducer } from "../editor/decorations/links";
import { imagesProducer } from "../editor/decorations/images";
import { blockquotesProducer } from "../editor/decorations/blockquotes";
import { tablesProducer } from "../editor/decorations/tables";
import {
  codeblocksProducer,
  primeHighlighter,
} from "../editor/decorations/codeblocks";
import { frontmatterProducer } from "../editor/decorations/frontmatter";
import { footnotesProducer } from "../editor/decorations/footnotes";
import { readingWidgetsProducer } from "../editor/decorations/reading-widgets";
import { mathProducer } from "../editor/decorations/math";
import { mermaidProducer } from "../editor/decorations/mermaid";
import { graphvizProducer } from "../editor/decorations/graphviz";

export interface MountWebsiteOptions {
  root: HTMLElement;
  source: string;
}

// Reading-mode producer set — headings/links/etc. AND the reading-only
// widget producers (math, mermaid, reading-widgets). This is the same
// set src/main.ts uses for reading mode, copied to be host-neutral.
const READING_PRODUCERS = [
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
  mathProducer,
  mermaidProducer,
  graphvizProducer,
];

// Edit-mode producer set — same producers MINUS the reading-mode widgets
// that would hide markers (readingWidgets, math, mermaid). Markers stay
// visible in edit mode so the source is editable as-typed.
const EDIT_PRODUCERS = [
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
  graphvizProducer,
];

// readingKeymap is exported as a finished `keymap.of(...)` extension;
// editKeymap is exported as a raw KeyBinding[] (see src/editor/keymaps.ts
// — the same shape src/main.ts consumes). Wrap edit, pass reading through.
export function buildReadingExtensions(): ModeExtensions {
  return {
    decorations: buildDecorationField({ producers: READING_PRODUCERS }),
    keymap: readingKeymap,
  };
}

export function buildEditExtensions(): ModeExtensions {
  return {
    decorations: buildDecorationField({ producers: EDIT_PRODUCERS }),
    keymap: keymap.of([...editKeymap, ...defaultKeymap]),
  };
}

export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";

  const view = createEditor({ parent: opts.root, source: opts.source });

  // Install reading-mode extensions. setMode reconfigures the editor's
  // decoration / keymap / readOnly compartments in one dispatch.
  setMode(view, "reading", buildReadingExtensions());

  // Prime the syntax highlighter so code blocks render with Shiki
  // tokens on first paint. Producer falls back to monospace placeholder
  // if Shiki rejects (network error, etc.).
  primeHighlighter(view, opts.source).catch(() => {
    /* placeholder remains */
  });

  return view;
}
```

> **Verified at plan time:** `readingKeymap` is `keymap.of([...])` (already an Extension); `editKeymap` is `KeyBinding[]` (raw array). That asymmetry is why the code above passes one straight through and wraps the other. Mirror what `src/main.ts` does if anything looks off when implementing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: PASS — all seven assertions across the two describe blocks.

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Wire reading-mode and edit-mode decoration fields in website bootstrap"
jj new
```

---

### Task 7: Mount the toolbar with edit toggle

**Files:**
- Modify: `src/website/bootstrap.ts`
- Modify: `tests/website/bootstrap.test.ts`

- [ ] **Step 1: Append failing tests for toolbar mount + edit-click**

Add to `tests/website/bootstrap.test.ts`:

```ts
describe("website bootstrap — toolbar", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("mounts a .viewer-toolbar above the editor", () => {
    mountWebsite({ root, source: "# Hello\n" });
    expect(root.querySelector(".viewer-toolbar")).not.toBeNull();
  });

  it("toolbar contains at least an edit toggle and a TOC button", () => {
    mountWebsite({ root, source: "# Hello\n" });
    const buttons = root.querySelectorAll(".viewer-toolbar-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("clicking the edit toggle flips html[data-mode] to 'edit'", () => {
    mountWebsite({ root, source: "# Hello\n" });
    // First .viewer-toolbar-btn is the edit toggle (per mountToolbar
    // append order in src/ui/toolbar.ts).
    const editBtn = root.querySelector<HTMLButtonElement>(".viewer-toolbar-btn");
    expect(editBtn).not.toBeNull();
    editBtn!.click();
    expect(document.documentElement.dataset.mode).toBe("edit");
  });

  it("toolbar path readout shows 'content.md'", () => {
    mountWebsite({ root, source: "# Hello\n" });
    const path = root.querySelector(".viewer-toolbar-path");
    expect(path?.textContent).toBe("content.md");
  });

  it("toolbar stats show word/char/min readout", () => {
    mountWebsite({ root, source: "# Hello\n\nA short paragraph of words.\n" });
    const stats = root.querySelector(".viewer-toolbar-stats");
    expect(stats?.textContent).toMatch(/words/);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: the older tests PASS; the five new ones FAIL.

- [ ] **Step 3: Update `mountWebsite` in `src/website/bootstrap.ts` to mount the toolbar**

Add at the top of `src/website/bootstrap.ts`, after the existing imports:

```ts
import { mountToolbar, computeDocStats } from "../ui/toolbar";
```

Replace the body of `mountWebsite` with:

```ts
export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";

  const view = createEditor({ parent: opts.root, source: opts.source });

  const readingExt = buildReadingExtensions();
  const editExt = buildEditExtensions();

  setMode(view, "reading", readingExt);

  // mountToolbar prepends a .viewer-toolbar to its parent and wires the
  // click handlers internally — clicking the edit button calls
  // setMode(view, "edit", editExt) and triggers onModeChange.
  const toolbar = mountToolbar(opts.root, {
    view,
    modeExtensions: { reading: readingExt, edit: editExt },
    initialMode: "reading",
    onModeChange: (mode) => {
      document.documentElement.dataset.mode = mode;
    },
    // Sidebar wiring is added in Task 8. Pass undefined for now —
    // clicking the TOC button is a no-op.
    onSidebarToggle: undefined,
    initialSidebarVisible: false,
  });

  toolbar.setDirty(false);
  toolbar.setPath("content.md");
  toolbar.setStats(computeDocStats(opts.source));
  toolbar.setStatus(null);

  primeHighlighter(view, opts.source).catch(() => {
    /* placeholder remains */
  });

  // Decoration field is already installed via setMode above; this
  // dispatch nudges producers that read external state at toDOM time
  // (e.g. the eventual settings-driven image policy) to refresh on
  // first paint.
  view.dispatch({ effects: refreshDecorationsEffect.of(undefined) });

  return view;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: PASS — all twelve assertions.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Mount the shared toolbar with edit toggle in the website bootstrap"
jj new
```

---

### Task 8: Wire the TOC sidebar to the toolbar TOC button

**Files:**
- Modify: `src/website/bootstrap.ts`
- Modify: `tests/website/bootstrap.test.ts`

- [ ] **Step 1: Append a failing test for TOC sidebar mounting**

Add to `tests/website/bootstrap.test.ts`:

```ts
describe("website bootstrap — TOC sidebar", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.innerHTML = "";
    root.remove();
    delete document.documentElement.dataset.mode;
  });

  it("clicking the TOC button mounts a .viewer-toc aside", () => {
    mountWebsite({
      root,
      source: "# Märklig\n\n## Reading-first\n\n## Install\n",
    });
    // Second .viewer-toolbar-btn is the TOC toggle.
    const buttons = root.querySelectorAll<HTMLButtonElement>(".viewer-toolbar-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    buttons[1].click();
    expect(root.querySelector(".viewer-toc")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: existing tests PASS; the new test FAILS (TOC button click is currently a no-op).

- [ ] **Step 3: Update `src/website/bootstrap.ts` to wire the TOC sidebar**

Add to the imports:

```ts
import { mountTocSidebar } from "../ui/sidebar/toc";
import type { TocSidebarHandle, TocEntry } from "../ui/sidebar/toc";
import { EditorView } from "@codemirror/view";
```

(Note: `EditorView` becomes a value import for `EditorView.scrollIntoView`, not just a type.)

Replace the body of `mountWebsite` with:

```ts
export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";

  const view = createEditor({ parent: opts.root, source: opts.source });

  const readingExt = buildReadingExtensions();
  const editExt = buildEditExtensions();

  setMode(view, "reading", readingExt);

  // TOC sidebar — mounted lazily on first toggle click. mountTocSidebar
  // appends a <aside class="viewer-toc"> to its parent.
  let tocHandle: TocSidebarHandle | null = null;

  const onSidebarToggle = (): void => {
    if (!tocHandle) {
      tocHandle = mountTocSidebar({
        view,
        parent: opts.root,
        initiallyVisible: true,
        initialDocumentPath: "content.md",
        onActivate: (entry: TocEntry) => {
          view.dispatch({
            selection: { anchor: entry.from },
            effects: EditorView.scrollIntoView(entry.from, { y: "start" }),
          });
        },
      });
      toolbar.setSidebarVisible(true);
    } else {
      const next = !tocHandle.isVisible();
      tocHandle.setVisible(next);
      toolbar.setSidebarVisible(next);
    }
  };

  const toolbar = mountToolbar(opts.root, {
    view,
    modeExtensions: { reading: readingExt, edit: editExt },
    initialMode: "reading",
    onModeChange: (mode) => {
      document.documentElement.dataset.mode = mode;
    },
    onSidebarToggle,
    initialSidebarVisible: false,
  });

  toolbar.setDirty(false);
  toolbar.setPath("content.md");
  toolbar.setStats(computeDocStats(opts.source));
  toolbar.setStatus(null);

  primeHighlighter(view, opts.source).catch(() => {
    /* placeholder remains */
  });

  view.dispatch({ effects: refreshDecorationsEffect.of(undefined) });

  return view;
}
```

> **Note:** The forward reference to `toolbar` inside `onSidebarToggle` works because JS closures resolve at call-time, not at declaration time — the click handler doesn't fire before `mountToolbar` returns. If TypeScript complains about "used before assignment," swap the order so the toolbar is mounted first and the toggle is wired post-hoc via assigning to an outer `let toolbar` and constructing the callback to capture it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: PASS — all thirteen assertions.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Wire the TOC sidebar to the website toolbar"
jj new
```

---

### Task 9: Wire link-clicks so external links open in a new tab

**Files:**
- Modify: `src/website/bootstrap.ts`
- Modify: `tests/website/bootstrap.test.ts`

`src/editor/link-clicks.ts` provides `linkClickExtension(handlers)` for routing clicks on rendered links. The desktop passes `@tauri-apps/plugin-opener`'s `openUrl`; the website passes `window.open`.

- [ ] **Step 1: Append a failing test for link-click external open**

Add to `tests/website/bootstrap.test.ts`:

```ts
import { resolveLinkAt } from "../../src/editor/link-clicks";

describe("website bootstrap — link clicks", () => {
  it("resolveLinkAt finds the external link in content", () => {
    // This test verifies the underlying util — clicking a real link in
    // jsdom is fiddly with CM6's event handling, so we cover the
    // resolver here and rely on Task 14's manual verification for the
    // actual click → window.open path.
    const src = "[GitHub](https://github.com/kek/marklig)\n";
    const result = resolveLinkAt(src, 1);
    expect(result?.href).toBe("https://github.com/kek/marklig");
  });
});
```

> **Note:** Click → window.open is verified manually in Task 14. Unit-testing CodeMirror click handlers in jsdom requires synthesizing mouse events at exact text positions and is fragile; the resolver test above plus the manual smoke covers the wiring without that fragility.

- [ ] **Step 2: Run the test to verify it passes immediately**

Run: `npx vitest run tests/website/bootstrap.test.ts`
Expected: this single test PASSES on first run (`resolveLinkAt` is already exported and host-neutral). It is here as a regression guard and to keep the wiring intent documented in the test file.

- [ ] **Step 3: Update `src/website/bootstrap.ts` to install `linkClickExtension`**

Add to imports:

```ts
import { StateEffect } from "@codemirror/state";
import { linkClickExtension, buildAnchorIndex } from "../editor/link-clicks";
import type { LinkClickHandlers } from "../editor/link-clicks";
```

Inside `mountWebsite`, after the `setMode(view, "reading", readingExt)` line and before the `mountToolbar` call, add:

```ts
  // LinkClickHandlers (from src/editor/link-clicks.ts) has four fields.
  // The website only meaningfully serves external links; the other three
  // are no-ops because content.md is the only document and there are no
  // local-markdown files to open relatively.
  const linkHandlers: LinkClickHandlers = {
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openLocalMarkdown: async () => {
      /* no-op: no local .md files reachable from the website */
    },
    scrollToAnchor: (slug) => {
      const index = buildAnchorIndex(view.state.doc.toString());
      const line = index.get(slug);
      if (line == null) return false;
      const pos = view.state.doc.line(line).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
      return true;
    },
    resolveRelativeMarkdown: async () => null,
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of(linkClickExtension(linkHandlers)),
  });
```

> **Verified at plan time:** `LinkClickHandlers` shape is `openExternal`, `openLocalMarkdown`, `scrollToAnchor` (returns `boolean`), `resolveRelativeMarkdown` (returns `Promise<string | null>`). Mirror exactly. `linkClickExtension` only invokes the handler when the editor is read-only (reading mode), so edit-mode link-clicks pass through to CodeMirror as normal cursor-placement.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests still pass; no new failures.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Wire link-clicks in website bootstrap to use window.open"
jj new
```

---

### Task 10: Load content.md via Vite ?raw and auto-mount

**Files:**
- Modify: `src/website/bootstrap.ts`
- Modify: `vitest.config.ts`

The bootstrap so far exports `mountWebsite` for tests. The deployed site needs to call it against `#root` with `content.md` as the source. Use Vite's `?raw` query to load the file as a string at build time.

- [ ] **Step 1: Add an env flag to `vitest.config.ts` so the auto-mount can be suppressed under tests**

Edit `vitest.config.ts`. The current shape (per `head vitest.config.ts`) is:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    globals: false,
    reporters: ["default"],
    setupFiles: ["tests/setup.ts"],
  },
});
```

Add `env: { VITEST: "true" }` so the bootstrap can branch:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    globals: false,
    reporters: ["default"],
    setupFiles: ["tests/setup.ts"],
    env: { VITEST: "true" },
  },
});
```

- [ ] **Step 2: Append the auto-mount block at the bottom of `src/website/bootstrap.ts`**

```ts
// ----- auto-mount (browser only) -----
//
// Vite's ?raw query loads the file contents as a string at build time.
// The path is relative to this file; ../../website/content.md resolves
// to website/content.md at the repo root.
//
// Skipped under vitest (env.VITEST="true" in vitest.config.ts) so unit
// tests that create their own #root don't trip on a second auto-mount.
import contentMd from "../../website/content.md?raw";

if (
  typeof document !== "undefined" &&
  !(import.meta as any).env?.VITEST
) {
  const root = document.getElementById("root");
  if (root) {
    mountWebsite({ root, source: contentMd });
  }
}
```

- [ ] **Step 3: Build the website to verify the bundle succeeds**

Run: `npm run website:build`

Expected: build succeeds and writes `website/dist/index.html` plus a hashed JS bundle under `website/dist/assets/`. Inspect the manifest:

```bash
ls -la website/dist/
ls -la website/dist/assets/
```

- [ ] **Step 4: Preview the built site locally**

Run: `npm run website:preview`

Visit the URL Vite reports (typically `http://localhost:4173/marklig/`). Verify in the browser:
- H1 "Märklig" renders typeset (not as `# Märklig`).
- All seven H2 sections are present.
- The Roadmap table renders.
- The install code block has monospace font and (after a moment) Shiki syntax coloring.
- Clicking the edit icon switches the view: raw `#` and `*` markers become visible.
- Clicking the TOC icon opens an aside listing the H2/H3 entries.
- Clicking the "[content.md]" link opens the GitHub source in a new tab.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass — the auto-mount is correctly suppressed under VITEST.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Load content.md via Vite ?raw and auto-mount the website"
jj new
```

---

### Task 11: Favicon and OG image

**Files:**
- Create: `website/favicon.svg`
- Create: `website/og.png` (binary, recovered from the orphan branch)

- [ ] **Step 1: Create `website/favicon.svg`**

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#fdfdfa"/>
  <text x="16" y="22" text-anchor="middle"
        font-family="Iowan Old Style, Charter, Georgia, serif"
        font-size="20" font-weight="700" fill="#1a1a1a">M</text>
</svg>
```

- [ ] **Step 2: Recover the reading-mode screenshot from the orphan branch**

```bash
git show origin/claude/plan-next-steps-MYxmU:website/assets/reading-mode.png > website/og.png
ls -l website/og.png
file website/og.png
```

Expected: file is roughly 900 KB and reported as `PNG image data`.

- [ ] **Step 3: Rebuild and verify the assets ship**

```bash
npm run website:build
ls website/dist/
```

Expected: `website/dist/` contains `favicon.svg` and `og.png` (Vite copies static assets from `website/` into the output root).

- [ ] **Step 4: Commit**

```bash
jj desc -m "Add website favicon and OG image"
jj new
```

---

### Task 12: GitHub Actions Pages deploy workflow

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Deploy website to GitHub Pages

on:
  push:
    branches: [trunk]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Allow only one concurrent deployment, but don't cancel in-progress runs.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build website
        run: npm run website:build

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: website/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Validate the YAML locally**

If `actionlint` is installed:

```bash
actionlint .github/workflows/pages.yml
```

If not, skip — the workflow will report errors in the Actions tab on first push.

- [ ] **Step 3: Commit**

```bash
jj desc -m "Add GitHub Actions workflow to deploy website to Pages"
jj new
```

---

### Task 13: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Website" subsection under Develop**

Find the section header `## Develop` (or its current equivalent). Below the existing dev / tauri:dev block, insert:

````markdown
### Website

The marketing site at `kek.github.io/marklig` is built from this repo —
it's the desktop reading mode rendering `website/content.md` through the
exact same decoration producers as the app. Treat it like any other
deploy target.

```bash
npm run website:dev       # local dev server with HMR
npm run website:build     # static build → website/dist/
npm run website:preview   # serve the built output locally
```

`.github/workflows/pages.yml` runs the build on every push to `trunk`
and deploys to GitHub Pages. The Pages source must be set to "GitHub
Actions" in repo Settings → Pages (one-time).
````

- [ ] **Step 2: Commit**

```bash
jj desc -m "README: document the website deploy target"
jj new
```

---

### Task 14: End-to-end smoke verification + PR

This task verifies the deployed site behaves correctly, then opens the PR.

- [ ] **Step 1: Final local build + preview**

```bash
npm test
npm run website:build
npm run website:preview
```

Open the preview URL. Verify each:
- H1 "Märklig" renders typeset.
- Italic lede appears below.
- All seven H2 sections present.
- Roadmap renders as a table.
- Install code block has monospace font; after a moment Shiki colorizes it.
- Blockquote ("What you write is what you get…") has the left rule.
- Clicking the "[content.md]" link opens GitHub in a new tab (verifies `window.open` wire).
- Clicking the edit icon flips markers visible; icon shows the "read" glyph.
- Clicking the TOC icon opens the heading sidebar. Clicking a heading scrolls.
- Cmd-E (or Ctrl-E) toggles modes via the keymap.

- [ ] **Step 2: Cross-check against Märklig itself**

Open `website/content.md` in the desktop Märklig app. The rendered page should look indistinguishable from what the website preview shows. Any difference is a bug (the website is the app rendering this file).

- [ ] **Step 3: Open the PR**

```bash
jj git push -c @-
gh pr create --title "Website as a fifth deploy target" --body "$(cat <<'EOF'
## Summary

- New `src/website/bootstrap.ts` reuses the desktop reading-mode editor + decoration producers to render `website/content.md`.
- New `vite.config.website.ts` builds into `website/dist/` and aliases `src/shell/store` → `src/website/store-web` (localStorage shim) so transitive Tauri-Store imports don't pull `@tauri-apps/plugin-store` into the bundle.
- New `npm run website:dev / build / preview` scripts.
- GitHub Actions workflow deploys to GitHub Pages on every push to `trunk`.

## Setup needed (one-time, repo admin)

Settings → Pages → Source → **"GitHub Actions"**. After this is set, the next push to `trunk` deploys to `https://kek.github.io/marklig/`.

## Test plan

- [x] `npm test` — vitest bootstrap + content + store-web tests pass.
- [x] `npm run website:build && npm run website:preview` — page renders locally.
- [ ] Visit `https://kek.github.io/marklig/` after merge — confirm checks listed in Task 14 Step 1 of the plan.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Manual: set Pages source on github.com**

Open `https://github.com/kek/marklig/settings/pages` → "Build and deployment" → "Source" → choose **GitHub Actions**.

- [ ] **Step 5: Watch the deploy**

After the PR merges to `trunk`, the workflow runs. Watch the Actions tab; the deploy step should publish to `https://kek.github.io/marklig/` within a few minutes. Open the URL and re-run the checks from Step 1 against the live site.

---

## Risks and notes for the implementing engineer

- **CodeMirror under jsdom.** `tests/setup.ts` already shims `ResizeObserver` and friends. Reuse the existing setup; don't add new shims unless a test fails for a specific missing API.
- **Producer ordering.** `buildDecorationField` calls `Decoration.set(ranges, /* sort */ true)`. Don't bypass the builder — the boolean is correctness-critical (per CLAUDE.md).
- **Shiki on first paint.** Code blocks render as monospace text without colors until `primeHighlighter` resolves. Acceptable for the marketing page; the producer's cache effect re-renders on resolution.
- **No producer or shared-UI edits.** This plan adds files. If a task tempts you to edit `src/editor/decorations/*`, `src/editor/*`, or `src/ui/*` to make something "work on the web", stop and re-read the spec — the boundary stays at the alias in `vite.config.website.ts`.
- **JJ, not git.** All commits use `jj desc -m` + `jj new`. The PR push at the end uses `jj git push`, which is fine. Don't use raw `git commit` — it'll corrupt the jj state (per the `jujutsu` skill).
- **Vite alias correctness.** The alias in `vite.config.website.ts` resolves the absolute path of `src/shell/store.ts`. If a future move of `shell/store.ts` breaks the alias, the website build will start importing `@tauri-apps/plugin-store` again and fail at runtime — not a silent regression, but worth knowing about when refactoring.
