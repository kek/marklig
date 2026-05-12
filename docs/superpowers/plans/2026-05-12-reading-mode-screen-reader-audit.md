# Reading-mode screen-reader audit — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ARIA semantics to the reading-mode body so screen readers can navigate by heading, identify list / quote / code regions, hear descriptions of opaque diagrams, and read math via MathML — without changing the decorated-source architecture or the rendered visuals.

**Architecture:** In-place ARIA on existing CodeMirror line decorations (`Decoration.line({ attributes: {...} })`) and on the `toDOM` output of widget classes. No new modules; no rendering path changes. New user-facing strings flow through the existing `t()` lookup in `src/i18n/strings.ts`.

**Tech Stack:** Existing — CodeMirror 6 decorations, KaTeX (flipping output mode to `htmlAndMathml`), DOMPurify (verify MathML survives), Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-12-reading-mode-screen-reader-audit-design.md`.

**VCS note:** This repository is a Jujutsu (`.jj/`) repo. Commits use `jj`, not `git`. Pattern: stage all edits in the working copy, then `jj desc -m "…"` to set the message and `jj new` to roll forward to the next task. Never run raw `git commit` here.

---

## File structure

```
viewer/
├── src/
│   ├── i18n/
│   │   └── strings.ts                          (mod) add a11y.* keys
│   └── editor/
│       └── decorations/
│           ├── headings.ts                     (mod) role=heading + aria-level
│           ├── lists.ts                        (mod) role=listitem
│           ├── blockquotes.ts                  (mod) role=blockquote
│           ├── codeblocks.ts                   (mod) role=code, aria-hidden on fences, aria-label on first body line
│           ├── reading-widgets.ts              (mod) aria-hidden on Bullet/SoftBreak; role=img on image placeholders
│           ├── mermaid.ts                      (mod) role=img/region on widget wrap
│           ├── graphviz.ts                     (mod) role=img/region on widget wrap
│           └── math.ts                         (mod) KaTeX htmlAndMathml output
├── tests/
│   └── decorations/
│       ├── headings.test.ts                    (mod) ARIA test case
│       ├── lists.test.ts                       (mod) ARIA test case
│       ├── blockquotes.test.ts                 (mod) ARIA test case
│       ├── codeblocks.test.ts                  (mod) ARIA test case
│       ├── reading-widgets.test.ts             (mod) ARIA test cases
│       ├── mermaid.test.ts                     (mod) ARIA test case
│       ├── graphviz.test.ts                    (mod) ARIA test case
│       └── math.test.ts                        (mod) MathML preserved test
├── ROADMAP.md                                  (mod) flip F to ✅
└── CHANGELOG.md                                (mod) new entry
```

---

## Task 1: Add a11y.* i18n keys

**Files:**
- Modify: `src/i18n/strings.ts`

- [ ] **Step 1: Add the keys**

In `src/i18n/strings.ts`, inside the `EN` object, **after** the existing `"toolbar.toc.title": "Toggle table of contents",` entry (and before the closing `} as const;`), add:

```ts
  // Reading-mode ARIA labels (announced to screen readers)
  "a11y.codeBlock": "Code block",
  "a11y.codeBlockWithLang": "Code block, {lang}",
  "a11y.mermaidDiagram": "Mermaid diagram",
  "a11y.mermaidDiagramFailed": "Mermaid diagram (failed to render)",
  "a11y.mermaidDiagramLoading": "Rendering Mermaid diagram",
  "a11y.graphvizDiagram": "Graphviz diagram",
  "a11y.graphvizDiagramFailed": "Graphviz diagram (failed to render)",
  "a11y.graphvizDiagramLoading": "Rendering Graphviz diagram",
  "a11y.remoteImage": "Remote image",
  "a11y.remoteImageWithAlt": "Remote image: {alt}",
  "a11y.brokenImage": "Broken image",
  "a11y.brokenImageWithAlt": "Broken image: {alt}",
```

- [ ] **Step 2: Add the `tA11y` helper for parameterised strings**

The existing `t()` returns the raw template; consumers need `{lang}` / `{alt}` substitution. Add this helper **immediately after** the existing `t()` function in `src/i18n/strings.ts`:

```ts
/** Look up a localized string and substitute `{name}` placeholders.
 * Example: tA11y("a11y.codeBlockWithLang", { lang: "rust" }) → "Code block, rust". */
