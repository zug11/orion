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
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/Orion.app"
FINAL_DMG="$OUTPUT_DIR/Orion-$RELEASE_LABEL-Apple-Silicon.dmg"
FIXTURE_VAULT="$ROOT_DIR/src-tauri/tests/fixtures/mcp-vault.json"
CONNECTOR_RELATIVE_PATH="Contents/Resources/Orion-Claude-Connector.mcpb"
SOURCE_STAMP_RELATIVE_PATH="Contents/Resources/orion-source.sha256"
RENDERER_STAMP_RELATIVE_PATH="Contents/Resources/orion-renderer.sha256"
HELPER_ENTITLEMENTS="$ROOT_DIR/src-tauri/entitlements/helper-runtime.plist"
NOTARY_PROFILE="${ORION_NOTARY_PROFILE:-}"
CODE_SIGN_IDENTITY="${ORION_CODESIGN_IDENTITY:-}"

if [[ -z "$APP_VERSION" ]]; then
  echo "could not read Orion version from package.json" >&2
  exit 1
fi

if [[ -z "$CODE_SIGN_IDENTITY" ]]; then
  identity_lines="$(
    security find-identity -v -p codesigning 2>/dev/null |
      sed -n '/"Developer ID Application:/p'
  )"
  identity_count="$(printf '%s\n' "$identity_lines" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$identity_count" != "1" ]]; then
    echo "Set ORION_CODESIGN_IDENTITY to one installed Developer ID Application identity." >&2
    echo "Found $identity_count usable Developer ID Application identities." >&2
    exit 1
  fi
  CODE_SIGN_IDENTITY="$(
    printf '%s\n' "$identity_lines" |
      sed -E 's/^[[:space:]]*[0-9]+\) ([0-9A-F]+) .*/\1/'
  )"
fi

if [[ ! -f "$HELPER_ENTITLEMENTS" ]]; then
  echo "missing helper entitlements: $HELPER_ENTITLEMENTS" >&2
  exit 1
fi

export ORION_CODESIGN_IDENTITY="$CODE_SIGN_IDENTITY"
# Rust 1.96 on current macOS can emit release-stripped proc-macro dylibs that
# rustc then cannot reload (E0463). Defer symbol trimming until after linking;
# this keeps the release build deterministic without weakening app signing.
export CARGO_PROFILE_RELEASE_STRIP=false

if [[ ! "$RELEASE_LABEL" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,79}$ ]] ||
  [[ "$RELEASE_LABEL" == *".."* ]]; then
  echo "release label must be filename-safe and may not contain '..': $RELEASE_LABEL" >&2
  exit 2
fi

verify_connector_package() (
  set -euo pipefail

  local package_path verification_dir connector_binary
  package_path="${1:?missing Claude connector package}"
  if [[ ! -f "$package_path" ]]; then
    echo "missing bundled Claude connector: $package_path" >&2
    exit 1
  fi
  verification_dir="$(mktemp -d /private/tmp/orion-connector-verify.XXXXXX)"
  connector_binary="$verification_dir/server/orion-mcp"

  cleanup_connector() {
    if [[ "$verification_dir" == /private/tmp/orion-connector-verify.* ]]; then
      rm -rf -- "$verification_dir"
    fi
  }
  trap cleanup_connector EXIT

  /usr/bin/unzip -tq "$package_path"
  /usr/bin/unzip -q "$package_path" -d "$verification_dir"
  codesign --verify --strict --verbose=2 "$connector_binary"
  "$connector_binary" --version
  node "$ROOT_DIR/script/test_mcp_connector.mjs" \
    "$connector_binary" "$FIXTURE_VAULT" "$verification_dir/manifest.json"
)

