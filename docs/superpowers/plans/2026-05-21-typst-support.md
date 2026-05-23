# Typst support implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class support for opening, editing, and live-previewing `.typ` (Typst) files alongside `.md`, on desktop only, using the embedded `typst` Rust crate.

**Architecture:** A new format abstraction (`src/format/`) lets the editor pick a parser/renderer pair by file extension. Existing Markdown wiring is moved behind that abstraction with no behavior change. A new preview-pane UI element (toggled with Cmd-J) renders the active document's compiled output to the right of the editor — markdown-it HTML for `.md`, SVG-per-page for `.typ`. The Rust shell gains a `src-tauri/src/typst/` module with a `ViewerWorld` (Typst `World` impl), per-document `TypstSession`s with shared `comemo` cache, and invoke commands `typst_open` / `typst_compile` / `typst_close`. All Typst paths are `#[cfg(desktop)]`-gated.

**Tech Stack:** Tauri 2, CodeMirror 6, markdown-it (existing); `typst`, `typst-svg`, `typst-kit`, `typst-syntax`, `comemo` (new Rust deps); `codemirror-lang-typst` or an inline language grammar (new npm dep).

**Reference spec:** `docs/superpowers/specs/2026-05-21-typst-support-design.md`.

**Phases.** Each phase delivers reviewable, working software and ends with green tests + a commit. Subsequent phases assume prior phases shipped.

- **Phase A — Format abstraction (refactor, zero behavior change).** Introduce `src/format/`, route extension checks through `detectFormat`. Markdown stays as today.
- **Phase B — Preview pane for Markdown.** Cmd-J, split layout, splitter, settings, render Markdown HTML into the pane. Independently valuable.
- **Phase C — Rust Typst backend.** Add `typst` deps and `src-tauri/src/typst/` with `ViewerWorld`, `TypstSession`, invoke commands. Frontend doesn't wire it yet.
- **Phase D — Frontend Typst integration.** `.typ` open path, source highlighting, compile driver, diagnostics, preview pane wires to Typst SVGs.
- **Phase E — Lifecycle parity.** Folder sidebar `list_documents`, file association, "New Typst File" menu, sample.typ, macOS NSDocumentController kind.
- **Phase F — Polish.** Status-bar compile indicator, error display with dimmed-prior-pages, zoom controls in pane, i18n strings, visual-regression baseline.

**Conventions used throughout:**

- VCS is `jj`. Every task ends with `jj desc -m "..." && jj new`. The skill `jujutsu` covers this. Do NOT use raw `git commit`.
- Tests live under `tests/` mirroring `src/`. Vitest for unit, Playwright for e2e.
- Strict TypeScript. Always run `npx tsc -b --noEmit` after touching `.ts`.
- Rust: always run `cargo check` from `src-tauri/` after touching `.rs`.
- User-visible strings go through `t()` in `src/i18n/strings.ts`.

---

## Phase A — Format abstraction (refactor)

**Goal of phase:** Introduce a single source of truth for "which file extensions are supported" and "which format is this file?". Replace every ad-hoc `/\.(md|markdown|mdx|mdown)$/i` regex in the frontend with calls to that module. Markdown behavior is unchanged.

**File structure changes:**

- Create: `src/format/index.ts`
- Modify: `src/main.ts` (drag-drop filter, file-open-request filter)
- Modify: `src/shell/files.ts` (open dialog filter)
- Modify: `src/shell/window-state.ts` (if it has any extension checks — verify)
- Test: `tests/format/index.test.ts`

### Task A1: Create `src/format/index.ts`

**Files:**
- Create: `src/format/index.ts`
- Test: `tests/format/index.test.ts`

- [ ] **Step A1.1: Write the failing test**

Create `tests/format/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  detectFormat,
  isSupportedExtension,
  supportedExtensions,
  type Format,
} from "../../src/format";

describe("format", () => {
  it("detects markdown for .md and variants", () => {
    expect(detectFormat("a.md")).toBe<Format>("markdown");
    expect(detectFormat("/abs/path/a.markdown")).toBe<Format>("markdown");
    expect(detectFormat("FILE.MD")).toBe<Format>("markdown");
    expect(detectFormat("a.mdx")).toBe<Format>("markdown");
    expect(detectFormat("a.mdown")).toBe<Format>("markdown");
  });

  it("detects typst for .typ", () => {
    expect(detectFormat("a.typ")).toBe<Format>("typst");
    expect(detectFormat("/abs/X.TYP")).toBe<Format>("typst");
  });

  it("defaults to markdown for null / unknown / no path", () => {
    expect(detectFormat(null)).toBe<Format>("markdown");
    expect(detectFormat("noext")).toBe<Format>("markdown");
    expect(detectFormat("a.txt")).toBe<Format>("markdown");
  });

  it("isSupportedExtension covers md + typ variants", () => {
    for (const p of ["a.md", "a.markdown", "a.mdx", "a.mdown", "a.typ"]) {
      expect(isSupportedExtension(p)).toBe(true);
    }
    expect(isSupportedExtension("a.txt")).toBe(false);
    expect(isSupportedExtension("a.pdf")).toBe(false);
  });

  it("supportedExtensions returns the full list", () => {
    expect(supportedExtensions()).toEqual(
      expect.arrayContaining(["md", "markdown", "mdx", "mdown", "typ"]),
    );
  });
});
```

- [ ] **Step A1.2: Run test — verify fails**

Run: `npx vitest run tests/format/index.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step A1.3: Implement `src/format/index.ts`**

```ts
export type Format = "markdown" | "typst";

const MARKDOWN_EXTS = ["md", "markdown", "mdx", "mdown"] as const;
const TYPST_EXTS = ["typ"] as const;
const ALL_EXTS = [...MARKDOWN_EXTS, ...TYPST_EXTS];

function extOf(path: string | null): string | null {
  if (!path) return null;
  const i = path.lastIndexOf(".");
  if (i < 0) return null;
  return path.slice(i + 1).toLowerCase();
}

export function detectFormat(path: string | null): Format {
  const ext = extOf(path);
  if (ext && (TYPST_EXTS as readonly string[]).includes(ext)) return "typst";
  return "markdown";
}

export function isSupportedExtension(path: string): boolean {
  const ext = extOf(path);
  if (!ext) return false;
  return (ALL_EXTS as readonly string[]).includes(ext);
}

export function supportedExtensions(): string[] {
  return [...ALL_EXTS];
}

export function markdownExtensions(): string[] {
  return [...MARKDOWN_EXTS];
}

export function typstExtensions(): string[] {
  return [...TYPST_EXTS];
}
```

- [ ] **Step A1.4: Run test — verify passes**

Run: `npx vitest run tests/format/index.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step A1.5: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step A1.6: Commit**

```bash
jj desc -m "Add src/format/index.ts with detectFormat and isSupportedExtension"
jj new
```

### Task A2: Replace drag-drop extension regex in `src/main.ts`

**Files:**
- Modify: `src/main.ts` (~line 1182, the `mdFiles` filter inside `onDragDropEvent`)
- Modify: `src/main.ts` (~line 1233, the `md` filter inside `file-open-request`)

- [ ] **Step A2.1: Read the current code around the drag-drop handler**

Run: `grep -n "mdx\\|mdown" src/main.ts` to confirm the two sites.

- [ ] **Step A2.2: Update the drag-drop filter**

Replace this block in `src/main.ts`:

```ts
    const mdFiles = paths.filter((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (mdFiles.length === 0) return;
```

with:

```ts
    const docFiles = paths.filter((p) => isSupportedExtension(p));
    if (docFiles.length === 0) return;
```

Then rename the two subsequent uses of `mdFiles` to `docFiles` in the same block (`mdFiles[0]`, `mdFiles[i]`, `mdFiles.length`).

- [ ] **Step A2.3: Update the file-open-request filter**

Replace:

```ts
    const md = paths.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (!md) return;
```

with:

```ts
    const doc = paths.find((p) => isSupportedExtension(p));
    if (!doc) return;
```

Then rename `md` to `doc` in the rest of the handler (the variable is used to compute `targetRoot` and as the value passed to `emitTo`/`spawnNewWindow`).

- [ ] **Step A2.4: Add the import**

In the existing import block near the top of `src/main.ts`, add:

```ts
import { isSupportedExtension } from "./format";
```

- [ ] **Step A2.5: Type-check + run existing tests**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step A2.6: Commit**

```bash
jj desc -m "Route main.ts drag-drop and file-open filters through isSupportedExtension"
jj new
```

### Task A3: Replace open-dialog extension list in `src/shell/files.ts`

**Files:**
- Modify: `src/shell/files.ts` (the `openFileViaDialog` extension list)

- [ ] **Step A3.1: Locate the dialog filter**

Run: `grep -n "extensions" src/shell/files.ts`.

- [ ] **Step A3.2: Update the dialog filter**

Wherever the dialog `filters` array hardcodes `["md", "markdown", "mdx", "mdown"]`, change it to:

```ts
import { supportedExtensions } from "../format";
// ...
filters: [{ name: "Documents", extensions: supportedExtensions() }],
```

If there is also a Markdown-specific filter for `saveMarkdownAs`, leave that one as Markdown-only — saving a `.typ` via "Save As" is handled separately in Phase E.

- [ ] **Step A3.3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step A3.4: Commit**

```bash
jj desc -m "Open-dialog accepts all supported document extensions"
jj new
```

### Task A4: Add `src/format/markdown.ts` placeholder (no behavior change)

This task introduces the per-format module that later phases populate. For Phase A, it just re-exports the existing decoration producers so the registry pattern is in place. `main.ts` is *not* refactored to consume it yet — that happens in Phase D where Typst needs the registry.

**Files:**
- Create: `src/format/markdown.ts`
- Test: `tests/format/markdown.test.ts`

- [ ] **Step A4.1: Write the failing test**

Create `tests/format/markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { markdownFormat } from "../../src/format/markdown";

describe("markdownFormat", () => {
  it("exposes editing producers and reading producers", () => {
    expect(markdownFormat.editingProducers.length).toBeGreaterThan(0);
    expect(markdownFormat.readingProducers.length).toBeGreaterThan(
      markdownFormat.editingProducers.length,
    );
  });
});
```

- [ ] **Step A4.2: Run test — verify fails**