export function tA11y(
  key: StringKey,
  params: Record<string, string> = {},
): string {
  let s: string = overrides[key] ?? EN[key];
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, v);
  }
  return s;
}
```

- [ ] **Step 3: Run type-check**

Run: `npx tsc -b --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Run the existing i18n tests**

Run: `npx vitest run tests/i18n`
Expected: PASS (all existing assertions still hold; we only added keys).

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: a11y.* i18n keys and tA11y helper

Source-of-truth English strings for ARIA labels announced in
reading mode (code blocks, diagrams, image placeholders). tA11y
substitutes {name} placeholders for parameterised announcements
like 'Code block, rust'."
jj new
```

---

## Task 2: Headings — role=heading + aria-level

**Files:**
- Modify: `src/editor/decorations/headings.ts`
- Test: `tests/decorations/headings.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/decorations/headings.test.ts`. Replace the `rangesOf` helper to also capture attributes, and add a new test case. The full updated file is:

```ts
import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { headingsProducer } from "../../src/editor/decorations/headings";

interface Row {
  from: number;
  to: number;
  class: string;
  attributes: Record<string, string> | undefined;
}

function rangesOf(source: string): Row[] {
  const tokens = parseMarkdown(source);
  const set = headingsProducer({ source, tokens });
  const out: Row[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const spec = cursor.value.spec as {
      class?: string;
      attributes?: Record<string, string>;
    };
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: spec.class ?? "",
      attributes: spec.attributes,
    });
    cursor.next();
  }
  return out;
}