source_fingerprint() (
  set -euo pipefail
  cd "$ROOT_DIR"

  {
    find src src-tauri/src src-tauri/native src-tauri/mcp-server/src \
      mcp/orion-claude -type f ! -name '.DS_Store'
    printf '%s\n' \
      AGENTS.md \
      index.html \
      package.json \
      package-lock.json \
      tsconfig.json \
      tsconfig.node.json \
      vite.config.ts \
      src-tauri/Cargo.toml \
      src-tauri/Cargo.lock \
      src-tauri/mcp-server/Cargo.toml \
      src-tauri/mcp-server/Cargo.lock \
      src-tauri/tauri.conf.json \
      script/build_mcp_connector.sh \
      script/build_ocr_sidecar.sh \
      script/build_transcription_sidecar.sh \
      script/package_release.sh \
      script/test_mcp_connector.mjs
  } |
    LC_ALL=C sort -u |
    while IFS= read -r source_path; do
      shasum -a 256 "$source_path"
    done |
    shasum -a 256 |
    awk '{ print $1 }'
)

renderer_fingerprint() (
  set -euo pipefail
  cd "$ROOT_DIR"

  if [[ ! -f dist/index.html ]]; then
    echo "missing production renderer: $ROOT_DIR/dist/index.html" >&2
    echo "Run npm run build before reusing an existing app bundle." >&2
    exit 1
  fi

  find dist -type f ! -name '.DS_Store' |
    LC_ALL=C sort -u |
    while IFS= read -r renderer_path; do
      shasum -a 256 "$renderer_path"
    done |
    shasum -a 256 |
    awk '{ print $1 }'
)

canonical_target_path() (
  set -euo pipefail

  local target_path parent_path base_name
  target_path="${1:?missing path to canonicalize}"
  parent_path="$(dirname "$target_path")"
  base_name="$(basename "$target_path")"
  printf '%s/%s\n' "$(cd "$parent_path" && pwd -P)" "$base_name"
)

verify_release_layout() {
  local frontend_relative tauri_root configured_frontend expected_frontend
  frontend_relative="$(
    node -e '
      const config = require(process.argv[1]);
      if (typeof config.build?.frontendDist !== "string") process.exit(1);
      process.stdout.write(config.build.frontendDist);
    ' "$ROOT_DIR/src-tauri/tauri.conf.json"
  )"
  tauri_root="$(cd "$ROOT_DIR/src-tauri" && pwd -P)"
  configured_frontend="$(
    canonical_target_path "$tauri_root/$frontend_relative"
  )"
  expected_frontend="$(canonical_target_path "$ROOT_DIR/dist")"

  if [[ "$configured_frontend" != "$expected_frontend" ]]; then
    echo "Tauri frontendDist resolves outside this release root." >&2
    echo "Configured renderer: $configured_frontend" >&2
    echo "Expected renderer:   $expected_frontend" >&2
    echo "Refusing to embed a stale renderer through a symlinked src-tauri directory." >&2
    exit 1
  fi
}

build_renderer_in_staging() (
  set -euo pipefail

  local build_dir stage_dir previous_dist
  build_dir="$(mktemp -d /private/tmp/orion-renderer-build.XXXXXX)"
  stage_dir="$(mktemp -d "$ROOT_DIR/.orion-renderer-stage.XXXXXX")"
  previous_dist="$stage_dir/previous-dist"

  cleanup_renderer_build() {
    if [[ "$build_dir" == /private/tmp/orion-renderer-build.* ]]; then
      rm -rf -- "$build_dir"
    fi
    if [[ "$stage_dir" == "$ROOT_DIR"/.orion-renderer-stage.* ]]; then
      rm -rf -- "$stage_dir"
    fi
  }
  trap cleanup_renderer_build EXIT

  cp -RX "$ROOT_DIR/src" "$build_dir/src"
  cp -RX "$ROOT_DIR/public" "$build_dir/public"
  cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" \
    "$ROOT_DIR/tsconfig.json" "$ROOT_DIR/tsconfig.node.json" \
    "$ROOT_DIR/vite.config.ts" "$ROOT_DIR/index.html" "$build_dir/"

  (
    cd "$build_dir"
    npm ci --ignore-scripts
    npm run build
  )

  cp -RX "$build_dir/dist" "$stage_dir/dist"
  if [[ -d "$ROOT_DIR/dist" ]]; then
    mv "$ROOT_DIR/dist" "$previous_dist"
  fi
  if ! mv "$stage_dir/dist" "$ROOT_DIR/dist"; then
    if [[ -d "$previous_dist" ]]; then
      mv "$previous_dist" "$ROOT_DIR/dist"
    fi
    exit 1
  fi
)