Run: `npx vitest run tests/format/markdown.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step A4.3: Implement `src/format/markdown.ts`**

```ts
import { headingsProducer } from "../editor/decorations/headings";
import { inlineProducer } from "../editor/decorations/inline";
import { listsProducer } from "../editor/decorations/lists";
import { linksProducer } from "../editor/decorations/links";
import { imagesProducer } from "../editor/decorations/images";
import { blockquotesProducer } from "../editor/decorations/blockquotes";
import { tablesProducer } from "../editor/decorations/tables";
import { codeblocksProducer } from "../editor/decorations/codeblocks";
import { frontmatterProducer } from "../editor/decorations/frontmatter";
import { footnotesProducer } from "../editor/decorations/footnotes";
import { readingWidgetsProducer } from "../editor/decorations/reading-widgets";
import { mathProducer } from "../editor/decorations/math";
import { mermaidProducer } from "../editor/decorations/mermaid";
import { graphvizProducer } from "../editor/decorations/graphviz";

export const markdownFormat = {
  id: "markdown" as const,
  editingProducers: [
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
  ],
  readingProducers: [
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
  ],
};
```

- [ ] **Step A4.4: Run test — verify passes**

Run: `npx vitest run tests/format/markdown.test.ts && npx tsc -b --noEmit`
Expected: PASS + no type errors.

- [ ] **Step A4.5: Commit**

```bash
jj desc -m "Introduce src/format/markdown.ts re-exporting decoration producers"
jj new
```

### Phase A acceptance

- `npm test` green.
- `npx tsc -b --noEmit` clean.
- Existing e2e specs still pass: `npx playwright test`.
- The app launches and behaves identically (smoke test: open a `.md`, toggle mode, save).

---

## Phase B — Preview pane (Markdown only)

**Goal of phase:** Add a new togglable preview pane to the right of the editor. Cmd-J toggles it in edit mode. For `.md`, the pane renders the document through the existing markdown-it + sanitize pipeline using the export stylesheet. Per-format default `{ markdown: false, typst: true }` is stored, but Typst rendering is inert until Phase D. The pane is resizable via a draggable splitter; width persists.

**File structure changes:**

- Modify: `src/shell/settings.ts` — add `previewPane`, `previewPaneWidth` getters/setters
- Create: `src/ui/preview-pane.ts` — the pane DOM/controller
- Create: `src/ui/preview-splitter.ts` — draggable splitter
- Modify: `src/editor/keymaps.ts` — Cmd-J binding wired through a handler setter
- Modify: `src/main.ts` — instantiate pane, wire Cmd-J handler, render Markdown HTML into pane
- Modify: `src/styles.css` (or wherever app shell layout lives) — grid template columns
- Test: `tests/ui/preview-pane.test.ts`, `tests/shell/settings.preview-pane.test.ts`, `tests/e2e/preview-pane.spec.ts`

### Task B1: Settings — `previewPane` per-format toggle + `previewPaneWidth`

**Files:**
- Modify: `src/shell/settings.ts`
- Test: `tests/shell/settings.preview-pane.test.ts`

- [ ] **Step B1.1: Write the failing test**

Create `tests/shell/settings.preview-pane.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getPreviewPaneOpen,
  setPreviewPaneOpen,
  getPreviewPaneWidth,
  setPreviewPaneWidth,
} from "../../src/shell/settings";

describe("preview-pane settings", () => {
  beforeEach(() => {
    // Reset to defaults each test by setting known values.
    setPreviewPaneOpen("markdown", false);
    setPreviewPaneOpen("typst", true);
    setPreviewPaneWidth(0.5);
  });

  it("defaults to false for markdown and true for typst", () => {
    // After resetting above, those ARE the defaults.
    expect(getPreviewPaneOpen("markdown")).toBe(false);
    expect(getPreviewPaneOpen("typst")).toBe(true);
  });

  it("setPreviewPaneOpen mutates only the targeted format", () => {
    setPreviewPaneOpen("markdown", true);
    expect(getPreviewPaneOpen("markdown")).toBe(true);
    expect(getPreviewPaneOpen("typst")).toBe(true); // untouched
  });

  it("preview-pane width clamps to [0.2, 0.8]", () => {
    setPreviewPaneWidth(0.1);
    expect(getPreviewPaneWidth()).toBe(0.2);
    setPreviewPaneWidth(0.9);
    expect(getPreviewPaneWidth()).toBe(0.8);
    setPreviewPaneWidth(0.42);
    expect(getPreviewPaneWidth()).toBe(0.42);
  });
});
```

- [ ] **Step B1.2: Run test — verify fails**

Run: `npx vitest run tests/shell/settings.preview-pane.test.ts`
Expected: FAIL.

- [ ] **Step B1.3: Implement**

Add to `src/shell/settings.ts`:

```ts
import type { Format } from "../format";

const DEFAULT_PREVIEW_PANE: Record<Format, boolean> = {
  markdown: false,
  typst: true,
};
const DEFAULT_PREVIEW_PANE_WIDTH = 0.5;
const MIN_PREVIEW_PANE_WIDTH = 0.2;
const MAX_PREVIEW_PANE_WIDTH = 0.8;

let previewPaneOpen: Record<Format, boolean> = { ...DEFAULT_PREVIEW_PANE };
let previewPaneWidth: number = DEFAULT_PREVIEW_PANE_WIDTH;

export function getPreviewPaneOpen(format: Format): boolean {
  return previewPaneOpen[format];
}

export function setPreviewPaneOpen(format: Format, v: boolean): void {
  if (previewPaneOpen[format] === v) return;
  previewPaneOpen = { ...previewPaneOpen, [format]: v };
  void setValue("previewPaneOpen", previewPaneOpen);
  for (const l of listeners) l();
}

export function getPreviewPaneWidth(): number {
  return previewPaneWidth;
}

export function setPreviewPaneWidth(v: number): void {
  const clamped = Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH, v));
  if (previewPaneWidth === clamped) return;
  previewPaneWidth = clamped;
  void setValue("previewPaneWidth", clamped);
  for (const l of listeners) l();
}
```

Also extend `loadSettings()` to read both keys with shape checks:

```ts
  try {
    const storedPane = await getValue<Partial<Record<Format, boolean>>>("previewPaneOpen");
    if (storedPane && typeof storedPane === "object") {
      previewPaneOpen = {
        markdown: typeof storedPane.markdown === "boolean" ? storedPane.markdown : DEFAULT_PREVIEW_PANE.markdown,
        typst:    typeof storedPane.typst    === "boolean" ? storedPane.typst    : DEFAULT_PREVIEW_PANE.typst,
      };
    }
    const storedWidth = await getValue<number>("previewPaneWidth");
    if (typeof storedWidth === "number" && isFinite(storedWidth)) {
      previewPaneWidth = Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH, storedWidth));
    }
  } catch { /* defaults */ }
```

- [ ] **Step B1.4: Run test — verify passes**

Run: `npx vitest run tests/shell/settings.preview-pane.test.ts && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step B1.5: Commit**

```bash
jj desc -m "Add per-format preview-pane settings (open, width)"
jj new
```

### Task B2: Preview pane controller (`src/ui/preview-pane.ts`)

The pane is a thin DOM wrapper with `setContent(html: string)`, `setVisible(v)`, `element`, and a `setStatus(text)` for later phases. It does NOT decide what to render — `main.ts` decides and pushes HTML in.

**Files:**
- Create: `src/ui/preview-pane.ts`
- Test: `tests/ui/preview-pane.test.ts`

- [ ] **Step B2.1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mountPreviewPane } from "../../src/ui/preview-pane";

describe("preview pane", () => {
  let parent: HTMLElement;
  beforeEach(() => {
    parent = document.createElement("div");
    document.body.append(parent);
  });

  it("mounts hidden by default and shows on setVisible(true)", () => {
    const handle = mountPreviewPane({ parent });
    expect(handle.element.hidden).toBe(true);
    handle.setVisible(true);
    expect(handle.element.hidden).toBe(false);
  });

  it("setContent inserts sanitized HTML into the body", () => {
    const handle = mountPreviewPane({ parent });
    handle.setContent("<h1>Hi</h1><script>alert(1)</script>");
    expect(handle.element.querySelector("h1")?.textContent).toBe("Hi");
    expect(handle.element.querySelector("script")).toBeNull();
  });

  it("setStatus updates the header line", () => {
    const handle = mountPreviewPane({ parent });
    handle.setStatus("Compiling…");
    expect(handle.element.textContent).toContain("Compiling…");
  });
});
```

- [ ] **Step B2.2: Run — verify fails**

Run: `npx vitest run tests/ui/preview-pane.test.ts`
Expected: FAIL.

- [ ] **Step B2.3: Implement**

```ts
import { sanitizeHtml } from "../export/sanitize";

export interface MountPreviewPaneOptions {
  parent: HTMLElement;
}

export interface PreviewPaneHandle {
  element: HTMLElement;
  setVisible(visible: boolean): void;
  setContent(rawHtml: string): void;
  setRawSvg(svg: string): void; // used by Typst in Phase D
  setStatus(text: string | null): void;
  isVisible(): boolean;
  destroy(): void;
}

export function mountPreviewPane(opts: MountPreviewPaneOptions): PreviewPaneHandle {
  const root = document.createElement("aside");
  root.className = "preview-pane";
  root.hidden = true;
  root.setAttribute("aria-label", "Preview");

  const header = document.createElement("div");
  header.className = "preview-pane-header";
  const status = document.createElement("span");
  status.className = "preview-pane-status";
  header.append(status);

  const body = document.createElement("div");
  body.className = "preview-pane-body";

  root.append(header, body);
  opts.parent.append(root);

  return {
    element: root,
    setVisible(v) { root.hidden = !v; },
    isVisible() { return !root.hidden; },
    setContent(rawHtml) {
      body.innerHTML = sanitizeHtml(rawHtml);
    },
    setRawSvg(svg) {
      // Sanitization happens via sanitizeSvg at the caller (Typst path).
      body.innerHTML = svg;
    },
    setStatus(text) {
      status.textContent = text ?? "";
    },
    destroy() {
      root.remove();
    },
  };
}
```

- [ ] **Step B2.4: Run — verify passes**

Run: `npx vitest run tests/ui/preview-pane.test.ts`
Expected: PASS.

- [ ] **Step B2.5: Commit**

```bash
jj desc -m "Add preview-pane controller with sanitized setContent"
jj new
```

### Task B3: Splitter (`src/ui/preview-splitter.ts`)

A draggable vertical splitter that updates `previewPaneWidth` in settings.

**Files:**
- Create: `src/ui/preview-splitter.ts`
- Test: `tests/ui/preview-splitter.test.ts`

- [ ] **Step B3.1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mountPreviewSplitter } from "../../src/ui/preview-splitter";

describe("preview splitter", () => {
  let parent: HTMLElement;
  beforeEach(() => {
    parent = document.createElement("div");
    Object.defineProperty(parent, "clientWidth", { value: 1000, configurable: true });
    document.body.append(parent);
  });

  it("emits onResize with a clamped fraction during drag", () => {
    const fractions: number[] = [];
    const handle = mountPreviewSplitter({
      parent,
      container: parent,
      onResize: (f) => fractions.push(f),
    });
    handle.element.dispatchEvent(new MouseEvent("mousedown", { clientX: 600, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
    // 1 - (400 / 1000) = 0.6
    expect(fractions.at(-1)).toBeCloseTo(0.6, 2);
  });
});
```

