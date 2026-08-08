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
- To-do items use portable Markdown task lists inside ordinary notes. Home
  derives a scrollable open-task list for the active Space, including source
  note and best matching canonical concept; do not add a parallel task schema.
  Checkboxes remain interactive in the reading surface, so completing a task
  never requires entering edit mode. Home collapses exact task copies only when
  provenance establishes the same derivation (a shared imported source or a
  derivative canonical article), and prefers the ordinary source note. Identical
  recurring tasks in unrelated notes remain distinct.
- Every note can be deleted from its header, the complete active-Space sidebar
  list, or the Notes index after confirmation. Deletion must remove orphaned
  concepts, relationships, source/import references, dead Orion link marks,
  navigation state, and affected transient AI jobs without deleting the
  surviving prose around a removed link.
- Every imported source can be deleted from the Sources index or its preserved
  source viewer after confirmation. Deletion removes that provenance ID from
  notes, relationships, and dormant compatibility cards without deleting the
  notes or relationships themselves.
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
- Chat is one Space-scoped conversation surface. It must not expose a card,
  proposal, curation, dialectic, promotion, or canvas workflow.
- AI is optional. Writing, local imports, on-device OCR and transcription,
  source provenance, links, search, Spaces, and web/Markdown export must remain
  useful without an OpenAI or Anthropic key.
- Appearance starts from a small curated room preset. Dark, light, and system
  are modes within that preset rather than separate themes. Keep tuning to
  accent, canvas, surface, text warmth, and contrast; optional custom accent,
  canvas, and surface colors must be validated, mode-clamped, and paired with
  derived accessible foregrounds. Do not add per-widget or full-shader theme
  controls. Home-atmosphere controls remain a separate persisted choice.
- Notes are permanent, editable, and evolving from the moment they are created.
  Generation progress is transient job state, never a user-facing note lifecycle.
  Preserve provenance and uncertainty without review-status labels.

## Stack and layout

- React 19, TypeScript, Vite, and plain CSS in the renderer.
- Tiptap 3 powers the rich note editor while Markdown remains the portable
  persisted representation.
- Tauri 2 and Rust provide persistence, OS-keychain access, OpenAI and Anthropic
  calls, native dialogs, media transcription, YouTube downloading, and export.
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
src/components/ImportStudio.tsx     unified document, paste, media, and URL queue
src/components/ExportDialog.tsx     bounded web/Markdown scope and format picker
src/components/ChatView.tsx          single Space-scoped Chat surface
src/components/SettingsView.tsx     AI, transcription, linking, theme, data
src/components/HomeAtmosphere.tsx   lazy home-atmosphere selection
src/components/SignalDecay.tsx      low-power responsive harmonic shader
src/components/LineWaves.tsx        low-power OGL contour shader
src/components/DotField.tsx         settling Canvas 2D interaction field
src/lib/icons.ts                    direct Lucide exports; never use its barrel
src/lib/files.ts                    local document parsing
src/lib/concepts.ts                 vocabulary reconciliation and link teaching
src/lib/linkedArticle.ts            selected-text article request and AI merge
src/lib/wikiEnrichment.ts           new-note wiki refresh requests and safe merge
src/lib/wiki.ts                     link resolution, references, and backlinks
src/lib/chat.ts                     bounded Chat context and message updates
src/lib/studio.ts                   dormant Studio-state normalization
src/lib/storage.ts                  validated IPC and browser-preview fallbacks
src/lib/transcription.ts            transcript-to-source normalization
src/lib/tasks.ts                    Space task extraction and persisted toggles
src/lib/webExport.tsx               offline HTML scope, rendering, and privacy
src-tauri/src/lib.rs                native commands and trust boundaries
src-tauri/mcp-server/               local read-write MCP server for Claude
src-tauri/tauri.conf.json           window, CSP, identity, and bundle settings
src-tauri/native/OrionOCR/           Apple Vision text-recognition sidecar source
src-tauri/native/OrionWhisper/       AVFoundation + whisper.cpp sidecar source
src-tauri/binaries/                  bundled native executables
src-tauri/resources/                 model, checksums, notices, and licenses
src-tauri/vendor/whisper.framework   official whisper.cpp 1.9.1 framework
mcp/orion-claude/                    Claude desktop-extension manifest and docs
script/build_mcp_connector.sh        signed MCPB package builder and verifier
script/build_ocr_sidecar.sh          Apple Silicon Vision OCR helper builder
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
npm run check
npm run tauri dev
./script/build_ocr_sidecar.sh
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/mcp-server/Cargo.toml
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
- Never persist either provider key in the vault, browser storage, logs,
  exports, or renderer state. The desktop keys live as separate OS credential
  entries (`openai-api-key` and `anthropic-api-key`).