stamp_app_source() {
  if [[ ! -d "$APP_BUNDLE" ]]; then
    echo "missing release app bundle: $APP_BUNDLE" >&2
    exit 1
  fi
  source_fingerprint >"$APP_BUNDLE/$SOURCE_STAMP_RELATIVE_PATH"
  renderer_fingerprint >"$APP_BUNDLE/$RENDERER_STAMP_RELATIVE_PATH"
}

verify_app_source_stamp() {
  local stamp_path renderer_stamp_path expected actual expected_renderer actual_renderer
  stamp_path="$APP_BUNDLE/$SOURCE_STAMP_RELATIVE_PATH"
  renderer_stamp_path="$APP_BUNDLE/$RENDERER_STAMP_RELATIVE_PATH"
  if [[ ! -f "$stamp_path" ]] || [[ ! -f "$renderer_stamp_path" ]]; then
    echo "existing Orion.app has incomplete release provenance; refusing to package a potentially stale bundle" >&2
    echo "Run this script in build mode to create a fresh release app." >&2
    exit 1
  fi
  expected="$(source_fingerprint)"
  actual="$(tr -d '[:space:]' <"$stamp_path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "existing Orion.app does not match the current source; refusing stale --use-existing packaging" >&2
    echo "Run this script in build mode before signing or notarizing this revision." >&2
    exit 1
  fi
  expected_renderer="$(renderer_fingerprint)"
  actual_renderer="$(tr -d '[:space:]' <"$renderer_stamp_path")"
  if [[ "$actual_renderer" != "$expected_renderer" ]]; then
    echo "existing Orion.app does not match the current production renderer; refusing stale --use-existing packaging" >&2
    echo "Run this script in build mode before signing or notarizing this revision." >&2
    exit 1
  fi
}

sign_app_bundle() {
  if [[ ! -d "$APP_BUNDLE" ]]; then
    echo "missing release app bundle: $APP_BUNDLE" >&2
    exit 1
  fi
  verify_connector_package "$APP_BUNDLE/$CONNECTOR_RELATIVE_PATH"

  # Sign every nested executable before sealing the main binary and app. All
  # executable code uses Developer ID, a secure timestamp, and Hardened Runtime
  # for notarization. yt-dlp retains only the narrow library-validation
  # exception required by its PyInstaller runtime.
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    "$APP_BUNDLE/Contents/Frameworks/whisper.framework"
  for executable in \
    "$APP_BUNDLE/Contents/MacOS/orion-whisper" \
    "$APP_BUNDLE/Contents/MacOS/orion-ocr" \
    "$APP_BUNDLE/Contents/MacOS/deno"; do
    codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
      "$executable"
  done
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    --entitlements "$HELPER_ENTITLEMENTS" \
    "$APP_BUNDLE/Contents/MacOS/yt-dlp"
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    "$APP_BUNDLE/Contents/MacOS/orion"
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=4 "$APP_BUNDLE"
}

prepare_existing_connector() {
  (
    cd "$ROOT_DIR"
    npm run build:mcp
  )
  ditto "$ROOT_DIR/src-tauri/resources/Orion-Claude-Connector.mcpb" \
    "$APP_BUNDLE/$CONNECTOR_RELATIVE_PATH"
}

