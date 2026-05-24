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
