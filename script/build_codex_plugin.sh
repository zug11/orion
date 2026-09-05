#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SOURCE="$ROOT_DIR/codex/orion"
MCP_MANIFEST="$ROOT_DIR/src-tauri/mcp-server/Cargo.toml"
MCP_BINARY="$ROOT_DIR/src-tauri/target/release/orion-mcp"
FIXTURE_VAULT="$ROOT_DIR/src-tauri/tests/fixtures/mcp-vault.json"
RESOURCE_PARENT="$ROOT_DIR/src-tauri/resources"
RESOURCE_ROOT="$RESOURCE_PARENT/Orion-Codex-Plugin"
OUTPUT_DIR="$ROOT_DIR/outputs"
CODEX_SKILLS_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/.system"
PLUGIN_VALIDATOR="$CODEX_SKILLS_ROOT/plugin-creator/scripts/validate_plugin.py"
SKILL_VALIDATOR="$CODEX_SKILLS_ROOT/skill-creator/scripts/quick_validate.py"
CODE_SIGN_IDENTITY="${ORION_CODESIGN_IDENTITY:--}"
USE_EXISTING=false

usage() {
  cat <<'EOF'
Usage: script/build_codex_plugin.sh [--use-existing]

Build and test Orion's MCP server by default. Pass --use-existing to package
the existing src-tauri/target/release/orion-mcp release binary.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --use-existing)
      USE_EXISTING=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

APP_VERSION="$(
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" |
    head -n 1
)"
PLUGIN_VERSION="$(
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' \
    "$PLUGIN_SOURCE/.codex-plugin/plugin.json" |
    head -n 1
)"
MCP_VERSION="$(
  sed -n 's/^version = "\([^"]*\)"/\1/p' "$MCP_MANIFEST" |
    head -n 1
)"

if [[ -z "$APP_VERSION" ]] ||
  [[ "$APP_VERSION" != "$PLUGIN_VERSION" ]] ||
  [[ "$APP_VERSION" != "$MCP_VERSION" ]]; then
  echo "Orion app, Codex plugin, and MCP crate versions must match." >&2
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
  echo "The bundled Orion Codex plugin currently targets Apple Silicon macOS." >&2
  exit 1
fi
for required_path in \
  "$PLUGIN_SOURCE/.codex-plugin/plugin.json" \
  "$PLUGIN_SOURCE/.mcp.json" \
  "$PLUGIN_SOURCE/skills/orion/SKILL.md" \
  "$PLUGIN_SOURCE/skills/orion/agents/openai.yaml" \
  "$PLUGIN_SOURCE/assets/icon.png" \
  "$PLUGIN_SOURCE/assets/orion-mark.svg" \
  "$FIXTURE_VAULT"; do
  if [[ ! -f "$required_path" ]]; then
    echo "Required Codex plugin file is missing: $required_path" >&2
    exit 1
  fi
done

run_official_validators() {
  local plugin_path="$1"
  if [[ ! -f "$PLUGIN_VALIDATOR" ]] || [[ ! -f "$SKILL_VALIDATOR" ]]; then
    echo "Codex scaffold validators are unavailable; using the bundled contract test."
    return
  fi
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 "$PLUGIN_VALIDATOR" "$plugin_path"
    python3 "$SKILL_VALIDATOR" "$plugin_path/skills/orion"
    return
  fi
  if command -v uv >/dev/null 2>&1; then
    uv run --no-project --with pyyaml python "$PLUGIN_VALIDATOR" "$plugin_path"
    uv run --no-project --with pyyaml python "$SKILL_VALIDATOR" \
      "$plugin_path/skills/orion"
    return
  fi
  echo "PyYAML is unavailable; using the bundled contract test for validation."
}

run_official_validators "$PLUGIN_SOURCE"

if [[ "$USE_EXISTING" == false ]]; then
  cargo test --locked --manifest-path "$MCP_MANIFEST" \
    --target-dir "$ROOT_DIR/src-tauri/target"
  cargo build --locked --release --manifest-path "$MCP_MANIFEST" \
    --target-dir "$ROOT_DIR/src-tauri/target"
fi

if [[ ! -x "$MCP_BINARY" ]]; then
  echo "Missing executable release MCP binary: $MCP_BINARY" >&2
  echo "Run without --use-existing to build it." >&2
  exit 1
fi
if ! file "$MCP_BINARY" | grep -q "Mach-O 64-bit executable arm64"; then
  echo "The Orion MCP release binary is not an Apple Silicon executable." >&2
  exit 1
