#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
SOURCE="$TAURI_DIR/native/OrionOCR/main.swift"
OUTPUT="$TAURI_DIR/binaries/orion-ocr-aarch64-apple-darwin"
MODULE_CACHE="${ORION_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/orion-swift-module-cache}"

if [[ ! -f "$SOURCE" ]]; then
  echo "missing bundled OCR source: $SOURCE" >&2
  exit 1
fi
mkdir -p "$MODULE_CACHE"

xcrun swiftc "$SOURCE" \
  -O \
  -target arm64-apple-macos13.3 \
  -module-cache-path "$MODULE_CACHE" \
  -framework AppKit \
  -framework Foundation \
  -framework ImageIO \
  -framework PDFKit \
  -framework Vision \
  -o "$OUTPUT"
chmod +x "$OUTPUT"

"$OUTPUT" --version
