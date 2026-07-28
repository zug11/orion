<p align="center">
  <img src="public/orion-mark.svg" width="72" height="72" alt="Orion">
</p>

<h1 align="center">Orion</h1>

<p align="center">
  A local-first, AI-assisted knowledge atlas for turning source material into a connected personal wiki.
</p>

Orion is a Tauri desktop app for importing files or pasted material, organizing it into focused project notes and canonical wiki articles, and exploring the concepts that connect them. Write directly on the finished note—there is no read/write split and no Markdown knowledge required. Each recognized term belongs to the active Space and normally opens its one named wiki article directly. The right-hand connections canvas is reserved for unresolved, multi-target terms carried forward from the legacy link model; links do not open reference-hover cards.

AI is optional. Manual notes, local imports, linking, search, contextual navigation, and Markdown export work without an API key.

Each project can live in its own **Space**. Use the switcher at the top-left to create a completely blank Space or move between existing ones. Notes, imports, sources, concepts, relationships, link suggestions, navigation history, and the active note are isolated per Space, so matching vocabulary in two projects cannot accidentally cross-link. Existing single-project vaults migrate into the first Space automatically.

Every Space also has **Chat**, one persistent AI conversation grounded in bounded context from that Space and its recent message history. Switching Spaces switches both the conversation and the material available to it. Chat is a single conversation surface; it has no card, dialectic, or canvas workflow.

## Download

