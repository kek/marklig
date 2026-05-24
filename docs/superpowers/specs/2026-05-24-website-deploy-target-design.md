# Website as a fifth deploy target

**Date:** 2026-05-24
**Status:** Design

## Summary

Treat the marketing site as a fifth deploy target alongside macOS, Windows,
Linux, and Android. The site is not a separately-built rendering of the
product — it *is* the product, embedded. A new `src/website/bootstrap.ts`
entry point imports the same decoration producers, the same editor module,
and the same toolbar component the desktop app uses, mounts a single
`EditorView` in reading mode, and feeds it a real Markdown file
(`website/content.md`) that contains the marketing copy. Build output is
static HTML/JS/CSS deployed to GitHub Pages on every push to `trunk`.

Because the site consumes the shipped `src/` modules instead of duplicating
them, marketing claims and product behavior are the same artifact:
improvements to producers automatically appear on the site, and removals
become visible immediately. Feature drift becomes impossible by construction.

## Goals

1. Site renders by running the actual application code — no fork, no
   simulation, no parallel renderer for marketing content.
2. Site is reachable at `kek.github.io/marklig` via GitHub Pages, deployed
   from a GitHub Actions workflow on push to `trunk`.
3. Site exposes reading mode by default and lets visitors switch to edit
   mode (edits don't persist).
4. The marketing copy lives in a single Markdown file
   (`website/content.md`) that is itself opened and rendered by the
   embedded `EditorView`.
5. Web becomes a normal deploy target: `npm run website:dev`,
   `npm run website:build`, `npm run website:preview` mirror the existing
   `tauri:dev` / `tauri:android:dev` ergonomics.

## Non-goals

- A separate static-site framework (Astro, Eleventy, Hugo). Vite is enough.
- A multi-page site. Single page only.
- Persisting visitor edits (no Tauri save path; reload discards).
- A separate `gh-pages` branch or `docs/` Pages source. Actions only.
- Custom domain in v1.
- Hand-written CSS that mimics reading mode. The real producers render.
- Tablet/mobile-specific layout. The desktop reading-mode layout already
  reflows; the page is narrow-measure by design.

## Architecture

```
src/
  editor/
    decorations/...      ← imported by desktop, mobile, AND website
    editor.ts            ← shared (createEditor, setMode, compartments)
    parser.ts            ← shared
    theme.ts             ← shared (applyTheme, loadStoredTheme)
    keymaps.ts           ← shared (readingKeymap, editKeymap)
  ui/
    toolbar.ts           ← shared (mountToolbar)
    sidebar/toc.ts       ← shared (mountTocSidebar)
  website/
    bootstrap.ts         ← NEW; parallel to src/mobile-bootstrap.ts

website/
  index.html             ← Vite entry; thin shell with #root
  content.md             ← the marketing page, written as real Markdown

vite.config.website.ts   ← NEW; root=website, base=/marklig/, output=website/dist
.github/workflows/
  pages.yml              ← NEW; build + upload-pages-artifact + deploy-pages
```

The website bootstrap follows the exact pattern already established by
`src/mobile-bootstrap.ts`:

1. Import `buildDecorationField` and the same producer set the desktop
   app uses (headings, inline, lists, links, images, blockquotes, tables,
   codeblocks, frontmatter, footnotes, reading-widgets, math, mermaid,
   graphviz).
2. Import `createEditor` from `src/editor/editor.ts`.
3. Import `mountToolbar` from `src/ui/toolbar.ts`.
4. Load `content.md` as a raw string via Vite's `?raw` import:
   `import contentMd from "../../website/content.md?raw"`.
5. Mount an `EditorView` in reading mode against `#root`.
6. Mount the toolbar above it; wire `onModeChange` to flip the
   `data-mode` attribute on `<html>` (drives the same CSS the app uses).
7. Initialize `setDirty(false)`, `setPath("content.md")`, and
   `setStats(computeDocStats(view.state.doc.toString()))`.

### Mobile-bootstrap is the precedent, not the parent

The mobile and website bootstraps share a shape but they don't share a
file. Each handles a different host environment. The thing they share —
the producer set, the editor module, the theme module — lives in `src/`
and is imported by both.

## Build target

A new Vite config (`vite.config.website.ts`) keeps the website build
isolated from the app build:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "website",
  base: "/marklig/",
  build: {
    outDir: "dist",       // becomes website/dist/
    target: "es2022",
    emptyOutDir: true,
  },
  // No server.host quirks; this config never runs under Tauri.
});
```

`website/index.html` is a thin shell:

```html
<!DOCTYPE html>
<html lang="en" data-mode="reading">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Märklig — Markdown that's beautiful to read</title>
    <meta name="description" content="A desktop Markdown reader and editor for macOS, Windows, and Linux." />
    <meta property="og:title" content="Märklig" />
    <meta property="og:description" content="Markdown that's beautiful to read." />
    <meta property="og:image" content="/marklig/og.png" />
    <link rel="icon" href="/marklig/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/website/bootstrap.ts"></script>
  </body>