describe("headingsProducer", () => {
  it("emits a line decoration for each ATX heading 1-6", () => {
    const source = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n";
    const rows = rangesOf(source);
    expect(rows.map((r) => ({ from: r.from, to: r.to, class: r.class }))).toEqual([
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

  it("exposes role=heading + aria-level on each heading line for screen readers", () => {
    const rows = rangesOf("# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n");
    expect(rows.map((r) => r.attributes)).toEqual([
      { role: "heading", "aria-level": "1" },
      { role: "heading", "aria-level": "2" },
      { role: "heading", "aria-level": "3" },
      { role: "heading", "aria-level": "4" },
      { role: "heading", "aria-level": "5" },
      { role: "heading", "aria-level": "6" },
    ]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/headings.test.ts`
Expected: the new "exposes role=heading + aria-level…" case FAILS because `attributes` is `undefined` on every row.

- [ ] **Step 3: Implement attributes in `headings.ts`**

Replace the entire content of `src/editor/decorations/headings.ts` with:

```ts
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

export const headingsProducer: DecorationProducer = ({ source, tokens }) => {
  const lines = computeLineStarts(source);
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
        attributes: { role: "heading", "aria-level": String(level) },
      }).range(from),
    );
  }

  return Decoration.set(ranges, /* sort */ true);
};
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/headings.test.ts`
Expected: all three cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: role=heading + aria-level on heading lines

Screen readers can now navigate by heading (VoiceOver rotor /
NVDA H key) in reading mode."
jj new
```

---

## Task 3: Lists — role=listitem

**Files:**
- Modify: `src/editor/decorations/lists.ts`
- Test: `tests/decorations/lists.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/decorations/lists.test.ts` and add this test inside the `describe("listsProducer", …)` block (preserve any existing tests; append after them):

```ts
  it("exposes role=listitem on bullet, ordered, and task list lines", () => {
    const source =
      "- first\n" +
      "- second\n" +
      "1. one\n" +
      "2. two\n" +
      "- [ ] todo\n" +
      "- [x] done\n";
    const tokens = parseMarkdown(source);
    const set = listsProducer({ source, tokens });
    const rows: Array<Record<string, string> | undefined> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { attributes?: Record<string, string> };
      rows.push(spec.attributes);
      cursor.next();
    }
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r).toEqual({ role: "listitem" });
  });
```

If `parseMarkdown` and `listsProducer` are not already imported at the top of the file, add the imports:

```ts
import { parseMarkdown } from "../../src/editor/parser";
import { listsProducer } from "../../src/editor/decorations/lists";
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/lists.test.ts`
Expected: the new "exposes role=listitem…" case FAILS.

- [ ] **Step 3: Implement attributes in `lists.ts`**

In `src/editor/decorations/lists.ts`, change the one `ranges.push(...)` line to attach the role. Replace:

```ts
      ranges.push(Decoration.line({ class: className }).range(lineStart));
```

with:

```ts
      ranges.push(
        Decoration.line({
          class: className,
          attributes: { role: "listitem" },
        }).range(lineStart),
      );
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/lists.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: role=listitem on bullet/ordered/task list lines

Lets screen readers identify list structure in reading mode.
Spec violation note: listitem without a list parent is technically
non-conformant but all three major SRs (VoiceOver, NVDA, Orca)
handle it. The alternative (synthesizing a list parent via a
block widget) would break click-to-position."
jj new
```

---

## Task 4: Blockquotes — role=blockquote

**Files:**
- Modify: `src/editor/decorations/blockquotes.ts`
- Test: `tests/decorations/blockquotes.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/decorations/blockquotes.test.ts` and append this test case inside the existing describe block:

```ts
  it("exposes role=blockquote on each quoted line", () => {
    const source = "> one\n> two\n>\n> four\n";
    const tokens = parseMarkdown(source);
    const set = blockquotesProducer({ source, tokens });
    const attrs: Array<Record<string, string> | undefined> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { attributes?: Record<string, string> };
      attrs.push(spec.attributes);
      cursor.next();
    }
    expect(attrs.length).toBeGreaterThanOrEqual(3);
    for (const a of attrs) expect(a).toEqual({ role: "blockquote" });
  });
```

If `parseMarkdown` / `blockquotesProducer` aren't already imported, add at the top of the file:

```ts
import { parseMarkdown } from "../../src/editor/parser";
import { blockquotesProducer } from "../../src/editor/decorations/blockquotes";
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/blockquotes.test.ts`
Expected: the new "exposes role=blockquote…" case FAILS.

- [ ] **Step 3: Implement attributes in `blockquotes.ts`**

In `src/editor/decorations/blockquotes.ts`, change the `Decoration.line(...)` call to include the role. Replace:

```ts
            Decoration.line({ class: "cm-md-blockquote" }).range(lineStart),
```

with:

```ts
            Decoration.line({
              class: "cm-md-blockquote",
              attributes: { role: "blockquote" },
            }).range(lineStart),
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/blockquotes.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: role=blockquote on blockquote lines

Screen readers now announce quoted regions in reading mode."
jj new
```

---

## Task 5: Code blocks — role=code, aria-hidden on fences, aria-label on first body line

**Files:**
- Modify: `src/editor/decorations/codeblocks.ts`
- Test: `tests/decorations/codeblocks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/decorations/codeblocks.test.ts` inside the existing describe block:

```ts
  it("exposes role=code on body lines, aria-hidden on fences, aria-label with lang on first body line", () => {
    const source = "```rust\nfn main() {}\nlet x = 1;\n```\n";
    const tokens = parseMarkdown(source);
    const set = codeblocksProducer({ source, tokens });
    const lineRows: Array<{ class: string; attrs: Record<string, string> | undefined }> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as {
        class?: string;
        attributes?: Record<string, string>;
      };
      // Only inspect line decorations (skip token-level Shiki marks).
      const cls = spec.class ?? "";
      if (cls.startsWith("cm-md-code-")) {
        lineRows.push({ class: cls, attrs: spec.attributes });
      }
      cursor.next();
    }
    // Expected order: fence-open, body[0], body[1], fence-close.
    expect(lineRows.length).toBe(4);

    expect(lineRows[0].class).toContain("cm-md-code-fence-open");
    expect(lineRows[0].attrs).toEqual({ "aria-hidden": "true" });

    expect(lineRows[1].class).toContain("cm-md-code-body");
    expect(lineRows[1].attrs).toEqual({
      role: "code",
      "aria-label": "Code block, rust",
    });

    expect(lineRows[2].class).toContain("cm-md-code-body");
    expect(lineRows[2].attrs).toEqual({ role: "code" });

    expect(lineRows[3].class).toContain("cm-md-code-fence-close");
    expect(lineRows[3].attrs).toEqual({ "aria-hidden": "true" });
  });
```

If `parseMarkdown` / `codeblocksProducer` aren't already imported, add at the top:

```ts
import { parseMarkdown } from "../../src/editor/parser";
import { codeblocksProducer } from "../../src/editor/decorations/codeblocks";
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/codeblocks.test.ts`
Expected: the new case FAILS — no attributes on any line dec.

- [ ] **Step 3: Implement attributes in `codeblocks.ts`**

In `src/editor/decorations/codeblocks.ts`, find the block that pushes line decorations (currently the three `ranges.push(Decoration.line({...}).range(...))` calls around lines 101–115). Replace that block with:

```ts
    ranges.push(
      Decoration.line({
        class: "cm-md-code-fence cm-md-code-fence-open",
        attributes: { "aria-hidden": "true" },
      })
        .range(lineStarts[startLine]),
    );
    for (let line = startLine + 1; line < endLine - 1; line++) {
      const isFirstBody = line === startLine + 1;
      const attributes: Record<string, string> = { role: "code" };
      if (isFirstBody) attributes["aria-label"] = tA11y("a11y.codeBlockWithLang", { lang });
      ranges.push(
        Decoration.line({
          class: `cm-md-code-body cm-md-code-lang-${lang}`,
          attributes,
        })
          .range(lineStarts[line]),
      );
    }
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({
          class: "cm-md-code-fence cm-md-code-fence-close",
          attributes: { "aria-hidden": "true" },
        })
          .range(lineStarts[endLine - 1]),
      );
    }
```

Add the import for `tA11y` at the top of the file. After the existing imports add:

```ts
import { tA11y } from "../../i18n/strings";
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/codeblocks.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: ARIA on code blocks (role=code, aria-hidden on fences)

Body lines announce as code; the first body line carries an
aria-label with the fence language so AT users hear 'Code block,
rust' on entry. Fence open/close lines are aria-hidden since
they're visually collapsed in reading mode."
jj new
```

---

## Task 6: Reading widgets — decorative aria-hidden + image-placeholder role=img

**Files:**
- Modify: `src/editor/decorations/reading-widgets.ts`
- Test: `tests/decorations/reading-widgets.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/decorations/reading-widgets.test.ts` inside the existing describe block:

```ts
  it("BulletWidget and SoftBreakWidget are aria-hidden in their rendered DOM", () => {
    // Bullet markers in source produce a BulletWidget; a multi-line paragraph
    // produces SoftBreakWidget at each interior newline.
    const src = "- one\n- two\n\nFirst line\nsecond line\n";
    const tokens = parseMarkdown(src);
    const set = readingWidgetsProducer({ source: src, tokens });
    const widgets: Array<{ name: string; dom: HTMLElement }> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as {
        widget?: { constructor: { name: string }; toDOM: () => HTMLElement };
      };
      if (spec.widget) {
        widgets.push({ name: spec.widget.constructor.name, dom: spec.widget.toDOM() });
      }
      cursor.next();
    }
    const bullets = widgets.filter((w) => w.name === "BulletWidget");
    const softs = widgets.filter((w) => w.name === "SoftBreakWidget");
    expect(bullets.length).toBeGreaterThanOrEqual(2);
    expect(softs.length).toBeGreaterThanOrEqual(1);
    for (const w of bullets) expect(w.dom.getAttribute("aria-hidden")).toBe("true");
    for (const w of softs) expect(w.dom.getAttribute("aria-hidden")).toBe("true");
  });

  it("remote-image placeholder exposes role=img with aria-label including the alt text", () => {
    // Force the remote-image placeholder path by setting policy to placeholder
    // (which is the default) and using a remote URL.
    const src = "![A bird](https://example.com/bird.png)\n";
    const tokens = parseMarkdown(src);
    const set = readingWidgetsProducer({ source: src, tokens });
    let dom: HTMLElement | null = null;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as {
        widget?: { constructor: { name: string }; toDOM: () => HTMLElement };
      };
      if (spec.widget?.constructor.name === "ImageWidget") {
        dom = spec.widget.toDOM();
        break;
      }
      cursor.next();
    }
    expect(dom).not.toBeNull();
    expect(dom!.getAttribute("role")).toBe("img");
    expect(dom!.getAttribute("aria-label")).toBe("Remote image: A bird");
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/decorations/reading-widgets.test.ts`
Expected: both new cases FAIL.

- [ ] **Step 3: Implement in `reading-widgets.ts`**

In `src/editor/decorations/reading-widgets.ts`:

(a) Add the i18n import below the existing imports near the top of the file:

```ts
import { t, tA11y } from "../../i18n/strings";
```

(b) Replace the entire `BulletWidget` class with:

```ts
class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-bullet";
    span.textContent = "•"; // •
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean { return true; }
}
```

(c) Replace the entire `SoftBreakWidget` class with:

```ts
class SoftBreakWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-reading-softbreak";
    span.textContent = " ";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean { return true; }
}
```

(d) Replace the entire `makeRemoteImagePlaceholder` function with:

```ts
function makeRemoteImagePlaceholder(src: string, alt: string, policy: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder";
  wrap.dataset.policy = policy;
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    alt ? tA11y("a11y.remoteImageWithAlt", { alt }) : t("a11y.remoteImage"),
  );
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Remote image: ${alt}` : "Remote image";
  label.setAttribute("aria-hidden", "true");
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  url.setAttribute("aria-hidden", "true");
  wrap.append(label, url);
  return wrap;
}
```

(e) Replace the entire `makeBrokenImagePlaceholder` function with:

```ts
function makeBrokenImagePlaceholder(src: string, alt: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-reading-image-placeholder cm-md-reading-image-broken";
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    alt ? tA11y("a11y.brokenImageWithAlt", { alt }) : t("a11y.brokenImage"),
  );
  const label = document.createElement("div");
  label.className = "cm-md-reading-image-placeholder-label";
  label.textContent = alt ? `Broken image: ${alt}` : "Broken image";
  label.setAttribute("aria-hidden", "true");
  const url = document.createElement("div");
  url.className = "cm-md-reading-image-placeholder-url";
  url.textContent = src;
  url.setAttribute("aria-hidden", "true");
  wrap.append(label, url);
  return wrap;
}
```

Visual text inside `label`/`url` stays in English (the existing copy) — the `aria-label` on `wrap` is the AT-facing string and goes through `t/tA11y`. The inner divs are `aria-hidden` so the label isn't read twice.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/decorations/reading-widgets.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: ARIA on reading-mode widgets

Decorative widgets (BulletWidget, SoftBreakWidget) are aria-hidden
so screen readers don't read out 'bullet' or stray spaces. Image
placeholders for blocked/broken remote images get role=img with a
localized aria-label (via tA11y) that includes the alt text."
jj new
```

---

## Task 7: Mermaid widget ARIA

**Files:**
- Modify: `src/editor/decorations/mermaid.ts`
- Test: `tests/decorations/mermaid.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/decorations/mermaid.test.ts` inside the existing describe block:

```ts
  it("widget DOM exposes ARIA: loading announces via role=status; cached success uses role=img + aria-label", () => {
    const src = "```mermaid\ngraph TD\nA-->B\n```\n";
    const tokens = parseMarkdown(src);
    const set = mermaidProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();

    // First render = loading state (cache miss). Should announce as a status
    // region so SRs pick it up via aria-live.
    const loading = widget!.toDOM();
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-label")).toBe("Rendering Mermaid diagram");

    // Prime the cache with an ok entry and re-render to hit the success
    // branch (synchronously — no await needed since we inject the entry).
    const sourceText = "graph TD\nA-->B\n";
    mermaidCache.set(sourceText, { status: "ok", payload: "<svg></svg>" });
    const set2 = mermaidProducer({ source: src, tokens });
    let widget2: WidgetType | undefined;
    const cursor2 = set2.iter();
    while (cursor2.value) {
      const spec = cursor2.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget2 = spec.widget; break; }
      cursor2.next();
    }
    const okDom = widget2!.toDOM();
    expect(okDom.getAttribute("role")).toBe("img");
    expect(okDom.getAttribute("aria-label")).toBe("Mermaid diagram");
  });
```

The existing file already imports `mermaidCache, mermaidProducer` on line 4 — leave that alone.

Cache-key shape: the producer constructs `new MermaidWidget(t.content)` where `t.content` is the markdown-it fence content — the text between the opening and closing fence lines, including the trailing newline. For `\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\``, that's `"graph TD\nA-->B\n"`. The `sourceText` literal above is already correct; don't change it.

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/mermaid.test.ts`
Expected: the new case FAILS (no role / aria-label set on wrap).

- [ ] **Step 3: Implement in `mermaid.ts`**

In `src/editor/decorations/mermaid.ts`:

(a) Add the i18n import at the top, next to existing imports:

```ts
import { t } from "../../i18n/strings";
```

(b) Replace the `MermaidWidget.toDOM` method body to set ARIA on each branch. The full updated `toDOM`:

```ts
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-mermaid";
    const entry = this.entry;
    if (!entry) {
      wrap.classList.add("cm-md-mermaid-loading");
      wrap.textContent = "Rendering diagram…";
      wrap.setAttribute("role", "status");
      wrap.setAttribute("aria-live", "polite");
      wrap.setAttribute("aria-label", t("a11y.mermaidDiagramLoading"));
      mermaidCache.request(this.source);
      return wrap;
    }
    if (entry.status === "ok") {
      wrap.innerHTML = entry.payload;
      wrap.setAttribute("role", "img");
      wrap.setAttribute("aria-label", t("a11y.mermaidDiagram"));
    } else {
      wrap.classList.add("cm-md-mermaid-error");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", t("a11y.mermaidDiagramFailed"));
      const msg = document.createElement("div");
      msg.className = "cm-md-mermaid-error-message";
      msg.textContent = entry.payload;
      const pre = document.createElement("pre");
      pre.className = "cm-md-mermaid-source";
      pre.textContent = this.source;
      wrap.append(msg, pre);
    }
    return wrap;
  }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/mermaid.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: ARIA on Mermaid widget

Loading state: role=status + aria-live=polite so SRs announce it
when render completes. Success state: role=img + aria-label
'Mermaid diagram'. Error state: role=region for navigability to
the error message."
jj new
```

---

## Task 8: Graphviz widget ARIA

**Files:**
- Modify: `src/editor/decorations/graphviz.ts`
- Test: `tests/decorations/graphviz.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/decorations/graphviz.test.ts` inside the existing describe block (mirroring Task 7):

```ts
  it("widget DOM exposes ARIA: loading announces via role=status; cached success uses role=img + aria-label", () => {
    const src = "```dot\ndigraph { A -> B }\n```\n";
    const tokens = parseMarkdown(src);
    const set = graphvizProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();

    const loading = widget!.toDOM();
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-label")).toBe("Rendering Graphviz diagram");

    const sourceText = "digraph { A -> B }\n";
    graphvizCache.set(sourceText, { status: "ok", payload: "<svg></svg>" });
    const set2 = graphvizProducer({ source: src, tokens });
    let widget2: WidgetType | undefined;
    const cursor2 = set2.iter();
    while (cursor2.value) {
      const spec = cursor2.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget2 = spec.widget; break; }
      cursor2.next();
    }
    const okDom = widget2!.toDOM();
    expect(okDom.getAttribute("role")).toBe("img");
    expect(okDom.getAttribute("aria-label")).toBe("Graphviz diagram");
  });
```

Confirm `graphvizCache` and `graphvizProducer` are imported at the top of the test file. If not, add:

```ts
import { graphvizCache, graphvizProducer } from "../../src/editor/decorations/graphviz";
import { WidgetType } from "@codemirror/view";
```

Cache-key shape is the same as Mermaid: `new GraphvizWidget(t.content)`. For `\`\`\`dot\ndigraph { A -> B }\n\`\`\``, `t.content` is `"digraph { A -> B }\n"`. The `sourceText` literal above is already correct.

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/decorations/graphviz.test.ts`
Expected: the new case FAILS.

- [ ] **Step 3: Implement in `graphviz.ts`**

In `src/editor/decorations/graphviz.ts`:

(a) Add the i18n import next to existing imports:

```ts
import { t } from "../../i18n/strings";
```

(b) Replace the `GraphvizWidget.toDOM` method body with:

```ts
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-graphviz";
    const entry = this.entry;
    if (!entry) {
      wrap.classList.add("cm-md-graphviz-loading");
      wrap.textContent = "Rendering diagram…";
      wrap.setAttribute("role", "status");
      wrap.setAttribute("aria-live", "polite");
      wrap.setAttribute("aria-label", t("a11y.graphvizDiagramLoading"));
      graphvizCache.request(this.source);
      return wrap;
    }
    if (entry.status === "ok") {
      wrap.innerHTML = sanitizeSvg(entry.payload);
      wrap.setAttribute("role", "img");
      wrap.setAttribute("aria-label", t("a11y.graphvizDiagram"));
    } else {
      wrap.classList.add("cm-md-graphviz-error");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", t("a11y.graphvizDiagramFailed"));
      const msg = document.createElement("div");
      msg.className = "cm-md-graphviz-error-message";
      msg.textContent = entry.payload;
      const pre = document.createElement("pre");
      pre.className = "cm-md-graphviz-source";
      pre.textContent = this.source;
      wrap.append(msg, pre);
    }
    return wrap;
  }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/decorations/graphviz.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: ARIA on Graphviz widget

