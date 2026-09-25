#!/usr/bin/env bash
# Local, ad-hoc signed native preview. Public releases use package_release.sh.
set -euo pipefail

MODE="${1:-run}"
case "$MODE" in
  run|--verify|--logs|--telemetry|--debug) ;;
  *) echo "Usage: $0 [--verify|--logs|--telemetry|--debug]" >&2; exit 2 ;;
esac
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREVIEW_ID="app.orion.desktop-preview"
APP_NAME="Orion Preview"
STAGE="$(mktemp -d /private/tmp/orion-desktop-preview.XXXXXX)"
OUTPUT_DIR="$ROOT_DIR/outputs/native-preview/$(basename "$STAGE")"
mkdir -p "$OUTPUT_DIR" "$ROOT_DIR/src-tauri/target"
echo "Building native preview in $STAGE"

# Ask only this preview to quit through its normal save handshake.
preview_running() {
  osascript -e 'application id "app.orion.desktop-preview" is running' 2>/dev/null || printf 'false\n'
}
if [[ "$(preview_running)" == true ]]; then
  osascript -e 'tell application id "app.orion.desktop-preview" to quit'
  for attempt in {1..30}; do
    [[ "$(preview_running)" == false ]] && break
    sleep 1
  done
  if [[ "$(preview_running)" == true ]]; then
    echo "Preview is still saving or needs attention. Resolve its dialog, then retry." >&2
    exit 1
  fi
fi

# Keep all source and renderer files in the same physical staging root; only
# Cargo's compiled dependency cache is shared with the working copy.
for dir in src public script mcp codex; do
  rsync -a "$ROOT_DIR/$dir/" "$STAGE/$dir/"
done
rsync -a --exclude target --exclude 'target-*' "$ROOT_DIR/src-tauri/" "$STAGE/src-tauri/"
for file in package.json package-lock.json index.html tsconfig.json tsconfig.node.json vite.config.ts; do
  cp "$ROOT_DIR/$file" "$STAGE/$file"
done
ln -s "$ROOT_DIR/src-tauri/target" "$STAGE/src-tauri/target"

python3 - "$STAGE" "$PREVIEW_ID" "$APP_NAME" <<'PY'
import json, pathlib, sys
root, identifier, name = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
path = root / 'src-tauri/tauri.conf.json'
config = json.loads(path.read_text())
config['identifier'] = identifier
config['productName'] = name
config['build']['beforeBuildCommand'] = ''
config['bundle']['targets'] = ['app']
config['bundle']['macOS']['signingIdentity'] = '-'
config['plugins']['deep-link']['desktop']['schemes'] = ['orion-desktop-preview']
path.write_text(json.dumps(config, indent=2) + '\n')
# The production service is deliberately constant. Isolate only the staged
# preview's credentials; never edit the release source or copy user secrets.
lib = root / 'src-tauri/src/lib.rs'
source = lib.read_text()
old = 'const KEYCHAIN_SERVICE: &str = "app.orion.knowledge";'
assert source.count(old) == 1, 'Review preview Keychain isolation after native changes'
lib.write_text(source.replace(old, f'const KEYCHAIN_SERVICE: &str = "{identifier}";'))
PY

(
  cd "$STAGE"
  export ORION_CODESIGN_IDENTITY=-
  export ORION_WHISPER_MODEL=small
  export VITE_ORION_WHISPER_MODEL=small
  export CARGO_PROFILE_RELEASE_STRIP=false
  npm ci --ignore-scripts
  npm run build:desktop
  npm run tauri build -- --bundles app
)
BUILT_APP="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
APP_BUNDLE="$HOME/Applications/Orion Previews/$(basename "$STAGE")/$APP_NAME.app"
mkdir -p "$(dirname "$APP_BUNDLE")"
ditto --norsrc --noextattr "$BUILT_APP" "$APP_BUNDLE"
# Documents/File Provider can attach Finder metadata to framework directories.
# Keep the runnable copy outside that indexed tree and remove only this metadata.
/usr/bin/xattr -dr com.apple.FinderInfo "$APP_BUNDLE" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.ResourceFork "$APP_BUNDLE" 2>/dev/null || true
codesign --verify --deep --strict "$APP_BUNDLE"
ln -s "$APP_BUNDLE" "$OUTPUT_DIR/$APP_NAME.app"
printf '%s\n' "$APP_BUNDLE" > "$ROOT_DIR/outputs/native-preview/latest-app.txt"
printf '%s\n' "$STAGE" > "$OUTPUT_DIR/build-source.txt"
echo "Native preview: $APP_BUNDLE"

if [[ "$MODE" == --debug ]]; then
  exec lldb -- "$APP_BUNDLE/Contents/MacOS/orion"
fi
open -n "$APP_BUNDLE"
case "$MODE" in
  --verify)
    sleep 3
    ps -axo command= | grep -F -x "$APP_BUNDLE/Contents/MacOS/orion"
    ;;
  --logs|--telemetry)
    exec /usr/bin/log stream --info --style compact --predicate 'process == "orion"'
    ;;
esac