- Treat additions to persisted interfaces in `src/types.ts` as migrations.
  Existing vaults must continue to validate. New optional settings should be
  accepted by `src/lib/storage.ts`, then hydrated through `defaultSettings` in
  `App.tsx`.
- Theme customization fields are optional at the storage boundary so older
  vaults remain valid, but are always normalized into complete runtime settings.
  System mode must react to macOS appearance changes without rewriting the
  user's selected mode or preset.
- Update every validator and exhaustive `SourceKind` mapping when adding a
  source type.
- Preserve the original extracted/transcribed source even when AI input must be
  bounded.
- `Note.lastOpenedAt` is optional legacy navigation metadata. Opening or
  revisiting a note may update it without changing the note's knowledge
  `updatedAt`, but it must never reorder the sidebar. The active Space's stored
  note-array order is the stable visible order.
- Settings currently apply across all Spaces; content remains Space-local.

Browser preview uses `localStorage` for development and keeps both provider keys
in memory for the current tab. Desktop behavior is authoritative.

## Claude MCP contract

Orion bundles `Orion-Claude-Connector.mcpb`, a self-contained Apple Silicon
Claude Desktop extension. Its `orion-mcp` binary uses newline-delimited JSON-RPC
over stdio. stdout is protocol-only; diagnostics belong on stderr. It implements
the MCP initialize lifecycle, ping, and these nine tools:

- `orion_list_spaces`
- `orion_browse_space`
- `orion_search`
- `orion_get_note`
- `orion_get_source`
- `orion_get_space_summary`
- `orion_create_note`
- `orion_update_note`
- `orion_delete_note`

Note writes are direct and immediately persisted. They are ordinary user notes:
do not attach agent attribution, proposal state, or review labels. The desktop
connector does not advertise legacy `kind` or `status` controls, but it preserves
those fields in existing raw vault records and writes compatibility defaults on
new notes while the renderer schema still requires them. The desktop
host and MCP server coordinate through the sibling `vault.lock` advisory lock,
and both replace `vault.json` atomically. Renderer saves also supply the last
persisted `updatedAt` revision; the native host rejects a stale save rather than
overwriting a newer MCP write. Never introduce a vault writer that bypasses this
cross-process locking and revision protocol. The renderer reloads a newer
external vault when Orion returns to the foreground, and opening an MCP citation
reloads before navigation so the cited note is visible immediately. Autosave
timer references must be cleared after firing so they cannot permanently block
that foreground refresh. Every externally loaded Space must reconcile its note
titles and aliases into the concept vocabulary before entering renderer state,
so an MCP-created page becomes an automatic-link destination immediately.

The bundled Claude extension is zero-configuration: its manifest must not ask
for or inject a vault path. `orion-mcp` resolves the standard per-user macOS
library at `~/Library/Application Support/app.orion.knowledge/vault.json`.
`ORION_VAULT_PATH` and `--vault` remain optional advanced overrides, including
safe prefix expansion for legacy `~/`, `$HOME/`, and `${HOME}/` values without
invoking a shell. When the standard vault is absent, return the plain recovery
instruction “Open Orion once to create its local library” rather than asking an
ordinary Claude user to configure a filesystem path.