Loading state: role=status + aria-live=polite. Success state:
role=img + aria-label 'Graphviz diagram'. Error state: role=region
on the error wrap."
jj new
```

---

## Task 9: Math — KaTeX htmlAndMathml, verify MathML survives sanitization

**Files:**
- Modify: `src/editor/decorations/math.ts`
- Test: `tests/decorations/math.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/decorations/math.test.ts` inside the existing describe block:

```ts
  it("rendered inline math contains a <math> element so screen readers can read it (MathML)", () => {
    const src = "Pythagoras: $a^2 + b^2 = c^2$ done.\n";
    const tokens = parseMarkdown(src);
    const set = mathProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();
    const dom = widget!.toDOM();
    // The post-sanitize innerHTML must still contain a <math> element so
    // assistive tech can announce the expression as math, not letters.
    expect(dom.innerHTML).toMatch(/<math[\s>]/i);
  });

  it("rendered block math contains a <math> element with displaystyle for screen readers", () => {
    const src = "$$\nx = y\n$$\n";
    const tokens = parseMarkdown(src);
    const set = mathProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();
    const dom = widget!.toDOM();
    expect(dom.innerHTML).toMatch(/<math[\s>]/i);
  });
```

If `WidgetType` isn't imported in the test file, add it at the top:

```ts
import { WidgetType } from "@codemirror/view";
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/decorations/math.test.ts`
Expected: both new cases FAIL because the current `output: "html"` strips MathML before render.

- [ ] **Step 3: Implement in `math.ts`**

In `src/editor/decorations/math.ts`, change both `katex.renderToString` calls. Replace each occurrence of:

```ts
        output: "html",
