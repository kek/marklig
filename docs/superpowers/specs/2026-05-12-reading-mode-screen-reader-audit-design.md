# Reading-mode screen-reader audit (Sub-spec F completion)

**Status:** approved 2026-05-12
**Closes:** the lone remaining item on Sub-spec F (A11y & i18n) — "full screen-reader audit on reading-mode body deferred" in `ROADMAP.md`.

## Goal

Make the reading-mode body navigable and intelligible to screen readers (VoiceOver, NVDA, Orca) without altering the decorated-source architecture or the visual rendering for sighted users.

Concretely, an AT user should be able to:
- Jump heading-to-heading (VoiceOver rotor / NVDA `H`) — currently fails: headings are plain `<div>`s.
- Hear "list, X items" / "list item N of X" around bullet and ordered lists — currently fails.
- Hear "quotation" / "blockquote" entering quoted text — currently fails.
- Hear "code" + language entering a code fence and skip past it on demand — currently fails.
- Get a description of opaque diagrams (Mermaid, Graphviz) rather than "graphic" — currently fails.
- Hear math expressions read as math (via MathML), not character-by-character — currently fails (KaTeX is asked for HTML-only output).
- Not be subjected to decorative characters (bullet glyphs, soft-break spacer widgets) or collapsed-line content (code fences, frontmatter source) — currently leaks through.

## Non-goals

- Reading-mode link semantics (`<a role="link">` + click handler). The marks-based architecture for links doesn't lend itself to drop-in role assignment, and we lack a reading-mode click handler today. Tracked as a follow-up.
- Editor-mode (decorated-source-edit) screen-reader audit. CodeMirror has its own a11y story for the focused textarea fallback; out of scope here.
- Re-rendering reading mode as semantic HTML. Would discard the decorated-source pattern, the click-to-position behavior, and the Shiki cache reuse — disproportionate to the gap.

## Approach

In-place ARIA on existing line decorations and widget DOM. ARIA roles can supply the structural cues that the `<div class="cm-line">` containers lack, without changing the rendered text or visual layout.

Two delivery paths:

1. **Line attributes** — `Decoration.line({ attributes: {...} })`. CodeMirror copies these onto the line element. Used for headings, list items, quote lines, code-body lines, and `aria-hidden` on collapsed lines.
2. **Widget DOM** — set attributes directly on the widget `toDOM` element. Used for Mermaid, Graphviz, image placeholders, math, and decorative widgets.

## Changes

### Line-level ARIA

| Producer | Line decoration today | Add attributes |
|---|---|---|
| `headings.ts` | `class: "cm-md-heading cm-md-heading-${level}"` | `role: "heading"`, `aria-level: String(level)` |
| `lists.ts` | `class: "cm-md-list cm-md-list-${kind}"` (or task variant) | `role: "listitem"` |
| `blockquotes.ts` | `class: "cm-md-blockquote"` | `role: "blockquote"` |
| `codeblocks.ts` (body) | `class: "cm-md-code-body cm-md-code-lang-${lang}"` | `role: "code"`; **first** body line additionally gets `aria-label: t("a11y.codeBlock", { lang })` so AT announces the language once on entry |
| `codeblocks.ts` (fence) | `class: "cm-md-code-fence cm-md-code-fence-open\|close"` | `aria-hidden: "true"` (visually collapsed; the body lines carry the announcement) |
| `reading-widgets.ts` (frontmatter `ELIDE_FENCE_LINE`-style use) | — | n/a; frontmatter is replaced by a single block widget already |

ARIA listitem note: `role="listitem"` without a parent `role="list"` is technically a spec violation, but all three major screen readers (VoiceOver, NVDA, Orca) announce orphan listitems acceptably. The alternative — synthesizing a parent — would require a block widget that swallows the whole list, breaking click-to-position. Accept the warning.

### Widget ARIA

In `reading-widgets.ts`:

- `BulletWidget.toDOM()` — `setAttribute("aria-hidden", "true")` on the returned `<span>`. The `•` glyph is decorative; the `role="listitem"` line carries the semantics.
- `SoftBreakWidget.toDOM()` — `setAttribute("aria-hidden", "true")`. The widget exists to merge paragraph lines visually; the literal space character is enough for AT.
- `HrWidget.toDOM()` — leave alone. `<hr>` is already semantic ("separator").
- `makeRemoteImagePlaceholder()` / `makeBrokenImagePlaceholder()` — `role="img"` + `aria-label` set to the existing label text ("Remote image: ${alt}" / "Broken image: ${alt}"). Inner divs gain `aria-hidden="true"` so the label isn't read twice. The existing label text is already user-facing English; migrate to `t("a11y.remoteImage" / "a11y.brokenImage")` as part of the same change.
- `FrontmatterWidget.toDOM()` — the rendered `<dl>` is already correctly announced. No change.
- `TableWidget.toDOM()` — `<table>` already correctly announced. No change.
- `ImageWidget.toDOM()` (real `<img>` path) — already has `alt`. No change.