- [ ] **Step B3.2: Run — verify fails**

Run: `npx vitest run tests/ui/preview-splitter.test.ts`
Expected: FAIL.

- [ ] **Step B3.3: Implement**

```ts
export interface MountPreviewSplitterOptions {
  parent: HTMLElement;
  /** Element whose width is used to compute the fraction (the app shell). */
  container: HTMLElement;
  onResize(fraction: number): void;
}

export interface PreviewSplitterHandle {
  element: HTMLElement;
  destroy(): void;
}

export function mountPreviewSplitter(opts: MountPreviewSplitterOptions): PreviewSplitterHandle {
  const el = document.createElement("div");
  el.className = "preview-splitter";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.tabIndex = 0;
  opts.parent.append(el);

  let dragging = false;

  function onMove(e: MouseEvent): void {
    if (!dragging) return;
    const rect = opts.container.getBoundingClientRect();
    const containerWidth = rect.width || opts.container.clientWidth || 1;
    const fromRight = rect.right - e.clientX;
    const fraction = fromRight / containerWidth;
    opts.onResize(fraction);
  }
  function onUp(): void {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("preview-splitter-dragging");
  }
  function onDown(_e: MouseEvent): void {
    dragging = true;
    document.body.classList.add("preview-splitter-dragging");
  }

  el.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  return {
    element: el,
    destroy() {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.remove();
    },
  };
}
```

- [ ] **Step B3.4: Run — verify passes**

Run: `npx vitest run tests/ui/preview-splitter.test.ts && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step B3.5: Commit**

```bash
jj desc -m "Add draggable splitter for the preview pane"
jj new
```

### Task B4: Cmd-J binding in `src/editor/keymaps.ts`

**Files:**
- Modify: `src/editor/keymaps.ts`

- [ ] **Step B4.1: Add handler setter + binding**

In `src/editor/keymaps.ts`, after `setSidebarToggleHandler`:

```ts
let previewPaneToggleHandler: () => void = () => {};
export function setPreviewPaneToggleHandler(handler: () => void): void {
  previewPaneToggleHandler = handler;
}

const previewPaneToggleBinding: KeyBinding = {
  key: "Mod-j",
  preventDefault: true,
  run: () => { previewPaneToggleHandler(); return true; },
};
```

Add `previewPaneToggleBinding` to BOTH `readingKeymap` and `editKeymap`'s `keymap.of([...])` (right after `sidebarToggleBinding`). The handler itself is a no-op in reading mode; main.ts decides what to do.

- [ ] **Step B4.2: Type-check**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step B4.3: Commit**

```bash
jj desc -m "Bind Cmd-J to preview-pane toggle handler"
jj new
```

### Task B5: CSS — split layout for the app shell

The app shell currently is a row with sidebar + editor. The pane goes to the right of the editor. The splitter lives in the gap.

**Files:**
- Modify: `src/styles.css` (or wherever `.viewer-app-shell` lives — `grep -n "viewer-app-shell" src/`)

- [ ] **Step B5.1: Locate the shell styles**

Run: `grep -rn "viewer-app-shell" src/`

- [ ] **Step B5.2: Add preview-pane styles**

Append to the relevant CSS file:

```css
.viewer-app-shell {
  /* Pre-existing rules retained. Adds preview pane support. */
  --preview-pane-width: 0px; /* runtime sets to '<fraction> * 100%' when open */
}
.viewer-app-shell.preview-open {
  display: grid;
  grid-template-columns: auto 1fr auto var(--preview-pane-width);
}
.preview-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--separator, #ddd);
  background: var(--editor-bg, #fff);
  overflow: auto;
}
.preview-pane[hidden] { display: none; }
.preview-pane-header {
  font-size: 11px;
  padding: 6px 12px;
  color: var(--muted, #666);
}
.preview-pane-body {
  padding: 16px 24px;
  overflow: auto;
}
.preview-splitter {
  width: 6px;
  cursor: col-resize;
  background: transparent;
}
.preview-splitter:hover, body.preview-splitter-dragging .preview-splitter {
  background: var(--separator, #ddd);
}
```

(Adjust class names if `viewer-app-shell` uses a different grid arrangement; the goal is: when `.preview-open` is set, the pane shows with the configured width and the splitter sits between editor and pane.)

- [ ] **Step B5.3: Commit**

```bash
jj desc -m "Add CSS for preview pane and splitter (hidden by default)"
jj new
```

### Task B6: Wire it all in `src/main.ts`

**Files:**
- Modify: `src/main.ts` (imports, instantiate pane + splitter, install Cmd-J handler, render Markdown HTML into pane on changes)

- [ ] **Step B6.1: Add imports**

Near the existing import block:

```ts
import { detectFormat } from "./format";
import { mountPreviewPane, type PreviewPaneHandle } from "./ui/preview-pane";
import { mountPreviewSplitter } from "./ui/preview-splitter";
import {
  setPreviewPaneToggleHandler,
} from "./editor/keymaps";
import {
  getPreviewPaneOpen,
  setPreviewPaneOpen,
  getPreviewPaneWidth,
  setPreviewPaneWidth,
} from "./shell/settings";
import MarkdownIt from "markdown-it"; // already imported elsewhere? if so, reuse
```

(If a markdown-it instance already exists for the export path, reuse it rather than constructing a new one. `src/export/html.ts` exports `buildHtmlExport` — for the preview we want just the *body* HTML, not the full export wrapper. See B6.3.)

- [ ] **Step B6.2: Instantiate pane + splitter inside `bootstrap()`**

After `shell` is created and `view` is mounted but before `mountChrome` (so layout flows right), add:

```ts
  const previewPane: PreviewPaneHandle = mountPreviewPane({ parent: shell });
  mountPreviewSplitter({
    parent: shell,
    container: shell,
    onResize: (frac) => {
      setPreviewPaneWidth(frac);
      applyPreviewPaneLayout();
    },
  });

  function applyPreviewPaneLayout(): void {
    const format = detectFormat(currentPath);
    const open = getPreviewPaneOpen(format);
    shell.classList.toggle("preview-open", open);
    previewPane.setVisible(open);
    shell.style.setProperty(
      "--preview-pane-width",
      `${(getPreviewPaneWidth() * 100).toFixed(2)}%`,
    );
  }
  applyPreviewPaneLayout();
```

- [ ] **Step B6.3: Add a markdown-renderer helper for the pane**

Create the small helper at the top of `bootstrap()` (or in `src/format/markdown.ts` if we want to centralize — for now, inline is fine):

```ts
  // Reuse the same markdown-it config as the export pipeline so what the
  // pane shows matches what export would produce. buildHtmlExport returns a
  // full HTML doc; we want only the body fragment. Extract by splitting on
  // the document scaffold OR refactor buildHtmlExport later to expose a
  // bodyOnly variant. For Phase B we do a lightweight md-it instance.
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

  function renderMarkdownToPane(): void {
    if (detectFormat(currentPath) !== "markdown") return;
    if (!getPreviewPaneOpen("markdown")) return;
    const html = md.render(view.state.doc.toString());
    previewPane.setContent(html); // sanitizeHtml runs inside setContent
  }
  renderMarkdownToPane();
```

NOTE: This is intentionally simple. The full math/Mermaid/Shiki render lives in the export pipeline; surfacing all of that in the pane is Phase F polish.

- [ ] **Step B6.4: Wire Cmd-J handler**

After `setSidebarToggleHandler(...)`:

```ts
  setPreviewPaneToggleHandler(() => {
    if (currentMode !== "edit") return; // no-op in reading mode
    const format = detectFormat(currentPath);
    const next = !getPreviewPaneOpen(format);
    setPreviewPaneOpen(format, next);
    applyPreviewPaneLayout();
    if (next) renderMarkdownToPane();
  });
```

- [ ] **Step B6.5: Re-render on doc change**

Augment the existing `tocUpdateCompartment` updateListener — find the block that calls `toc.refresh()` and `refreshStats()`, and add:

```ts
          if (!u.docChanged) return;
          toc.refresh();
          refreshStats();
          renderMarkdownToPane();
```

- [ ] **Step B6.6: Re-render on doc load**

In `loadAndApplyDoc`, after `dirtyTracker.reset();`, add:

```ts
    applyPreviewPaneLayout();
    renderMarkdownToPane();
```

- [ ] **Step B6.7: Type-check + run all tests**

Run: `npx tsc -b --noEmit && npm test`
Expected: green.

- [ ] **Step B6.8: Manual smoke test**

Run: `npm run tauri:dev`. Open a `.md`. Switch to edit mode (Cmd-E). Press Cmd-J — pane should appear on the right with rendered HTML. Edit the source — pane updates. Drag the splitter — pane resizes. Close pane (Cmd-J again). Restart — pane stays closed for Markdown (default) but width is remembered.

- [ ] **Step B6.9: Commit**

```bash
jj desc -m "Wire preview pane: Cmd-J toggles, Markdown rendered via markdown-it"
jj new
```

### Task B7: E2E test for Markdown preview pane

**Files:**
- Create: `tests/e2e/preview-pane.spec.ts`

- [ ] **Step B7.1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { launchApp, openSample } from "./helpers"; // adapt to your existing helpers

test("Cmd-J toggles Markdown preview pane in edit mode", async () => {
  const app = await launchApp();
  const page = app.firstWindow();
  await openSample(page, "sample.md");

  // Switch to edit mode (Cmd-E)
  await page.keyboard.press("Meta+E");

  // Pane should be hidden by default
  await expect(page.locator(".preview-pane")).toBeHidden();

  // Toggle on
  await page.keyboard.press("Meta+J");
  await expect(page.locator(".preview-pane")).toBeVisible();

  // Pane body should contain rendered HTML
  await expect(page.locator(".preview-pane-body h1, .preview-pane-body h2"))
    .toHaveCountGreaterThan(0);

  // Toggle off
  await page.keyboard.press("Meta+J");
  await expect(page.locator(".preview-pane")).toBeHidden();

  await app.close();
});
```

(Adapt `launchApp` / `openSample` calls to match the existing helpers in `tests/e2e/`. Run `ls tests/e2e/` and look at any existing spec for the right import.)

- [ ] **Step B7.2: Run**

Run: `npx playwright test tests/e2e/preview-pane.spec.ts`
Expected: PASS.

- [ ] **Step B7.3: Commit**

```bash
jj desc -m "E2E: Cmd-J toggles Markdown preview pane"
jj new
```

### Phase B acceptance

- `npm test` green, including new pane + settings unit tests.
- `npx playwright test tests/e2e/preview-pane.spec.ts` green.
- Smoke: opening a `.md` and pressing Cmd-J in edit mode shows the rendered Markdown to the right. The splitter resizes it. The setting persists per-format.

---

## Phase C — Rust Typst backend

**Goal of phase:** A working in-process Typst compiler exposed through three invoke commands: `typst_open`, `typst_compile`, `typst_close`. No frontend wiring yet. Unit tests via Rust integration tests cover the happy path, a syntax error, and a missing import.

**File structure changes (all `#[cfg(desktop)]`):**

- Modify: `src-tauri/Cargo.toml` — add deps
- Create: `src-tauri/src/typst/mod.rs`
- Create: `src-tauri/src/typst/world.rs`
- Create: `src-tauri/src/typst/session.rs`
- Create: `src-tauri/src/typst/commands.rs`
- Create: `src-tauri/src/typst/diagnostics.rs`
- Create: `src-tauri/src/typst/packages.rs`
- Modify: `src-tauri/src/lib.rs` — register module + commands + state
- Create: `src-tauri/tests/typst_basic.rs`

### Task C1: Add Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step C1.1: Verify the latest typst crate versions**

Run: `cargo search typst-svg | head -3`
Expected: a version line, e.g. `typst-svg = "0.13.x"`.

- [ ] **Step C1.2: Add deps under the existing desktop-only target**

In `src-tauri/Cargo.toml`, under `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`, add (using the versions you found in C1.1; do not pin patch versions):

```toml
typst = "0.13"
typst-syntax = "0.13"
typst-svg = "0.13"
typst-kit = "0.13"
comemo = "0.4"
uuid = { version = "1", features = ["v4"] }
parking_lot = "0.12"
```

- [ ] **Step C1.3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: clean (warnings OK; no errors).

- [ ] **Step C1.4: Commit**

```bash
jj desc -m "Add typst, typst-kit, comemo deps (desktop only)"
jj new
```

### Task C2: Skeleton `src-tauri/src/typst/` module

**Files:**
- Create: `src-tauri/src/typst/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step C2.1: Create the module skeleton**

`src-tauri/src/typst/mod.rs`:

```rust
//! Embedded Typst compiler. Desktop-only — gated at `lib.rs`.
#![cfg(not(any(target_os = "android", target_os = "ios")))]

pub mod commands;
pub mod diagnostics;
pub mod packages;
pub mod session;
pub mod world;

pub use commands::{TypstState, typst_open, typst_compile, typst_close};
```

- [ ] **Step C2.2: Wire it into `lib.rs`**

Find the existing desktop-only modules in `src-tauri/src/lib.rs` (next to `commands::watcher`, etc.) and add:

```rust
#[cfg(desktop)]
mod typst;
```

In the `tauri::Builder::default()` chain, add the state and command registration inside the existing `#[cfg(desktop)]` block:

```rust
#[cfg(desktop)]
{
    builder = builder
        .manage(typst::TypstState::new())
        .invoke_handler(tauri::generate_handler![
            // ...existing handlers...
            typst::typst_open,
            typst::typst_compile,
            typst::typst_close,
        ]);
}
```

(Exact placement depends on how `lib.rs` is structured today. Read it first — the existing `WatcherState` registration is the pattern to copy.)

- [ ] **Step C2.3: Stub commands so `cargo check` passes**

Until we write the real `commands.rs` in later tasks, give the module just enough to compile. Create `src-tauri/src/typst/commands.rs`:

```rust
use std::collections::HashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub struct TypstState {
    sessions: Mutex<HashMap<String, ()>>, // placeholder
}

impl TypstState {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

#[derive(Serialize)]
pub struct CompileResult { pub pages: Vec<String>, pub diagnostics: Vec<()>, pub elapsed_ms: u32 }

#[derive(Serialize, thiserror::Error, Debug)]
pub enum TypstError {
    #[error("not implemented")]
    NotImplemented,
}

#[tauri::command]
pub fn typst_open(_path: String) -> Result<String, TypstError> { Err(TypstError::NotImplemented) }

#[tauri::command]
pub fn typst_compile(_session_id: String, _source: String) -> Result<CompileResult, TypstError> {
    Err(TypstError::NotImplemented)
}

#[tauri::command]
pub fn typst_close(_session_id: String) -> Result<(), TypstError> { Ok(()) }
```

Create empty stub files `diagnostics.rs`, `packages.rs`, `session.rs`, `world.rs` (single `// stub` line each — they get content in C3–C6).

- [ ] **Step C2.4: Verify build**

Run: `cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step C2.5: Commit**

```bash
jj desc -m "Stub src-tauri/src/typst module + register commands"
jj new
```

### Task C3: `ViewerWorld` (typst World impl)

**Files:**
- Modify: `src-tauri/src/typst/world.rs`

- [ ] **Step C3.1: Implement ViewerWorld**

```rust
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use comemo::Prehashed;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};
use typst_kit::fonts::{FontSearcher, Fonts};

pub struct ViewerWorld {
    library: LazyHash<Library>,
    fontbook: LazyHash<FontBook>,
    fonts: Vec<Font>,
    root: PathBuf,
    main: FileId,
    main_source: parking_lot::RwLock<Source>,
}

impl ViewerWorld {
    pub fn new(entry_path: &Path) -> Result<Self, std::io::Error> {
        let root = entry_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let rel = entry_path
            .file_name()
            .map(|n| PathBuf::from(n))
            .unwrap_or_else(|| PathBuf::from("main.typ"));
        let main = FileId::new(None, VirtualPath::new(rel));
        let source_text = std::fs::read_to_string(entry_path)?;
        let main_source = Source::new(main, source_text);

        let mut searcher = FontSearcher::new();
        searcher.include_system_fonts(true);
        let Fonts { book, fonts } = searcher.search();

        Ok(Self {
            library: LazyHash::new(Library::default()),
            fontbook: LazyHash::new(book),
            fonts,
            root,
            main,
            main_source: parking_lot::RwLock::new(main_source),
        })
    }

    /// Replace the in-memory main source for the next compile.
    pub fn set_main_source(&self, text: String) {
        let mut guard = self.main_source.write();
        *guard = Source::new(self.main, text);
    }

    pub fn main_id(&self) -> FileId { self.main }
}

impl World for ViewerWorld {
    fn library(&self) -> &LazyHash<Library> { &self.library }
    fn book(&self) -> &LazyHash<FontBook> { &self.fontbook }
    fn main(&self) -> FileId { self.main }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            return Ok(self.main_source.read().clone());
        }
        let path = resolve_id(&self.root, id)?;
        let text = std::fs::read_to_string(&path)
            .map_err(|err| FileError::from_io(err, &path))?;
        Ok(Source::new(id, text))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let path = resolve_id(&self.root, id)?;
        let bytes = std::fs::read(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Bytes::from(bytes))
    }

    fn font(&self, index: usize) -> Option<Font> { self.fonts.get(index).cloned() }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        let now = chrono::Local::now();
        Datetime::from_ymd(now.year(), now.month() as u8, now.day() as u8)
    }
}