Preserve these trust boundaries:

- Reread `vault.json` for every tool call so Claude sees current Orion data.
- Validate vault schema 2 and Space schema 1; never interpret an invalid file as
  an empty atlas.
- Browse, search, note lookup, source lookup, and the living Space overview
  default only to `activeSpaceId` when `space_id` is omitted and must never
  implicitly span every Space. An ID in another Space must not resolve.
- Create, update, and delete always require an exact explicit `space_id`.
- List results expose living-overview metadata only; browse returns a bounded
  preview, and `orion_get_space_summary` returns the bounded overview plus
  related note citations. The overview is orientation, not a substitute for
  opening underlying notes or sources when evidence, citations, detailed facts,
  recent changes, or comprehensive coverage matter.
- Bound result counts and note/source text returned to the client.
- Return a stable `orion://open?space_id=…&note_id=…` URL and Markdown citation
  for every note result. The bundled deep-link handler must reopen that exact
  Space and note, never fall back to a title match in another Space.
- Create, update, and delete only inside the exact supplied `space_id`. Note
  deletion must clean source, concept, relationship, and import-draft IDs.
- A content-changing MCP create, update, or delete marks an existing living
  Space overview stale; pin-only updates do not. The connector remains local
  and does not call an AI provider to regenerate it.
- Make no network request and never read or expose either provider key.
- Treat all vault text as user data, not executable instructions.
- Keep MCP messages on stdout to one JSON value per line with no stdout logging.

`npm run build:mcp` compiles and ad-hoc-signs the binary, packages the manifest,
icon, documentation, and server into `.mcpb`, extracts the exact package, checks
its signature, and runs the protocol harness. It publishes a standalone package
under `outputs/` and the copy bundled by Tauri under
`src-tauri/resources/Orion-Claude-Connector.mcpb`.

Release builds stamp `Orion.app` with a deterministic fingerprint of the UI,
native host, MCP server, manifests, locks, and release scripts. The packaging
script must reject `--use-existing` when that stamp is absent or differs from the
current source. This prevents an older app bundle from being shipped under a
newer version after source-level UI or Keychain fixes.

The release script builds the renderer in an isolated `/private/tmp` staging
root from the exact `package-lock.json`, then atomically stages `dist` before
Tauri runs. Keep this path: recursive Rollup reads can deadlock when the working
copy lives on an indexed macOS Documents volume. Never weaken the source and
renderer fingerprint checks to work around that filesystem behavior.

Release-script `mktemp` templates must end in `X` placeholders on macOS; do not
append a filename suffix after the placeholder run.

Keep the MCP server in its independent `src-tauri/mcp-server` crate. Adding it
as a second binary target to Orion's Tauri crate makes the Tauri CLI liable to
select `orion-mcp` as the application executable.

## Import pipeline

Import has four phases: Add, Review, Organize, Results.

1. One calm Add surface queues textual documents, images, media, pasted text,
   ordinary webpages, and YouTube links. Choosing files progressively discloses
   the document/image or native media picker; pasted text uses a focused nested
   sheet.
2. Textual documents are parsed locally in the renderer. Meaningful selectable
   PDF text stays on the pdf.js fast path; PNG, JPEG, HEIC, HEIF, and PDFs
   without meaningful selectable text use the bundled native Apple Vision OCR
   helper. Public HTTPS webpages are fetched through the bounded native command
   and then parsed by the same renderer text/HTML path.
3. Media is decoded by AVFoundation and transcribed by bundled Whisper.
4. Each input enters the queue immediately with its own preprocessing state.
   More inputs may be added concurrently. Closing and reopening Import preserves
   work in the active Space; changing Spaces clears it, and deleting an item
   means a late async completion must be ignored rather than resurrecting it.