In `mermaid.ts`:

- `MermaidWidget.toDOM()` wrap:
  - Loading state: `role="status"`, `aria-live="polite"`, text remains "Rendering diagram…".
  - Success state: `role="img"`, `aria-label: t("a11y.mermaidDiagram")`. The SVG's interior text becomes secondary detail; the role+label give AT a stable announcement.
  - Error state: `role="region"`, `aria-label: t("a11y.mermaidDiagramFailed")`. Error message + source remain readable.

In `graphviz.ts`: mirror of `mermaid.ts` with `t("a11y.graphvizDiagram")` / `t("a11y.graphvizDiagramFailed")`.

All new strings go through `t()` from `src/i18n/strings.ts` and land in the English source table as the canonical copy. Keys live under an `a11y.*` namespace to keep them out of the existing `menu.*` / `modal.*` namespaces.

In `math.ts`:

- Flip `katex.renderToString` `output` from `"html"` to `"htmlAndMathml"` (KaTeX's default). KaTeX wraps the rendered span in a `<span class="katex">` containing both `<span class="katex-mathml">` (the `<math>` subtree, the AT-facing path) and `<span class="katex-html" aria-hidden="true">` (the visual layout). Both are emitted; CSS shows only the latter.
- Verify `sanitizeHtml` preserves `<math>` and its children. DOMPurify's default HTML profile permits MathML, so the existing `sanitizeHtml` call should pass through. Add a test that asserts the post-sanitize output contains a `<math` tag.
- If preservation requires an explicit allowlist, extend `sanitize.ts` to pass `MATHML_TAGS` profile alongside the existing config.

### Tests

One new test case per file, asserting the new attribute on a representative input:

| File | Test |
|---|---|
| `tests/decorations/headings.test.ts` | "exposes role=heading + aria-level on each level" |
| `tests/decorations/lists.test.ts` | "exposes role=listitem on bullet and ordered list lines" |
| `tests/decorations/blockquotes.test.ts` | "exposes role=blockquote on quoted lines" |
| `tests/decorations/codeblocks.test.ts` | "body lines have role=code; first body line carries aria-label with language; fence lines are aria-hidden" |
| `tests/decorations/reading-widgets.test.ts` | "decorative widgets (bullet, softbreak) are aria-hidden; image placeholders expose role=img + aria-label" |
| `tests/decorations/mermaid.test.ts` | "success-state widget has role=img + aria-label='Mermaid diagram'; loading state announces via role=status" |
| `tests/decorations/graphviz.test.ts` | "success-state widget has role=img + aria-label='Graphviz diagram'; loading state announces via role=status" |
| `tests/decorations/math.test.ts` | "rendered math contains a <math> element for screen readers (htmlAndMathml output)" |

No new test files; no new dependencies.

## Risks and mitigations

- **DOMPurify stripping `<math>`.** Add a unit test that fails loudly if a future config change drops MathML. Mitigation in code: explicit allowlist if the default profile changes.
- **Listitem-without-list warning.** Documented above. Verified against VoiceOver/NVDA behavior — they handle it; the spec violation is harmless.
- **KaTeX `htmlAndMathml` slightly larger output.** Adds a `<math>` subtree per expression. Visual rendering unchanged.
- **CodeMirror future versions changing `Decoration.line` attribute handling.** Locked-in pattern in current CM 6.x; covered by tests so a future bump that breaks it fails CI.

## Definition of done

- All 8 new test cases pass (`npm test`).
- `npx tsc -b --noEmit` clean.
- `cargo check` clean (no Rust changes expected).
- Manual VoiceOver pass on a sample document containing each construct: heading nav, list, blockquote, code fence, mermaid, graphviz, math, image, table.
- ROADMAP.md: Sub-spec F status flipped from 🟡 to ✅; the "screen-reader audit on reading-mode body deferred" qualifier removed.
- CHANGELOG.md: new entry summarising the audit and the user-visible improvement (AT users can now navigate by heading, identify regions, hear diagram descriptions, etc.).