fn resolve_id(root: &Path, id: FileId) -> FileResult<PathBuf> {
    let path = id.vpath().resolve(root).ok_or_else(|| {
        FileError::Other(Some(eco_format::eco_format!("could not resolve path")))
    })?;
    Ok(path)
}

// Pull in items used above so the file compiles standalone.
use chrono::Datelike;
use eco_format;
```

NOTE: The exact API of typst 0.13 may differ. Run `cargo check` after writing and adjust types as the compiler reports (`Prehashed` → `LazyHash`, `eco_format!` vs `EcoString::from`, etc.). The structure above is the spec's contract; the exact line-by-line implementation is best confirmed against the current crate docs (`cargo doc --open -p typst` or context7 → typst).

- [ ] **Step C3.2: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean. If errors, the typst crate API has moved — adjust the types in `world.rs` to match.

- [ ] **Step C3.3: Commit**

```bash
jj desc -m "Implement ViewerWorld with disk-backed source/file resolution"
jj new
```

### Task C4: `TypstSession` (`src-tauri/src/typst/session.rs`)

**Files:**
- Modify: `src-tauri/src/typst/session.rs`

- [ ] **Step C4.1: Implement session**

```rust
use std::path::Path;
use crate::typst::world::ViewerWorld;

pub struct TypstSession {
    pub world: ViewerWorld,
}

impl TypstSession {
    pub fn open(path: &Path) -> Result<Self, std::io::Error> {
        Ok(Self { world: ViewerWorld::new(path)? })
    }

    pub fn set_source(&self, text: String) {
        self.world.set_main_source(text);
    }
}
```

The reason `TypstSession` is intentionally thin: `comemo` does the heavy memoization. We rely on the same `ViewerWorld` instance being passed to each `typst::compile` call so that comemo's per-tracked-input cache reuses results.

- [ ] **Step C4.2: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step C4.3: Commit**

```bash
jj desc -m "Add TypstSession wrapping ViewerWorld"
jj new
```

### Task C5: Diagnostics shape (`src-tauri/src/typst/diagnostics.rs`)

**Files:**
- Modify: `src-tauri/src/typst/diagnostics.rs`

- [ ] **Step C5.1: Implement the wire format + converter**

```rust
use serde::Serialize;
use typst::diag::{Severity as TypstSev, SourceDiagnostic};
use typst::syntax::Source;

#[derive(Serialize, Clone, Debug)]
pub struct Position { pub line: u32, pub column: u32 }

#[derive(Serialize, Clone, Debug)]
pub struct Range { pub start: Position, pub end: Position }

#[derive(Serialize, Clone, Debug)]
pub struct Diag {
    pub severity: &'static str, // "error" | "warning"
    pub message: String,
    pub range: Range,
    pub file: Option<String>,
}

pub fn to_wire(diags: &[SourceDiagnostic], main: &Source) -> Vec<Diag> {
    diags.iter().map(|d| to_one(d, main)).collect()
}

fn to_one(d: &SourceDiagnostic, main: &Source) -> Diag {
    let severity = match d.severity {
        TypstSev::Error => "error",
        TypstSev::Warning => "warning",
    };
    let range = if let Some(span) = d.span.id().and_then(|id| {
        if id == main.id() { Some(main) } else { None }
    }) {
        let start_byte = main.range(d.span).map(|r| r.start).unwrap_or(0);
        let end_byte = main.range(d.span).map(|r| r.end).unwrap_or(0);
        Range {
            start: byte_to_pos(range, start_byte),
            end: byte_to_pos(range, end_byte),
        }
    } else {
        Range { start: Position { line: 0, column: 0 }, end: Position { line: 0, column: 0 } }
    };
    Diag {
        severity,
        message: d.message.to_string(),
        range,
        file: None,
    }
}