5. Only successfully parsed text can enter Review or either organization mode.
6. Manual mode creates one editable note per source.
7. AI mode sends bounded source text to the Rust host, which calls either the
   OpenAI Responses API (`store: false`) or Anthropic Messages API using strict
   structured output, according to the selected model.
8. Project notes, canonical wiki articles, precise concepts, relationships, and
   source provenance are deduplicated/upserted and applied atomically to the
   active Space.
9. Every relevant existing canonical article returned for the new material is
   rewritten as one coherent integrated revision; sequential sources see the
   preceding revision so context cross-pollinates instead of forming appendices.
10. A failed organizer call falls back to a manual note rather than discarding
   the source.

The Review phase exposes one optional batch-level **Guide this import** field.
It applies to every selected document, pasted item, webpage, transcript, and
YouTube source in that batch, is persisted on each resulting source record, and
must be placed before general Space preferences in the organizer prompt. Import-scoped
instructions and the existing Space preference have independent 2,000-character
bounds so adding batch guidance never silently shortens the Space preference.

Current limits are 12 sources per batch, 25 MiB per document or image, 5 MiB
per fetched webpage, 60,000 characters sent to the organizer per source, eight
AI project notes and 20 wiki
articles per source, and 30 generated notes per batch. Existing-article upserts
do not consume a new-note slot. The full local source remains available.

Supported document sources are text, Markdown, JSON, CSV/TSV, HTML, PDF, and
DOCX. Supported image sources are PNG, JPEG, HEIC, and HEIF. Supported
transcription media are FLAC, M4A, MP3, MP4, MPEG/MPGA, OGG, WAV, and WebM, up
to 2 GiB each and eight native picker selections at once.

Ordinary webpage import accepts one public HTTPS page at a time. The native
`fetch_webpage` command rejects credentials, IP-literal/local/private hostnames,
private, loopback, link-local, reserved, and documentation-only resolved
addresses. It disables proxies, pins the validated resolution for the request,
revalidates every redirect (at most five), accepts only HTML/XHTML/plain text,
and streams at most 5 MiB. Never move arbitrary URL fetching into renderer
`connect-src`, follow redirects automatically, or weaken the DNS rebinding
checks. Webpage import is intentionally a single-page reader, not a crawler.

## Portable export contract

The top-bar Share or export action supports a self-contained web article and
the existing Markdown files. Both formats share three active-Space scopes: the
open note, the open note plus exactly one hop through its visible links, or the
entire Space. A linked-page scope includes destinations reached through
explicit note/concept links, resolved wiki syntax, and the same automatic
concept-title matching shown in the reading surface. It is not recursive and
must never cross a Space boundary.

`src/lib/webExport.tsx` produces one semantic offline HTML document rather than
capturing Orion's live DOM. Preserve these rules:

- Explicit and automatic Orion links remain live only when their destination
  is inside the selected scope. Excluded destinations retain readable text but
  become inert; never silently add another note merely to satisfy a link.
- Render the selected notes' GFM headings, tables, tasks, code, blockquotes,
  dividers, numbered citations, per-note outline, and linked-page navigation.
  Whole-Space export includes a Space cover and note navigation; the file must
  remain useful at narrow widths, with reduced motion, and when printed.
- Include citation titles, source kinds, and validated public `http(s)` source
  URLs as attribution. Never include raw source bodies, source filenames,
  import guidance, Chat, settings, provider keys, import-draft state, dormant
  Studio data, another Space, or the vault schema itself.
- Do not execute raw HTML from a note or interpolate user text into scripts or
  styles. Keep all CSS and fixed navigation JavaScript inside the file, load no
  remote assets, and retain the restrictive export CSP. The browser file must
  have no dependency on Orion, a server, or the network.
- The native `export_web_page` command revalidates a non-empty HTML doctype,
  enforces the 16 MiB bound, asks for an explicit local destination, then
  flushes and atomically replaces that file. Browser preview uses a normal
  Blob download. A renderer-provided path is never accepted.
