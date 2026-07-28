# Orion Agent Guide

This file is the durable operating manual for anyone changing Orion. Read it
before editing the application. Keep it accurate when architecture, commands,
security boundaries, schemas, or release procedures change.

## Product intent

Orion is a beautiful, local-first Tauri knowledge atlas. People import source
material or write directly in a note; Orion turns that material into a personal
wiki with reusable concepts and intelligent hyperlinks.

These product decisions are intentional:

- Orion is not a graph canvas and must not grow an Obsidian-style graph.
- The app starts empty. Do not add sample notes, mock sources, demo concepts, or
  seeded Chat messages to a real vault.
- Notes have one direct reading/writing surface. Editing reveals a lightweight
  word-processing toolbar; users never need to understand Markdown.
- Durable link phrases resolve to one canonical wiki article or note inside the
  active Space. Clicking a canonical concept navigates directly to that article.
- The right-hand connections canvas is a compatibility surface only for an
  unresolved legacy concept with several valid targets and no canonical article.
  Do not route normal concept navigation through it or add reference-hover UI.
- Tags organize, filter, and export notes. They are not link vocabulary and must
  never create automatic concepts merely because they appear on a note.
- Spaces are hard project boundaries. Notes, concepts, sources, relationships,
  Chat history, navigation, and automatic links must never leak across Spaces.
- Chat is one Space-scoped conversation surface. It must not expose a card,
  proposal, curation, dialectic, promotion, or canvas workflow.
- AI is optional. Writing, local imports, source provenance, links, search,
  Spaces, and Markdown export must remain useful without an OpenAI key.
- Generated material is a draft for review. Preserve provenance and uncertainty.

## Stack and layout

- React 19, TypeScript, Vite, and plain CSS in the renderer.
- Tiptap 3 powers the rich note editor while Markdown remains the portable
  persisted representation.
- Tauri 2 and Rust provide persistence, OS-keychain access, native dialogs,
  OpenAI calls, media transcription, YouTube downloading, and export.
- Vitest covers renderer logic. Rust unit tests live at the end of
  `src-tauri/src/lib.rs`.

Important paths:

```text
src/App.tsx                         vault/Space orchestration and app actions
src/App.css                         complete visual system and responsive UI
src/types.ts                        persisted and IPC data contracts
src/data/defaults.ts                clean-vault defaults and new settings
src/components/NoteView.tsx         direct rich-text note surface
src/components/ConnectionCanvas.tsx legacy concept disambiguation
src/components/ImportStudio.tsx     document, paste, media, and YouTube flow
src/components/ChatView.tsx          single Space-scoped Chat surface
src/components/SettingsView.tsx     AI, transcription, linking, theme, data
src/lib/files.ts                    local document parsing
src/lib/concepts.ts                 vocabulary reconciliation and link teaching
src/lib/wiki.ts                     link resolution, references, and backlinks
src/lib/chat.ts                     bounded Chat context and message updates
src/lib/studio.ts                   dormant Studio-state normalization
src/lib/storage.ts                  validated IPC and browser-preview fallbacks
src/lib/transcription.ts            transcript-to-source normalization
src-tauri/src/lib.rs                native commands and trust boundaries
src-tauri/tauri.conf.json           window, CSP, identity, and bundle settings
src-tauri/native/OrionWhisper/       AVFoundation + whisper.cpp sidecar source
src-tauri/binaries/                  bundled native executables
src-tauri/resources/                 model, checksums, notices, and licenses
src-tauri/vendor/whisper.framework   official whisper.cpp 1.9.1 framework
README.md                           user and contributor documentation
```

## Everyday commands

Run from this directory:

```bash
npm ci
npm run dev
npm test
npm run build
npm run check
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

`npm run check` runs renderer tests and a production renderer build.
`npm run tauri build` is the canonical native integration and release check.
Native artifacts are produced under `src-tauri/target/release/bundle/`.

## Persistence and schema rules

The canonical desktop vault is `vault.json` in Tauri's application data folder
for `app.orion.knowledge`. It is a schema-versioned `OrionVault` containing one
or more schema-versioned `AppSnapshot` Spaces. Saves are serialized and use a
flushed temporary file plus atomic replacement.

- Never silently replace an invalid vault with an empty one.
- Never persist the OpenAI key in the vault, browser storage, logs, exports, or
  renderer state. The desktop key lives in the OS credential store.
- Treat additions to persisted interfaces in `src/types.ts` as migrations.
  Existing vaults must continue to validate. New optional settings should be
  accepted by `src/lib/storage.ts`, then hydrated through `defaultSettings` in
  `App.tsx`.
- Update every validator and exhaustive `SourceKind` mapping when adding a
  source type.
- Preserve the original extracted/transcribed source even when AI input must be
  bounded.
- Settings currently apply across all Spaces; content remains Space-local.

Browser preview uses `localStorage` for development and keeps the OpenAI key in
memory for the current tab. Desktop behavior is authoritative.

## Import pipeline

Import Studio has four phases: Add, Review, Organize, Results.

1. Textual documents are parsed locally in the renderer.
2. Media is decoded by AVFoundation and transcribed by bundled Whisper.
3. Each parsed source enters one shared review queue.
4. Manual mode creates one editable draft per source.
5. AI mode sends bounded source text to the Rust host, which calls the OpenAI
   Responses API with strict structured output and `store: false`.
6. Project notes, canonical wiki articles, precise concepts, relationships, and
   source provenance are deduplicated/upserted and applied atomically to the
   active Space.
7. A failed organizer call falls back to a manual draft rather than discarding
   the source.

Current document limits are 12 sources per batch, 25 MiB per document, 60,000
characters sent to the organizer per source, eight AI notes per source, and 30
generated notes per batch. The full local source remains available.

Supported document sources are text, Markdown, JSON, CSV/TSV, HTML, PDF, and
DOCX. Supported transcription media are FLAC, M4A, MP3, MP4, MPEG/MPGA, OGG,
WAV, and WebM, up to 2 GiB each and eight native picker selections at once.

## Offline transcription contract

Orion 0.3.2 is self-contained on Apple Silicon macOS 13.3 or later. It bundles:

- `whisper.cpp` 1.9.1 as `Contents/Frameworks/whisper.framework`;
- the custom `Contents/MacOS/orion-whisper` sidecar;
- the multilingual `ggml-base.bin` model in `Contents/Resources/models`;
- official standalone `yt-dlp_macos` as `Contents/MacOS/yt-dlp`;
- Deno as `Contents/MacOS/deno`.

Settings retain only `whisperLanguage`, blank for automatic detection. Legacy
`whisperUrl`, `whisperModel`, and `ytDlpPath` properties remain accepted by the
snapshot validator for migration but are ignored and are not shown in the UI.

`orion-whisper` uses AVFoundation to decode a selected audio or video track
directly to 16 kHz mono Float32 samples and calls the whisper C API. It writes
only the finished transcript to stdout and diagnostic detail to stderr. Rust
passes exact model and media paths as structured process arguments, captures the
result, and never transfers media through renderer IPC or HTTP.

The upstream framework is built for macOS 13.3, which defines Orion's current
minimum system version. The model must be at least 100 MiB or setup validation
treats it as incomplete. `THIRD_PARTY_NOTICES.md` records artifact versions,
hashes, origins, and licenses. Do not replace a bundled artifact without
updating and verifying those records.

Run `../script/build_transcription_sidecar.sh` after changing the Swift source.
Both the workspace Run action and release packaging script do this
automatically. Browser preview has no native sidecars and must report that
transcription is desktop-only.

## YouTube-to-notes workflow

The native `transcribe_youtube` command is deliberately narrow:

1. Accept only a specific HTTPS URL on `youtube.com` or `youtu.be`.
2. Verify the bundled Whisper runner/model, `yt-dlp`, and Deno are complete
   before downloading anything.
3. Invoke the exact bundled `yt-dlp` executable with structured arguments,
   never through a shell and never through PATH.
4. Pass the exact bundled Deno path through `--js-runtimes`; official
   `yt-dlp_macos` already includes the matching EJS challenge scripts.
5. Disable playlists and download at most one best-audio source into a new
   `tempfile::TempDir`.
6. Locate the supported downloaded media and pass it to bundled Whisper.
7. Return the transcript and original URL as source provenance.
8. Drop the temporary directory after offline transcription has finished.

The `TempDir` must remain owned by the command for the whole download and
transcription. Rust RAII deletion is a security/privacy invariant: success,
download failure, transcription failure, and early return all delete temporary
media. Do not replace it with a persistent cache. Never pass the video URL or an
executable string through a shell. Keep playlists disabled unless the product
gets an explicit bounded batch design.

Homebrew, Python, ffmpeg, an external `yt-dlp`, and a Whisper server are not
runtime prerequisites. Browser preview cannot run the YouTube workflow.

## Linking model

A `Concept` is a Space-scoped reusable phrase. `canonicalNoteId` identifies its
primary wiki article or note, and the normalized concept label must match that
note's title. `noteIds` retains the canonical target and compatibility data for
older multi-target concepts; contextual project notes belong in relationships,
not as alternate canonical destinations.

Concepts are reconciled from:

- note and canonical wiki-article titles;
- deliberate note aliases;
- AI import vocabulary whose `canonicalTitle` exactly names a returned or
  existing article;
- phrases explicitly taught with the editor's Link tool.

Tags are excluded. Do not seed, merge, or auto-link a concept from `Note.tags`.

The editor Link tool uses an empty destination selection as the normal
Wikipedia-style path: create or reuse the exact named article, then register it
as the concept's canonical target. A non-empty destination selection is an
explicit compatibility override for an existing manual/legacy branch. Never
default a new phrase to the note currently being edited.

Navigation follows one deterministic rule: open a valid canonical article
directly; otherwise open the sole valid target directly; use the connections
canvas only when a legacy concept has several valid targets and no canonical
article. A missing target does nothing safely. Do not add hover previews or make
the ambiguity canvas part of ordinary canonical navigation.

Automatic matching must prefer longer phrases, respect word boundaries and case
settings, avoid unsafe ranges such as code and existing links, and never mutate
the underlying prose merely to render a link. Do not merge project notes merely
because they mention the same phrase. All target IDs must resolve inside the
active Space.

### Canonical wiki-article import contract

AI organization returns contextual project notes separately from durable wiki
articles. Each wiki article is Space-scoped and must contain:

- `## Overview`: a concise, high-confidence explanation. It may use stable
  general knowledge needed to explain the subject.