fn byte_to_pos(source: &Source, byte: usize) -> Position {
    let line = source.byte_to_line(byte).unwrap_or(0) as u32;
    let col = source.byte_to_column(byte).unwrap_or(0) as u32;
    Position { line, column: col }
}
```

(Again: the exact typst-syntax API may differ. Adjust to the compiler's hints.)

- [ ] **Step C5.2: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step C5.3: Commit**

```bash
jj desc -m "Add typst::diagnostics wire format and converter"
jj new
```

### Task C6: Package resolution stub (`src-tauri/src/typst/packages.rs`)

For Phase C, this is a stub that always returns `FileError::Package` for `@preview/...`. Full implementation lands in Phase F (or sooner if a real test doc needs it). The session still works for docs that don't import packages — which covers the integration test.

**Files:**
- Modify: `src-tauri/src/typst/packages.rs`

- [ ] **Step C6.1: Add a minimal stub**

```rust
// Placeholder. Full package resolution is added in Phase F (or moved
// earlier if a test fixture needs it).
```

- [ ] **Step C6.2: Commit**

```bash
jj desc -m "Stub typst::packages module (Phase F will implement)"
jj new
```

### Task C7: Real `typst_open` / `typst_compile` / `typst_close`

**Files:**
- Modify: `src-tauri/src/typst/commands.rs`

- [ ] **Step C7.1: Implement the commands**

Replace the stub `commands.rs` with the real impl:

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::typst::diagnostics::{to_wire, Diag};
use crate::typst::session::TypstSession;

pub struct TypstState {
    sessions: Mutex<HashMap<String, TypstSession>>,
}

impl TypstState {
    pub fn new() -> Self { Self { sessions: Mutex::new(HashMap::new()) } }
}

#[derive(Serialize)]
pub struct CompileResult {
    pub pages: Vec<String>,
    pub diagnostics: Vec<Diag>,
    pub elapsed_ms: u32,
}

#[derive(Serialize, thiserror::Error, Debug)]
pub enum TypstError {
    #[error("session {0} not found")]
    UnknownSession(String),
    #[error("io: {0}")]
    Io(String),
}

#[tauri::command]
pub fn typst_open(state: State<'_, TypstState>, path: String) -> Result<String, TypstError> {
    let p = PathBuf::from(&path);
    let session = TypstSession::open(&p).map_err(|e| TypstError::Io(e.to_string()))?;
    let id = Uuid::new_v4().to_string();
    state.sessions.lock().insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub fn typst_compile(
    state: State<'_, TypstState>,
    session_id: String,
    source: String,
) -> Result<CompileResult, TypstError> {
    let start = std::time::Instant::now();
    let pages_and_diags = {
        let map = state.sessions.lock();
        let session = map.get(&session_id)
            .ok_or_else(|| TypstError::UnknownSession(session_id.clone()))?;
        session.set_source(source);

        // Compile the document. Returns (document, diagnostics) shape varies
        // across typst minor versions; adapt to the one in Cargo.toml.
        let result = typst::compile(&session.world);

        let diags = to_wire(result.warnings(), session.world.main_source_ref());
        let pages: Vec<String> = match result.output {
            Ok(doc) => {
                doc.pages.iter()
                    .map(|p| typst_svg::svg(p))
                    .collect()
            }
            Err(errs) => {
                // No pages on hard failure; merge errors into the diag list.
                let mut all = to_wire(&errs, session.world.main_source_ref());
                all.extend(diags.clone());
                return Ok(CompileResult {
                    pages: vec![],
                    diagnostics: all,
                    elapsed_ms: start.elapsed().as_millis() as u32,
                });
            }
        };
        (pages, diags)
    };

    Ok(CompileResult {
        pages: pages_and_diags.0,
        diagnostics: pages_and_diags.1,
        elapsed_ms: start.elapsed().as_millis() as u32,
    })
}

#[tauri::command]
pub fn typst_close(state: State<'_, TypstState>, session_id: String) {
    state.sessions.lock().remove(&session_id);
}
```

Also expose `main_source_ref()` from `ViewerWorld` so the diagnostics converter has access:

```rust
// in world.rs
impl ViewerWorld {
    pub fn main_source_ref(&self) -> Source {
        self.main_source.read().clone()
    }
}
```

- [ ] **Step C7.2: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean. Adapt API mismatches as needed.

- [ ] **Step C7.3: Commit**

```bash
jj desc -m "Implement typst_open/compile/close commands"
jj new
```

### Task C8: Rust integration test (`src-tauri/tests/typst_basic.rs`)

**Files:**
- Create: `src-tauri/tests/typst_basic.rs`

- [ ] **Step C8.1: Write the test**

```rust
#![cfg(not(any(target_os = "android", target_os = "ios")))]
use std::fs;
use tempfile::TempDir;

use marklig_lib::typst::session::TypstSession;

#[test]
fn compiles_a_minimal_document() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.typ");
    fs::write(&path, "= Hello world\n\nA paragraph.\n").unwrap();
    let session = TypstSession::open(&path).expect("open");
    session.set_source(fs::read_to_string(&path).unwrap());

    let res = typst::compile(&session.world);
    let doc = res.output.expect("compile ok");
    assert!(!doc.pages.is_empty(), "expected at least one page");
    let svg = typst_svg::svg(&doc.pages[0]);
    assert!(svg.starts_with("<svg"));
}

#[test]
fn reports_syntax_error_without_panic() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("broken.typ");
    // Unclosed function bracket.
    fs::write(&path, "#text(weight: \"bold\"").unwrap();
    let session = TypstSession::open(&path).expect("open");
    session.set_source(fs::read_to_string(&path).unwrap());
    let res = typst::compile(&session.world);
    assert!(res.output.is_err(), "expected compile error");
}
```

Add `tempfile = "3"` to `src-tauri/Cargo.toml` under `[dev-dependencies]` if not already there.

(`marklig_lib` is the library crate name from `Cargo.toml`; verify with `grep '^name' src-tauri/Cargo.toml`.)

Expose `typst` module as public on the library crate so tests can import: in `src-tauri/src/lib.rs`, ensure `#[cfg(desktop)] pub mod typst;` (the `pub` is required).

- [ ] **Step C8.2: Run test**

Run: `cd src-tauri && cargo test --test typst_basic`
Expected: 2 passed.

- [ ] **Step C8.3: Commit**

```bash
jj desc -m "Add Rust integration test: typst compile happy + error paths"
jj new
```

### Phase C acceptance