repack_signed_app() (
  set -euo pipefail

  local staging_dir mount_dir rw_dmg rebuilt_dmg attach_output device
  staging_dir="$(mktemp -d "$OUTPUT_DIR/.orion-resign.XXXXXX")"
  mount_dir="$staging_dir/mount"
  rw_dmg="$staging_dir/Orion-read-write.dmg"
  rebuilt_dmg="$staging_dir/$(basename "$SOURCE_DMG")"
  device=""
  mkdir "$mount_dir"

  cleanup_repack() {
    if [[ -n "$device" ]]; then
      hdiutil detach "$device" >/dev/null 2>&1 ||
        hdiutil detach -force "$device" >/dev/null 2>&1 ||
        true
    fi
    rm -f "$rw_dmg" "$rebuilt_dmg"
    rmdir "$mount_dir" "$staging_dir" >/dev/null 2>&1 || true
  }
  trap cleanup_repack EXIT

  # Preserve Tauri's Finder layout and Applications link while replacing only
  # the app payload with the completely signed bundle.
  hdiutil convert "$SOURCE_DMG" -format UDRW -o "$rw_dmg"
  attach_output="$(
    hdiutil attach -readwrite -nobrowse -noautoopen \
      -mountpoint "$mount_dir" "$rw_dmg"
  )"
  device="$(
    printf '%s\n' "$attach_output" |
      awk '/^\/dev\// { print $1; exit }'
  )"
  if [[ -z "$device" ]]; then
    echo "could not identify the temporary DMG device" >&2
    exit 1
  fi

  rm -rf "$mount_dir/Orion.app"
  ditto "$APP_BUNDLE" "$mount_dir/Orion.app"
  hdiutil detach "$device"
  device=""
  hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 \
    -o "$rebuilt_dmg"
  hdiutil verify "$rebuilt_dmg"

  # `rebuilt_dmg` is a new inode; replacing the Tauri artifact by rename avoids
  # mutating any mounted backing file.
  mv "$rebuilt_dmg" "$SOURCE_DMG"
  rebuilt_dmg=""
)

stage_final_dmg() (
  set -euo pipefail

  local staging_dir staged_dmg
  staging_dir="$(mktemp -d "$OUTPUT_DIR/.orion-package.XXXXXX")"
  staged_dmg="$staging_dir/$(basename "$FINAL_DMG")"

  cleanup_staging() {
    rm -f -- "$staged_dmg"
    rmdir "$staging_dir" >/dev/null 2>&1 || true
  }
  trap cleanup_staging EXIT

  # Always stage to a new inode. Copying directly over a mounted DMG can mutate
  # its live backing store and make Finder fail partway through copying the app.
  ditto "$SOURCE_DMG" "$staged_dmg"
  hdiutil verify "$staged_dmg"
  verify_final_dmg "$staged_dmg"
  mv "$staged_dmg" "$FINAL_DMG"
  staged_dmg=""
)

sign_and_optionally_notarize_dmg() {
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp "$FINAL_DMG"
  codesign --verify --strict --verbose=2 "$FINAL_DMG"

  if [[ -z "$NOTARY_PROFILE" ]]; then
    echo "Signed release created but not submitted for notarization." >&2
    echo "Set ORION_NOTARY_PROFILE to a notarytool Keychain profile and rerun with --use-existing." >&2
    return
  fi

  local result_file status submission_id
  result_file="$(mktemp /private/tmp/orion-notary-result.XXXXXX)"
  cleanup_notary_result() {
    rm -f -- "$result_file"
  }
  trap cleanup_notary_result RETURN

  xcrun notarytool submit "$FINAL_DMG" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait --output-format json >"$result_file"
  status="$(plutil -extract status raw -o - "$result_file")"
  if [[ "$status" != "Accepted" ]]; then
    submission_id="$(plutil -extract id raw -o - "$result_file")"
    cat "$result_file" >&2
    xcrun notarytool log "$submission_id" \
      --keychain-profile "$NOTARY_PROFILE" >&2 || true
    echo "Apple did not accept the notarization submission." >&2
    exit 1
  fi

  xcrun stapler staple "$FINAL_DMG"
  xcrun stapler validate "$FINAL_DMG"
  spctl -a -t open --context context:primary-signature -vv "$FINAL_DMG"
}