- `## In <Space name>`: why the subject matters to this project, grounded in the
  supplied source and Space context.
- `## From the imported material`: source-grounded details, when present.
- `## Uncertainties`: explicit gaps or unresolved claims, when present.

Never invent citations, quotations, dates, statistics, current facts, or
contested specifics for an overview. Project relevance and source-grounded
sections must follow from the supplied material.

Canonical articles are upserts:

1. Normalize the exact title inside the active Space and coalesce matching
   articles across the current import batch.
2. Prefer the one existing concept whose canonical article has that title;
   otherwise reuse the one existing exact-title note. Never create a suffixed
   duplicate for an established canonical title.
3. Create a new article only when no unambiguous match exists. New articles are
   draft `wiki` notes with canonical sections and source provenance.
4. When reusing an article, preserve its ID, existing prose, and review status.
   Fill only an empty summary, merge aliases/tags/source IDs, and append a
   source-scoped context block only when its `orion-source` marker is absent.
5. A returned concept's `canonicalTitle` must resolve to exactly that returned
   or existing article. `relatedTitles` create relationships to project notes;
   they are not additional hyperlink destinations.

Never search another Space for an upsert target.

## Chat contract

The visible route and navigation label are **Chat**. It is one persistent
conversation scoped to the active Space, not a thinking-card workspace. Build
each request from the current prompt, up to 12 recent turns, and bounded context
from that Space: up to 80 notes, 30 sources, and 120 concepts. Never read context
from another Space.