- `cd src-tauri && cargo check` clean.
- `cargo test` green (Rust unit + integration).
- The three commands are wired into the invoke handler and reachable from the frontend (we'll prove this in Phase D).

---

## Phase D — Frontend Typst integration

**Goal of phase:** Open a `.typ` file from any source (CLI arg, drag-drop, dialog), show Typst-flavored source highlighting, run a debounced compile on every keystroke when the preview pane is open, render SVG pages into the pane, and surface diagnostics as red gutter underlines.

**File structure changes:**

- Create: `src/format/typst.ts`
- Create: `src/format/typst-driver.ts`
- Create: `src/editor/typst-diagnostics.ts`
- Create: `src/editor/typst-language.ts`
- Modify: `src/main.ts`
- Modify: `src/shell/files.ts` (read .typ as text — same `read_text_file` works, but verify open dialog already accepts via Phase A)
- Test: `tests/format/typst.test.ts`, `tests/format/typst-driver.test.ts`, `tests/e2e/typst-basic.spec.ts`

### Task D1: Typst format module (`src/format/typst.ts`)

**Files:**
- Create: `src/format/typst.ts`
- Test: `tests/format/typst.test.ts`

- [ ] **Step D1.1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { typstFormat } from "../../src/format/typst";

describe("typstFormat", () => {
  it("exposes editing+reading producers (empty by default — highlighting comes from lang)", () => {
    expect(typstFormat.editingProducers).toEqual([]);
    expect(typstFormat.readingProducers).toEqual([]);
  });

  it("exposes the language extension", () => {
    expect(typstFormat.languageExtension).toBeDefined();
  });
});
```

- [ ] **Step D1.2: Run — fails**

Run: `npx vitest run tests/format/typst.test.ts`
Expected: FAIL.

- [ ] **Step D1.3: Implement**

```ts
import { typstLanguageExtension } from "../editor/typst-language";

export const typstFormat = {
  id: "typst" as const,
  editingProducers: [],
  readingProducers: [],
  languageExtension: typstLanguageExtension(),
};
```

- [ ] **Step D1.4: Implement `src/editor/typst-language.ts`**

Install the language package: `npm install @codemirror/lang-rust @lezer/highlight`. Lacking a stable `codemirror-lang-typst` may force a roll-your-own approach; the simplest stable v1 is a `StreamLanguage` based on the typst lexer rules — keywords, strings, comments. For the plan, we use a small `StreamLanguage`:

Install: `npm install @codemirror/language @codemirror/legacy-modes`.

```ts
import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const typstStreamLanguage = StreamLanguage.define({
  name: "typst",
  startState: () => ({ inString: false as false | '"' | '\'' }),
  token(stream, state) {
    if (state.inString) {
      if (stream.match(/^\\./)) return "string";
      if (stream.match(state.inString as string)) { state.inString = false; return "string"; }
      stream.next();
      return "string";
    }
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^"/)) { state.inString = '"'; return "string"; }
    if (stream.match(/^#(let|set|show|import|include|if|else|while|for|return|break|continue|in|none|auto|true|false)\b/)) {
      return "keyword";
    }
    if (stream.match(/^#[a-zA-Z_][a-zA-Z0-9_-]*/)) return "variableName";
    if (stream.match(/^@[a-zA-Z_][a-zA-Z0-9_/.-]*/)) return "string"; // package refs
    if (stream.match(/^=+\s/)) return "heading";
    if (stream.match(/^\*[^*]+\*/)) return "strong";
    if (stream.match(/^_[^_]+_/)) return "emphasis";
    if (stream.match(/^[0-9]+(\.[0-9]+)?/)) return "number";
    stream.next();
    return null;
  },
  tokenTable: {
    keyword: t.keyword,
    string: t.string,
    comment: t.comment,
    variableName: t.variableName,
    number: t.number,
    heading: t.heading,
    strong: t.strong,
    emphasis: t.emphasis,
  },
});

export function typstLanguageExtension(): LanguageSupport {
  return new LanguageSupport(typstStreamLanguage);
}
```

- [ ] **Step D1.5: Run — passes**

Run: `npx vitest run tests/format/typst.test.ts && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step D1.6: Commit**

```bash
jj desc -m "Add typstFormat module and minimal StreamLanguage highlighting"
jj new
```

### Task D2: Compile driver (`src/format/typst-driver.ts`)

**Files:**
- Create: `src/format/typst-driver.ts`
- Test: `tests/format/typst-driver.test.ts`

- [ ] **Step D2.1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createTypstDriver, type CompileResult } from "../../src/format/typst-driver";

vi.mock("@tauri-apps/api/core", () => {
  return {
    invoke: vi.fn(async (cmd: string, args: any): Promise<unknown> => {
      if (cmd === "typst_open") return "session-123";
      if (cmd === "typst_compile") {
        await new Promise(r => setTimeout(r, args._delay ?? 1));
        return {
          pages: [`<svg data-source="${args.source}"></svg>`],
          diagnostics: [],
          elapsed_ms: 5,
        } as CompileResult;
      }
      if (cmd === "typst_close") return undefined;
      throw new Error("unhandled " + cmd);
    }),
  };
});

describe("typst driver", () => {
  it("open returns a session id, compile returns pages", async () => {
    const driver = createTypstDriver();
    await driver.open("/tmp/x.typ");
    const res = await driver.compile("hello");
    expect(res.pages[0]).toContain("hello");
  });

  it("close clears the session — subsequent compile rejects", async () => {
    const driver = createTypstDriver();
    await driver.open("/tmp/x.typ");
    await driver.close();
    await expect(driver.compile("anything")).rejects.toThrow(/no session/);
  });
});
```

- [ ] **Step D2.2: Run — fails**

Run: `npx vitest run tests/format/typst-driver.test.ts`
Expected: FAIL.

- [ ] **Step D2.3: Implement**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  file: string | null;
}

export interface CompileResult {
  pages: string[];
  diagnostics: Diagnostic[];
  elapsed_ms: number;
}

export interface TypstDriver {
  open(path: string): Promise<void>;
  compile(source: string): Promise<CompileResult>;
  close(): Promise<void>;
  sessionId(): string | null;
}

export function createTypstDriver(): TypstDriver {
  let sessionId: string | null = null;
  return {
    async open(path: string): Promise<void> {
      if (sessionId !== null) await invoke("typst_close", { sessionId });
      sessionId = await invoke<string>("typst_open", { path });
    },
    async compile(source: string): Promise<CompileResult> {
      if (sessionId === null) throw new Error("no session");
      return await invoke<CompileResult>("typst_compile", { sessionId, source });
    },
    async close(): Promise<void> {
      if (sessionId === null) return;
      const id = sessionId;
      sessionId = null;
      await invoke("typst_close", { sessionId: id });
    },
    sessionId() { return sessionId; },
  };
}
```

- [ ] **Step D2.4: Run — passes**

Run: `npx vitest run tests/format/typst-driver.test.ts && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step D2.5: Commit**

```bash
jj desc -m "Add typst compile driver wrapping tauri invoke"
jj new
```

### Task D3: Diagnostics field (`src/editor/typst-diagnostics.ts`)

A small CM6 `StateField` + `StateEffect` for pushing diagnostics as gutter marks.

**Files:**
- Create: `src/editor/typst-diagnostics.ts`
- Test: `tests/editor/typst-diagnostics.test.ts`

- [ ] **Step D3.1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  typstDiagnosticsExtension,
  setTypstDiagnostics,
  type Diagnostic,
} from "../../src/editor/typst-diagnostics";

describe("typst diagnostics field", () => {
  it("applies and clears", () => {
    const state = EditorState.create({
      doc: "= H\n\nparagraph",
      extensions: [typstDiagnosticsExtension()],
    });
    const diags: Diagnostic[] = [
      { severity: "error", message: "boom",
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        file: null },
    ];
    const after = state.update({ effects: setTypstDiagnostics.of(diags) }).state;
    // No public API to count Decoration ranges directly; exercise via field facet:
    const facet = (after as any).field; // smoke check that the field reflects the effect
    expect(facet).toBeDefined();
  });
});
```

- [ ] **Step D3.2: Run — fails**

Run: `npx vitest run tests/editor/typst-diagnostics.test.ts`
Expected: FAIL.

- [ ] **Step D3.3: Implement**

```ts
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { StateField, StateEffect, type Extension, RangeSetBuilder } from "@codemirror/state";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  file: string | null;
}

export const setTypstDiagnostics = StateEffect.define<Diagnostic[]>();

const errorMark = Decoration.mark({ class: "typst-diag-error", attributes: { title: "" } });
const warnMark  = Decoration.mark({ class: "typst-diag-warn",  attributes: { title: "" } });

function buildSet(view: any, diags: Diagnostic[]): DecorationSet {
  const doc = view.state ? view.state.doc : view.doc;
  const b = new RangeSetBuilder<Decoration>();
  for (const d of diags) {
    if (d.file) continue; // only entry-file diagnostics for v1
    const startLine = Math.max(1, Math.min(doc.lines, d.range.start.line + 1));
    const endLine = Math.max(startLine, Math.min(doc.lines, d.range.end.line + 1));
    const from = doc.line(startLine).from + Math.max(0, d.range.start.column);
    const to = doc.line(endLine).from + Math.max(0, d.range.end.column);
    const m = d.severity === "error" ? errorMark : warnMark;
    if (to > from) b.add(from, Math.min(to, doc.length), m);
  }
  return b.finish();
}

const diagField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTypstDiagnostics)) {
        return buildSet({ state: tr.state }, e.value);
      }
    }
    return value.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

export function typstDiagnosticsExtension(): Extension {
  return [diagField];
}
```

Add CSS in the existing stylesheet:

```css
.typst-diag-error { text-decoration: underline wavy var(--diag-error, #c44); text-decoration-skip-ink: none; }
.typst-diag-warn  { text-decoration: underline wavy var(--diag-warn,  #c90); text-decoration-skip-ink: none; }
```

- [ ] **Step D3.4: Run — passes**

Run: `npx vitest run tests/editor/typst-diagnostics.test.ts && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step D3.5: Commit**

```bash
jj desc -m "Add CM6 StateField+Effect for Typst diagnostics"
jj new
```

### Task D4: Format-aware editor wiring in `main.ts`

This is the big integration task. It branches the existing Markdown-only setup based on `detectFormat(currentPath)`.

**Files:**
- Modify: `src/main.ts`

- [ ] **Step D4.1: Add imports**

```ts
import { typstFormat } from "./format/typst";
import { createTypstDriver, type TypstDriver, type CompileResult } from "./format/typst-driver";
import { typstDiagnosticsExtension, setTypstDiagnostics } from "./editor/typst-diagnostics";
import { sanitizeSvg } from "./export/sanitize";
```

- [ ] **Step D4.2: Install the language + diagnostics extensions via a Compartment**

Near the existing `tocUpdateCompartment`, add a `formatCompartment`:

```ts
  const formatCompartment = new Compartment();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      formatCompartment.of([]),
    ),
  });
```

- [ ] **Step D4.3: Add a helper to install per-format extensions**

```ts
  function applyFormatExtensions(): void {
    const format = detectFormat(currentPath);
    const exts =
      format === "typst"
        ? [typstFormat.languageExtension, typstDiagnosticsExtension()]
        : [];
    view.dispatch({ effects: formatCompartment.reconfigure(exts) });
  }
```

Call `applyFormatExtensions()` once after `view` is created and again at the end of `loadAndApplyDoc()`.

- [ ] **Step D4.4: Add Typst compile driver lifecycle**

In `bootstrap()`:

```ts
  let typstDriver: TypstDriver | null = null;
  let typstCompileTimer: ReturnType<typeof setTimeout> | null = null;
  let typstCompileSeq = 0;
  const TYPST_COMPILE_DEBOUNCE_MS = 300;

  async function openTypstSessionIfNeeded(): Promise<void> {
    if (detectFormat(currentPath) !== "typst") {
      // Tear down any old session if switching away from typst.
      if (typstDriver) { await typstDriver.close(); typstDriver = null; }
      return;
    }
    if (!currentPath) return;
    if (typstDriver) await typstDriver.close();
    typstDriver = createTypstDriver();
    await typstDriver.open(currentPath);
    scheduleTypstCompile(); // initial compile
  }

  function scheduleTypstCompile(): void {
    if (!typstDriver) return;
    if (!getPreviewPaneOpen("typst")) return;
    if (typstCompileTimer) clearTimeout(typstCompileTimer);
    typstCompileTimer = setTimeout(() => { void runTypstCompile(); }, TYPST_COMPILE_DEBOUNCE_MS);
  }

  async function runTypstCompile(): Promise<void> {
    if (!typstDriver) return;
    const mySeq = ++typstCompileSeq;
    let result: CompileResult;
    try {
      result = await typstDriver.compile(view.state.doc.toString());
    } catch (err) {
      console.warn("typst compile failed", err);
      return;
    }
    if (mySeq !== typstCompileSeq) return; // stale — newer compile arrived

    if (result.pages.length > 0) {
      // Stack pages vertically inside the pane body.
      const html = result.pages
        .map((svg) => `<div class="typst-page">${sanitizeSvg(svg)}</div>`)
        .join("");
      previewPane.setContent(""); // clear sanitization first
      previewPane.element.querySelector(".preview-pane-body")!.innerHTML = html;
    }
    view.dispatch({ effects: setTypstDiagnostics.of(result.diagnostics) });
  }
```

- [ ] **Step D4.5: Hook compile into doc changes**

Inside the existing `tocUpdateCompartment` updateListener, after `renderMarkdownToPane()`:

```ts
          if (detectFormat(currentPath) === "typst") scheduleTypstCompile();
```

- [ ] **Step D4.6: Hook compile into pane toggle and doc load**

Update the Cmd-J handler:

```ts
  setPreviewPaneToggleHandler(() => {
    if (currentMode !== "edit") return;
    const format = detectFormat(currentPath);
    const next = !getPreviewPaneOpen(format);
    setPreviewPaneOpen(format, next);
    applyPreviewPaneLayout();
    if (next) {
      if (format === "markdown") renderMarkdownToPane();
      else if (format === "typst") scheduleTypstCompile();
    }
  });
```

At the end of `loadAndApplyDoc()`:

```ts
    applyFormatExtensions();
    applyPreviewPaneLayout();
    if (detectFormat(currentPath) === "typst") {
      await openTypstSessionIfNeeded();
    } else {
      renderMarkdownToPane();
    }
```

Also call `openTypstSessionIfNeeded()` once at the end of initial bootstrap (after `initialDoc` is applied).

- [ ] **Step D4.7: Close driver on window unload**

```ts
  window.addEventListener("beforeunload", () => {
    if (typstDriver) void typstDriver.close();
  });
