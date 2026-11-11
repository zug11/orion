# Publishing Orion updates

Orion 0.6.0 introduces an optional in-app update path for the public Apple
Silicon build. People install 0.6.0 once from the DMG. Later releases can be
downloaded and installed from Orion's update control. The Vercel site remains
the public download page.

The release feed is fixed at:

`https://github.com/zug11/orion/releases/latest/download/latest.json`

The native updater uses Tauri's updater plugin with an embedded public key and
`requireSignedVersion: true`. Each archive signature binds both the complete
archive and its release version. A manifest cannot relabel an older signed
archive as a newer release. Preview builds have a different application
identity and do not consume the public release feed.

The update first waits for every window to save, then installs the verified
archive. After installation it drains native media work and requests a fresh
save from every window before restarting, including results that arrived while
the app was being replaced. If that final save fails, Orion remains open so the
save problem can be resolved. Retrying saves and restarts the already-installed
version without reinstalling it.

## Signing key

The maintainer's private updater key is kept outside the repository at
`~/.tauri/orion-release.key`; its public companion is `.key.pub`. Keep a secure
backup of this private key. The public key is embedded in
`src-tauri/tauri.conf.json`. Losing or changing the private key without a planned
key migration prevents existing installations from accepting future updates.
Never commit the private key or password, place either in a website build, or
include either in release assets.

Apple Developer ID signing, Apple notarization, and the Tauri update signature
serve separate purposes. All three must succeed for a public update. The CLI
must be Tauri 2.12.4 or newer because the standalone signer needs
`--app-version`.

## Build a release

Update application and connector versions together, complete the repository's
required checks, and write release notes before packaging. The public
`darwin-aarch64` target currently contains Whisper Medium; do not switch it to
Small or point a Windows/Intel target at the same archive.

From the physical checkout:

```sh
ORION_WHISPER_MODEL=medium \
ORION_NOTARY_PROFILE=orion-notary \
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/orion-release.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
ORION_UPDATE_NOTES_FILE="$PWD/releases/0.6.0.md" \
./script/package_release.sh 0.6.0.m
```

Use the actual version in the label and notes path. An encrypted private key
requires its password through the environment; do not put a real password in a
saved shell command or documentation. `TAURI_SIGNING_PRIVATE_KEY_PATH` is also
accepted. The script does not print credentials.

Packaging builds the renderer and native app from the verified source root,
signs all nested code with Developer ID, submits a ZIP of the completed app to
Apple, and staples the accepted ticket to the app. It then builds and notarizes
the APFS DMG around that same stapled app. The app copied out of the exact DMG
must retain its signatures, ticket, model, source fingerprints, and working
connectors.

Finally, `script/package_updater.mjs` creates the `.app.tar.gz`, extracts it to
verify its app signature and stapled ticket, signs the archive with
`--app-version`, and independently verifies both Minisign signatures against
the configured public key. Only then does it write `latest.json` and checksums.
`bundle.createUpdaterArtifacts` is deliberately `false`: the release pipeline
re-signs Tauri's intermediate app, so an archive generated before that step
would contain the wrong app signatures.

The DMG is written to `outputs/Orion-<label>-Apple-Silicon.dmg`. Update assets
are written to `outputs/releases/v<version>/`:

- `Orion-<version>-Apple-Silicon.app.tar.gz`
- `Orion-<version>-Apple-Silicon.app.tar.gz.sig`
- `latest.json`
- `Orion-<version>-SHA256SUMS.txt`

The same folder also contains app and DMG notarization receipts for local
verification; they are not required release assets. The helper refuses to
replace existing update assets. Use a separate output directory for a deliberate
rebuild and compare candidates before publishing.

If packaging already completed app and DMG notarization but archive creation
failed, fix the cause and rerun only the final step:

```sh
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/orion-release.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
node script/package_updater.mjs \
  src-tauri/target/release/bundle/macos/Orion.app \
  outputs/Orion-0.6.0.m-Apple-Silicon.dmg \
  releases/0.6.0.md
```

Do not rebuild or re-sign the app between the DMG and update archive. Both must
contain the same completed app. `--use-existing` on the main packaging script
re-signs and re-notarizes its verified input, so it is a new release candidate.

## Publish and verify

Create a draft GitHub release for the matching `v<version>` source tag. Upload
the DMG and all four update assets, then publish it as the latest stable
release. Uploading the manifest after the archive and signature keeps an
incomplete download out of the public feed. Do not mark an unrelated Preview
or Windows-only release as latest: the shared latest endpoint must always keep
a complete `darwin-aarch64` entry. When other supported platforms are added,
publish all target entries together.

Fetch the public `latest.json`, confirm its version, target and immutable asset
URL, and verify the downloaded archive against its embedded signature and the
app's public key. Update the website's download metadata only after these
public assets are available. The installed version checks the same feed;
0.6.0 sees no newer update when 0.6.0 is the latest release.

Run the independent signing/feed regression checks with:

```sh
node --test script/test_updater_manifest.mjs
```

These use a temporary signing key to check the real Tauri CLI, reject altered
payloads and forged version comments, reject mismatched keys, and validate the
single-platform release manifest. They do not install over a user's app or
change a vault.

References: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/)
and [Tauri signer implementation](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs).
