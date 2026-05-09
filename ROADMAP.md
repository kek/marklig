# Roadmap

This document tracks the full v1 plan from `REQUIREMENTS.md`, decomposed during the original brainstorm into six sub-specs (A–F). Each sub-spec stands on its own and ships when complete.

The Foundation sub-spec (A) shipped on 2026-05-08 across three implementation plans. The remaining sub-specs (B–F) follow.

## Status overview

| Sub-spec | Scope | Status |
|---|---|---|
| **A. Foundation** | Tauri shell, decorated-source editor, reading↔editing modes, themes, file lifecycle, TOC sidebar, recents, crash recovery, native menus, zoom, find/replace, CI matrix | ✅ Shipped 2026-05-08 |
| **B. Rich content** | Math (KaTeX), Mermaid, image rendering, remote-image policy, full HTML sanitization story | ✅ Shipped 2026-05-08 |
| **C. Export & print** | PDF, self-contained HTML, print pipeline | ✅ Shipped 2026-05-08 (PDF via OS print dialog; native print-to-PDF deferred) |
| **D. OS integration** | File associations, drag-drop polish, OS-level Recents, native menu polish, optional folder/project tree, multi-window UX | 🟡 Mostly done 2026-05-09 (file associations, folder tree, multi-window with per-window watcher, drag-drop refinements, last-file restore, macOS NSDocumentController; Windows Jump List + Linux RecentManager remain) |
| **E. Settings, updater, privacy** | Preferences UI, auto-update channel, network privacy toggles | 🟡 Partial 2026-05-09 (prefs UI + remote-image policy + auto-save toggle + keyboard-shortcut help; auto-updater deferred) |
| **F. A11y & i18n** | WCAG audit, screen-reader pass, i18n string extraction | 🟡 Mostly done 2026-05-09 (modal a11y + reduced-motion + keyboard-navigable TOC + i18n foundation + menu-string sweep + WCAG contrast on muted text; full screen-reader audit on reading-mode body deferred) |

---

## Sub-spec A: Foundation — shipped

Three sequential implementation plans, executed via subagent-driven-development.

**Plan 1 — Read-only viewer (23 tasks).** Tauri 2 + Vite + TypeScript scaffold; markdown-it parser with GFM/footnotes/deflist/tasklists; CodeMirror 6 editor with three compartments; eleven decoration producers (headings, inline, lists, links, images, blockquotes, tables, code blocks with Shiki priming, front matter, footnotes/deflist, reading-mode widgets); light/dark/OS-follow themes; Rust `read_text_file` command; bootstrap that opens via OS dialog or CLI arg.

**Plan 2 — Editing & file lifecycle (20 tasks).** Edit mode (decorated source — markers visible AND styled); mode toggle via toolbar button + `Cmd/Ctrl + E`; reading-mode keymap (Space/Shift+Space/PageUp/PageDown/arrows/Home/End); save (`Cmd/Ctrl + S`); dirty tracking with toolbar dot + window-title bullet; close-with-dirty prompt; drag-drop file open; Rust file watcher (`notify-debouncer-mini` initially) with self-write filter; reconciliation flow (clean reload, dirty modal, orphan notice, diverged-save warning). Closed Plan 1 carryover: Shiki token coloring, multi-line paragraph decoration, shared `computeLineStarts` util.

**Plan 3 — Polish & platform (26 tasks).** Togglable TOC sidebar with click-to-jump and scroll-sync; recents menu (last 10, dedupe); 5-second crash-recovery dump + startup restore prompt; native menu inventory (File/Edit/View/Window with everything wired); document zoom (`Cmd/Ctrl + 0/+/-`); find/replace via `@codemirror/search` panel in both modes; DOMPurify `sanitizeHtml` seam for Sub-spec C export; real iconset; GitHub Actions CI matrix (Ubuntu/macOS/Windows); visual regression Playwright corpus (light + dark baselines). Closed Plan 2 carryover: switched to `notify-debouncer-full` so file-removed events fire; preserve scroll on external reload; reconcile modal default focus on safe action; `frontmatter.ts` and `inline.ts` use shared util; `thiserror` aligned to 2.x; `setActiveTheme` wired via View → Theme menu.

**Test surface at A's ship:** 80 unit tests across 21 test files; 5 Playwright e2e specs (open-and-render, edit-and-save, external-change, visual-regression light/dark).

**Spec:** `docs/superpowers/specs/2026-05-08-markdown-viewer-foundation-design.md`. **Plans:** `docs/superpowers/plans/2026-05-08-markdown-viewer-foundation-{1-viewer,2-editing-and-files,3-polish-and-platform}.md`.

---

## Sub-spec B: Rich content — shipped

Shipped as a single iterative pass on top of Foundation rather than a fresh spec → plans cycle, since each piece followed the established decoration-producer contract from A.

**Math (KaTeX).** Inline `$…$` and block `$$…$$` rendered in reading mode via `decorations/math.ts`. Two widgets (`InlineMathWidget`, `BlockMathWidget`) call `katex.renderToString(..., { throwOnError: false })`. Currency-like `$5` and escaped `\$` are excluded by negative lookbehinds. Block math wins over inline disambiguation so `$$x$$` doesn't double-tokenize.

**Mermaid diagrams.** Fenced blocks tagged `mermaid` are replaced with an async-rendered SVG widget (`decorations/mermaid.ts`). Mermaid is loaded via `import("mermaid")` on first use — the package is ~1 MB, but lives in its own chunk. Render results are cached by source string; completion fires a `mermaidCacheEffect` that triggers decoration recompute (mirrors the Shiki async cache pattern from `codeblocks.ts`). Failures render the source verbatim above the error message rather than throwing.