```

with:

```ts
        output: "htmlAndMathml",
```

(Two call sites: `InlineMathWidget.toDOM` and `BlockMathWidget.toDOM`.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/decorations/math.test.ts`
Expected: all cases PASS.

If they don't pass because DOMPurify is stripping `<math>` on its own, also extend `src/export/sanitize.ts`:

(a) Read `src/export/sanitize.ts` first. If the current `sanitizeHtml` already preserves `<math>` (DOMPurify default html profile does — most builds keep MathML), no change needed. If the test still fails, replace the `sanitizeHtml` body with:

```ts
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  });
}
```

Re-run the math test; expected: PASS.

- [ ] **Step 5: Run the full export sanitize tests as a regression check**

Run: `npx vitest run tests/export`
Expected: PASS (sanitize behavior on KaTeX/Mermaid HTML output unchanged for the existing scenarios).

- [ ] **Step 6: Commit**

```bash
jj desc -m "Sub-spec F: KaTeX emits htmlAndMathml so SRs read math as math

KaTeX's htmlAndMathml output wraps the visual HTML with a hidden
<math> MathML subtree (kept aria-hidden=false by KaTeX). Screen
readers consume the MathML; sighted users see the same HTML
rendering as before. sanitize.ts left intact — DOMPurify's default
html profile preserves MathML elements."
jj new
```