- Markdown export continues to write portable UTF-8 notes with title/tag
  frontmatter and no overwrite, but it uses the same scope resolver as web
  export. Adding a new export format must not weaken these scope/privacy rules.

## Local Vision OCR contract

Image and scanned-PDF recognition is a desktop-only, local preprocessing step.
The app bundles `Contents/MacOS/orion-ocr`, built from
`src-tauri/native/OrionOCR/main.swift`, which links to the system-supplied macOS
Vision framework and runs `VNRecognizeTextRequest`. Do not describe Vision
as a bundled framework, downloaded model, network service, or third-party
runtime: macOS supplies it, and no OCR model belongs in Orion's resources or
third-party notices.

Preserve these boundaries:

- `SourceKind` includes `image`. Update its TypeScript union, snapshot validators,
  exhaustive MIME mappings, import detection, source presentation, and tests
  together. Existing Space schemas remain valid because the new value extends
  the accepted enum without changing stored field shape.
- Accept only PNG, JPEG, HEIC, HEIF, and PDF payloads through the OCR command.
  Validate the canonical MIME and decoded byte count again in the Rust host;
  renderer checks alone are not a native trust boundary. The 25 MiB file limit
  applies before OCR as well as to ordinary documents. Reject PDFs above 50
  pages and images above 100 megapixels; downsample source images to a
  4,096-pixel longest edge and render PDF pages to at most 2,600 pixels. Bound
  recognized output to 100,000 characters per page and one million characters
  per document.
- Keep PDFs with meaningful selectable text on the pdf.js fast path. Invoke
  Vision only when that pass is empty or contains too little meaningful text;
  preserve page numbers in the recognized source.
- Recognition receives the selected file bytes inside the desktop app. Keep
  them on-device, do not write a persistent image/PDF copy, and retain only the
  recognized text plus source filename, MIME type, byte size, warnings, and
  note provenance in `vault.json`. AI mode may subsequently send bounded
  recognized text under the normal provider contract; it never needs the
  original image bytes.
- Treat OCR output as untrusted source text. Empty or partial recognition must
  produce a clear warning or error, never a fabricated success.
- Browser preview has no native Vision helper and must clearly report that
  image and scanned-PDF recognition requires the installed desktop app.
- Recognition quality varies with sharpness, contrast, orientation,
  handwriting, layout, and the languages supported by the installed macOS
  version. Do not present OCR text as independently verified.

The OCR helper is first-party executable code. Run
`./script/build_ocr_sidecar.sh` after changing its Swift source; it compiles for
Orion's Apple Silicon macOS 13.3 deployment target. Include that script in the
release source fingerprint and run it before a fresh Tauri release. Public
release packaging must Developer-ID-sign the helper with a secure timestamp and
Hardened Runtime before sealing the main executable and app. It needs no special
entitlement. Verify the helper signature and `--version` from the exact app
copied out of the finished DMG; release QA should also recognize a deterministic
local fixture through that copied helper and assert expected text before
claiming end-to-end OCR coverage.

## Offline transcription contract

Orion 0.3.8 is self-contained on Apple Silicon macOS 13.3 or later. It bundles:

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
as the concept's canonical target. The user chooses either an AI-written
definitional article—with an optional page-specific instruction—or a genuinely
blank article. Only the AI choice queues a linked-article job, and Restart must
retain its instruction. A non-empty destination selection is an explicit
compatibility override for an existing manual/legacy branch. Never default a
new phrase to the note currently being edited.

The editor Unlink action preserves the selected words and destination note. For
an Orion concept it also sets that concept's `autoLink` to false so decorations
do not immediately recreate the link everywhere; explicitly teaching the phrase
again re-enables the same concept instead of creating a duplicate. Ordinary
external or direct-note link marks can be removed without changing concept
vocabulary. This per-concept control is authoritative in both the editor and
reading surface. The legacy persisted `settings.autoLink` field remains schema
compatible but must not globally suppress concept links or make the two surfaces
disagree.

