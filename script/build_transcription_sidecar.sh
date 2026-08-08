#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
SOURCE="$TAURI_DIR/native/OrionWhisper/main.swift"
FRAMEWORKS="$TAURI_DIR/vendor"
OUTPUT="$TAURI_DIR/binaries/orion-whisper-aarch64-apple-darwin"
MODEL="$TAURI_DIR/resources/models/ggml-base.bin"
YT_DLP="$TAURI_DIR/binaries/yt-dlp-macos"
DENO="$TAURI_DIR/binaries/deno"
MODULE_CACHE="${ORION_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/orion-swift-module-cache}"

for required in "$SOURCE" "$FRAMEWORKS/whisper.framework" "$MODEL" "$YT_DLP" "$DENO"; do
  if [[ ! -e "$required" ]]; then
    echo "missing bundled transcription resource: $required" >&2
    exit 1
  fi
done
mkdir -p "$MODULE_CACHE"

xcrun swiftc "$SOURCE" \
  -O \
  -target arm64-apple-macos13.3 \
  -module-cache-path "$MODULE_CACHE" \
  -F "$FRAMEWORKS" \
  -framework whisper \
  -framework AVFoundation \
  -framework Foundation \
  -Xlinker -rpath \
  -Xlinker @executable_path/../Frameworks \
  -o "$OUTPUT"
chmod +x "$OUTPUT" "$YT_DLP" "$DENO"

DYLD_FRAMEWORK_PATH="$FRAMEWORKS" "$OUTPUT" --version
