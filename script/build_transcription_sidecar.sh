#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
SOURCE="$TAURI_DIR/native/OrionWhisper/main.swift"
FRAMEWORKS="$TAURI_DIR/vendor"
OUTPUT="$TAURI_DIR/binaries/orion-whisper-aarch64-apple-darwin"
WHISPER_MODEL_EDITION="${ORION_WHISPER_MODEL:-small}"
case "$WHISPER_MODEL_EDITION" in
  small)
    MODEL="$TAURI_DIR/resources/models/ggml-small.bin"
    EXPECTED_MODEL_BYTES=487601967
    EXPECTED_MODEL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
    ;;
  medium)
    MODEL="$TAURI_DIR/resources/models/ggml-medium.bin"
    EXPECTED_MODEL_BYTES=1533763059
    EXPECTED_MODEL_SHA256="6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"
    ;;
  *)
    echo "ORION_WHISPER_MODEL must be 'small' or 'medium'" >&2
    exit 2
    ;;
esac
YT_DLP="$TAURI_DIR/binaries/yt-dlp-macos"
DENO="$TAURI_DIR/binaries/deno"
MODULE_CACHE="${ORION_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/orion-swift-module-cache}"

for required in "$SOURCE" "$FRAMEWORKS/whisper.framework" "$MODEL" "$YT_DLP" "$DENO"; do
  if [[ ! -e "$required" ]]; then
    echo "missing bundled transcription resource: $required" >&2
    exit 1
  fi
done

actual_model_bytes="$(wc -c <"$MODEL" | tr -d '[:space:]')"
actual_model_sha256="$(shasum -a 256 "$MODEL" | awk '{ print $1 }')"
if [[ "$actual_model_bytes" != "$EXPECTED_MODEL_BYTES" ]] ||
  [[ "$actual_model_sha256" != "$EXPECTED_MODEL_SHA256" ]]; then
  echo "bundled Whisper $WHISPER_MODEL_EDITION model failed size or SHA-256 verification" >&2
  exit 1
fi
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
