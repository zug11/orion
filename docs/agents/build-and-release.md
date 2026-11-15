# Builds, updates and releases

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: Preview builds, the pinned voice SDK patch, the updater, packaging, signing and notarization.

Read it before changing `script/`, `src-tauri/tauri.conf.json`, the updater, and anything that ships inside the app bundle.

Related: [Claude connector and Codex plugin](mcp-connector.md), [Dictation and transcription](dictation-and-transcription.md).

## Preview builds and the pinned voice SDK patch

`script/build_and_run.sh` and the Codex Run action create a local native
**Orion Preview** under `~/Applications/Orion Previews`, linked from
`outputs/native-preview` to keep signed frameworks outside indexed Documents.
The script stages current
sources in `/private/tmp`, uses the exact npm lockfile, rebuilds desktop
dependencies, and bundles with Tauri. Only the staged config and Keychain
service change to `app.orion.desktop-preview`, with a separate URL scheme.
Never copy, reset, or seed the user's vault for this preview. Its library
persists across preview builds; normal Quit must complete before rebuilding
a running preview for replacement. `--build-only` instead builds and verifies a
separate app without querying, quitting or launching the running Preview. It
writes `outputs/native-preview/latest-built-app.txt`, leaving `latest-app.txt`
unchanged. Each build records the physical source root, exact staged input
hashes (including untracked files), Git HEAD and Preview identity patches in
`source-manifest.json`; this identifies the captured staging tree, not an atomic
snapshot of a concurrently edited checkout. Shared Cargo caches are excluded.
This ad-hoc local app is not a release artifact.
The ElevenLabs browser client is pinned to 1.36.1. The idempotent
`script/patch_elevenlabs_client.mjs` verifies exact upstream hashes before adding
abort support to pending microphone permission, WebSocket and audio-worklet setup.
The same bounded patch gates input until connected and unmuted, drops startup
audio before buffering until the first finalized human utterance, and loads the
local resampler whenever the actual device sample rate differs from the request.
Interruption clears current and queued worklet samples and output gain
immediately. Reject audio older than the monotonic interruption boundary before
callbacks and playback, including pre-attachment queues; ignore duplicate/older
interruptions so they cannot erase a newer reply. Preserve audio at the boundary
and newer audio. Only accepted new audio restores output after interruption;
ordinary volume changes cannot reopen the old buffer.
Install, dev, test and renderer-build hooks apply it; the renderer-build hook also
covers Preview's `npm ci --ignore-scripts`. SDK upgrades require reviewing and
updating this patch and running the actual-SDK cancellation regressions. Do not
replace Stop with a timer that leaves a pending microphone capture alive.

