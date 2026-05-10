#!/usr/bin/env bash
# Build the Viewer Quick Look extension bundles (.appex) from Swift sources.
#
# Output: target/quicklook/{ViewerQuickLook.appex,ViewerThumbnail.appex}
#
# These are hand-built bundles rather than xcodebuild targets so the repo
# doesn't carry a parallel Xcode project with churn-prone pbxproj files. A
# Quick Look extension is just an .appex bundle with the right Info.plist
# and a Mach-O linked against QuickLookUI / QuickLookThumbnailing — no Xcode
# pipeline is required.
#
# Usage:
#   scripts/build-quicklook.sh                  # builds both appex bundles
#   scripts/build-quicklook.sh --install <APP>  # builds and copies into APP/Contents/PlugIns/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QL_DIR="$REPO_ROOT/src-tauri/macos/quicklook"
OUT_DIR="$REPO_ROOT/target/quicklook"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "build-quicklook.sh: macOS only — Quick Look extensions are an Apple platform feature." >&2
    exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
    echo "build-quicklook.sh: xcrun not found. Install the Xcode command-line tools." >&2
    exit 1
fi

SDK_PATH="$(xcrun --show-sdk-path --sdk macosx)"
DEPLOY_TARGET="12.0"
ARCHS=("arm64" "x86_64")

mkdir -p "$OUT_DIR"

build_appex() {
    local kind="$1"          # "preview" or "thumbnail"
    local exe_name="$2"      # "ViewerQuickLook" or "ViewerThumbnail"
    local module_name="$2"   # Swift module name == executable name
    local appex_name="$3"    # "ViewerQuickLook.appex" or "ViewerThumbnail.appex"
    local extra_frameworks=("${@:4}")

    local src_dir="$QL_DIR/$kind"
    local appex_dir="$OUT_DIR/$appex_name"
    local macos_dir="$appex_dir/Contents/MacOS"
    local resources_dir="$appex_dir/Contents/Resources"

    echo "==> Building $appex_name"
    rm -rf "$appex_dir"
    mkdir -p "$macos_dir" "$resources_dir"

    # Compile a thin/fat binary: build per-arch then lipo.
    local arch_binaries=()
    for arch in "${ARCHS[@]}"; do
        local out="$OUT_DIR/.build/${module_name}-${arch}"
        mkdir -p "$(dirname "$out")"

        # Build the swiftc invocation.
        local frameworks_args=()
        for fw in "${extra_frameworks[@]}"; do
            frameworks_args+=("-framework" "$fw")
        done

        xcrun --sdk macosx swiftc \
            -target "${arch}-apple-macos${DEPLOY_TARGET}" \
            -sdk "$SDK_PATH" \
            -module-name "$module_name" \
            -emit-executable \
            -O \
            "${frameworks_args[@]}" \
            -o "$out" \
            "$src_dir"/*.swift
        arch_binaries+=("$out")
    done

    xcrun lipo -create -output "$macos_dir/$exe_name" "${arch_binaries[@]}"
    chmod +x "$macos_dir/$exe_name"

    cp "$src_dir/Info.plist" "$appex_dir/Contents/Info.plist"

    # Substitute $(PRODUCT_MODULE_NAME) in the Info.plist for the principal class.
    /usr/bin/plutil -replace NSExtension.NSExtensionPrincipalClass \
        -string "${module_name}.$(plutil_principal_class "$kind")" \
        "$appex_dir/Contents/Info.plist"

    # Ad-hoc sign so Quick Look will load the extension without a developer ID.
    # Real distribution requires `codesign --sign "Developer ID Application: ..."`
    # — see README §Build & sign for the full flow.
    codesign --force --sign - --timestamp=none --options runtime \
        --entitlements "$QL_DIR/extension.entitlements" \
        "$appex_dir" 2>/dev/null || \
    codesign --force --sign - --timestamp=none "$appex_dir"

    echo "    -> $appex_dir"
}

plutil_principal_class() {
    case "$1" in
        preview)   echo "PreviewViewController" ;;
        thumbnail) echo "ThumbnailProvider" ;;
        *) echo "Principal" ;;
    esac
}

# Build both appex bundles. Frameworks list per kind:
#   preview:   QuickLookUI, WebKit, AppKit
#   thumbnail: QuickLookThumbnailing, AppKit
build_appex preview   "ViewerQuickLook" "ViewerQuickLook.appex"  QuickLookUI WebKit AppKit
build_appex thumbnail "ViewerThumbnail" "ViewerThumbnail.appex"  QuickLookThumbnailing AppKit

echo "==> Done."
echo "Bundles:"
echo "  $OUT_DIR/ViewerQuickLook.appex"
echo "  $OUT_DIR/ViewerThumbnail.appex"

# Optional install into a built Viewer.app:
#   scripts/build-quicklook.sh --install /Applications/Viewer.app
if [[ "${1:-}" == "--install" && -n "${2:-}" ]]; then
    APP="$2"
    if [[ ! -d "$APP" ]]; then
        echo "build-quicklook.sh: $APP does not exist." >&2
        exit 1
    fi
    PLUGINS="$APP/Contents/PlugIns"
    mkdir -p "$PLUGINS"
    rm -rf "$PLUGINS/ViewerQuickLook.appex" "$PLUGINS/ViewerThumbnail.appex"
    cp -R "$OUT_DIR/ViewerQuickLook.appex" "$PLUGINS/"
    cp -R "$OUT_DIR/ViewerThumbnail.appex" "$PLUGINS/"
    echo "==> Installed into $PLUGINS"
    echo "Re-sign the host app if you want a single chain of trust:"
    echo "  codesign --force --deep --sign - \"$APP\""
fi