[Download Orion for Apple Silicon](https://github.com/zug11/orion/releases/latest/download/Orion-0.3.2-Apple-Silicon.dmg). This build requires macOS 13.3 or later and includes the offline Whisper model, `yt-dlp`, and Deno.

## What is included

- A polished React/Tauri desktop workspace with home, notes, sources, Space-scoped Chat, settings, and contextual backlink views.
- A top-left Space switcher for separate projects, with blank-space creation and strict concept/link isolation.
- AI Import Studio using the OpenAI Responses API and strict structured output.
- A persistent per-Space AI conversation with bounded recent history and note, source, and concept context.
- Manual import fallback that creates one editable draft per source.
- Local extraction for text, Markdown, JSON, CSV/TSV, HTML, PDF, and DOCX.
- Fully offline media transcription for MP3, MP4, M4A, WAV, WebM, OGG, FLAC,
  and MPEG media using the bundled Whisper base multilingual model and
  Metal-accelerated `whisper.cpp`.
- A self-contained YouTube → bundled `yt-dlp` + Deno → bundled Whisper workflow
  whose temporary download is deleted after transcription, including on errors.
- A direct rich-text writing surface with an animated, lightweight toolbar for headings, bold, italic, lists, quotes, and reusable links.
- Automatic concept recognition from canonical article titles, deliberate aliases, AI-generated vocabulary, and phrases explicitly taught through the Link tool. Tags remain organizational metadata rather than link vocabulary.
- Direct navigation to canonical Space articles, with the right-hand connections canvas retained only to disambiguate unresolved legacy terms.
- Search and command palette across notes, concepts, sources, and actions.
- Automatic local persistence, OS-keychain API-key storage, and native Markdown export.
- Dark, light, and system appearance modes.

## Architecture and trust boundary

```text
files / pasted text / recordings / YouTube
        │
        ▼
React + TypeScript renderer
  • parses imports locally
  • edits and renders Markdown
  • builds canonical concepts, links, backlinks, and direct navigation
  • keeps Chat history and context isolated by Space
        │ Tauri IPC
        ▼
Rust host
  • atomically reads/writes vault.json
  • reads the API key from the OS credential store
  • calls OpenAI over HTTPS
  • decodes media with AVFoundation and transcribes it with bundled Whisper
  • downloads one YouTube source into a self-deleting temporary folder
  • exports Markdown through a native folder picker
```

The desktop renderer never receives the saved API key. It asks the Rust host whether a key exists and invokes narrowly scoped commands for key management, AI organization, persistence, and export. The Rust host adds the bearer token only when making the OpenAI request. The desktop content-security policy blocks arbitrary renderer network access.

Import parsing happens locally in the renderer. In AI mode, Orion sends the selected source text plus the enabled existing-note context to OpenAI. In manual mode, it makes no OpenAI request. See [Privacy and data behavior](#privacy-and-data-behavior) for the precise payload and browser-preview caveat.

## Prerequisites

- [Git LFS](https://git-lfs.com/) 3.x to fetch the bundled Whisper model,
  `yt-dlp`, and Deno assets from a source checkout (`git lfs install` once per
  machine, then `git lfs pull` inside the repository).
- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0` and npm.
- A stable Rust toolchain with Cargo.
- The native dependencies required by [Tauri 2](https://v2.tauri.app/start/prerequisites/):
  - macOS: Xcode Command Line Tools (`xcode-select --install`), or full Xcode.
  - Windows: Microsoft C++ Build Tools with **Desktop development with C++**, plus WebView2. MSI builds also require the Windows VBSCRIPT optional feature.
  - Debian/Ubuntu Linux:

    ```bash
    sudo apt update
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    ```

- An OpenAI API key with access to the selected model is optional and required only for AI organization.

No Whisper server, Python environment, Homebrew package, `yt-dlp`, Deno,
ffmpeg, or transcription API key is required at runtime. Orion ships the
offline model and all YouTube executables inside the macOS application bundle.
This build requires macOS 13.3 or later and Apple Silicon.

This snapshot has been verified with Node `25.9.0`, npm `11.12.1`, and Rust/Cargo `1.96.0`.

## Run Orion

From this directory:

```bash
git lfs pull
npm ci
npm run tauri dev
```

`tauri dev` starts Vite on port `1420`, compiles the Rust host, and opens the desktop app.

To exercise only the web renderer:

```bash
npm run dev
```

This browser-preview path stores the vault in browser `localStorage`, keeps any API key in memory only for the current tab, and calls OpenAI from the browser. It is a development convenience, not Orion's desktop security model.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked JavaScript dependencies. |
| `npm run dev` | Start the browser-only Vite preview on port `1420`. |
| `npm run build` | Type-check and build the renderer into `dist/`. |
| `npm run preview` | Serve the built renderer locally. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run check` | Run renderer tests, type-check, and production build. |
| `npm run tauri dev` | Run the complete desktop app in development. |
| `npm run tauri build` | Build native bundles for the current platform. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust host tests. |

Native bundles are written below `src-tauri/target/release/bundle/`. Local macOS builds are ad-hoc signed; public distribution still requires a Developer ID identity and notarization.

From the repository root, `./script/package_release.sh <release-label>` builds
and stages a DMG through a new file before publishing it in `outputs/`. Do not
copy directly over an installer that may still be mounted: mutating a mounted
DMG's backing file can cause Finder error `-36` and leave a partial app in
Applications.

## Import behavior

Import Studio accepts up to 12 sources per batch, with a 25 MiB limit per
document. Pasted text and local transcripts can be queued alongside documents.

| Input | Behavior |
| --- | --- |
| `.txt` | Imported as plain text. |
| `.md`, `.markdown` | Preserves Markdown and uses the first level-one heading as the title when present. |
| `.json` | Validates and pretty-prints JSON; `title`, `name`, or `subject` can supply the source title. |
| `.csv`, `.tsv` | Detects comma, tab, or semicolon delimiters and converts quoted rows to a Markdown table. |
| `.html`, `.htm` | Extracts readable headings and text while removing scripts, styles, and other non-content elements. |
| `.pdf` | Extracts selectable text page by page. Image-only/scanned PDFs require OCR before import. |
| `.docx` | Extracts document text with Mammoth; layout, comments, and embedded media are not retained. |
| `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac` | Decodes locally with AVFoundation and transcribes with Orion's bundled model. |
| `.mp4`, `.webm`, `.mpeg`, `.mpga` | Extracts the audio track on-device and transcribes it with bundled Whisper. |
| YouTube URL | Uses bundled `yt-dlp` and Deno to download one best-audio source, transcribes it offline, and deletes the temporary media. |

Media can be up to 2 GiB. The native picker accepts up to eight media files at
once. Transcripts enter the same Review → Organize → Results flow as documents,
so manual mode keeps one verbatim draft while AI mode can split a recording
into focused notes and generate reusable concepts and links.

The full extracted source text is retained locally in the source record. AI mode sends at most 60,000 characters from each selected source, produces at most eight notes per source and 30 notes per batch, and preserves the full local source if trimming was necessary. Manual mode creates one draft per source using at most 200,000 characters for the note body while still preserving the full source record.

AI mode distinguishes contextual project notes from durable, Space-scoped wiki articles. A generated wiki article contains a concise **Overview**, why the subject matters **In [the current Space]**, details **From the imported material**, and an **Uncertainties** section when the source leaves something unresolved. The overview may use stable general knowledge needed to explain the subject; project relevance, source-grounded details, citations, dates, statistics, and contested or current claims must come from the supplied material and Space context.

Canonical articles are upserted rather than duplicated. Orion normalizes exact titles within the active Space, coalesces repeated articles in the same import, and reuses a uniquely matching existing canonical article or note instead of creating a suffixed copy. A new article is a draft wiki note. Updating an existing article preserves its identity and authored body, fills an empty summary, merges aliases, tags, and source provenance, and appends each source-specific context section at most once.

If an AI call fails, Orion keeps the source and falls back to a manual draft for that item rather than discarding the import.

## Offline Whisper and YouTube

Open **Settings → Transcription** to choose an optional language hint or run
**Check setup**. The check executes the tools inside Orion's own bundle and
verifies:

- `whisper.cpp` 1.9.1;
- the 147,951,465-byte Whisper base multilingual model;
- the official standalone `yt-dlp_macos` executable;
- the bundled Deno runtime used for YouTube JavaScript challenge solving.

Media is decoded to 16 kHz mono floating-point samples with AVFoundation and
passed directly to the native Whisper library. No media is uploaded and no
localhost service is started. The first transcription after a launch may take a
few seconds to initialize Metal; later inference remains on-device.

YouTube imports accept only a specific HTTPS `youtube.com` or `youtu.be` URL,
disable playlists and user configuration, and invoke the exact bundled
executables with structured arguments rather than a shell. The download lives
inside a fresh OS temporary directory owned by Rust and is removed on success
or every error path. Browser preview cannot execute native model or downloader
components; install the desktop app for transcription.

## OpenAI configuration

Open **Settings → Intelligence** to save, replace, test, or remove a key. In the Tauri app it is stored under:

- service: `app.orion.knowledge`
- account: `openai-api-key`

The underlying credential store is macOS Keychain, Windows Credential Manager, or the persistent keyutils/Secret Service store on Linux. A Linux desktop session therefore needs a working Secret Service-compatible keyring. The key is not written to `vault.json`, included in exports, returned to the renderer, or intentionally logged. **Test connection** makes an authenticated `GET /v1/models` request.

AI organization uses `POST /v1/responses`, strict JSON-schema output, `store: false`, and a 12,000-token response ceiling. Chat uses the same endpoint and privacy posture with its own strict reply schema and a 6,000-token response ceiling. The default settings are:

- Model: `gpt-5.6-sol`
- Reasoning depth: `low`
- Existing-note context: enabled

The model choices exposed by the UI are:

| Model ID | UI intent |
| --- | --- |
| `gpt-5.6-sol` | Best quality; the default. |
| `gpt-5.6-terra` | Balanced quality, speed, and cost. |
| `gpt-5.6-luna` | Efficient for straightforward collections. |

Reasoning choices are `none`, `low`, `medium`, `high`, and `xhigh`. Model access and billing depend on the OpenAI project behind the supplied key; Orion does not silently substitute a different model.

Organization guidance in Settings is appended to Orion's built-in knowledge-architect instructions. Source content is treated as untrusted data, and the built-in prompt explicitly tells the model not to follow instructions found inside imported material.

## Chat

Open **Chat** from the main navigation to continue the conversation belonging to
the active Space. Orion sends the current prompt, up to 12 recent conversation
turns, and bounded context from that Space: up to 80 notes, 30 sources, and 120
concepts. Switching Spaces changes both the history and context completely.
Orion treats supplied note, source, concept, and conversation text as untrusted
knowledge data rather than instructions.

Chat is intentionally one conversation surface. It does not create or curate
cards and has no proposal, selection, promotion, dialectic, or canvas workflow.
For existing vaults, Chat history continues to use the legacy
`studio.messages` field. Older card, selection, focus, view, zoom, and
panel-layout fields remain dormant and are accepted solely for vault
compatibility; Chat does not display them or send them to OpenAI.

## Links, concepts, and navigation

Each Space owns an independent canonical link vocabulary. A concept label and its deliberate aliases identify one primary wiki article or note in that Space; the concept's canonical title must match that destination's title. Contextual project notes can support or relate to the article without becoming alternate link destinations. Tags remain useful for organization, filtering, and export, but Orion does not turn tags into automatic hyperlinks. Markdown remains a portable storage and export format behind the editor, but users never need to write it.

- Click **Edit** to write directly on the note; the compact word-processing toolbar animates into place without swapping to a separate editor.
- Select words and click **Link**, or click **Link** first and type a phrase. Orion creates or reuses the named Space article by default, and future occurrences become hyperlinks automatically. The destination picker remains available only when deliberately preserving a multi-note legacy branch.
- A canonical concept link opens its article directly in the main note view. Orion does not interrupt reading with reference-hover popovers.
- The right-hand connections canvas appears only when an older unresolved concept still has several destinations and no valid canonical article. Choosing a destination opens it in the main note view while retaining the originating note as a trail.
- The right context panel shows headings, backlinks, related notes, and sources.

During import, Orion asks the model for precise canonical vocabulary in addition to project notes. Every returned concept names an exact returned or existing canonical article; related project-note titles become relationships, not alternate destinations. The importer deduplicates normalized article titles across the batch, reuses an exact article already present in the active Space, and merges new source-grounded context without overwriting prior prose. Existing and manually written notes receive local title and alias concepts without an AI call.

## Keyboard shortcuts

Use `⌘` on macOS and `Ctrl` on Windows/Linux.

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl K` | Open search globally; while editing a note, teach Orion a reusable link. |
| `⌘/Ctrl N` | Create a note. |
| `⌘/Ctrl Shift I` | Open Import Studio. |
| `⌘/Ctrl [` | Navigate back through opened notes. |
| `⌘/Ctrl ]` | Navigate forward through opened notes. |
| `Esc` | Close the command palette, connections canvas, or Import Studio. |
| `↑` / `↓`, `Enter` | Navigate and run a command-palette result. |

## Vault and export

The desktop app stores one schema-versioned JSON snapshot named `vault.json` under Tauri's application data directory for the identifier `app.orion.knowledge`:

| Platform | Default path |
| --- | --- |
| macOS | `~/Library/Application Support/app.orion.knowledge/vault.json` |
| Windows | `%APPDATA%\app.orion.knowledge\vault.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/app.orion.knowledge/vault.json` |

The path is not currently configurable. Saves are debounced, serialized, flushed before a normal desktop close or application quit, and use a temporary file plus atomic replacement. Orion also enforces a single running desktop instance so two processes cannot race over the same whole-vault snapshot. The snapshot contains notes, full extracted source text, concepts, relationships, import metadata, per-Space Chat history, dormant legacy Studio fields retained solely for compatibility, and non-secret settings.

If `vault.json` is unreadable or uses an unsupported schema, Orion blocks automatic saving and opens a recovery screen instead of treating it as an empty vault. The existing file is left untouched while you open the data folder, repair or move it, and retry.

With no existing vault, Orion opens as a clean slate with direct paths to import documents, paste notes, or start writing. No example notes or sources are bundled. **Open data location** reveals the application data folder. **Erase local vault** requires confirmation and replaces the saved snapshot with a fresh empty atlas; it does not remove the separately stored API key.

Desktop export asks for a folder and writes one UTF-8 Markdown file per note with YAML `title` and `tags` frontmatter. Existing files are never overwritten; Orion adds a numeric suffix. Browser preview downloads one combined `orion-export.md` file instead.

## Privacy and data behavior

- Notes, relationships, concepts, settings, and extracted source text are plaintext on local disk. Orion does not currently encrypt the vault.
- AI mode sends the selected source text, source name, Space name and description, organization guidance (up to 2,000 characters), and—when enabled—up to 80 existing note titles, kinds, aliases, and summaries to OpenAI. Existing canonical wiki articles may also contribute up to 6,000 characters of body text so the organizer can reuse and extend them without duplication; other note bodies and unrelated source records are not added.
- A Chat message sends only bounded material from the active Space: the prompt, up to 12 recent turns, and context for up to 80 notes, 30 sources, and 120 concepts. It sends no legacy card or layout state. Switching Spaces changes the history and context completely.
- `store: false` requests that OpenAI not store the generated response for later retrieval; account-level data controls and OpenAI's applicable retention policies still apply.
- API use can incur charges. A valid key does not guarantee access to every model.
- AI-generated notes are drafts. Orion constrains the response shape but does not independently fact-check the content; review important claims and links before relying on them.
- Manual imports and editing remain local and can work offline. AI organization and connection testing require network access.
- PDF and DOCX extraction and media transcription happen locally. Orion has no
  OCR, general URL crawler, sync service, collaboration server, transcription
  server, or telemetry integration.
- A YouTube import briefly writes downloaded media to an OS temporary folder;
  it is deleted once offline Whisper finishes, including when
  download or transcription fails. The finished transcript and source URL
  remain in the vault as provenance.
- Markdown exports are plaintext and may contain sensitive source-derived material.
- In browser-only development, the snapshot (`orion:vault:v2`) is stored in that origin's `localStorage`; an entered API key is held in memory only and clears on reload. Use the Tauri app for persistent OS-keychain storage.

## Tests

The renderer suite covers import detection and parsing, transcription-source
mapping, canonical destination and legacy-ambiguity resolution, automatic-link
safety, backlinks/search, Space-scoped Chat request bounds and history,
dormant legacy Studio-state compatibility, and browser persistence without leaking the key
into the snapshot. Rust tests cover bundled-runtime validation, YouTube URL
validation, temporary-media deletion, `yt-dlp` metadata, Responses API output
extraction, portable export names, and atomic vault round-trips. Release QA also
uses only the executables inside the finished app to download and transcribe a
real short YouTube source.

Before handing off a change:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

The final native build is the best end-to-end check because browser preview intentionally uses a different persistence and key path.

## Project map

```text
src/
  components/       workspace, editor, Space-scoped Chat, connections, import
  data/defaults.ts  clean-vault defaults and settings
  lib/files.ts      local import extraction
  lib/chat.ts       bounded Space Chat context and message updates
  lib/studio.ts     dormant Studio-state compatibility
  lib/storage.ts    Tauri IPC and browser-development fallback
  lib/wiki.ts       linking, backlinks, references, and search helpers
  types.ts          schema-versioned application model
src-tauri/
  native/           Swift AVFoundation + whisper.cpp transcription sidecar
  binaries/         bundled Whisper runner, yt-dlp, and Deno executables
  resources/        Whisper model, hashes, notices, and third-party licenses
  vendor/           official whisper.cpp macOS framework
  src/lib.rs        vault, keychain, OpenAI, offline media, export, and Tauri commands
  tauri.conf.json   window, bundled runtime files, identity, and CSP configuration
```