---

## Task 10: Update ROADMAP and CHANGELOG

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Flip Sub-spec F in ROADMAP.md status table**

In `ROADMAP.md`, replace the existing Sub-spec F row in the status table:

```markdown
| **F. A11y & i18n** | WCAG audit, screen-reader pass, i18n string extraction | 🟡 Mostly done 2026-05-09 (modal a11y + reduced-motion + keyboard-navigable TOC + i18n foundation + menu-string sweep + WCAG contrast on muted text; full screen-reader audit on reading-mode body deferred) |
```

with:

```markdown
| **F. A11y & i18n** | WCAG audit, screen-reader pass, i18n string extraction | ✅ Shipped 2026-05-12 (modal a11y + reduced-motion + keyboard-navigable TOC + i18n foundation + menu-string sweep + WCAG contrast on muted text + reading-mode body screen-reader audit: ARIA on headings/lists/quotes/code/diagrams, MathML for math) |
```

- [ ] **Step 2: Update Sub-spec F section body**

In `ROADMAP.md`, find the "## Sub-spec F: A11y & i18n polish" section. Replace its content (from the heading through the `---` that follows) with:

```markdown
## Sub-spec F: A11y & i18n polish — shipped

Shipped in two batches: 2026-05-09 (modal a11y, reduced-motion, keyboard-navigable TOC, i18n foundation + menu-string sweep, WCAG AA contrast — see CHANGELOG 0.7.0 / 0.11.0) and 2026-05-12 (reading-mode body screen-reader audit).

**Reading-mode body audit (2026-05-12).** ARIA roles attached to line decorations so screen readers can navigate by structure: `role="heading"` + `aria-level` on each heading, `role="listitem"` on bullet/ordered/task list lines, `role="blockquote"` on quoted lines, `role="code"` on code-body lines (first body line carries `aria-label` with the fence language), `aria-hidden="true"` on collapsed fence lines. Opaque widgets (Mermaid, Graphviz) gain `role="img"` + localized `aria-label` for the success state, `role="status"` + `aria-live="polite"` for the loading state, `role="region"` for the error state. Decorative widgets (BulletWidget, SoftBreakWidget) are `aria-hidden`. Remote/broken image placeholders gain `role="img"` with the existing label text exposed via `aria-label`. KaTeX flipped to `htmlAndMathml` output so screen readers read math expressions as math.

All new AT-facing strings flow through `t()`/`tA11y()` in `src/i18n/strings.ts` under the `a11y.*` namespace.

**Deferred to a future iteration:** semantic `<a>` for reading-mode links — depends on a reading-mode click-handler decision that's out of scope here.

---
```