When the normal path creates or reuses an empty link placeholder and the key for
the selected AI provider is configured, `App.tsx` immediately starts one
Space-scoped organizer
request built by `src/lib/linkedArticle.ts`. The request must include the
originating note, its direct imported sources, the Space identity, and bounded
existing-note context when enabled. It must request exactly the named canonical
article. Merge the result into the same note ID; never replace a populated
human-authored article or create a suffixed duplicate.

Linked-article jobs are transient UI state, not vault schema. The sidebar shows
phase-based progress for the active Space across a 90-second renderer response
budget. A failed or timed-out article remains able to open after an error and
must expose Restart and Delete actions. Restart uses the latest captured Space,
article, and origin-note IDs; Delete removes the placeholder note plus orphaned
link vocabulary and relationships. Switching Spaces must not redirect an
in-flight result: completion updates the Space and note IDs captured when the
job began. Treat the `orion-link-pending` tag plus its normalized single
placeholder message as the current durable unfinished-page marker because the
rich editor may normalize Markdown whitespace, quote characters, or the hidden
comment. Continue recognizing the legacy `orion-link-draft` marker when reading
older vaults. Never mistake additional human prose for an unfinished generated
page. Each live attempt must
own its Space/article request key so a canceled or late older promise cannot
clear a restart. Deleting a paused page must release that key and allow the
same phrase to create and queue a new article immediately.

Finishing a substantive non-wiki note with AI configured starts the targeted
refresh in `src/lib/wikiEnrichment.ts`. Its request must ask for every existing
canonical article meaningfully affected by that note plus any clearly important
missing durable article, while excluding lexical-only matches. It must never
create a relabelled summary, plan, list, checklist, or paraphrased companion to
the originating note, and it must never replace the originating note merely
because the model echoes its title. Tasks remain in the ordinary project/source
note; do not copy them into a canonical article. Apply results
only to the captured Space and only if the originating note did not change while
the request was running. The returned wiki body is a complete revision that
must preserve worthwhile existing knowledge while weaving new context into its
natural place. Never append `Context from`, imported-source, new-note, or
change-log sections, and never persist merge-marker comments. A manual wiki edit
must not itself start another refresh.

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
articles. Each wiki article is Space-scoped and returns a complete, coherent
body. It should explain the subject definitionally, integrate Space relevance
and source-grounded detail where they naturally belong, and surface material
uncertainty without a rigid template. Link-created pages especially should read
like named wiki articles rather than summaries of the note that created them.

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
   immediately editable reference notes with canonical sections and source
   provenance; the hidden `wiki` value is compatibility metadata, not a user
   type.
4. When reusing an article, preserve its ID, merge
   aliases/tags/source IDs, and replace its body only with the organizer's
   complete integrated revision. The prompt must preserve worthwhile existing
   knowledge; do not use deterministic append blocks.
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

- Models beginning `claude-` route to Anthropic and all other supported model
  IDs route to OpenAI. One Anthropic key serves Fable 5, Opus 5, and Sonnet 5;
  never store duplicate keys per model or silently fall back between providers.
- Organizer calls use OpenAI `POST /v1/responses` or Anthropic
  `POST /v1/messages`, strict JSON schema, bounded existing-note context, and
  the built-in knowledge-architect prompt. OpenAI calls set `store: false`.
  That context can include up to 6,000 characters from an existing `wiki`
  article body so the model can produce a coherent revised `body`; do not
  include ordinary note bodies. Concepts must be inferred from semantic roles,
  relationships, and aliases rather than keyword frequency. Explicit actions
  may become `- [ ]` items in project notes, but the model must not invent tasks.
- Chat uses a separate strict reply schema and prompt. Its request must contain
  only the bounded Space context and history described above, with no legacy
  card or layout payload.
