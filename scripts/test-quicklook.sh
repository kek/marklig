#!/usr/bin/env bash
# Compile and run the Quick Look renderer smoke test.
#
# This is a hosted Swift binary that pulls in MarkdownRenderer.swift and
# Stylesheet.swift, runs a handful of fixtures, and exits non-zero on failure.
# It intentionally does not bring in WebKit or Quick Look frameworks — the
# renderer is decoupled from the AppKit hosting layer for exactly this reason.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QL_DIR="$REPO_ROOT/src-tauri/macos/quicklook"
OUT_DIR="$REPO_ROOT/target/quicklook/.test"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "test-quicklook.sh: macOS only — skipping."
    exit 0
fi

mkdir -p "$OUT_DIR"
BIN="$OUT_DIR/renderer-smoke-test"

xcrun --sdk macosx swiftc \
    -O \
    -o "$BIN" \
    "$QL_DIR/preview/MarkdownRenderer.swift" \
    "$QL_DIR/preview/Stylesheet.swift" \
    "$QL_DIR/tests/main.swift"

"$BIN"