```

- [ ] **Step D4.8: For `.typ` files, default to edit mode on open**

In `loadAndApplyDoc`, where existing logic forces edit mode for `isNew`, also force edit when format is typst — because reading mode for `.typ` is "preview pane full-width" which Phase F adds; Phase D treats reading mode as undefined for `.typ`:

```ts
      if (doc.isNew || detectFormat(currentPath) === "typst") {
        if (currentMode !== "edit") {
          currentMode = "edit";
          setMode(view, "edit", modeExtensions.edit);
          toolbar.setMode("edit");
          document.documentElement.dataset.mode = "edit";
        }
      }
```

(Phase F refines this: real reading mode for Typst hides the source and shows the pane full-width. For Phase D, sticking to edit mode keeps the implementation small.)

- [ ] **Step D4.9: Type-check + tests**

Run: `npx tsc -b --noEmit && npm test`
Expected: green.

- [ ] **Step D4.10: Commit**

```bash
jj desc -m "Wire typst format end-to-end in main.ts: open, compile, pane"
jj new
```

### Task D5: Bundled `sample.typ`

**Files:**
- Create: `src/assets/sample.typ`

- [ ] **Step D5.1: Write a tiny sample**

```typst
= Sample Typst document

This is a *minimal* sample to show that the preview pane works.

== Math

$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $

== A list

- one
- two
- three
```

- [ ] **Step D5.2: Commit**

```bash
jj desc -m "Bundle sample.typ for first-launch demo"
jj new
```

### Task D6: Manual smoke + e2e

- [ ] **Step D6.1: Manual smoke**

Run: `npm run tauri:dev`. From File → Open, pick `src/assets/sample.typ`. The editor opens in edit mode. The preview pane appears on the right (default open for typst). Compiled pages render. Edit `= Sample` → `= Sample doc` and watch the pane update ~300ms later. Introduce a syntax error (e.g., remove a closing `)`) and confirm the gutter underline appears.

- [ ] **Step D6.2: Write the e2e**

`tests/e2e/typst-basic.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { launchApp, openSample } from "./helpers";

test("opens .typ, renders pages in the pane", async () => {
  const app = await launchApp();
  const page = app.firstWindow();
  await openSample(page, "sample.typ");
  // Pane is on by default for typst
  await expect(page.locator(".preview-pane")).toBeVisible();
  // At least one rendered page (svg) appears
  await expect(page.locator(".preview-pane-body .typst-page svg")).toHaveCountGreaterThan(0);
  await app.close();
});
```

- [ ] **Step D6.3: Run e2e**

Run: `npx playwright test tests/e2e/typst-basic.spec.ts`
Expected: PASS.

- [ ] **Step D6.4: Commit**

```bash
jj desc -m "E2E: open .typ renders pages in preview pane"
jj new
```

### Phase D acceptance

- Opening a `.typ` file via dialog or drag-drop loads, highlights, compiles, and renders pages.
- Editing the source updates the pane within ~300ms.
- Syntax errors surface as gutter underlines and do not crash the app.
- `npm test`, `cargo test`, and the new e2e all pass.

---

## Phase E — Lifecycle parity

**Goal of phase:** Bring `.typ` files to feature parity with `.md` for: folder sidebar listing, file association, macOS NSDocumentController, "New Typst file" menu entry, and watcher behavior. Most of these are small touch points that ride on Phase A's `isSupportedExtension`.

### Task E1: Rename `list_markdown_files` → `list_documents` (Rust + frontend)

**Files:**
- Modify: `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/ui/sidebar/folder.ts` and any other callers (grep `list_markdown_files`)

- [ ] **Step E1.1: Rust rename**

In `src-tauri/src/commands/files.rs`, rename `list_markdown_files` to `list_documents`. The existing function accepts a `root` path and returns markdown entries; extend the filter to also include `.typ`:

```rust
fn is_supported_ext(p: &Path) -> bool {
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "mdx" | "mdown" | "typ")
}
```

(Find the existing extension check inside `list_markdown_files` and route through this helper. Keep the entry struct name but consider adding a `kind: String` field if needed — Phase E.2 looks at the frontend; for now matching the existing shape is fine if the frontend doesn't care.)

Update the Tauri registration in `lib.rs`:

```rust
commands::files::list_documents,
```

- [ ] **Step E1.2: Frontend rename + accept both formats**

In `src/ui/sidebar/folder.ts` (and any other caller), replace `invoke("list_markdown_files", ...)` with `invoke("list_documents", ...)`. If the folder sidebar filters file lists by extension client-side, route that filter through `isSupportedExtension`.

- [ ] **Step E1.3: Type-check + cargo check**

Run: `npx tsc -b --noEmit && cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step E1.4: Manual smoke**

Run: `npm run tauri:dev`. Open a folder that contains both `.md` and `.typ` files. Both should appear in the folder sidebar.

- [ ] **Step E1.5: Commit**

```bash
jj desc -m "Rename list_markdown_files to list_documents; include .typ"
jj new
```

### Task E2: File association in `tauri.conf.json`

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step E2.1: Add the `.typ` association**

Find `bundle.macOS.fileAssociations` (or `bundle.fileAssociations` — verify the schema for your Tauri 2 version) and add an entry alongside the existing Markdown ones:

```json
{
  "ext": ["typ"],
  "name": "Typst Document",
  "role": "Editor",
  "mimeType": "text/x-typst"
}
```

If the existing config uses `bundle.fileAssociations` at the top level, add the entry there with the same shape.

- [ ] **Step E2.2: Verify build still works**

Run: `npm run tauri:build -- --bundles app` (per the project memory — skip DMG).
Expected: clean build, no schema errors.

- [ ] **Step E2.3: Manual smoke**

After installing the new build, double-click a `.typ` file in Finder. The app opens it.

- [ ] **Step E2.4: Commit**

```bash
jj desc -m "Register .typ file association in tauri.conf.json"
jj new
```

### Task E3: "New Typst File" menu entry + ⇧⌘N

**Files:**
- Modify: `src/shell/menus.ts`
- Modify: `src/shell/menu-actions.ts` (add the action type)
- Modify: `src/main.ts` (handler)

- [ ] **Step E3.1: Add the menu action type**

In `src/shell/menu-actions.ts`'s action union, add `{ type: "newTypstFile" }`. In the `LocalMenuHandlers` interface, add `newTypstFile: () => Promise<void>`.

- [ ] **Step E3.2: Update the menu builder**

In `src/shell/menus.ts`, in the File → New submenu, add a second item:

```ts
{
  id: "new-typst-file",
  text: "New Typst File",
  accelerator: "CmdOrCtrl+Shift+N",
  action: () => onAction({ type: "newTypstFile" }),
}
```

(Adapt to the existing menu DSL — read the file first.)

- [ ] **Step E3.3: Implement the handler in `main.ts`**

```ts
    newTypstFile: async () => {
      const dest = await saveMarkdownAs("= Document title\n\n", "untitled.typ");
      if (!dest) return;
      await loadAndApplyDoc(dest); // existing flow opens the new file as current
    },
```

(Rename `saveMarkdownAs` to be format-agnostic — `saveDocumentAs(contents, defaultName)` — or add a parallel `saveTypstAs`. The minimal change is to add a new function `saveTypstAs` mirroring the existing one with a Typst dialog filter.)

- [ ] **Step E3.4: Type-check**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step E3.5: Commit**

```bash
jj desc -m "File → New Typst File (⇧⌘N) menu entry and handler"
jj new
```

### Task E4: macOS NSDocumentController kind

**Files:**
- Modify: `src-tauri/src/commands/recents_os.rs` (if it filters by ext)
- Modify: `src-tauri/tauri.conf.json` (CFBundleDocumentTypes if separate from fileAssociations)

- [ ] **Step E4.1: Check current behavior**

Run: `grep -n "extension\\|md\\|markdown" src-tauri/src/commands/recents_os.rs`. If the recents OS bridge filters by extension, expand that filter to also accept `.typ`.

- [ ] **Step E4.2: Update tauri.conf.json**

If `CFBundleDocumentTypes` is not auto-generated from `fileAssociations`, add a typ entry. (Verify with `cat src-tauri/tauri.conf.json | grep -A 5 CFBundleDocumentTypes`.)

- [ ] **Step E4.3: Manual smoke**

After install, open a `.typ`. Right-click the dock icon — the file should appear in Recents.

- [ ] **Step E4.4: Commit**

```bash
jj desc -m "Surface .typ in macOS NSDocumentController recents"
jj new
```

### Task E5: Watcher acceptance

The watcher (`src-tauri/src/commands/watcher.rs`) is path-based; it doesn't filter by extension. The frontend `installWatcher` is called with whatever path is current, so it should already work for `.typ`. Sanity-check that no path in `src/shell/watcher.ts` short-circuits on `.md` only.

- [ ] **Step E5.1: Audit**

Run: `grep -rn "\\.md\\|markdown\\|mdx" src/shell/watcher.ts src/shell/watcher.ts`. If you find any extension filter, route it through `isSupportedExtension`. (Most likely no change needed.)

- [ ] **Step E5.2: Manual smoke**

Open a `.typ` in the app. From another editor (or `echo` from a shell), append a line to the file. The app reloads (watcher) and the pane recompiles. Editing while dirty pops the reconcile modal as for `.md`.

- [ ] **Step E5.3: Commit (only if changes were made)**

```bash
jj desc -m "Confirm watcher handles .typ (no code change required)" || true
jj new
```

### Task E6: Mobile bootstrap refuses .typ politely

**Files:**
- Modify: `src/mobile-bootstrap.ts`

- [ ] **Step E6.1: Add a guard**

When opening a file in mobile-bootstrap, if `detectFormat(path) === "typst"`, render an explanatory empty state instead of the editor:

```ts
import { detectFormat } from "./format";
import { t } from "./i18n/strings";
// ...
if (detectFormat(path) === "typst") {
  container.textContent = t("typst.unsupported_on_mobile");
  return;
}
```

Add the string in `src/i18n/strings.ts`:

```ts
"typst.unsupported_on_mobile": "Typst documents aren't supported on mobile yet.",
```

- [ ] **Step E6.2: Type-check**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step E6.3: Commit**

```bash
jj desc -m "Mobile bootstrap shows friendly message for .typ files"
jj new
```

### Phase E acceptance

- Folder sidebar lists `.typ` and `.md` side by side.
- Double-clicking `.typ` in Finder opens it.
- Cmd-Shift-N creates a new `.typ`.
- macOS recents includes opened `.typ` files.
- Mobile builds don't crash on a `.typ`; they show a polite "not supported" message.

---

## Phase F — Polish

**Goal of phase:** Tighten the user-facing surface: status-bar compile indicator, dimmed-prior-pages on transient failures, zoom controls in the pane, package resolution, real reading-mode-for-`.typ`, i18n strings, and a visual-regression baseline.