For vault compatibility, Chat history remains in `Space.studio.messages`.
Existing `studio.cards`, `selectedCardIds`, `activeConceptId`, `view`, `zoom`,
`chatCollapsed`, and `canvasCollapsed` fields must continue to validate and
round-trip, but they are dormant compatibility data. Do not render them, mutate
them as a workflow, include them in Chat requests, or use them to reactivate
card proposals, selection, promotion, dialectic, or canvas UI. Do not add a
parallel Chat persistence field without an explicit schema migration.

## AI boundaries

Desktop AI calls originate in Rust. Imported text, notes, sources, concepts,
and prior Chat messages are untrusted data, not instructions.

- Organizer calls use `POST /v1/responses`, strict JSON schema, `store: false`,
  bounded existing-note context, and the built-in knowledge-architect prompt.
  That context can include up to 6,000 characters from an existing `wiki`
  article body so the model can reuse it; do not include ordinary note bodies.
- Chat uses a separate strict reply schema and prompt. Its request must contain
  only the bounded Space context and history described above, with no legacy
  card or layout payload.
- Do not invent citations or silently claim AI output was verified.
- Keep manual behavior available when the key is absent or an AI request fails.
- Any new renderer-to-Rust command needs validated input and a narrow purpose.
- The renderer CSP intentionally blocks arbitrary network access.

## UI principles

Orion should feel calm, editorial, and spatial rather than dashboard-heavy.
Reuse the existing colors, surfaces, typography, radii, and compact scale in
`App.css`. Prefer a single clear action and progressive disclosure. Preserve:

- direct editing with the animated toolbar;
- direct canonical article navigation, with the right-hand connections canvas
  reserved for unresolved legacy ambiguity instead of a graph;
- no reference-hover popovers on automatic or explicit concept links;
- strong empty states with no fake content;
- keyboard access, focus trapping, visible focus, reduced-motion behavior, and
  useful ARIA labels;
- desktop layouts down to the configured 1024×680 minimum, plus responsive
  browser-preview layouts.

Do not introduce a separate Markdown editor, read/write tabs, a Link Lens button,
or a persistent import button floating over unrelated screens.

## Change checklist

Before handoff:

1. Inspect the relevant components, data types, validators, native commands,
   configuration, and existing tests.
2. Make the smallest coherent change and preserve unrelated user work.
3. Add tests for pure behavior, validation, migrations, and security-sensitive
   parsing.
4. Run `npm run check`.
5. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
6. Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.
7. For native changes, run `npm run tauri build`.
8. Exercise the finished UI in a real browser or desktop runtime at normal and
   narrow sizes; inspect console errors and keyboard behavior.
9. Update `README.md` and this file when behavior or operational assumptions
   changed.
10. Refresh distributable artifacts and release notes when the task includes a
    release build. From the workspace root, use
    `./script/package_release.sh <release-label>` so the DMG is staged to a new
    inode before publication. Never use an in-place copy to replace a DMG that
    may be mounted; doing so corrupts the live mounted backing store and can
    leave a partial application after Finder error `-36`.

Never claim the media workflow was end-to-end verified unless the exact
finished app bundle downloaded a real bounded YouTube source with its bundled
`yt-dlp` + Deno and transcribed that downloaded media with its bundled model.
A compile, unit test, or setup-version check alone verifies integration shape,
not decoding, model inference, or current YouTube extraction.