- [ ] **Step 3: Add CHANGELOG entry**

In `CHANGELOG.md`, insert the following entry as the **new top entry** (above the `## [0.11.0]` header):

```markdown
## [0.12.0] - 2026-05-12 — Sub-spec F: reading-mode screen-reader audit

### Added

- **ARIA semantics on reading-mode body.** Headings, list items, blockquotes, and code-body lines now carry the appropriate `role` and (for headings) `aria-level` so screen readers navigate the document by structure. The first body line of a code fence carries an `aria-label` announcing the language; fence open/close lines are `aria-hidden`. VoiceOver, NVDA, and Orca can now jump heading-to-heading in reading mode (rotor / `H` key).
- **Opaque widget descriptions.** Mermaid and Graphviz diagrams expose `role="img"` + localized `aria-label` on success, `role="status"` + `aria-live="polite"` on first paint (so SRs announce when the diagram lands), and `role="region"` on the error path. Remote-image and broken-image placeholders gain `role="img"` with `aria-label` derived from the alt text.
- **Math as math.** KaTeX flipped from `output: "html"` to `output: "htmlAndMathml"` — every rendered expression now ships a `<math>` MathML subtree that screen readers read as mathematics, not letter-by-letter. Visual rendering unchanged.
- **`a11y.*` i18n namespace.** New keys under `a11y.*` in `src/i18n/strings.ts` for every AT-facing label, plus a `tA11y(key, params)` helper for `{lang}` / `{alt}` substitution.

### Fixed

- Decorative widgets (`BulletWidget`, `SoftBreakWidget`) no longer leak through to AT — both are now `aria-hidden="true"` so screen readers don't read out "bullet bullet bullet" or stray spaces.

### Test surface

- 10 new unit tests across 8 producer test files; existing tests unchanged.
- Manual VoiceOver pass on a document containing each construct (heading nav, list, blockquote, code fence, mermaid, graphviz, math, image, table).
```

- [ ] **Step 4: Verify the whole test suite still passes**

Run: `npm test`
Expected: all unit tests PASS (existing + 10 new across 8 producer test files).

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Sub-spec F: flip to shipped in ROADMAP + CHANGELOG 0.12.0

Reading-mode screen-reader audit complete. Sub-spec F is fully
shipped; only one explicitly-deferred item remains (semantic <a>
for reading-mode links), tracked as a future iteration."
jj new
```

---

## Self-review checklist (run after completing all tasks)

- [ ] All 10 new test cases pass (1 in headings, 1 in lists, 1 in blockquotes, 1 in codeblocks, 2 in reading-widgets, 1 in mermaid, 1 in graphviz, 2 in math).
- [ ] `npx tsc -b --noEmit` clean.
- [ ] `cargo check` clean (no Rust changes).
- [ ] Manual VoiceOver smoke pass on `REQUIREMENTS.md` or another rich document: heading nav works, list/quote/code/diagram regions identified, math read as math.
- [ ] ROADMAP.md Sub-spec F row is ✅ and section body updated.
- [ ] CHANGELOG.md has the new 0.12.0 entry at the top.
- [ ] All 10 task commits are present in `jj log` with sensible messages.