- Living-overview generation uses the organizer's strict schema but accepts only
  one returned note as the overview artifact. It must write an editorial title
  and cohesive orientation rather than a source inventory, provenance section,
  change log, or ordinary note. It never creates note/type/status UI.
- Do not invent citations or silently claim AI output was verified.
- Keep manual behavior available when the key is absent or an AI request fails.
- Any new renderer-to-Rust command needs validated input and a narrow purpose.
- The renderer CSP intentionally blocks arbitrary network access.

## UI principles

Orion should feel calm, editorial, and spatial rather than dashboard-heavy.
Reuse the existing colors, surfaces, typography, radii, and compact scale in
`App.css`. Prefer a single clear action and progressive disclosure. Preserve:

- direct editing with the animated toolbar;
- one wider toolbar around a restrained reading measure, with portable Markdown
  controls for strikethrough, inline and fenced code, dividers, and editable GFM
  tables. Table row, column, header, and deletion controls appear contextually
  while the cursor is inside a table rather than permanently crowding the bar.
  Undo and Redo remain in a fixed trailing group inside the toolbar; only the
  formatting region may compress or scroll at constrained widths;
- source citations are ordinary Markdown links using the private
  `orion-source://<id>` protocol. The citation picker may attach any source in
  the current Space, updates both sides of note/source provenance atomically,
  and inserts compact numbers ordered by first appearance. Persisted/exported
  Markdown includes a canonical trailing `## References` list, but the editor
  strips that generated block from `contenteditable` and renders it as a
  read-only footer so it is always last and cannot move the caret. Repeated
  citations reuse one number and reference entry. Inline numbers and footer
  titles open the preserved Source viewer. Deleting a source removes numeric
  markers entirely, retains descriptive prose from legacy citation links, and
  renumbers the remaining references;
- note-local Find in reading and editing modes through the header control and
  `Cmd/Ctrl+F`, with wrapping previous/next navigation and no mutation of note
  content; closing Find must preserve the current reading position and restore
  focus with `preventScroll`;
- a gradient-free writing surface, with to-do list formatting in the same
  toolbar and one fixed-size scrollable Home task card replacing the redundant
  lower Import Studio card; task rows are plain, proportionate typography beside
  the checkbox, without colored text containers or nested card surfaces; use the
  blue/periwinkle Orion checkbox in every state, and keep task spacing visually
  identical between the editing and reading surfaces;
- the Home lower row with Tasks on the left at 40% width and a fixed-size,
  scrollable living Space overview on the right at 60% width, stacking only at
  narrower breakpoints. Task text and overview headlines wrap naturally instead
  of truncating; the overview is a first-class optional Space field, keeps its
  previous text visible during refresh, becomes stale whenever substantive
  knowledge changes, rejects late results against a knowledge fingerprint, and
  has a deterministic local fallback without an API key;
- card hover glow follows the perimeter nearest the pointer as a soft luminous
  edge and halo; never replace it with a radial spotlight beneath the pointer or
  reveal a persistent solid outline; both edge and halo must inherit the exact
  card radius without square filter bleed at the corners;
- a persisted, reduced-motion-safe home atmosphere chosen from Line Waves,
  Signal Decay, and Field, with curated accent and motion controls; only the
  active renderer should load or animate;
- direct canonical article navigation, with the right-hand connections canvas
  reserved for unresolved legacy ambiguity instead of a graph;
- route-aware Back/Forward: a note opened from Notes returns to Notes, a note
  opened from Home returns to Home, direct destinations open at the top, and
  history traversal restores the exact saved scroll position;
- a dedicated Favorites section above one complete active-Space sidebar note
  list, both preserving the stored note-array order when notes are opened;
  favorites remain in All notes so that list is genuinely complete;
- a scrollable left-hand outline derived from H2/H3 Markdown, with stable
  duplicate-safe anchors, an editorial reading scale, and the current section
  emphasized as the user reads, including the final section at scroll end;
  never reserve its grid column when no outline exists, and hide the rail only
  where the window cannot support it;
