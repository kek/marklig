# Viewer Quick Look extension (macOS)

This directory contains two Quick Look `.appex` bundles that ship with the
macOS build of Viewer:

- **`ViewerQuickLook.appex`** — `QLPreviewProvider` for `.md` files. Pressing
  Space on a markdown file in Finder shows a fully rendered preview that
  matches Viewer's reading mode (typography, palette, code blocks, tables,
  blockquotes, lists).
- **`ViewerThumbnail.appex`** — `QLThumbnailProvider` that draws a light-page
  thumbnail with an "MD" badge and the document's first heading peeking out
  underneath, so a folder of markdown files looks coherent in column view.

Both bundles target macOS 12+.

## Why hand-built (no Xcode project)

Apple's Quick Look extensions are normally produced by an Xcode `App
Extension` target. We deliberately skip Xcode here:

- A Quick Look extension is just an `.appex` bundle: `Contents/Info.plist`
  declaring `NSExtensionPointIdentifier`, plus a Mach-O linked against
  `QuickLookUI` / `QuickLookThumbnailing` and hosted by `NSExtensionMain`.
  Everything Xcode generates around that is build-system noise.
- A `.xcodeproj` is a 1500-line `pbxproj` that churns on every Xcode
  upgrade and that Tauri / Rust contributors shouldn't have to maintain.
- The renderer is plain Swift; no SwiftPM, no third-party deps, no signing
  identity required for local install (ad-hoc signature works for dev).

`scripts/build-quicklook.sh` invokes `xcrun swiftc` directly, lipos arm64
and x86_64 slices, drops the binary into the bundle layout, runs `plutil`
to fill `$(PRODUCT_MODULE_NAME)` in the principal-class string, and
`codesign`s ad-hoc.

## Layout

```
src-tauri/macos/quicklook/
├── README.md                   ← this file
├── extension.entitlements      ← App Sandbox + read-only file access
├── preview/
│   ├── Info.plist              ← com.apple.quicklook.preview extension
│   ├── main.swift              ← NSExtensionMain shim
│   ├── PreviewViewController.swift
│   ├── MarkdownRenderer.swift  ← MD → HTML, sanitised at the source
│   └── Stylesheet.swift        ← copy of src/export/styles.ts
├── thumbnail/
│   ├── Info.plist              ← com.apple.quicklook.thumbnail extension
│   ├── main.swift
│   └── ThumbnailProvider.swift ← Core Graphics drawing
└── tests/
    └── main.swift              ← Swift smoke test for MarkdownRenderer
```

## Build

From the repo root:

```bash
scripts/build-quicklook.sh
# → target/quicklook/{ViewerQuickLook,ViewerThumbnail}.appex
```

Test the renderer in isolation:

```bash
scripts/test-quicklook.sh
# → "OK: all renderer fixtures passed."
```

Smoke-test the bundles via `qlmanage`:

```bash
qlmanage -p some-file.md           # opens the preview window
qlmanage -t -s 256 -o /tmp some-file.md   # writes thumbnail PNG to /tmp
```

## Install

The extension is loaded from `Viewer.app/Contents/PlugIns/`. After running
`npm run tauri:build`:

```bash
scripts/build-quicklook.sh --install src-tauri/target/release/bundle/macos/Viewer.app
```

For a system-wide install, drag `Viewer.app` to `/Applications/`. The
first time Finder sees the app it registers the embedded extensions with
Launch Services / `pluginkit`. To force re-registration during development:

```bash
pluginkit -m -p com.apple.quicklook.preview | grep viewer
pluginkit -e use -i com.viewer.app.quicklook
pluginkit -e use -i com.viewer.app.thumbnail
```

## Sanitisation

Every code path that emits HTML into the WKWebView is sanitised at source:

- **Source text** is HTML-escaped before any markdown replacements run, so
  user-supplied `<script>` / `onerror=` / `javascript:` payloads can never
  appear as live HTML.
- **URLs** in links and images go through `MarkdownRenderer.sanitizeURL`,
  which restricts schemes to `http`, `https`, `mailto`, `tel`, plus
  relative paths and same-document anchors. Anything else collapses to `#`.
- **JavaScript** in the WKWebView is disabled via
  `WKWebpagePreferences.allowsContentJavaScript = false`.
- **Network** access is blocked by the App Sandbox entitlement set; the
  extension does not declare `com.apple.security.network.client`.

This satisfies the "sanitize any HTML rendered into a WKWebView"
requirement called out in the project's CLAUDE.md.

## Deferred scope

- **Math** (`$…$`, `$$…$$`) — the in-app reader uses KaTeX. The Quick Look
  extension currently leaves math as raw source. Adding KaTeX is doable
  but means bundling its CSS + a JS engine, which is heavyweight for a
  Quick Look path most users won't notice.
- **Mermaid** — same trade-off; defer.
- **Shiki syntax highlighting** in fenced code blocks — Quick Look shows
  monospaced un-highlighted code. Adding Shiki would mean a JS engine in
  the extension; defer.
- **Tighter Tauri integration** — `tauri build` doesn't yet copy the
  `.appex` into `Contents/PlugIns/` automatically. The README documents
  the post-build script. A follow-up issue should wire this into Tauri's
  `bundle.macOS` hooks (or a `cargo tauri` after-bundle script).
