#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/outputs"
APP_VERSION="$(
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" |
    head -n 1
)"
RELEASE_LABEL="${1:-$APP_VERSION}"
BUILD_MODE="${2:-build}"
SOURCE_DMG="$ROOT_DIR/src-tauri/target/release/bundle/dmg/Orion_${APP_VERSION}_aarch64.dmg"
FINAL_DMG="$OUTPUT_DIR/Orion-$RELEASE_LABEL-Apple-Silicon.dmg"

if [[ -z "$APP_VERSION" ]]; then
  echo "could not read Orion version from package.json" >&2
  exit 1
fi

case "$BUILD_MODE" in
  build)
    "$ROOT_DIR/script/build_transcription_sidecar.sh"
    (
      cd "$ROOT_DIR"
      npm run tauri build
    )
    ;;
  --use-existing)
    ;;
  *)
    echo "usage: $0 [release-label] [build|--use-existing]" >&2
    exit 2
    ;;
esac

if [[ ! -f "$SOURCE_DMG" ]]; then
  echo "missing release DMG: $SOURCE_DMG" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
STAGING_DIR="$(mktemp -d "$OUTPUT_DIR/.orion-package.XXXXXX")"
STAGED_DMG="$STAGING_DIR/$(basename "$FINAL_DMG")"

# Always stage to a new inode. Copying directly over a mounted DMG can mutate
# its live backing store and make Finder fail partway through copying the app.
ditto "$SOURCE_DMG" "$STAGED_DMG"
hdiutil verify "$STAGED_DMG"
mv "$STAGED_DMG" "$FINAL_DMG"
rmdir "$STAGING_DIR"

shasum -a 256 "$FINAL_DMG"
echo "$FINAL_DMG"