- note sources, backlinks, and related notes in an on-demand right-hand
  connections inspector that overlays the reading canvas rather than
  permanently shrinking it. Source entries open the preserved text or
  transcript, metadata, original URL when available, and the notes it shaped;
- no reference-hover popovers on automatic or explicit concept links;
- strong empty states with no fake content;
- keyboard access, focus trapping, visible focus, reduced-motion behavior, and
  useful ARIA labels;
- draggable native window chrome across the empty top bar and workspace label,
  while every navigation, search, export, and panel control remains interactive;
- one calm Share or export sheet whose default is an offline web article, with
  explicit format and scope choices plus a plain privacy summary; do not turn
  export into a settings dashboard or imply that a local file is already a
  hosted public URL;
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
6. Run `cargo test --manifest-path src-tauri/mcp-server/Cargo.toml`.
7. Run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and
   `cargo fmt --manifest-path src-tauri/mcp-server/Cargo.toml -- --check`.
8. For native changes, run `npm run tauri build`.
9. Exercise the finished UI in a real browser or desktop runtime at normal and
   narrow sizes; inspect console errors and keyboard behavior.
10. Update `README.md` and this file when behavior or operational assumptions
   changed.
11. Refresh distributable artifacts and release notes when the task includes a
    release build. From the workspace root, use
    `./script/package_release.sh <release-label>` so the DMG is staged to a new
    inode before publication. Never use an in-place copy to replace a DMG that
    may be mounted; doing so corrupts the live mounted backing store and can
    leave a partial application after Finder error `-36`.

The packaging script must re-sign all copied executable code before publishing.
It must also reject a release root whose `src-tauri` path causes
`build.frontendDist` to resolve outside that same root, and stamp both the
source tree and built `dist/` fingerprints into the app. This prevents a clean
source mirror with a symlinked native directory from embedding a stale renderer
from another checkout. Build the renderer and connector explicitly before the
Tauri release step and disable Tauri's nested `beforeBuildCommand` for that
step; the renderer must be built once, fingerprinted once, and embedded once.
Release builds sign `whisper.framework`, `orion-ocr`, `orion-whisper`, `yt-dlp`,
Deno, the main Orion executable, and the outer app with one Developer ID
Application identity, secure timestamps, and Hardened Runtime. The PyInstaller
`yt-dlp` helper alone receives the narrow `disable-library-validation`
entitlement it needs to map its extracted Python framework. Verify the entire
bundle with `codesign --verify --deep --strict`, then regenerate and sign the
DMG around that exact signed app. Mount the finished image read-only, copy the
app out with `ditto`, and run the four helper `--version` commands from that
copy. Set
`ORION_CODESIGN_IDENTITY` when more than one Developer ID identity is installed.
Set `ORION_NOTARY_PROFILE` to a `notarytool` Keychain profile to submit, staple,
and Gatekeeper-check the DMG as part of the same release command. The script
currently sets `CARGO_PROFILE_RELEASE_STRIP=false` because Rust 1.96 on current
macOS can make release-stripped proc-macro dylibs unloadable with E0463; remove
that workaround only after the installed stable toolchain builds Orion cleanly
with Cargo's normal release stripping.
The MCPB contains nested executable code that outer bundle signing cannot
inspect through the ZIP container. Build and Developer-ID-sign `orion-mcp`
before creating a release MCPB (ordinary local builds remain ad hoc); release
verification must extract the connector from both
the app bundle and the copied-out final DMG, verify that exact binary, and run
the MCP protocol/Space-boundary harness.

Never claim the media workflow was end-to-end verified unless the exact
finished app bundle downloaded a real bounded YouTube source with its bundled
`yt-dlp` + Deno and transcribed that downloaded media with its bundled model.
A compile, unit test, or setup-version check alone verifies integration shape,
not decoding, model inference, or current YouTube extraction.