</html>
```

The `<html data-mode="reading">` initial attribute matches what the
desktop app sets — the same CSS rules apply.

### Scripts (package.json)

```json
{
  "website:dev":     "vite --config vite.config.website.ts",
  "website:build":   "vite build --config vite.config.website.ts",
  "website:preview": "vite preview --config vite.config.website.ts"
}
```

Existing `dev`, `tauri:dev`, `tauri:build`, `tauri:android:dev` are
untouched.

## Deploy

`.github/workflows/pages.yml`:

- Triggers: `push` to `trunk` (and `workflow_dispatch` for manual).
- Permissions: `pages: write`, `id-token: write`.
- Concurrency: one in-flight Pages deploy at a time, cancel queued.
- Steps:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with the project's Node version.
  3. `npm ci`
  4. `npm run website:build`
  5. `actions/configure-pages@v5`
  6. `actions/upload-pages-artifact@v3` with `path: website/dist`
  7. `actions/deploy-pages@v4`

**One-time manual step (called out in PR description):** repo Settings →
Pages → Source: "GitHub Actions". No `gh-pages` branch, no `docs/`
folder source.

## Content (`website/content.md`)

Single Markdown file. Outline matches the approved mockup:

```
# Märklig

*Markdown that's beautiful to read.*

A desktop reader and editor for macOS, Windows, and Linux —
and a mobile reader for Android. Reading comes first.

This page is a Märklig EditorView rendering content.md —
the same code that runs in the desktop app, with one of the same
decoration producers per Markdown construct. Click the edit icon
in the toolbar to switch this page to edit mode.

## Reading-first
…

## Full Markdown
…

> What you write is what you get. What you read is what you wrote.

