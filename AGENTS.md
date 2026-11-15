# Orion Agent Guide

This file and the manuals in `docs/agents/` are the durable operating manual
for anyone changing Orion. Read this file first. Then, before editing, read
every manual that [the index](#how-this-manual-is-organised) lists for the area
you are changing. Those manuals carry the same authority as this file. Keep both
accurate when architecture, commands, security boundaries, schemas, or release
procedures change.

The active physical checkout is `/Users/zzz/Developer/orion`, outside iCloud.
The previous Documents path is a compatibility symlink for existing Codex tasks
and launch paths. Prefer the Developer path for new work. The older Developer
snapshot is preserved at `~/Developer/orion-before-cutover-20261011-163852`;
it is an archive, not another active checkout. Do not delete the compatibility
link, archived tree or retained conflict copies as incidental cleanup.
See `docs/development-checkout.md` for migration evidence and path ownership.

## How this manual is organised

`AGENTS.md` holds what applies to every change: product intent, the rules that
protect a user's library, the layout, the commands and the handoff checklist.
Each area's contract lives in exactly one manual:

| Area | Manual |
| --- | --- |
| The vault file and its writers, preserved source text, backups, multiple windows | [`docs/agents/vault-storage.md`](docs/agents/vault-storage.md) |
| Note surface, rich editor, blocks, tables, images, narration, writing sessions, note and source deletion | [`docs/agents/notes-and-editor.md`](docs/agents/notes-and-editor.md) |
| Dictation and its cleanup, bundled Whisper, media and YouTube transcription | [`docs/agents/dictation-and-transcription.md`](docs/agents/dictation-and-transcription.md) |
| To-dos, tickets, boards, ticket inference, inline dates, Home's work and calendar sections | [`docs/agents/work-and-calendar.md`](docs/agents/work-and-calendar.md) |
| Local and AI search, concepts, automatic and explicit links, linked and canonical articles | [`docs/agents/search-and-linking.md`](docs/agents/search-and-linking.md) |
| Note digests, the knowledge hierarchy and the Across this Space overview | [`docs/agents/space-knowledge.md`](docs/agents/space-knowledge.md) |
| Import queue, parsing, OCR, webpages, provider scheduling, knowledge orchestration | [`docs/agents/import-pipeline.md`](docs/agents/import-pipeline.md) |
| Web article, Word and Markdown export | [`docs/agents/export.md`](docs/agents/export.md) |
| Generate from New note, Write, Rewrite, Enrich and image generation in the editor | [`docs/agents/generation-and-inline-ai.md`](docs/agents/generation-and-inline-ai.md) |
| Chat threads, reading, citations, web research, edits from Chat, passage discussions | [`docs/agents/chat.md`](docs/agents/chat.md) |
| Live voice, voice workers and findings, completed-task working views | [`docs/agents/voice.md`](docs/agents/voice.md) |
| ChatGPT plan sign-in, the model picker, the ElevenLabs voice studio | [`docs/agents/ai-providers.md`](docs/agents/ai-providers.md) |
| The bundled MCP server, its vault and library tools, the Codex plugin | [`docs/agents/mcp-connector.md`](docs/agents/mcp-connector.md) |
| Workflows a connector runs through the open app, editor context, actions and review, voice work orders | [`docs/agents/desktop-workflows.md`](docs/agents/desktop-workflows.md) |
| Themes, Home atmosphere, window glass, app icon, typography, interface principles | [`docs/agents/ui-and-appearance.md`](docs/agents/ui-and-appearance.md) |
| Preview builds, the updater, packaging, signing and notarization | [`docs/agents/build-and-release.md`](docs/agents/build-and-release.md) |

Each manual opens with the paths it governs. A change that touches several
areas reads several manuals.

Keeping the manual usable:

- A rule lives in one place. Link to it instead of restating it.
- When behaviour changes, update the manual that owns it in the same change.
- A new feature contract goes in the manual that owns its area, never in this
  file. Add a manual and a row above when an area has no owner.
- Keep this file short enough to read in full at the start of every task.
- When a manual and the code disagree, do not guess which is right. Read the
  code and its tests, settle the intended behaviour, and correct the manual in
  the same change.

## Product intent

Orion is a beautiful, local-first Tauri knowledge atlas. People import source
material or write directly in a note; Orion turns that material into a personal
wiki with reusable concepts and intelligent hyperlinks.

These product decisions are intentional:

- Orion is not a graph canvas and must not grow an Obsidian-style graph.
- The app starts empty. Do not add sample notes, mock sources, demo concepts, or
  seeded Chat messages to a real vault.
- Durable link phrases resolve to one canonical wiki article or note inside the
  active Space. Clicking a canonical concept navigates directly to that article.
- Opening a note through a link or ordinary navigation control resets the
  central reading pane to the top; scroll position must never leak from the
  previous note. Back and Forward are the intentional exception: each history
  entry captures its own reading position when left and restores that exact
  position when revisited.
- The right-hand connections canvas is a compatibility surface only for an
  unresolved legacy concept with several valid targets and no canonical article.
  Do not route normal concept navigation through it or add reference-hover UI.
- Tags organize, filter, and export notes. They are not link vocabulary and must
  never create automatic concepts merely because they appear on a note.
- Spaces are hard project boundaries. Notes, concepts, sources, relationships,
  Chat history, navigation, and automatic links must never leak across Spaces.
- AI is optional. Writing, local imports, on-device OCR and transcription,
  source provenance, links, search, Spaces, and web/Markdown export must remain
  useful without an OpenAI or Anthropic key.
- Notes are permanent, editable, and evolving from the moment they are created.
  Generation progress is transient job state, never a user-facing note lifecycle.
  Preserve provenance and uncertainty without review-status labels.

The product decisions for one feature sit with that feature's contract: the
note surface and deletion in `notes-and-editor.md`, dictation in
`dictation-and-transcription.md`, to-dos, tickets, boards and the calendar in
`work-and-calendar.md`, Chat in `chat.md`, and appearance in
`ui-and-appearance.md`.

## Stack and layout

- React 19, TypeScript, Vite, and plain CSS in the renderer.
- Tiptap 3 powers the rich note editor while Markdown remains the portable
  persisted representation.
- Tauri 2 and Rust provide persistence, OS-keychain access, OpenAI and Anthropic
  calls, native dialogs, media transcription, YouTube downloading, and export.
- Vitest covers renderer logic. Native Rust unit tests live with their owning
  modules, with the remaining command tests in `src-tauri/src/lib.rs`.

Important paths:

```text
src/App.tsx                         vault/Space orchestration and app actions
src/App.css                         complete visual system and responsive UI
src/types.ts                        persisted and IPC data contracts
src/data/defaults.ts                clean-vault defaults and new settings
src/components/NoteView.tsx         direct rich-text note surface
src/components/VoiceMemoButton.tsx  bounded note-local microphone capture
src/components/ConnectionCanvas.tsx legacy concept disambiguation
src/components/ImportStudio.tsx     unified document, paste, media, and URL queue
src/components/ExportDialog.tsx     bounded web/Markdown scope and format picker
src/components/ChatView.tsx          single Space-scoped Chat surface
src/components/SettingsView.tsx     AI, transcription, linking, theme, data
src/components/HomeAtmosphere.tsx   lazy home-atmosphere selection
src/components/SignalDecay.tsx      low-power responsive harmonic shader
src/components/LineWaves.tsx        low-power OGL contour shader
src/components/QuietLoom.tsx        original local WebGL woven-light shader
src/components/Nova.tsx             original animated plasma volume and sparks
src/components/Flux.tsx             full-width flowing plasma currents
src/components/TidalGlass.tsx       full-width procedural liquid caustics
src/components/PrismDrift.tsx       animated crystalline height-field facets
src/components/Nebula.tsx           layered full-width cloud and star field
src/components/Emberwake.tsx        advected full-width spark streams and wakes
src/components/GravitySilk.tsx      billowing satin field with analytic normals
src/components/Mirage.tsx           drifting procedural glass-lens field
src/components/Opal.tsx          local iridescent glass ribbons
src/components/RippleGlass.tsx   local refractive optical ripples
src/components/ProceduralAtmosphere.tsx shared bounded WebGL lifecycle
src/components/atmosphereShader.ts  local GLSL palette and room composition
src/components/DotField.tsx         settling Canvas 2D interaction field
src/lib/icons.ts                    direct Lucide exports; never use its barrel
src/lib/files.ts                    local document parsing
src/lib/concepts.ts                 vocabulary reconciliation and link teaching
src/lib/linkedArticle.ts            selected-text article request and AI merge
src/lib/wikiEnrichment.ts           new-note wiki refresh requests and safe merge
src/lib/wiki.ts                     link resolution, references, and backlinks
src/lib/chat.ts                     bounded Chat context and message updates
src/lib/chatEdits.ts                current-note edit authority, evidence and stale guards
src/lib/chatEditsProtocol.json      shared native/browser edit limits and instructions
src/components/ChatEditPreview.tsx  transient before/after preview and Apply/Discard
src/components/editor/chatEditTransaction.ts one undoable rich-editor edit
src/lib/aiImages.ts                 adaptive illustration research and resumable checkpoints
src/lib/imageContextSearch.ts       incremental Space-local exact passage search
src/lib/aiImagePlanningProtocol.json shared read-only image planning instructions/schema
src-tauri/src/image_planning.rs     cancellable provider transport for illustration plans
src/lib/studio.ts                   dormant Studio-state normalization
src/lib/storage.ts                  validated IPC and browser-preview fallbacks
src/lib/transcription.ts            transcript-to-source normalization
src/lib/tasks.ts                    Space task extraction and persisted toggles
src/lib/tickets.ts                  cached note-backed tickets and board markers
src/lib/ticketInference.ts          whole-note bounded readers, local task collection and guarded acceptance
src/lib/calendarRecognition.ts      yielded local date recognition over immutable notes
src/components/CalendarPicker.tsx   shared keyboard all-day picker and due-date control
src/components/HomeCalendar.tsx     Space-local dates and agenda
src/components/HomeTickets.tsx     adaptive To-dos/Tickets sections and session views
src/components/Tickets.tsx         shared board, inline ticket entry and creation dialog
src/lib/webExport.tsx               offline HTML scope, rendering, and privacy
src-tauri/src/lib.rs                native commands and trust boundaries
src-tauri/src/local_transcription.rs offline media/dictation, Whisper runtime and speech alignment
src-tauri/src/knowledge_schemas.rs  pure organizer/knowledge JSON schemas and provider schema adapters
src-tauri/src/connector_installation.rs bundled connector validation and native install-page openers
src-tauri/src/chat_reading.rs       bounded reading schemas, requests, checkpoints and parser tests
src-tauri/mcp-server/               local read-write MCP server for Claude
src-tauri/tauri.conf.json           window, CSP, identity, and bundle settings
src-tauri/native/OrionOCR/           Apple Vision text-recognition sidecar source
src-tauri/native/OrionWhisper/       AVFoundation + whisper.cpp sidecar source
src-tauri/binaries/                  bundled native executables
src-tauri/resources/                 model, checksums, notices, and licenses
src-tauri/vendor/whisper.framework   official whisper.cpp 1.9.1 framework
mcp/orion-claude/                    Claude desktop-extension manifest and docs
codex/orion/                         canonical Codex plugin source
src-tauri/resources/Orion-Codex-Plugin/ generated bundled plugin tree
script/build_mcp_connector.sh        signed MCPB package builder and verifier
script/build_codex_plugin.sh         Codex plugin staging and validation
script/build_ocr_sidecar.sh          Apple Silicon Vision OCR helper builder
script/test_codex_plugin.mjs         plugin contract and read-write MCP harness
script/test_mcp_connector.mjs        stdio lifecycle and Space-isolation harness
README.md                           user and contributor documentation
```

## Everyday commands

Run from this directory:

```bash
npm ci
npm run dev
npm test
npm run build
npm run build:mcp
npm run build:codex
npm run build:desktop
npm run check
npm run tauri dev
./script/build_ocr_sidecar.sh
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/mcp-server/Cargo.toml
npm run tauri build
```

`npm run check` runs renderer tests and a production renderer build.
Vitest excludes `outputs/`, which may contain archived diagnostic test fixtures;
maintained application tests belong in `src/`. TypeScript excludes local
`* 2.ts` / `* 2.tsx` duplicate copies under `src/`; these retained copies are
not maintained application source and must not be imported.
`npm run tauri build` is the canonical native integration and release check.
Native artifacts are produced under `src-tauri/target/release/bundle/`.
Preview builds, the pinned voice SDK patch and release packaging are in
`docs/agents/build-and-release.md`.

## Persistence and schema rules

The canonical desktop vault is `vault.json` in Tauri's application data folder
for `app.orion.knowledge`. It is a schema-versioned `OrionVault` containing one
or more schema-versioned `AppSnapshot` Spaces. Saves are serialized and use a
flushed temporary file plus atomic replacement.

- Never silently replace an invalid vault with an empty one.
- Never persist either provider key in the vault, browser storage, logs,
  exports, or renderer state. The desktop keys live as separate OS credential
  entries (`openai-api-key` and `anthropic-api-key`).
- Treat additions to persisted interfaces in `src/types.ts` as migrations.
  Existing vaults must continue to validate. New optional settings should be
  accepted by `src/lib/storage.ts`, then hydrated through `defaultSettings` in
  `App.tsx`.
- Update every validator and exhaustive `SourceKind` mapping when adding a
  source type.
- Preserve the original extracted/transcribed source even when AI input must be
  bounded.
- `Note.lastOpenedAt` is optional legacy navigation metadata. Opening or
  revisiting a note may update it without changing the note's knowledge
  `updatedAt`, but it must never reorder the sidebar. The active Space's stored
  note-array order is the stable visible order.
- Settings currently apply across all Spaces; content remains Space-local.

Multiple windows and their merge rules are in `docs/agents/vault-storage.md`.
Persisted appearance settings are in `docs/agents/ui-and-appearance.md`.

Browser preview uses `localStorage` for development and keeps both provider keys
in memory for the current tab. Desktop behavior is authoritative.

## AI boundaries

Desktop AI calls originate in Rust. Imported text, notes, sources, concepts,
and prior Chat messages are untrusted data, not instructions.

- Models beginning `claude-` route to Anthropic and all other supported model
  IDs route to OpenAI. One Anthropic key serves Fable 5, Opus 5, and Sonnet 5;
  never store duplicate keys per model. Never fall back between providers unless
  the user enabled the bounded Wave 2 failover setting; auth/billing failures and
  cancellation never qualify.
- Organizer calls use OpenAI `POST /v1/responses` or Anthropic
  `POST /v1/messages`, strict JSON schema, bounded existing-note context, and
  the built-in knowledge-architect prompt. OpenAI calls set `store: false`.
  Compatibility organizer context is the shared 56 KiB bodyless digest
  directory; orchestration may open a full existing note only through the exact
  route-and-owner rules in `docs/agents/import-pipeline.md`. Concepts must be inferred from semantic roles,
  relationships, and aliases rather than keyword frequency. Explicit actions
  may become `- [ ]` items in project notes, but the model must not invent tasks.
- Chat's `chat-reading` schema carries bounded `readRequests`; reading steps
  cannot write. Without an attached note or creation request it is reply-only
  at 6,000 output tokens. Explicit prompt-authorized note creation may use strict
  `reply` + `noteActions` at 12,000 tokens. A captured attached note enables
  `editIntent`, `noteEdits` and `noteRewrite` with the same ceiling for unsaved
  proposals, followed by explicit local acceptance. This does not grant creation
  or write authority. Requests contain only bounded Space context and history,
  with no legacy card or layout payload. Inline writing keeps its own reply-only
  schema even though it shares the transport command.
- Living-overview generation uses the organizer's strict schema but accepts only
  one returned note as the overview artifact. It must write an editorial title
  and cohesive orientation rather than a source inventory, provenance section,
  change log, or ordinary note. It never creates note/type/status UI.
- Do not invent citations or silently claim AI output was verified.
- Keep manual behavior available when the key is absent or an AI request fails.
- Any new renderer-to-Rust command needs validated input and a narrow purpose.
- The renderer CSP intentionally blocks arbitrary network access.

## Change checklist

Before handoff:

1. Inspect the relevant components, data types, validators, native commands,
   configuration, and existing tests.
2. Make the smallest coherent change and preserve unrelated user work.
3. Add tests for pure behavior, validation, migrations, and security-sensitive
   parsing.
4. Run `npm run check`.
5. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
6. Run `cargo test --manifest-path src-tauri/mcp-server/Cargo.toml`.
7. Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and
   `cargo fmt --manifest-path src-tauri/mcp-server/Cargo.toml -- --check`.
8. For native changes, run `npm run tauri build`.
9. Exercise the finished UI in a real browser or desktop runtime at normal and
   narrow sizes; inspect console errors and keyboard behavior.
10. Update `README.md`, this file and the owning manual in `docs/agents/` when
   behavior or operational assumptions changed.
11. Refresh distributable artifacts and release notes when the task includes a
    release build. From the workspace root, use
    `./script/package_release.sh <release-label>` for the ordinary Small
    edition, or `ORION_WHISPER_MODEL=medium ./script/package_release.sh
    <release-label>.m` for the Medium edition, so the DMG is staged to a new
    inode before publication. Never use an in-place copy to replace a DMG that
    may be mounted; doing so corrupts the live mounted backing store and can
    leave a partial application after Finder error `-36`.
    `docs/agents/build-and-release.md` has the full packaging contract.

Never claim the media workflow was end-to-end verified unless the exact
finished app bundle downloaded a real bounded YouTube source with its bundled
`yt-dlp` + Deno and transcribed that downloaded media with its bundled model.
A compile, unit test, or setup-version check alone verifies integration shape,
not decoding, model inference, or current YouTube extraction.