fi
if ! "$MCP_BINARY" --version | grep -q "$MCP_VERSION"; then
  echo "The Orion MCP release binary version does not match $MCP_VERSION." >&2
  exit 1
fi
if LC_ALL=C grep -a -F -q "$HOME/" "$MCP_BINARY"; then
  echo "The Orion MCP release binary contains a build-user path." >&2
  echo "Run npm run build:mcp before packaging the Codex plugin." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$RESOURCE_PARENT"
TEMPORARY_DIR="$(mktemp -d /private/tmp/orion-codex-plugin.XXXXXX)"
STAGED_ROOT="$TEMPORARY_DIR/Orion-Codex-Plugin"
STAGED_PLUGIN="$STAGED_ROOT/plugins/orion"
STAGED_BINARY="$STAGED_PLUGIN/server/orion-mcp"
VERIFICATION_DIR="$TEMPORARY_DIR/verification"
OUTPUT_NAME="Orion-Codex-Plugin-$APP_VERSION-Apple-Silicon.zip"
STAGED_ZIP="$TEMPORARY_DIR/$OUTPUT_NAME"
OUTPUT_ZIP="$OUTPUT_DIR/$OUTPUT_NAME"

cleanup() {
  if [[ "$TEMPORARY_DIR" == /private/tmp/orion-codex-plugin.* ]]; then
    rm -rf -- "$TEMPORARY_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGED_ROOT/.agents/plugins" "$STAGED_ROOT/plugins"
cp -R "$PLUGIN_SOURCE" "$STAGED_PLUGIN"
mkdir -p "$STAGED_PLUGIN/server"
cp "$MCP_BINARY" "$STAGED_BINARY"
chmod 755 "$STAGED_BINARY"

cat > "$STAGED_ROOT/.agents/plugins/marketplace.json" <<'EOF'
{
  "name": "orion-desktop",
  "interface": {
    "displayName": "Orion"
  },
  "plugins": [
    {
      "name": "orion",
      "source": {
        "source": "local",
        "path": "./plugins/orion"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
EOF

if [[ "$CODE_SIGN_IDENTITY" == "-" ]]; then
  codesign --force --sign - "$STAGED_BINARY"
else
  codesign --force --sign "$CODE_SIGN_IDENTITY" --timestamp --options runtime \
    "$STAGED_BINARY"
fi
codesign --verify --strict --verbose=2 "$STAGED_BINARY"

run_official_validators "$STAGED_PLUGIN"
node "$ROOT_DIR/script/test_mcp_connector.mjs" \
  "$STAGED_BINARY" "$FIXTURE_VAULT" "$STAGED_PLUGIN/.mcp.json"
node "$ROOT_DIR/script/test_codex_plugin.mjs" "$STAGED_ROOT" "$FIXTURE_VAULT"

(
  cd "$TEMPORARY_DIR"
  /usr/bin/zip -q -X -r "$STAGED_ZIP" Orion-Codex-Plugin
)
/usr/bin/unzip -tq "$STAGED_ZIP"
mkdir -p "$VERIFICATION_DIR"
/usr/bin/unzip -q "$STAGED_ZIP" -d "$VERIFICATION_DIR"
node "$ROOT_DIR/script/test_codex_plugin.mjs" \
  "$VERIFICATION_DIR/Orion-Codex-Plugin" "$FIXTURE_VAULT"
node "$ROOT_DIR/script/test_mcp_workflows.mjs" \
  "$VERIFICATION_DIR/Orion-Codex-Plugin/plugins/orion/server/orion-mcp" "$FIXTURE_VAULT"
node "$ROOT_DIR/script/test_mcp_library.mjs" \
  "$VERIFICATION_DIR/Orion-Codex-Plugin/plugins/orion/server/orion-mcp" "$FIXTURE_VAULT"

rm -rf -- "$RESOURCE_ROOT"
mv "$STAGED_ROOT" "$RESOURCE_ROOT"
mv "$STAGED_ZIP" "$OUTPUT_ZIP"

codesign --verify --strict --verbose=2 \
  "$RESOURCE_ROOT/plugins/orion/server/orion-mcp"
node "$ROOT_DIR/script/test_codex_plugin.mjs" "$RESOURCE_ROOT" "$FIXTURE_VAULT"
/usr/bin/unzip -tq "$OUTPUT_ZIP"
shasum -a 256 "$OUTPUT_ZIP"
echo "$OUTPUT_ZIP"