## Typst
[describes in-process compile, system fonts, @preview/* packages,
 status bar, dimmed last-good pages — all accurate to shipped state]

## Android companion — work in progress
[share-sheet, same renderer; iOS/edit/folder-browser out of scope for v2.0]

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
[Rust](…), Node.js 20+, and the [Tauri prerequisites](…) for your OS.

```bash
git clone https://github.com/kek/marklig
cd marklig
npm install
npm run tauri:build
```

For Android, see the `tauri:android:dev` instructions in the README.

---

[github.com/kek/marklig](https://github.com/kek/marklig)
```

Content edits are part of implementation, not the spec. The spec fixes
the shape (sections present, each accurate to shipped state, no marketing
copy that the producers can't render).

## Toolbar / UX

The website mounts `mountToolbar` from `src/ui/toolbar.ts` directly.
- **Edit toggle (left)**: real `setMode()` call against the shared
  compartments. Switches `<html data-mode>` and producer set.
  Cmd-E also works (via `editKeymap` / `readingKeymap`).
- **TOC toggle**: mounts `mountTocSidebar` on first click; the heading
  list comes from the same parser the app uses.
- **Dirty dot**: never lit (`setDirty(false)` once at startup).
- **Path readout**: `content.md`.
- **Stats**: `computeDocStats(view.state.doc.toString())`, fed once at
  startup. Edits change the doc but the stats display does not refresh
  in v1 (no `updateListener` wire-up); acceptable for a demo. (Add later
  if useful — trivial.)

No extra marketing CTAs, badges, or HTML chrome. Download links are
plain Markdown links rendered by `linksProducer`.

## Tauri-API boundary

Verified at spec time (`grep -rn "tauri\|convertFileSrc\|invoke"` across
`src/editor/decorations/*` and `src/editor/*`): the decoration producers
and editor module are host-neutral. They take callbacks and DOM nodes,
not Tauri APIs. No shim layer is needed in v1.

- `link-clicks.ts` — `linkClickExtension(handlers: LinkClickHandlers)`
  takes its open-external callback as a parameter. The website
  bootstrap passes `(url) => window.open(url, "_blank", "noopener")`.
  The desktop `main.ts` passes `@tauri-apps/plugin-opener`'s `openUrl`.
  Same extension, different injected open.
- `images.ts` — does not import from `@tauri-apps/*`. Renders `<img>`
  tags directly. The website content references only HTTPS URLs and
  same-origin assets, so no special-casing needed.
- `reading-widgets.ts` — host-neutral.
- Math / Mermaid / Graphviz producers — browser libraries, no Tauri.

If a future producer adds a Tauri dependency without a callback seam,
`npm run website:build` will fail loudly at the import. That's the
desired feedback loop: producers stay host-neutral, the website target
catches regressions, no silent feature drift.

(There is therefore no `src/website/stubs.ts` file in v1. If a future
producer requires one, add it then and document the host-detection rule
here.)

## What gets bundled

The website bundle includes the producer set plus their transitive
dependencies:
- `markdown-it` + its plugins
- `codemirror` (core + the language/decoration bits actually used)
- `shiki` (lazy-loaded by `codeblocks.ts`)
- `katex` (lazy-loaded by `math.ts`)
- `mermaid` (lazy-loaded by `mermaid.ts`)
- `@viz-js/viz` (lazy-loaded by `graphviz.ts`)

Lazy chunks stay lazy. The initial bundle is the editor + producers +
parser. KaTeX CSS is imported eagerly (same as the app) so math doesn't
flash unstyled.

If initial-bundle size becomes a concern, the codeblocks producer can
defer Shiki priming on the website — the marketing content's code
blocks render unstyled-but-monospace until Shiki finishes. Not in v1
unless measurements demand it.

## What's NOT shared with the app

- `src/main.ts`, `src/shell/*`, `src/ui/sidebar/folder.ts`,
  `src/ui/preferences.ts`, `src/ui/reconcile.ts`, the menu system,
  recents, watcher, recovery, multi-window — none of these load in the
  website. The bootstrap doesn't import them.
- `src-tauri/*` — irrelevant to the website target.

## Files touched / created

**New:**
- `src/website/bootstrap.ts`
- `website/index.html`
- `website/content.md`
- `website/favicon.svg`
- `website/og.png` (Märklig reading mode screenshot; replaces
  the existing branch's `assets/reading-mode.png`)
- `vite.config.website.ts`
- `.github/workflows/pages.yml`

**Modified:**
- `package.json` — three new scripts.
- `.gitignore` — add `website/dist/`.
- `README.md` — add a "Website" subsection under develop with the three
  npm scripts and a note about Pages source.

**Deleted/replaced (from `claude/plan-next-steps-MYxmU`):**
- That branch's hand-written `website/index.html`, `website/styles.css`,
  inline tab JS — all superseded by the live-editor approach. The
  screenshot asset is reused (renamed/repurposed if needed).

## Open questions

- **OG image / favicon.** Need a screenshot of Märklig reading mode
  large enough for OG (1200×630). Reuse the branch's `reading-mode.png`
  for now; consider a Märklig-rendered HTML → screenshot pipeline later
  so the OG image regenerates with each release. **v1 decision:** reuse
  the existing screenshot.
- **Custom domain.** Out of scope. `kek.github.io/marklig` for v1.
- **Analytics.** None.
- **Edit-mode persistence.** Edits don't persist on reload. **v1
  decision:** acceptable — visitors switching to edit see real editing
  behavior; the URL stays a stable marketing surface.

## Risks

- **Bundle size.** If the editor + producers exceed ~500 KB initial,
  consider deferring Shiki priming. Measure before optimizing.
- **Producer adds Tauri dep without fallback.** Spec requires producers
  stay host-neutral; if a future producer reaches for `invoke`, the
  website build fails loudly at `npm run website:build`. That's the
  desired behavior — better than silent feature drift.
- **GitHub Actions Pages source flip.** The repo-level switch to "GitHub
  Actions" is manual; first PR description must call it out.
