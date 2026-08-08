#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_DIR="$ROOT_DIR/mcp/orion-claude"
MCP_CRATE="$ROOT_DIR/src-tauri/mcp-server/Cargo.toml"
OUTPUT_DIR="$ROOT_DIR/outputs"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources"
FIXTURE_VAULT="$ROOT_DIR/src-tauri/tests/fixtures/mcp-vault.json"
APP_VERSION="$(
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" |
    head -n 1
)"
MANIFEST_VERSION="$(
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$MANIFEST_DIR/manifest.json" |
    head -n 1
)"
MCP_VERSION="$(
  sed -n 's/^version = "\([^"]*\)"/\1/p' "$MCP_CRATE" |
    head -n 1
)"
RELEASE_BINARY="$ROOT_DIR/src-tauri/target/release/orion-mcp"
OUTPUT_PACKAGE="$OUTPUT_DIR/Orion-Claude-Connector-$APP_VERSION-Apple-Silicon.mcpb"
RESOURCE_PACKAGE="$RESOURCE_DIR/Orion-Claude-Connector.mcpb"
CODE_SIGN_IDENTITY="${ORION_CODESIGN_IDENTITY:--}"

if [[ -z "$APP_VERSION" ]] ||
  [[ "$APP_VERSION" != "$MANIFEST_VERSION" ]] ||
  [[ "$APP_VERSION" != "$MCP_VERSION" ]]; then
  echo "Orion, MCP crate, and MCP manifest versions must match." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "The bundled Claude connector currently targets Apple Silicon." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$RESOURCE_DIR"

(
  cd "$ROOT_DIR"
  cargo test --locked --manifest-path "$MCP_CRATE" \
    --target-dir "$ROOT_DIR/src-tauri/target"
  cargo build --locked --release --manifest-path "$MCP_CRATE" \
    --target-dir "$ROOT_DIR/src-tauri/target"
)

if [[ ! -x "$RELEASE_BINARY" ]] ||
  ! file "$RELEASE_BINARY" | grep -q "Mach-O 64-bit executable arm64"; then
  echo "orion-mcp is missing or is not an Apple Silicon executable." >&2
  exit 1
fi
if [[ "$CODE_SIGN_IDENTITY" == "-" ]]; then
  codesign --force --sign - "$RELEASE_BINARY"
else
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    "$RELEASE_BINARY"
fi
codesign --verify --strict --verbose=2 "$RELEASE_BINARY"
"$RELEASE_BINARY" --version
node "$ROOT_DIR/script/test_mcp_connector.mjs" \
  "$RELEASE_BINARY" "$FIXTURE_VAULT" "$MANIFEST_DIR/manifest.json"

(
  set -euo pipefail
  temporary_dir="$(mktemp -d /private/tmp/orion-mcp-package.XXXXXX)"
  staging_dir="$temporary_dir/staging"
  verification_dir="$temporary_dir/verification"
  staged_package="$staging_dir/$(basename "$OUTPUT_PACKAGE")"
  staged_resource="$temporary_dir/$(basename "$RESOURCE_PACKAGE")"

  cleanup() {
    if [[ "$temporary_dir" == /private/tmp/orion-mcp-package.* ]]; then
      rm -rf -- "$temporary_dir"
    fi
  }
  trap cleanup EXIT

  mkdir -p "$staging_dir/server" "$verification_dir"
  /bin/cp "$MANIFEST_DIR/manifest.json" "$staging_dir/manifest.json"
  /bin/cp "$MANIFEST_DIR/README.md" "$staging_dir/README.md"
  /bin/cp "$ROOT_DIR/src-tauri/icons/icon.png" "$staging_dir/icon.png"
  /bin/cp "$RELEASE_BINARY" "$staging_dir/server/orion-mcp"

  (
    cd "$staging_dir"
    /usr/bin/zip -q -X -r "$staged_package" \
      manifest.json README.md icon.png server
  )
  /usr/bin/unzip -tq "$staged_package"
  /usr/bin/unzip -q "$staged_package" -d "$verification_dir"
  codesign --verify --strict --verbose=2 \
    "$verification_dir/server/orion-mcp"
  "$verification_dir/server/orion-mcp" --version
  node "$ROOT_DIR/script/test_mcp_connector.mjs" \
    "$verification_dir/server/orion-mcp" "$FIXTURE_VAULT" \
    "$verification_dir/manifest.json"

  /bin/cp "$staged_package" "$staged_resource"
  mv "$staged_resource" "$RESOURCE_PACKAGE"
  mv "$staged_package" "$OUTPUT_PACKAGE"
)

shasum -a 256 "$RESOURCE_PACKAGE" "$OUTPUT_PACKAGE"
echo "$OUTPUT_PACKAGE"
