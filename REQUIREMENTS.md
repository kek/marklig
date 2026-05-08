# Requirements — Markdown Reader/Editor (desktop app)

A desktop application for reading and editing Markdown files. The defining quality is that **rendered Markdown should look beautiful** — good enough that a user is happy to read long-form content in the app, not just edit it. Editing is a secondary mode the user enters when they want to change something.

This document describes *what* the app must do, not *how* it should be built.

---

## 1. Goals & non-goals

### Goals
- Make reading Markdown on a desktop computer a pleasant, near-typographic experience.
- Let the user edit any Markdown file they can read, with a fast switch between reading and editing.
- Faithfully render the full Markdown spec, including math and Mermaid diagrams, so users can trust the preview.
- Work as a self-contained desktop app: open files from disk, save back to disk, integrate with the OS.

### Non-goals
- Real-time collaborative editing.
- Cloud sync, accounts, or any server-side component.
- Being a general-purpose IDE or note database (no tag systems, no graph view, no daily-notes scaffolding).
- Mobile or web deployment.

---

## 2. Target users

- **Readers** opening `.md` files they received, downloaded, or have in a project — they care most about how the document looks.
- **Writers** drafting documentation, notes, blog posts, or technical specs — they care about typing flow and accurate preview.
- **Developers** reading READMEs and design docs locally, often with code blocks and diagrams.

The app should be usable by all three without configuration. Power features may be hidden behind menus or settings, but the default experience must be excellent.

---

## 3. Core functional requirements

### 3.1 Reading (rendered) mode
- The app opens any `.md` / `.markdown` / `.mdx` / `.mdown` file and presents it as a fully rendered document.
- Reading mode is the **default** when a file is opened.
- The reader is read-only: clicks do not move a cursor or insert characters; they activate links, expand details, copy code, etc.
- Clicking an external link opens it in the user's default browser. Clicking a link to another local Markdown file opens that file in the same app.
- The reader supports browser-style navigation: scroll, find-in-page, copy selection, zoom, print/export.
- Long documents render incrementally — the user can start reading the top while the rest is still being laid out.

### 3.2 Editing mode
- The user can enter edit mode from any document via a single, obvious action (toolbar control, menu item, and a discoverable keyboard shortcut).
- The user can leave edit mode the same way and immediately see the rendered result.
- Edits are made to the underlying Markdown source. The on-disk file is plain Markdown — no proprietary format, no sidecar files.
- Standard editing affordances: undo/redo, cut/copy/paste, find & replace, multi-line selection, indent/outdent.
- The transition between reading and editing should preserve the reader's scroll position so they don't lose their place.
- Save must be explicit by default (Ctrl/Cmd+S). Auto-save is acceptable as an opt-in.
- Unsaved changes must be visually indicated and the app must warn before closing or quitting with unsaved work.

### 3.3 Markdown coverage
The renderer must handle the full Markdown surface a typical user expects:

- **CommonMark** — all block and inline constructs (headings, paragraphs, lists, blockquotes, code blocks, thematic breaks, links, images, emphasis, inline code, hard/soft breaks, HTML passthrough where safe).
- **GitHub-Flavored Markdown extensions** — tables, task lists, strikethrough, autolinks, fenced code with language hints.
- **Front matter** — YAML/TOML front matter at the top of a file is recognized and not rendered as body content.
- **Footnotes**, **definition lists**, and **reference links**.
- **Math** — both inline (`$…$`) and block (`$$…$$`) LaTeX, rendered as proper typeset math.
- **Syntax highlighting** for fenced code blocks across the common languages (at minimum: JS/TS, Python, Go, Rust, Java, C/C++, shell, JSON, YAML, SQL, HTML/CSS, Markdown itself).
- **Images** from local relative paths, absolute paths, and remote URLs. Broken images render a clear placeholder rather than failing silently.
- **Embedded raw HTML** is rendered safely (see §6 Security).

### 3.4 Mermaid diagrams
- Fenced code blocks with the `mermaid` language tag render as live diagrams in reading mode.
- All standard Mermaid diagram types are supported (flowcharts, sequence diagrams, class diagrams, state diagrams, ER, Gantt, pie, etc.).
- A Mermaid block that fails to parse shows a clear, non-fatal error in place of the diagram, with the source visible so the user can fix it. The rest of the document still renders.
- Diagrams scale with document zoom and respect the active light/dark theme.

### 3.5 File and project handling
- Open a single file from the OS file dialog, drag-and-drop onto the app, or via "Open With…" from the file manager.
- Optional: open a folder/project to browse a tree of Markdown files in a side panel. This is a nice-to-have for the v1 scope but should be planned for.
- The app remembers recently opened files and offers them in a Recents menu.
- File associations: the app can register itself as a handler for `.md` family extensions on the host OS.

### 3.6 Export
The user can export the currently open document to at least:
- **PDF** — using the same beautiful rendering as the on-screen reader.
- **HTML** — self-contained, with styles inlined or alongside, suitable for sharing.

Print-to-paper produces the same layout as the PDF export.

---

## 4. Look & feel — the bar for "beautiful"

The rendered view is the product's signature surface. The bar is "I'd rather read this document here than on GitHub." Concretely:

- **Typography first.** A serif or modern sans body face chosen for long-form readability, generous line height (~1.5–1.7), comfortable measure (~70–80 characters), and proper hanging punctuation where feasible. Headings use a clear typographic hierarchy.
- **Restraint.** Lots of whitespace. No chrome, panels, or rulers visible while reading; the document is the interface.
- **Code blocks** are visually distinct but quiet — subtle background, monospace face with proper ligatures support, syntax colors that work in both light and dark themes, and a copy button that appears on hover.
- **Tables** are typeset, not "spreadsheet-y" — proper alignment, zebra striping optional, no heavy borders.
- **Math and diagrams** sit at the same visual quality as the surrounding text — vector-rendered, scale with zoom, never pixelated.
- **Images** are full-bleed-capable within the measure, with optional captions taken from the alt text.
- **Themes.** At minimum a refined light theme and a refined dark theme. Theme switching is instant. The app should also follow the OS appearance setting by default.
- **Smooth interaction.** Scrolling is buttery. Switching between reading and editing is animated/instant, never a jarring reload.

The editing surface should be visually calm too — no syntax soup of color overlays in the user's face. Where formatting markers (e.g. `**`, `_`, headings hashes) appear in edit mode, they should be muted relative to the content text.

---

## 5. Non-functional requirements

### 5.1 Performance
- A typical Markdown file (≤ 100 KB) opens and renders in under ~300 ms on commodity hardware.
- Switching reading ↔ editing is perceptually instant (no spinner, no progress bar).
- Scrolling a long document (e.g. 5000 lines) maintains a smooth frame rate.
- The app cold-starts in a few seconds on commodity hardware.

### 5.2 Reliability
- The app does not lose user edits on crash. Recover unsaved buffers on next launch.
- The app survives a malformed Markdown file: it always renders something, never gets into a stuck or blank state.
- A failed Mermaid diagram, broken image, or unsupported extension never breaks the rest of the document.

### 5.3 Platforms
- Runs on macOS, Windows, and Linux as a native desktop app.
- Honors OS conventions on each platform: menu bar location, keyboard shortcuts, window controls, file dialogs, accent color, scrollbar style, dark-mode signal.
- Available in both per-machine and per-user install forms where the OS distinguishes.

### 5.4 Accessibility
- Full keyboard navigation. Every action reachable by mouse must also be reachable by keyboard.
- Screen-reader-friendly reading mode (semantic headings, alt text, link text exposed).
- Respects the user's OS-level font-size and reduced-motion settings.
- Color choices in both themes meet WCAG AA contrast.

### 5.5 Internationalization
- UTF-8 throughout. Files with non-Latin scripts, RTL languages, and emoji render correctly.
- The app's own UI strings are translatable (i18n is in scope; shipping many translations on day one is not).

### 5.6 Privacy
- The app does not phone home. No telemetry, analytics, or crash reporting that leaves the machine **without explicit, opt-in consent**.
- No background network activity initiated by the app itself. Network requests happen only as a direct consequence of user content (e.g. an `<img>` whose `src` is a URL) or user action (e.g. checking for updates).
- If a remote image is in a document, the user can disable remote image loading globally — the document still renders, with placeholders.

### 5.7 Updates
- The app can check for updates and apply them with the user's permission.
- Update channel is configurable (stable / pre-release) or disable-able entirely.

---

## 6. Security

The renderer treats Markdown as untrusted input.

- Embedded raw HTML is sanitized: no script execution, no inline event handlers, no `javascript:` URLs, no exfiltration via crafted images or links. Sanitization is the default, applied to **all** rendering paths — on-screen, export, print, copied HTML.
- Linked and embedded resources from the document do not gain access to the user's filesystem or local processes beyond reading the image file they explicitly point to.
- The app does not execute any code embedded in a document. Code blocks are rendered, never run.
- Opening a Markdown file must never be sufficient to compromise the user's machine. If a user can be persuaded to download a `.md` file and open it, that alone must be safe.
- The app stores any user-provided secrets (API tokens for optional integrations) in the OS-provided secure storage, not in plain config files.

---

## 7. Settings & customization

A small, focused preferences surface:

- Theme (light / dark / follow system) and editor font.
- Reading-mode font, size, and measure.
- Auto-save on/off, auto-save interval.
- Spell-check on/off and dictionary language(s).
- Default file associations.
- Update channel.
- Network privacy: allow remote images, allow update checks.

Settings are discoverable, searchable within the preferences window, and have sensible defaults so a brand-new user never needs to open them.

---

## 8. Out of scope (v1)

- Plugin/extension system.
- Image upload to third-party hosts.
- Git integration.
- Multi-file projects with cross-document features (backlinks, graph view).
- Collaborative or live-shared editing.
- Cloud accounts or sync.

These can be considered for later versions; calling them out keeps v1 focused on the core "read and edit one beautiful Markdown file" experience.

---

## 9. Acceptance criteria (high level)

The v1 is shippable when:

1. A user can double-click a `.md` file in their OS file manager and the app opens it in reading mode within a few seconds.
2. The rendered output of a representative test corpus (CommonMark spec, GFM spec, a doc with math, a doc with Mermaid, a long real-world README) looks visibly more polished than the same document on GitHub.
3. The user can switch to edit mode, type changes, switch back, and save — entirely from the keyboard if they choose.
4. Closing a document with unsaved changes always prompts; the app never silently discards work.
5. Exporting to PDF produces a document that looks like the on-screen reader.
6. Light theme, dark theme, and OS-following all work and survive a theme switch mid-document without re-opening the file.
7. A document containing a malicious `<script>` or `javascript:` URL renders safely with the offending element neutralized.
8. The app passes its own privacy claim: a network monitor on a freshly opened plain-text Markdown file shows zero outbound traffic from the app itself.
