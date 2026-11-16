#!/usr/bin/env bash
# Build the real local app with a stable identity so updates retain Keychain trust.
# Isolated, ad-hoc previews continue to use build_and_run.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This command builds the signed local macOS app." >&2
  exit 2
fi

identity_lines="$(security find-identity -v -p codesigning)"
identity="$(printf '%s\n' "$identity_lines" | python3 -c '
import os, re, sys
identities = re.findall(r"\) ([A-F0-9]{40}) \"(Developer ID Application: [^\"]+)\"", sys.stdin.read())
requested = os.environ.get("ORION_CODESIGN_IDENTITY", "")
matches = [entry for entry in identities if not requested or requested in entry]
if len(matches) != 1:
    sys.exit("Set ORION_CODESIGN_IDENTITY to one installed Developer ID Application identity. For an isolated ad-hoc preview, use script/build_and_run.sh --build-only.")
print(matches[0][1])
')"
export ORION_CODESIGN_IDENTITY="$identity"
signing_stage="$(mktemp -d /private/tmp/orion-local-signing.XXXXXX)"
config="$signing_stage/tauri.local.json"
cleanup() { rm -f "$config"; rmdir "$signing_stage"; }
trap cleanup EXIT
python3 - "$config" "$identity" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({"bundle": {"macOS": {"signingIdentity": sys.argv[2]}}}))
PY

cd "$ROOT_DIR"
echo "Building Orion with $identity"
npm run tauri -- build --bundles app --config "$config"
codesign --verify --deep --strict "$ROOT_DIR/src-tauri/target/release/bundle/macos/Orion.app"
echo "Signed local app: $ROOT_DIR/src-tauri/target/release/bundle/macos/Orion.app"