verify_final_dmg() (
  set -euo pipefail

  local dmg_path verification_dir mount_dir copy_dir copied_app attach_output device
  dmg_path="${1:?missing DMG path to verify}"
  verification_dir="$(mktemp -d /private/tmp/orion-release-verify.XXXXXX)"
  mount_dir="$verification_dir/mount"
  copy_dir="$verification_dir/copied"
  copied_app="$copy_dir/Orion.app"
  device=""
  mkdir "$mount_dir" "$copy_dir"

  cleanup_verification() {
    if [[ -n "$device" ]]; then
      hdiutil detach "$device" >/dev/null 2>&1 ||
        hdiutil detach -force "$device" >/dev/null 2>&1 ||
        true
    fi
    if [[ "$verification_dir" == /private/tmp/orion-release-verify.* ]] &&
      [[ -d "$verification_dir" ]]; then
      rm -rf -- "$verification_dir"
    fi
  }
  trap cleanup_verification EXIT

  attach_output="$(
    hdiutil attach -readonly -nobrowse -noautoopen \
      -mountpoint "$mount_dir" "$dmg_path"
  )"
  device="$(
    printf '%s\n' "$attach_output" |
      awk '/^\/dev\// { print $1; exit }'
  )"
  if [[ -z "$device" ]]; then
    echo "could not identify the final DMG device" >&2
    exit 1
  fi
  if [[ ! -d "$mount_dir/Orion.app" ]] ||
    [[ ! -L "$mount_dir/Applications" ]]; then
    echo "final DMG is missing Orion.app or its Applications link" >&2
    exit 1
  fi
  if [[ "$(readlink "$mount_dir/Applications")" != "/Applications" ]]; then
    echo "final DMG Applications link has the wrong target" >&2
    exit 1
  fi

  # Copying out of the exact finished image catches filesystem corruption that
  # an in-place signature check misses (including the former Finder error -36).
  ditto "$mount_dir/Orion.app" "$copied_app"
  hdiutil detach "$device"
  device=""

  codesign --verify --deep --strict --verbose=4 "$copied_app"
  if [[ "$(tr -d '[:space:]' <"$copied_app/$SOURCE_STAMP_RELATIVE_PATH")" != "$(source_fingerprint)" ]] ||
    [[ "$(tr -d '[:space:]' <"$copied_app/$RENDERER_STAMP_RELATIVE_PATH")" != "$(renderer_fingerprint)" ]]; then
    echo "final DMG provenance does not match its source and renderer" >&2
    exit 1
  fi
  "$copied_app/Contents/MacOS/orion-whisper" --version
  "$copied_app/Contents/MacOS/orion-ocr" --version
  "$copied_app/Contents/MacOS/yt-dlp" --version
  "$copied_app/Contents/MacOS/deno" --version
  verify_connector_package "$copied_app/$CONNECTOR_RELATIVE_PATH"
)

case "$BUILD_MODE" in
  build)
    verify_release_layout
    "$ROOT_DIR/script/build_transcription_sidecar.sh"
    "$ROOT_DIR/script/build_ocr_sidecar.sh"
    build_renderer_in_staging
    (
      cd "$ROOT_DIR"
      # Build the renderer and connector exactly once in the verified release
      # root. The renderer is staged above from the exact lockfile because
      # recursive Rollup reads can deadlock on indexed macOS Documents volumes.
      # Nesting Vite under Tauri's beforeBuildCommand can also obscure which
      # dist/ tree is about to be embedded.
      npm run build:mcp
      npm run tauri -- build \
        --config '{"build":{"beforeBuildCommand":""}}'
    )
    stamp_app_source
    ;;
  --use-existing)
    verify_release_layout
    verify_app_source_stamp
    prepare_existing_connector
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
sign_app_bundle
repack_signed_app
stage_final_dmg
sign_and_optionally_notarize_dmg
shasum -a 256 "$FINAL_DMG"
echo "$FINAL_DMG"