The native crate sets release `strip = "none"` to avoid Rust 1.96 producing
misaligned proc-macro dylibs with the macOS 27 toolchain
([upstream issue](https://github.com/rust-lang/rust/issues/157750)). Retain this
until the supported compiler includes the fix. The independent MCP package
keeps its existing remapping, stripping, signing, and verification pipeline.

## Running the checks on Linux

The release target is Apple Silicon macOS, but the renderer checks and both
Rust test suites also run on Linux, which is what a cloud agent or CI has.

- `npm run check` needs nothing beyond `npm ci`.
- The MCP server crate builds and tests as is. Its Node harnesses
  (`script/test_mcp_connector.mjs`, `script/test_mcp_library.mjs` and the
  workflow harness) use `/private/tmp`; create that directory first.
- The desktop crate needs the WebKitGTK development packages:
  `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
  libssl-dev libdbus-1-dev pkg-config`. With those, `cargo test --manifest-path
  src-tauri/Cargo.toml` compiles and runs the host's unit tests. The macOS-only
  tests are ignored there.
- Swift sidecars, native glass, signing, the updater and anything that needs
  AppKit can only be built and verified on macOS. Say so in a handoff instead
  of implying they were exercised.

## Application updates

Public Apple Silicon releases from 0.6.0 use the Tauri updater plugin with
`https://github.com/zug11/orion/releases/latest/download/latest.json` and a
dedicated public verification key in `tauri.conf.json`. Updates are optional:
background checks may advertise a release, but downloading and restarting are
explicit user actions. Keep update progress in its own subscribed component so
it never rerenders the note editor. Provide a manual check in Settings.
Browser development, debug builds, and the separate Orion Preview identity
must not download or install public release updates.

Native code owns release metadata, the verified download, and installation;
the renderer cannot supply an endpoint, archive URL, signature, or executable.
Keep signature verification and signed-version matching enabled. Installation
must use the existing all-window save handshake and cancel on any save failure;
never use a raw renderer process-restart permission to bypass it. The updater
must not read, migrate, reset, or copy the vault as part of replacing the app.
After installation, drain native media work and request a fresh save from every
window before restarting, preserving results that arrived during installation.
Fresh save attempts must run even in already-locked renderers; duplicate and
stale acknowledgements cannot satisfy a later attempt. A failed final save
keeps the running process and local edits available. Retrying saves and restarts
the already-installed update without installing it again.

The public update archive is produced only from the final Developer ID signed,
Apple-notarized and stapled application. `bundle.createUpdaterArtifacts` stays
false because the custom packaging pipeline performs final signing after
Tauri's interim app bundle. See `docs/updating-orion.md` for packaging and
publication. The private signing key is stored outside the checkout and must
never enter Git, release assets, logs, or the app. Retain and securely back it
up: future releases need the same key to update existing installations.

## Packaging, signing and notarization

The packaging script must re-sign all copied executable code before publishing.
It must also reject a release root whose `src-tauri` path causes
`build.frontendDist` to resolve outside that same root, and stamp both the
source tree and built `dist/` fingerprints into the app. This prevents a clean
source mirror with a symlinked native directory from embedding a stale renderer
from another checkout. Build the renderer and connector explicitly before the
Tauri release step and disable Tauri's nested `beforeBuildCommand` for that
step; the renderer must be built once, fingerprinted once, and embedded once.
The isolated renderer stage includes `script/patch_elevenlabs_client.mjs` so
the normal prebuild hook applies and verifies the pinned voice SDK patch;
include that script in the release source fingerprint.
Release builds sign `whisper.framework`, `orion-ocr`, `orion-whisper`, `yt-dlp`,
Deno, the main Orion executable, and the outer app with one Developer ID
Application identity, secure timestamps, and Hardened Runtime. The PyInstaller
`yt-dlp` helper alone receives the narrow `disable-library-validation`
entitlement it needs to map its extracted Python framework. The main Orion
executable receives only the audio-input entitlement required for note voice
memos, and the app bundle includes the matching microphone usage description.
Verify the entire bundle with `codesign --verify --deep --strict`, then
regenerate and sign the DMG around that exact signed app. Mount the finished
image read-only, copy the app out with `ditto`, and run the four helper
`--version` commands from that copy. Set
`ORION_CODESIGN_IDENTITY` when more than one Developer ID identity is installed.
Set `ORION_NOTARY_PROFILE` to a `notarytool` Keychain profile to submit, staple,
and Gatekeeper-check the DMG as part of the same release command. The script
currently sets `CARGO_PROFILE_RELEASE_STRIP=false` because Rust 1.96 on current
macOS can make release-stripped proc-macro dylibs unloadable with E0463; remove
that workaround only after the installed stable toolchain builds Orion cleanly
with Cargo's normal release stripping.

On the maintainer's Mac, the existing notarization Keychain profile is
`orion-notary`, verified against Apple's accepted Orion submission history on
2026-09-08. For an authorized notarized release, use
`ORION_NOTARY_PROFILE=orion-notary`. Check it with
`xcrun notarytool history --keychain-profile orion-notary --output-format json`
before asking the maintainer to set up credentials again. An unset environment
variable or an empty `security dump-keychain` search does not mean the profile
is missing; notarytool can access credentials those checks do not enumerate.
Never print or request the stored password.
The MCPB contains nested executable code that outer bundle signing cannot
inspect through the ZIP container. Build and Developer-ID-sign `orion-mcp`
before creating a release MCPB (ordinary local builds remain ad hoc); release
verification must extract the connector from both
the app bundle and the copied-out final DMG, verify that exact binary, and run
the MCP protocol/Space-boundary harness.

The Codex plugin also contains a nested `orion-mcp`, at
`Contents/Resources/Orion-Codex-Plugin/plugins/orion/server/orion-mcp`. Include
`codex/orion`, `script/build_codex_plugin.sh`, and
`script/test_codex_plugin.mjs` in the source fingerprint. The marketplace
manifest is generated inside each staged root at
`.agents/plugins/marketplace.json`; validate that generated contract rather
than maintaining a second repo-root manifest with an incompatible relative
source path. Developer-ID-sign the exact nested binary with Hardened Runtime
before sealing `Orion.app`. Verify its signature and version, the full plugin
contract, and the MCP read-write harness first from the app bundle and again
from the app copied out of the final DMG. A `--use-existing` pass must rebuild
the Claude connector, stage Codex with `--use-existing`, remove the prior Codex
resource directory, and copy the new complete tree before resealing. Never use
a merging directory copy that can retain stale plugin files.

Build only the app with Tauri (`--bundles app`); the release script creates
the final APFS DMG directly. Do not require a preliminary Finder-scripted Tauri
DMG that would be discarded by the APFS packaging step.
Rebuild the final drag-install image on APFS rather than HFS+. The plugin
contract necessarily includes nested dotfiles (`.agents`, `.codex-plugin`, and
`.mcp.json`); HFS+ can synthesize `com.apple.FinderInfo` for them when Finder or
`ditto` copies the app out, invalidating the sealed bundle. Preserve Tauri's
drag-install structure, but do not import its generated `.DS_Store` or volume
icon: those assets cause Finder metadata to reappear on `whisper.framework`.
Create a clean `Orion.app` + `/Applications` symlink surface, copy the signed
app with extended attributes disabled, then verify the app copied from the
exact APFS DMG. Sanitize the complete app tree before Developer ID signing and
stage the APFS source under `/private/tmp`, not the repository's Documents
directory: File Provider can otherwise reattach FinderInfo while `hdiutil`
reads nested framework directories.

The release entry point accepts only an installed **Developer ID Application**
certificate, by exact certificate name or fingerprint. Never allow ad-hoc
signing (`-`) or an Apple Development identity to produce a release-labelled
DMG; `codesign --verify` alone proves integrity, not Gatekeeper trust.
