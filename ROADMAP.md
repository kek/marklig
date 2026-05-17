# Roadmap

This document tracks the full v1 plan from `REQUIREMENTS.md`, decomposed during the original brainstorm into six sub-specs (A–F). Each sub-spec stands on its own and ships when complete.

The Foundation sub-spec (A) shipped on 2026-05-08 across three implementation plans. The remaining sub-specs (B–F) follow.

## Status overview

| Sub-spec | Scope | Status |
|---|---|---|
| **A. Foundation** | Tauri shell, decorated-source editor, reading↔editing modes, themes, file lifecycle, TOC sidebar, recents, crash recovery, native menus, zoom, find/replace, CI matrix | ✅ Shipped 2026-05-08 |
| **B. Rich content** | Math (KaTeX), Mermaid, image rendering, remote-image policy, full HTML sanitization story | ✅ Shipped 2026-05-08 (Graphviz `dot`, paragraph soft-line-break reflow, and pretty YAML frontmatter added 2026-05-11) |
| **C. Export & print** | PDF, self-contained HTML, print pipeline | ✅ Shipped 2026-05-08 (PDF via OS print dialog; native print-to-PDF deferred) |
| **D. OS integration** | File associations, drag-drop polish, OS-level Recents, native menu polish, optional folder/project tree, multi-window UX | ✅ Shipped 2026-05-12 for macOS (file associations + LaunchServices registration, folder tree with live project-tree watcher, multi-window with per-window watcher + per-window folder/sidebar state restore + multi-window-restore on launch, drag-drop refinements, last-file restore, per-file scroll memory, macOS NSDocumentController, Projects menu + recent-projects palette `Ctrl-R`, `Cmd-P` fuzzy file finder, window-aware menu routing via event bus, quit-vs-close lifecycle, `Cmd-W` closes focused window). Windows Jump List, Linux `RecentManager`, and Quick Look signing moved to [Future](#future). |
| **E. Settings, updater, privacy** | Preferences UI, auto-update channel, network privacy toggles | ✅ Shipped 2026-05-09 as scoped (prefs UI + remote-image policy + auto-save toggle + keyboard-shortcut help). Auto-updater moved to [Future](#future). |
| **F. A11y & i18n** | WCAG audit, screen-reader pass, i18n string extraction | ✅ Shipped 2026-05-12 (modal a11y + reduced-motion + keyboard-navigable TOC + i18n foundation + menu-string sweep + WCAG contrast on muted text + reading-mode body screen-reader audit: ARIA on headings/lists/quotes/code/diagrams, MathML for math) |

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

**Post-ship additions (2026-05-11).** Graphviz `dot` fences render as SVG in reading mode (same async-cache pattern as Mermaid; loaded via `import("@viz-js/viz")` so the ~1.2 MB lives in its own chunk). Soft-line-break paragraph reflow in reading mode — single newlines inside a paragraph collapse to spaces visually while the source stays untouched. YAML frontmatter renders as a pretty key/value metadata block (table-styled) instead of literal source, and is excluded from the TOC. Mermaid widget `eq()` fixed so the async-rendered SVG actually replaces the "loading…" placeholder instead of being deduped against it.

---

## Sub-spec C: Export & print — shipped

**HTML export** (`src/export/html.ts` + `src/export/styles.ts`). File → Export → HTML… writes a self-contained `.html` file: full DOCTYPE, inlined export stylesheet (mirrors reading-mode typography but doesn't depend on CodeMirror), inlined KaTeX CSS via Vite `?inline`, and the rendered body. Math is pre-extracted via the same regex used in the in-app `math.ts` producer, rendered through `katex.renderToString`, swapped back as placeholders so markdown-it never tokenizes math source. Sanitized via the existing `sanitizeHtml`.

**Print.** `Cmd/Ctrl + P` renders the export HTML into a hidden same-process iframe, then calls `contentWindow.print()`. The same-document path is used (rather than `window.open`) because Tauri's webview doesn't reliably forward print events from popups. The export stylesheet's `@media print` block drops page padding, forces black-on-white, and adds `page-break-inside: avoid` for code/blockquotes. PDF export works through the OS print dialog's "Save as PDF" — a first-class native-PDF entry would need a Rust-side webview-to-PDF call, deferred.

**Copy as HTML.** `Cmd/Ctrl + Shift + C` writes a `ClipboardItem` with both `text/html` and a `text/plain` fallback (the latter for terminal/plain-text receivers).

**Mermaid in exports** is not in this slice — Mermaid is async per-instance and would block the synchronous export. Fenced `mermaid` blocks export as their source for now.

---

## Sub-spec D: OS integration

A handful of polish items that turn the foundation into "feels like a real desktop app." Most landed across two batches: 2026-05-09 (initial pass — see CHANGELOG 0.6.0 / 0.8.0 / 0.9.0) and 2026-05-10 → 2026-05-12 (a long PR-driven polish pass, #6 → #39, not yet in the changelog).

**Shipped:**
- **File associations.** macOS `CFBundleDocumentTypes` + `UTExportedTypeDeclarations`, Windows registry entries, Linux `.desktop` MimeType for `.md` / `.markdown` / `.mdx` / `.mdown`. macOS also registers with LaunchServices (PR #9) so Finder routing works without re-opening the app. Files arrive via `RunEvent::Opened` and are forwarded to the frontend; cold-start waits up to 500 ms for the event before falling back to the open dialog. Finder-launched files prefer a window already showing the file's tree, otherwise spawn a new one (PR #28).
- **Drag-drop refinements.** Folder → opens in the folder sidebar; multi-file drop → first opens here, the rest each spawn a new window pre-loaded with their file.
- **OS-level Recents.** macOS `NSDocumentController.noteNewRecentDocumentURL` (objc2-app-kit, main-thread-only). Windows + Linux equivalents are in [Future](#future) — can't be tested on the current dev machine.
- **Native menu polish.** Explicit application + Help submenus on macOS, platform-correct accelerators throughout, platform-aware "Reveal in Finder/Explorer/File Manager" label. Menu actions route to the focused window via a typed event bus (PR #22), not just the menu-owning main, so File/Edit/View work in any window.
- **Folder/project tree.** Side panel listing `.md` files under an opened directory; recursive `list_markdown_files` (depth 6, 5,000 entries cap) skips `node_modules` / `.git` / `target` / `dist` / `build` / `out` but does traverse leading-dot dirs like `.claude` (PR #19) since users keep notes there. Substring filter input above the list. Project tree is now watched live (PR #30) so files appearing/disappearing on disk refresh the sidebar. Opening a file inside an already-open folder no longer switches the sidebar root (PR #38). Opening a file from outside the current root switches the sidebar to the file's repo or directory (PR #21).
- **Multi-window UX.** `Cmd+N` spawns blank windows; per-window watcher and per-window folder/sidebar state. Window sizes/positions persist via Tauri store. Multi-window restore on launch (PR #8) re-opens whatever windows were open before quit. `Cmd-W` closes the focused window instead of the menu-owning main (PR #20). On macOS the app keeps running after the last window closes until explicit quit (PR #39), matching platform convention. Crash-recovery session-tick race fixed at close time (PR #37).
- **Projects menu + palettes.** `Projects` menu lists recent project folders (PR #29). `Ctrl-R` opens the recent-projects palette (PR #32). `Cmd-P` opens a fuzzy file finder across the open project (PR #33); Print moved to `Cmd-Alt-P`.
- **Per-file scroll memory.** Each file remembers its scrollTop, restored on re-open (PR #7).
- **macOS Quick Look.** Extension target exists and renders Markdown via Quick Look (PR #10). Ship is blocked on Developer ID signing + notarization, so the binding is in [Future](#future) — do **not** re-investigate format/ExtensionKit angles.

---

## Sub-spec E: Settings, updater, privacy — shipped

A small, focused preferences surface and the privacy toggles.

**Shipped:**
- **Preferences window** (`Cmd/Ctrl + ,`). Appearance (system / light / dark), remote-image policy (placeholder / load / off), and an auto-save toggle. Keyboard shortcuts modal (`F1`) lists every binding with platform-correct glyphs.
- **Network privacy.** Remote-image policy defaults to `placeholder` so no outbound image requests fire without explicit consent. No other outbound network paths exist.

**Deferred to [Future](#future):** auto-updater (needs `tauri-plugin-updater`, signing keys, and an update-feed host — pure infra blocker, not a code one).

---

## Sub-spec F: A11y & i18n polish — shipped

Shipped in two batches: 2026-05-09 (modal a11y, reduced-motion, keyboard-navigable TOC, i18n foundation + menu-string sweep, WCAG AA contrast — see CHANGELOG 0.7.0 / 0.11.0) and 2026-05-12 (reading-mode body screen-reader audit — see CHANGELOG 0.12.0).

**Reading-mode body audit (2026-05-12).** ARIA roles attached to line decorations so screen readers can navigate by structure: `role="heading"` + `aria-level` on each heading, `role="listitem"` on bullet/ordered/task list lines, `role="blockquote"` on quoted lines, `role="code"` on code-body lines (first body line carries `aria-label` with the fence language), `aria-hidden="true"` on collapsed fence lines. Opaque widgets (Mermaid, Graphviz) gain `role="img"` + localized `aria-label` for the success state, `role="status"` + `aria-live="polite"` for the loading state, `role="region"` for the error state. Decorative widgets (BulletWidget, SoftBreakWidget) are `aria-hidden`. Remote/broken image placeholders gain `role="img"` with the existing label text exposed via `aria-label`. KaTeX flipped to `htmlAndMathml` output so screen readers read math expressions as math.

All new AT-facing strings flow through `t()` / `tA11y()` in `src/i18n/strings.ts` under the `a11y.*` namespace.

**Deferred to a future iteration:** semantic `<a>` for reading-mode links — depends on a reading-mode click-handler decision that's out of scope here. Tracked in [Future](#future).

**Spec:** `docs/superpowers/specs/2026-05-12-reading-mode-screen-reader-audit-design.md`. **Plan:** `docs/superpowers/plans/2026-05-12-reading-mode-screen-reader-audit.md`.

---

## v2: Mobile companion (in progress)

Read-only Android companion app sharing the desktop renderer, with LAN-only sync between desktop and phone. Server-backed sync, iOS, and edit-on-phone are explicitly out of scope for v2.0. Spec: `docs/superpowers/specs/2026-05-17-mobile-companion-design.md`. Tracking issue: #70.

- [x] **Step 1 — Tauri Android init.** Scaffold the Android target; render a bundled `sample.md` on hardware. Plan: `docs/superpowers/plans/2026-05-17-mobile-companion-1-tauri-android-init.md`. PRs: #81 (spec), #82 (impl). Verified on Pixel 8 Pro 2026-05-17.
- [x] **Step 2 — Share-sheet (`tauri-plugin-deep-link` + `plugin-fs`).** Cold-launch and warm-launch ACTION_VIEW intents with `content://` URIs render the shared file. Plan: `docs/superpowers/plans/2026-05-17-mobile-companion-2-saf-fileshell.md`. PR #83. SAF folder picker / library indexer deferred to a later iteration.
- [x] **Step 3 — Recents + library UI.** Persistent recents via `tauri-plugin-store`. Tap-to-reopen, back-bar to library, first-launch shows bundled sample. v2.0-alpha–shippable as a standalone reader. Plan: `docs/superpowers/plans/2026-05-17-mobile-companion-3-library-ui.md`. PR #84.
- [x] **Step 4 — Crypto core (`marklig-sync-core`).** Workspace crate with Noise XK pairing, ChaCha20-Poly1305 envelope, sync op log + Lamport clock. 25 unit tests; builds for Android via Tauri. No consumers in code yet — steps 5+ wire it up. Plan: `docs/superpowers/plans/2026-05-17-mobile-companion-4-crypto-core.md`. PR #_.
- [ ] **Step 4 — Crypto core (`marklig-sync-core`).** Noise XK pairing handshake + per-file ChaCha20-Poly1305 envelope + sync op log. Tested desktop ↔ desktop in loopback.
- [ ] **Step 5 — Desktop pairing UX.** QR modal, settings → Pairings pane, per-folder "Sync this folder to phone" menu action.
- [ ] **Step 6 — LAN transport.** mDNS discovery (`_marklig-sync._tcp`) + direct TCP, WebRTC fallback.
- [ ] **Step 7 — Phone pairing UX + sync wire-up.** Scan QR, resolve mDNS, run handshake, subscribe to folder, render synced content.
- [ ] **Step 8 — Soft launch (v2.0).** Android internal track, then production.
- [ ] **(v2.1+, deferred)** Blind-relay path for off-LAN sync. Separate spec.

## Future

De-scoped from the v1 sub-specs because they can't be meaningfully built or verified on the current dev setup. Code-complete pieces are kept in-tree; the missing piece in each case is platform access or signing infrastructure, not implementation work. None of these block a v1 macOS ship.

- **Windows OS-level Recents (Jump List).** Sync the internal recents list with the Windows Jump List. Needs a Windows machine for development and a CI runner for regression testing.
- **Linux OS-level Recents (`RecentManager`).** Sync the internal recents list with GTK `RecentManager` / freedesktop recently-used spec. Needs a Linux desktop session for development; headless CI won't exercise the integration meaningfully.
- **macOS Quick Look extension.** Extension target (PR #10) is code-complete and renders Markdown via Quick Look, but the bundle has to be signed with a Developer ID Application cert and notarized before macOS will load it from an installed app. Blocked on paid Apple Developer membership + notarization pipeline; do **not** re-investigate the format / ExtensionKit angles.
- **Auto-updater.** `tauri-plugin-updater` integration with stable / pre-release / off channels, consent-required apply. Blocked on signing keys (same Developer ID dependency as Quick Look on macOS) and an update-feed host. Pure infra blocker — the code shape is well-trodden.
- **Native print-to-PDF.** A first-class "Export as PDF…" menu entry that doesn't route through the OS print dialog. Needs a Rust-side webview-to-PDF call from Tauri; currently the OS print dialog's "Save as PDF" covers the workflow.
- **Mermaid in HTML exports.** Mermaid is async per-instance; rendering during a synchronous export pass would block. Either pre-render all diagrams ahead of `buildHtmlExport` or move the export pipeline to async. Fenced `mermaid` blocks currently export as source.
- **Semantic `<a>` for reading-mode links.** Reading-mode links are styled via mark decorations on the literal `[text](url)` source, not real `<a>` elements — so screen readers don't announce them as links and there's no keyboard activation. Doing this properly requires a reading-mode click-handler design (when does the underlying source click pass through, when does it activate the link?). Out of scope for the F audit; tracked as a follow-up.

When the infra/access blockers lift (Apple Developer cert + notarization pipeline; access to Windows + Linux dev environments), promote items back into a sub-spec.

---

## How the work is organized

- **`docs/superpowers/specs/`** — design specs. Each sub-spec gets one. Specs describe what to build and why; they don't mandate implementation order.
- **`docs/superpowers/plans/`** — implementation plans. Each spec produces one or more plans. Plans are TDD-disciplined task lists, ~20 atomic tasks each, executed via the `superpowers:subagent-driven-development` skill.
- **`CHANGELOG.md`** — release notes per shipped plan.
- **`ROADMAP.md`** (this file) — running view of where Sub-specs A–F stand.

When a sub-spec is ready to start, the workflow is: `superpowers:brainstorming` to write the spec → `superpowers:writing-plans` to decompose into plans → `superpowers:subagent-driven-development` to execute.