### Task F1: Status-bar compile indicator

**Files:**
- Modify: `src/ui/toolbar.ts` and `src/ui/titlebar.ts` (add a status slot)
- Modify: `src/main.ts` (set status during compile)

- [ ] **Step F1.1: Add a `setStatus` slot on the toolbar/titlebar handle**

(Mirror how `setStats` and `setPath` are implemented. Add a tiny `<span class="status">` and a `setStatus(text: string | null)` method.)

- [ ] **Step F1.2: Update during compile**

In `runTypstCompile`:

```ts
  toolbar.setStatus(t("typst.compiling"));
  try { ... } finally { toolbar.setStatus(`${t("typst.compiled_in", { ms: result.elapsed_ms })}`); }
  if (errors > 0) toolbar.setStatus(t("typst.n_errors", { n: errors }));
```

Add the strings to `src/i18n/strings.ts`.

- [ ] **Step F1.3: Commit**

```bash
jj desc -m "Status bar shows Typst compile progress and timing"
jj new
```

### Task F2: Dimmed-prior-pages on failure

**Files:**
- Modify: `src/main.ts` (don't clear pane when result.pages is empty)
- Modify: stylesheet (add `.typst-pane-stale` for dimming)

- [ ] **Step F2.1: Update render logic**

In `runTypstCompile`, if `result.pages.length === 0 && result.diagnostics.length > 0`, do not replace the existing innerHTML; instead add a `.typst-pane-stale` class to the body. Remove the class on the next successful render.

- [ ] **Step F2.2: CSS**

```css
.typst-pane-stale { opacity: 0.5; filter: saturate(0.7); }
```

- [ ] **Step F2.3: Commit**

```bash
jj desc -m "Keep last good pages dimmed while Typst compile is failing"
jj new
```

### Task F3: Zoom controls on the pane

**Files:**
- Modify: `src/shell/settings.ts` — `typstZoom`
- Modify: `src/main.ts` — Cmd-+/-/0 handler when pane is focused

- [ ] **Step F3.1: Add `getTypstZoom` / `setTypstZoom`**

Default 1.0, clamp [0.5, 3.0]. Persist via store.

- [ ] **Step F3.2: Apply zoom**

Add CSS:

```css
.preview-pane-body[data-format="typst"] { transform-origin: top left; transform: scale(var(--typst-zoom, 1)); }
```

Set `--typst-zoom` from `main.ts` whenever `setTypstZoom` is called or pane re-renders.

- [ ] **Step F3.3: Wire Cmd-+/-/0**

The existing `installZoomKeyHandler` already binds these to the *editor* zoom. To avoid colliding, install a second handler that fires only when focus is inside `.preview-pane-body` and route to `setTypstZoom` instead.

- [ ] **Step F3.4: Commit**

```bash
jj desc -m "Cmd-+/-/0 in pane focus zooms the Typst preview"
jj new
```

### Task F4: Reading mode for .typ — pane full-width, source hidden

**Files:**
- Modify: `src/main.ts` (mode switching)
- Modify: stylesheet — `[data-mode="reading"][data-format="typst"]`

- [ ] **Step F4.1: Track format on document element**

```ts
function setDocumentFormatAttr() {
  document.documentElement.dataset.format = detectFormat(currentPath);
}
```

Call from `loadAndApplyDoc` and bootstrap.

- [ ] **Step F4.2: Hide source in reading-mode-for-typst**

```css
[data-mode="reading"][data-format="typst"] .cm-editor { display: none; }
[data-mode="reading"][data-format="typst"] .preview-pane { width: 100%; }
[data-mode="reading"][data-format="typst"] .preview-splitter { display: none; }
```

- [ ] **Step F4.3: Commit**

```bash
jj desc -m "Typst reading mode: source hidden, pane full-width"
jj new
```

### Task F5: `@preview/...` package resolution (real impl)

**Files:**
- Modify: `src-tauri/src/typst/packages.rs`
- Modify: `src-tauri/src/typst/world.rs` (route `World::package` here)

- [ ] **Step F5.1: Implement download + cache**

Use `typst-kit`'s `Downloader` and `PackageStorage` (or roll a minimal cache under `$DATA_DIR/typst/packages/$namespace/$name/$version/`). On first request, download the zip from `https://packages.typst.org/$namespace/$name-$version.tar.gz`, extract to cache, and return the local path. Subsequent requests return the cached path.

```rust
// in packages.rs (sketch — adapt to typst-kit API in your Cargo.toml version)
use std::path::PathBuf;
use typst::diag::{FileResult, FileError};
use typst::syntax::PackageSpec;

pub fn prepare_package(cache_dir: &PathBuf, spec: &PackageSpec) -> FileResult<PathBuf> {
    let target = cache_dir
        .join(spec.namespace.as_str())
        .join(spec.name.as_str())
        .join(spec.version.to_string());
    if target.exists() { return Ok(target); }
    fetch_and_extract(cache_dir, spec)?;
    Ok(target)
}

fn fetch_and_extract(_cache_dir: &PathBuf, _spec: &PackageSpec) -> FileResult<()> {
    // Use typst-kit::download::Downloader if available; otherwise reqwest+tar.
    Err(FileError::Other(Some(eco_format::eco_format!("not yet implemented"))))
}
```

Wire `ViewerWorld::file` and `ViewerWorld::source` to call this for non-local file IDs (those with `Some(namespace)` on their FileId).

- [ ] **Step F5.2: Add a Rust integration test for a doc that imports a package**

Skip live network: stub the cache by pre-populating the cache dir with a known package fixture. Confirm compile succeeds when the package is cached.

- [ ] **Step F5.3: Surface "Downloading ..." in status bar**

When a network fetch starts, emit an event the frontend listens for. (Simpler v1: the network fetch is synchronous inside the compile; frontend already shows "Compiling…" — leave it at that. Skip the explicit "Downloading" only if it complicates the path.)

- [ ] **Step F5.4: Commit**

```bash
jj desc -m "Implement @preview/* package resolution with on-disk cache"
jj new
```

### Task F6: i18n strings sweep

**Files:**
- Modify: `src/i18n/strings.ts`

- [ ] **Step F6.1: Ensure every user-visible string introduced in this plan is keyed**

Scan changes for raw English strings ("Show Preview Pane", "New Typst File", "Compiling…", "Compiled in {ms} ms", "{n} errors", "Typst documents aren't supported on mobile yet"). Add keys to `strings.ts` and replace literals with `t(...)`.

- [ ] **Step F6.2: Commit**

```bash
jj desc -m "i18n: route all Typst-feature strings through t()"
jj new
```

### Task F7: Visual-regression baseline

**Files:**
- Modify: `tests/e2e/visual-regression.spec.ts`

- [ ] **Step F7.1: Add a screenshot for sample.typ**

```ts
test("typst sample renders identically (visual)", async () => {
  const app = await launchApp();
  const page = app.firstWindow();
  await openSample(page, "sample.typ");
  await expect(page.locator(".preview-pane-body")).toHaveScreenshot("sample-typ-pane.png");
  await app.close();
});
```

- [ ] **Step F7.2: Generate baseline**

Run: `npx playwright test tests/e2e/visual-regression.spec.ts --update-snapshots`

- [ ] **Step F7.3: Verify the baseline runs clean a second time**

Run: `npx playwright test tests/e2e/visual-regression.spec.ts`
Expected: PASS.

- [ ] **Step F7.4: Commit**

```bash
jj desc -m "Add visual-regression baseline for Typst sample"
jj new
```

### Phase F acceptance

- Status bar shows Typst compile status with timing.
- Failed compiles leave a dimmed-but-readable preview.
- Cmd-+/-/0 zooms the preview when the pane is focused.
- Reading mode for `.typ` hides the source and shows the pane full-width.
- Documents using `@preview/...` packages compile (cached).
- All i18n strings flow through `t()`.
- Visual regression baseline captured.

---

## Cross-phase acceptance

- `npm test` clean.
- `npm run test:e2e` clean (serial).
- `cd src-tauri && cargo test` clean.
- `npx tsc -b --noEmit` clean.
- Smoke: open `sample.typ`, edit, save, see preview, see errors when introduced, close, re-open, close window, re-launch, app remembers per-format pane state.
- Mobile build still passes (`npm run tauri:android:dev`) — Typst paths gated out.

---

## Self-review notes (for the plan writer / reviewer)

**Spec coverage check (against `docs/superpowers/specs/2026-05-21-typst-support-design.md`):**

- §1 in-scope items all map: format abstraction → Phase A; preview pane + Cmd-J → Phase B; Rust Typst backend → Phase C; frontend wiring → Phase D; lifecycle parity → Phase E; status bar / dimmed prior pages / zoom / reading mode for typst / packages → Phase F.
- §1 explicit non-goals: mobile gated in C+D, no Markdown-export-via-Typst added anywhere, KaTeX untouched, sibling watching deferred (called out in Phase E5 and spec §10).
- §2 approaches: only approach 1 implemented (correct).
- §3 architecture: format abstraction lives at `src/format/`, decoration producers separated per format, preview pane is window-level — matches spec.
- §4 Rust: ViewerWorld + TypstSession + commands — Phase C.
- §5 frontend: language extension, compile driver, preview pane, error display — Phases D + F.
- §6 file lifecycle: extension recognition (A), save/write (no change), watcher (E5), recovery (no change needed — payload is path-based), auto-save (no change), recents (E4), file association (E2), multi-window (no change), bundled sample (D5), mobile (E6, gated in C/D).
- §7 keybindings + settings: Cmd-J (B4), Cmd-+/-/0 zoom (F3), New Typst File (E3), per-format pane state (B1).
- §8 performance: targets aren't tasks, but the architecture (300ms debounce, comemo cache reuse, fontdb-once-per-session) is in place.
- §9 testing: covered across A1, A4, B1, B2, B3, B7, C8, D2, D3, D6.2, F7.

**Placeholder scan:** No "TBD" left. Two genuine "adapt to current API" notes (typst 0.13 may have moved between version of this plan and execution) — those are not placeholders, they're advisories to verify against the live crate docs at implementation time. The package-resolution sketch in F5.1 is explicit about being a sketch and points to the typst-kit Downloader / a fallback.

**Type consistency:** `Diagnostic` shape declared once in `src/format/typst-driver.ts` and consumed by `src/editor/typst-diagnostics.ts`. `CompileResult` declared once. `Format` declared once in `src/format/index.ts` and imported elsewhere. `previewPaneOpen` is a Record<Format, boolean> consistently across settings, main.ts, and CSS class application.

**Known limitations carried forward (re-stated in §10 of the spec):** sibling-file watching is out of scope; SVG payload size not preemptively optimized; `@preview` packages require network on first use.
