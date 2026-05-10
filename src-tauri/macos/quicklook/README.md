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
│   ├── Info.plist              ← NSExtension (com.apple.quicklook.preview)
│   ├── main.swift              ← NSExtensionMain shim
│   ├── PreviewViewController.swift
│   ├── MarkdownRenderer.swift  ← MD → HTML, sanitised at the source
│   └── Stylesheet.swift        ← copy of src/export/styles.ts
├── thumbnail/
│   ├── Info.plist              ← EXAppExtensionAttributes + NSExtension
│   │                             (com.apple.quicklook.thumbnail)
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

## Plist format on Tahoe / Sequoia

Both `Info.plist` files declare the extension twice: once via the modern
`EXAppExtensionAttributes` dictionary (ExtensionKit format introduced for
macOS 14+) and once via the legacy `NSExtension` dictionary. The duplication
is intentional:

- The thumbnail extension point
  (`/System/Library/ExtensionKit/ExtensionPoints/com.apple.quicklook.thumbnail.appexpt`)
  sets `EXSupportsNSExtensionPlistKeys = true`, which means the OS accepts
  either key shape under the same public point. Listing both lets newer
  PluginKit code paths read `EXAppExtensionAttributes` directly while older
  paths still parse `NSExtension`.
- The newer `.secure` thumbnail extension point exists
  (`com.apple.quicklook.thumbnail.secure`) but is marked
  `EXExtensionPointIsPublic = false` and is reserved for OS-bundled extensions
  in `/System/Library/ExtensionKit/Extensions/` (e.g. `TextThumbnailExtension`).
  Third-party apps cannot register against it.
- There is no `com.apple.quicklook.preview.appexpt` on Tahoe at all — the
  preview point only exists as a legacy `NSExtension` point. Every third-party
  preview extension currently shipping (Bear, Krita, LibreOffice, Microsoft
  Remote Desktop, Xcode's own `ProvisoningProfileQuicklookExtension`) declares
  itself with the legacy `NSExtension` dictionary, so we do too.

`LSItemContentTypes` is also set at the bundle root so `lsregister` picks the
supported UTIs up before the system opens the extension descriptor.

### Runtime activation requires real signing

`pluginkit -m` lists ad-hoc-signed extensions, and `qlmanage -t` will route
the right UTI to the right `.appex` once the host app is installed under
`/Applications/`, but quicklookd on macOS 14+ will **not** spawn an ad-hoc
extension into its sandboxed XPC pool. The extension surface needs a real
`TeamIdentifier` (Developer ID Application certificate) plus the hardened
runtime to satisfy quicklookd's launch checks. Every working third-party
Quick Look extension on disk (Bear, Krita, Blender, LibreOffice, …) carries
a non-empty `TeamIdentifier` in its `codesign -dv` output. End-to-end
verification of the rendered thumbnail / preview therefore has to wait for
a signed CI build; the format and the bundle layout above are correct on
their own.

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