**Remote-image policy.** New `shell/settings.ts` owns `remoteImagePolicy` (`load` | `placeholder` | `off`, default `placeholder`). `ImageWidget` consults it: local images always render; remote images render only when policy is `load`. Otherwise a bordered placeholder shows alt + URL. `load` mode adds an `onerror` handler that swaps in a broken-image placeholder. Settings persist via the Tauri store; no UI yet — Sub-spec E adds the prefs window.

**Sanitization hardening.** Both new innerHTML paths go through DOMPurify. KaTeX HTML output → existing `sanitizeHtml`. Mermaid SVG output → new `sanitizeSvg` with `USE_PROFILES: { svg: true, svgFilters: true, html: true }` to keep SVG markup (including `foreignObject` for HTML labels) while still stripping `<script>` and event handlers. Reading-mode rendering itself remains text + widget on the editor side, so the architectural guarantee from A still holds.

**Test surface:** 104 unit tests across 24 files (was 89/22). Math producer (8), Mermaid producer (5), settings/URL classification (10), `sanitizeSvg` (3).

---

## Sub-spec C: Export & print — shipped

**HTML export** (`src/export/html.ts` + `src/export/styles.ts`). File → Export → HTML… writes a self-contained `.html` file: full DOCTYPE, inlined export stylesheet (mirrors reading-mode typography but doesn't depend on CodeMirror), inlined KaTeX CSS via Vite `?inline`, and the rendered body. Math is pre-extracted via the same regex used in the in-app `math.ts` producer, rendered through `katex.renderToString`, swapped back as placeholders so markdown-it never tokenizes math source. Sanitized via the existing `sanitizeHtml`.

**Print.** `Cmd/Ctrl + P` renders the export HTML into a hidden same-process iframe, then calls `contentWindow.print()`. The same-document path is used (rather than `window.open`) because Tauri's webview doesn't reliably forward print events from popups. The export stylesheet's `@media print` block drops page padding, forces black-on-white, and adds `page-break-inside: avoid` for code/blockquotes. PDF export works through the OS print dialog's "Save as PDF" — a first-class native-PDF entry would need a Rust-side webview-to-PDF call, deferred.

**Copy as HTML.** `Cmd/Ctrl + Shift + C` writes a `ClipboardItem` with both `text/html` and a `text/plain` fallback (the latter for terminal/plain-text receivers).

**Mermaid in exports** is not in this slice — Mermaid is async per-instance and would block the synchronous export. Fenced `mermaid` blocks export as their source for now.

---

## Sub-spec D: OS integration

A handful of polish items that turn the foundation into "feels like a real desktop app."

**In scope:**
- **File associations.** Register the app as a handler for `.md` / `.markdown` / `.mdx` / `.mdown` on each OS. Handle "Open With…" properly (currently routed via CLI arg in A; D makes it native).
- **Drag-drop refinements.** Drop a folder → optional folder/project tree opens; drop multiple files → multi-window.
- **OS-level Recents.** macOS `LSRecentDocuments`, Windows Jump List, Linux RecentManager — sync our internal recents list with these.
- **Native menu polish.** macOS "About" / "Services" / standard items; Windows app menu in title bar; per-platform accelerators.
- **Optional folder/project tree.** Side panel listing `.md` files in an opened directory. Single-click to open, double-click to focus.
- **Multi-window UX.** Per-window menu state, window cycling, session restore.

**Likely shape:** 1 spec → 1–2 plans depending on whether the folder tree lands here or pushes to a future iteration.

---

## Sub-spec E: Settings, updater, privacy

A small, focused preferences surface and a compliant updater.

**In scope:**
- **Preferences window.** Theme (already wired via View menu — pref window adds the same control plus reading-mode font / size / measure, editor font, auto-save toggle, spell-check toggle/dictionary, default file associations, update channel).
- **Auto-update.** Configurable channel (stable / pre-release / off). The user must consent to apply updates; no silent install.
- **Network privacy toggles.** Allow remote images on/off (default off — even though Sub-spec B introduces remote images, the kill switch is a privacy commitment). Allow update checks on/off. The app makes zero outbound requests without explicit consent except in response to user content (remote `<img>`) or user action (Check for Updates).

**Depends on:** Sub-spec B (remote-image policy must exist before E exposes a toggle for it).

---

## Sub-spec F: A11y & i18n polish

The home stretch for shipping a real product.

**In scope:**
- **Full keyboard navigation.** Every action reachable by mouse must be reachable by keyboard.
- **Screen-reader audit.** Reading mode exposes semantic headings, alt text, link text, list structure. The editor side surfaces enough for a blind user to locate and edit.
- **WCAG AA contrast.** Both light and dark themes audited and adjusted.
- **Reduced-motion support.** Honors the OS setting; mode-toggle and scroll-to-jump animations skip when reduced-motion is on.
- **i18n string extraction.** Every UI string lives in a translation table. Ship en-US on day one; the framework supports adding locales without code changes.

**Likely shape:** 1 spec → 1 plan. Lots of small, mechanical tasks; the audit findings drive the task list.

---

## How the work is organized

- **`docs/superpowers/specs/`** — design specs. Each sub-spec gets one. Specs describe what to build and why; they don't mandate implementation order.
- **`docs/superpowers/plans/`** — implementation plans. Each spec produces one or more plans. Plans are TDD-disciplined task lists, ~20 atomic tasks each, executed via the `superpowers:subagent-driven-development` skill.
- **`CHANGELOG.md`** — release notes per shipped plan.
- **`ROADMAP.md`** (this file) — running view of where Sub-specs A–F stand.

When a sub-spec is ready to start, the workflow is: `superpowers:brainstorming` to write the spec → `superpowers:writing-plans` to decompose into plans → `superpowers:subagent-driven-development` to execute.
