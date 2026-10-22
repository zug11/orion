# Orion Agent Guide

This file is the durable operating manual for anyone changing Orion. Read it
before editing the application. Keep it accurate when architecture, commands,
security boundaries, schemas, or release procedures change.

The active physical checkout is `/Users/zzz/Developer/orion`, outside iCloud.
The previous Documents path is a compatibility symlink for existing Codex tasks
and launch paths. Prefer the Developer path for new work. The older Developer
snapshot is preserved at `~/Developer/orion-before-cutover-20261011-163852`;
it is an archive, not another active checkout. Do not delete the compatibility
link, archived tree or retained conflict copies as incidental cleanup.
See `docs/development-checkout.md` for migration evidence and path ownership.

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
  Each window remembers each note's last edit/preview mode independently by
  Space during the session, including navigation through Home or another view.
  Returning to a note resumes that mode; Done explicitly returns it to preview.
  This is transient window navigation state, never a persisted note field.
- The sticky rich-text toolbar can record dictation at the current body cursor.
  The renderer preserves and tracks that insertion point while rotating the
  live microphone into bounded M4A segments. The Small edition uses independent
  two-minute requests. The Medium edition loads one persistent Whisper worker
  when recording starts and processes 30-second windows with two seconds of
  acoustic overlap; local assembly removes repeated boundary words. Completed
  segments are transcribed sequentially while recording continues, so the
  session has no fixed duration cap, but their generated text stays buffered
  and is not shown in the note until the user stops the whole session. The
  native host bounds and temporarily stages each part, bundled Whisper
  transcribes it entirely on-device, and only the combined ordered transcript
  is inserted into the note; each recording is discarded after its command
  finishes.
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
  curation, dialectic, promotion, or canvas workflow. A requested text edit is reviewed in the actual note, with highlighted
  replacements, gray additions, and Accept changes/Discard. When the user
  explicitly asks Chat to create or save notes, the host may authorize one
  response to carry at most three bounded creation-only actions; valid actions
  become permanent editable notes in that active Space immediately. The host
  derives that authority from the current user prompt, never Space context or
  model output. Every assistant reply can also be kept through the ordinary
  local **Keep as note** action. These creation paths cannot update/delete a note
  or cross Spaces. Explicit editing requests or composer edit modes may separately propose
  bounded focused replacements or a full rewrite for the attached note. Accept rechecks its
  Space and original body and uses the normal rich editor and autosave, with
  one Undo. Never silently apply an edit or allow the model to choose a target.
- AI is optional. Writing, local imports, on-device OCR and transcription,
  source provenance, links, search, Spaces, and web/Markdown export must remain
  useful without an OpenAI or Anthropic key.
- Appearance starts from a small curated room preset. Dark, light, and system
  are modes within that preset rather than separate themes. Keep tuning to
  accent, canvas, surface, text warmth, and contrast; optional custom accent,
  canvas, and surface colors must be validated, mode-clamped, and paired with
  derived accessible foregrounds. New visual directions must be optional and
  offer meaningful, bounded adjustments and a reset. Window glass explicitly
  uses one optional Regular surface shared by the top bar and sidebar, with
  shared tint opacity and blur blend. Keep the frame continuous without a
  divider between those areas. Do not restore style, radius, interaction, or
  per-area controls. Do not create an unbounded
  per-widget styling system. Home-atmosphere controls remain a separate persisted choice, but
  their room, readable strokes, preview, and Theme accent resolve from that
  same active palette and must react to a live System-mode appearance change.
- Notes are permanent, editable, and evolving from the moment they are created.
  Generation progress is transient job state, never a user-facing note lifecycle.
  Preserve provenance and uncertainty without review-status labels.

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
Vitest excludes `outputs/`, which may contain archived diagnostic test fixtures;
maintained application tests belong in `src/`. TypeScript excludes local
`* 2.ts` / `* 2.tsx` duplicate copies under `src/`; these retained copies are
not maintained application source and must not be imported.
`npm run tauri build` is the canonical native integration and release check.
Native artifacts are produced under `src-tauri/target/release/bundle/`.

The native crate sets release `strip = "none"` to avoid Rust 1.96 producing
misaligned proc-macro dylibs with the macOS 27 toolchain
([upstream issue](https://github.com/rust-lang/rust/issues/157750)). Retain this
until the supported compiler includes the fix. The independent MCP package
keeps its existing remapping, stripping, signing, and verification pipeline.

`src-tauri/src/local_transcription.rs` owns offline media imports, persistent
dictation workers, YouTube acquisition, bundled Whisper runtime validation and
local alignment of generated speech. `media_jobs.rs` continues to own cancellation,
window scope and subprocess lifetime. Tauri command names/arguments remain stable;
the application manages `VoiceMemoWorkers` once and the assistant bridge calls
the same controlled transcription helpers. Provider speech generation, credentials
and the Preview Keychain-service rewrite remain in `lib.rs`. Keep temporary-media
cleanup, partial batch results, deadlines and on-device-only transcription intact
when changing this module.

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
- Optional `Settings.themeIcon` defaults to true and `homeAtmosphereAppearance`
  defaults to `theme` (`dark` is the only override). These are shared appearance
  settings, not Space-specific identities. `resolveAtmosphereTheme` resolves
  Always dark from the same complete theme preferences. Scope its CSS palette to
  the Home hero, including text/actions, and use the same palette in Settings
  previews. Light atmosphere rooms are gently deepened paper tones; physical
  surface shaders use explicit diffuse/specular daylight lighting, not inverse
  emission. Mirage uses a render-resolution-aware daylight silhouette rather
  than its broad night-glow mask, and retains refraction and rim detail. Both
  modes use the same pixel budget. Preserve dark rendering, custom colour pairs,
  and bounded lifecycles.
- Named personal palettes use optional `themeSavedPalettes` and
  `themeActivePaletteId`, validated at the storage boundary and normalized on
  hydration. A saved palette contains only the bounded nine theme preferences,
  a stable `palette-` ID, and a trimmed name of at most 60 characters. Cap the
  collection at 24 unique IDs; modes and Home atmosphere settings are independent.
  Saved palettes appear alongside curated presets in the same room-preview card
  grid. Saving, overwriting, deleting, applying, and reverting are explicit UI actions.
  Tuning Canvas/Surface preserves the custom colour seed and applies relative
  tone/lift changes through `resolveThemePalette`; it must not clear a custom
  colour or silently overwrite the saved palette. Shared appearance updates
  continue across all Spaces. Older vaults have an empty palette collection.
- Home atmosphere offers only Mirage, Signal Decay, Field, Line Waves, Opal,
  and Ripple Glass. Retired recent effect IDs remain accepted at the storage
  boundary and hydrate to Mirage; older Antigravity/Constellation and
  Aurora/Liquid Ether aliases retain their Signal Decay/Line Waves migrations.
  The new glass shaders share the existing bounded local WebGL lifecycle,
  daylight shading, custom colour pair, offscreen pause, context recovery,
  and reduced-motion handling. Do not import retired shader components into
  the active renderer. Palette object refreshes with unchanged render colours must
  not recreate procedural canvases. Preserve elapsed animation time across
  colour/motion updates and WebGL context recovery; visibility pauses must
  resume the existing phase rather than restart it.
- `homeAtmosphereCustomColor` and `homeAtmosphereCustomSecondaryColor` are
  optional six-digit hex colours (or empty) at the storage boundary, hydrated
  to empty for older vaults. Together they override the first two colour
  channels across every shader and preview; derive any third channel from
  their blend and preserve readable signal contrast and the themed room.
  Older single-colour overrides keep their existing tonal companions until
  edited. Editing either picker captures the other visible colour once, then
  preserves that independent choice. Each colour has a native picker and hex
  field; choosing a preset or Reset colours clears both overrides. With neither
  set, the original multi-colour preset remains unchanged.
- Update every validator and exhaustive `SourceKind` mapping when adding a
  source type.
- Preserve the original extracted/transcribed source even when AI input must be
  bounded.
- `Note.lastOpenedAt` is optional legacy navigation metadata. Opening or
  revisiting a note may update it without changing the note's knowledge
  `updatedAt`, but it must never reorder the sidebar. The active Space's stored
  note-array order is the stable visible order.
- Settings currently apply across all Spaces; content remains Space-local.
- Optional `Settings.windowGlass` hydrates to complete bounded defaults in
  `src/lib/windowGlass.ts`: `enabled`, shared 0–100% `tintOpacity`, and `blur`.
  Defaults are on, 30% tint, and 50% added blur. Legacy material/style, area
  switches/tints, radius, and interaction fields still validate. Hydration
  preserves an explicit Solid/both-off choice and averages the enabled areas'
  tints (both saved tints when both were off); new fields take precedence.
  Off choices retain their tuning. `src-tauri/src/window_glass.rs` owns the
  per-window native view: Liquid uses the public `NSGlassEffectView` on macOS
  26+, with a `contentView` container hosting the existing WKWebView. The
  renderer always requests Regular, a 16 pt radius, and no interaction.
  Runtime class detection falls back to a sidebar `NSVisualEffectView` on older
  Macs. The native command retains its bounded compatibility contract, including
  a guarded macOS 27 interactive setter. Never emulate Apple's glass
  with a CSS shader or put an unrelated glass sibling behind the WKWebView.
  Switches reparent the same WebView on the main thread; native views are owned
  by that window's hierarchy, not global pointers. IPC targets only its caller.
  Never assign the WKWebView directly as the glass's `contentView`: AppKit's
  Auto Layout changes break Wry's frame-based sizing on material switches.
  A disposable NSView container absorbs those constraints; the WKWebView keeps
  its width/height autoresizing and focus when moved back to the original host.
  `blur` is a bounded 0–100% mix of a native behind-window sidebar visual-effect
  backdrop. Its public `alphaValue` controls added frosting independently from
  the shared HTML colour overlay. It never fades or blurs the WebView. Zero removes
  the extra backdrop; Liquid Glass still retains Regular's system blur.
  Do not label this a pixel blur radius or use undocumented Apple filter keys.
- `useWindowGlass` serializes native material updates, ignores stale responses,
  and changes opacity through CSS without rebuilding native views. Fully hidden
  or disabled glass removes the native material. Only top/left navigation can
  reveal glass; text, controls, and the reading canvas retain full opacity.
  The reading canvas has a 13 px top-left inner radius with its top border
  following the curve. Solid mode adds a matching left border, joining the top
  edge into one continuous curved boundary; never extend it through the top bar.
  The workspace shell carries the shared frame tint
  behind that corner; keep the top bar transparent to avoid double tinting.
  New library windows apply the same shared settings through their own hook.
  Reduce Transparency/Increase Contrast select solid surfaces without rewriting
  the saved preference. Interactive glass is always disabled. Browser preview
  remains opaque. `useResolvedTheme` must call `setTheme(null)` for System so
  OS appearance changes continue propagating. Tauri's `macos-private-api` and
  `app.macOSPrivateApi` are still needed for its transparent WebView, even though
  the glass APIs themselves are public. This direct-distribution configuration
  is not compatible with Mac App Store submission. See `docs/window-glass.md`.
- The intelligence picker includes GPT-6 Astra (`gpt-6-astra`) through the
  existing OpenAI request path. Selecting it changes None reasoning to Low and
  disables None while selected; its visible supported depths run Low through
  Extra high. Preserve the exact selected model in persistence and requests.

Browser preview uses `localStorage` for development and keeps both provider keys
in memory for the current tab. Desktop behavior is authoritative.

### Multiple Orion windows

**File → New Window** and **Cmd+Shift+N** open another full library window in the
current Space after flushing the originating window. **Cmd+N** still creates a
note. Windows share one vault while keeping their active Space, selected note,
history, scroll position, and transient UI independent. Titles identify the
current Space and note for the macOS Window menu.

The note toolbar's **Open in writing window** icon (left of Export) flushes the
current edits and opens a dedicated window for that exact Space and note. Reuse
an existing writing window for the same target. Its immutable launch route uses
`view=writing`, `space`, and `note`; it starts in the normal rich editor with no
sidebar or library navigation. Deleted or invalid targets show an unavailable
state, never a different note. Linked notes and excerpt
references route into a library window while the draft stays open. The minimal
window header has only the title and Export; do not add a back button. Excerpt
passages travel only as bounded transient native navigation data. Library
listeners register before declaring navigation ready, so loading windows can
queue a target. External citations and global theme-icon changes target library
windows. Writing windows retain ordinary autosave, conflict choices, native
fullscreen, and the shared Close/Quit save handshake; there is no separate copy
or persisted writing-window schema. Cmd+N in a writing window opens a library
window so it cannot replace the bound draft.

`src-tauri/src/desktop_windows.rs` owns window creation, native menus, citation
routing, overview ownership, and the per-window quit handshake. New windows use
the main window configuration and the narrowly scoped `orion-window-*`
capability pattern. Closing a window flushes and destroys only that window;
application Quit waits for every registered window to save. A failed save
cancels Quit in all windows. Never force-exit after an arbitrary timeout.

`src/lib/windowVault.ts` merges each window's changes against its last persisted
snapshot and freshly read disk data. Disjoint fields and records merge, while
competing text or deletion/edit changes require a visible choice. A choice is
bound to the displayed disk revision, and must not overwrite a later unseen
revision. Pending typing during a save is rebased as subsequent local edits.
Every write still uses `vault.lock`, the expected revision, and atomic file
replacement. Retries are bounded; failed writes leave local edits available.
Native save/workflow events refresh other windows without changing their
navigation; browser preview uses storage events and Web Locks. JSON object key
order is not a content change. New save revisions must advance monotonically.
Autosave coalesces 800 ms typing pauses with a five-second ceiling during
continuous input; explicit navigation/window/quit flushes retain their save
handshake. `windowVaultPublication.ts` reuses equal immutable Space, note and
vocabulary objects after disk round trips. Only incoming note/concept changes
need external vocabulary reconciliation. Do not rebuild every Space's vocabulary
or invalidate rich-editor linking after an ordinary local autosave.

Deep links target one preferred window, not every renderer. The native workflow
lease remains shared across windows. Automatic overview generation also claims
one native owner per Space to avoid duplicate provider work.

## Claude MCP contract

Orion bundles `Orion-Claude-Connector.mcpb`, a self-contained Apple Silicon
Claude Desktop extension. Its `orion-mcp` binary uses newline-delimited JSON-RPC
over stdio. stdout is protocol-only; diagnostics belong on stderr. It implements
the MCP initialize lifecycle, ping, these nine local vault tools, and the optional
desktop workflows described below:

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
- Successful note detail, create, and update results expose `linksTo` and
  `linkedFrom` as bounded, deduplicated Space-local note relationships. Derive
  them from explicit Orion note/concept links, the note's stored concept
  associations, legacy wiki links, and directed persisted relationships. Each
  related-note entry contains only its stable ID, title, Orion URL, citation,
  and derivation kinds; never duplicate another note body. Cap each direction
  at 50, report truncation explicitly, and keep browse/search discovery results
  compact. Advertise this contract through those tools' MCP output schemas.
- Create, update, and delete only inside the exact supplied `space_id`. Note
  deletion must clean source, concept, relationship, and import-draft IDs.
- A content-changing MCP create, update, or delete marks an existing living
  Space overview stale; pin-only updates do not. The connector remains local
  and does not call an AI provider to regenerate it.
- Make no network request and never read or expose either provider key.
- Treat all vault text as user data, not executable instructions.
- Keep MCP messages on stdout to one JSON value per line with no stdout logging.

### Additional local library tools

The independent MCP crate also exposes 23 tools from `src/library`:
`orion_list_sources`, `orion_search_sources`, `orion_get_source_passage`,
`orion_get_note_section`, `orion_get_notes`, `orion_list_concepts`,
`orion_get_concept`, `orion_resolve_link`, `orion_get_related_notes`,
`orion_get_provenance`, `orion_list_tags`, `orion_list_tasks`,
`orion_set_task_completion`, `orion_edit_note_text`, `orion_append_to_note`,
`orion_batch_update_metadata`, `orion_find_duplicate_notes`,
`orion_check_space_integrity`, `orion_get_recent_changes`, and
`orion_get_link_path`, and `orion_apply_note_command`. They work with Orion closed, without credentials or
provider calls, under the existing direct local-library access contract.

- Reads default only to the active Space. Every write requires an explicit
  exact Space and opaque current note versions, checked under `vault.lock`.
  Batch metadata updates validate every member before any mutation. Preserve
  unrelated raw fields and settings; content edits stale the overview, pin-only
  edits do not. A stale retry must never duplicate an append or erase new text.
- `orion_apply_note_command` is a direct local version-guarded writer for portable
  editor content. Its finite command set covers writing blocks, text/headings,
  tasks/lists, dividers, quotes/code, tables, web links, same-Space note links and excerpts,
  and already referenced managed images. Insertions use note boundaries or an
  exact unique anchor; validate destination/source versions and target ownership
  under the same vault lock. Never execute arbitrary slash text, shell commands,
  provider calls, or native pickers. Preserve block framing, safe Markdown escaping, and import
  round trips; flatten balanced pre-existing frames when wrapping content and
  reject malformed frames or insertions that would create nested blocks.
  `paragraph_format`, `document_margins` and `image_layout` modify existing
  portable metadata under the same write guard. Paragraphs/ATX headings and
  standalone managed images require exact whole anchors, not partial structural
  ranges. Paragraph alignment is left/justify; margins are integer percentages
  0–25. The finite image schema preserves omitted and unknown existing fields,
  distinguishes null/zero/false resets, validates position against width, and
  never imports an asset. Reject invalid numeric values instead of clamping.
  Layout commands do not accept insertion placement or replacement text.
  `table_layout` and `table_edit` use an exact complete GFM table anchor including
  its adjacent metadata, with zero-based logical row/column indices. An empty
  synthetic header for a headerless table never counts as a data row. Preserve
  untouched cell Markdown and unknown valid metadata; reject partial tables,
  code/HTML examples, malformed geometry and stale versions. Explicit row,
  column or table deletion authorizes that exact removal; shrinking dimensions
  requires `allow_content_removal: true` when occupied cells would be lost.
  Width-only changes proportionally scale existing measured columns, matching
  the editor. Explicit column widths take precedence. Existing oversized imports
  retain their untouched axis; new growth remains within the editor limits.
  `inline_format` applies/removes bold, italic, strike or code with an explicit
  `enabled` boolean and unique original-Markdown anchor. It edits one ordinary
  paragraph/ATX heading, including within Orion frames, with source-span parsing
  and visible-text/mark/link equivalence checks. Removal requires complete
  delimiters; code application accepts unformatted single-line text. `unlink`
  removes one complete explicit web/note/concept link, retaining its label and
  marks. Exclude citations, excerpts, autolinks and reference-style links; never
  mutate concept vocabulary or claim that unlink disables automatic decoration.
  Both commands reject unsupported containers or partial syntax, keep unrelated
  source bytes and take no insertion placement/replacement text. The independent
  MCP crate pins pulldown-cmark 0.13.4 without default features. Include its MIT
  notice and unicase's MIT notice in both connector packages and the app, and
  verify those notices after archive extraction.
  `source_citation` is a separate finite command. Insert requires the current
  exact same-Space source version as well as the note version; attach both
  `note.sourceIds` and `source.noteIds` under the same vault lock. Its optional
  `sourceAttachments` receipt exposes the resulting bounded source/version.
  Remove requires one exact unique citation anchor and retains provenance.
  Rebuild only recognized numbered markers and a renderer-owned trailing
  References footer; preserve authored References prose and literal examples.
  Reject unsupported citation syntax, ambiguous IDs and unsafe anchors without
  writing. No provider request, source fetch or source deletion is implied.
  `link` requires exactly one of `target_note_id` or `url`. The URL variant
  follows `externalLinks.ts`: bounded HTTP/HTTPS only, recognizable bare domains
  normalize to HTTPS, and credentials, controls, spaces and backslashes are
  rejected. WHATWG parsing uses the pinned `url` crate; no destination is fetched.
  Escape literal labels and URL parentheses for Markdown. An omitted URL-link
  label preserves the exact replacement anchor, or uses the normalized address
  at other placements. Existing note links retain their same-Space target check
  and default title; excerpt source-version checks remain separate.
- Tasks remain Markdown checkboxes. Return exact raw text and zero-based line
  indices, ignore frontmatter/fenced examples, and change only the requested
  marker. Collapse matching task copies only with shared provenance or a wiki
  derivation, preserving unrelated recurring tasks and ordinary-note authority.
- Source and section ranges use Unicode scalar offsets, with exclusive ends.
  Carry versions and exact note citations. Paginated reads expose a vault
  revision and optionally reject a changed revision between pages. Versions
  are current-content equality tokens, never historical snapshots.
- Bound results to 2 MiB, page sizes to 100, multi-note reads to 12 bodies of
  at most 5,000 characters each, and exact passages/sections to 20,000 characters.
  Whole-body scans report their 2,000-record/8-MiB coverage. Bound matches/tasks
  and diagnostic examples to 5,000, and path searches to eight hops, 500 expanded
  notes, and 10,000 edges. Report truncation; never infer exhaustive absence.
- Provenance, paths, and title matches are navigation/diagnostic evidence, not
  claim-level support. Recent changes are current metadata, not a deletion or
  version history. Integrity tooling never silently repairs or deletes data.
- Run `script/test_mcp_library.mjs` against each exact extracted package binary
  and include this harness in release fingerprints. The harness uses only
  isolated fixtures and exercises all 21 local additions, including real atomic edits.
  Its completed-task contract checks default and explicit working reads, scoped
  history, cached derivative suppression, completion followed by a fresh read in
  the same process, original versions/Unicode-scalar ranges/CRLF line positions,
  fenced examples and independent requirements, and byte-for-byte unchanged
  Markdown outside the intended checkbox. It rejects filtered whole-note
  replacement and stale completion retries. Passing a freshly built binary does
  not establish that either client's installed copy has been updated.

### Optional native desktop workflows

The shared connector now exposes 57 tools: 32 local library tools, 14 desktop
workflow/capability/job tools, three native edit-review tools and one read-only
active-editor-context tool, plus three finite voice work-order tools and four
captured-editor-generation tools. The optional workflows are
`orion_get_capabilities`, `orion_get_context`, `orion_research`,
`orion_search_space`, `orion_export_word`, `orion_import`,
`orion_reprocess_sources`, `orion_generate`, `orion_develop_concept`,
`orion_enrich_knowledge`, `orion_refresh_overview`, `orion_get_job`,
`orion_list_jobs`, and `orion_cancel_job`.

`orion_list_voice_work_orders`, `orion_get_voice_work_order` and
`orion_control_voice_work_order` address existing voice workers through an exact
`orion_get_capabilities.voiceTargets` identity. These are separate from ordinary
workflow jobs. The owning library window advertises its current Space even while
audio is idle; note/Chat navigation and Stop preserve that identity, while a Space
change, window close, retired renderer session or expired 30-second lease removes
it. Writing windows cannot register. Native registration trusts the library
renderer to report its current Space, then binds that exact Space/window/session
to an opaque target; it never silently chooses another window.

`src-tauri/shared/voice_work_orders_protocol.rs` owns strict request and bounded
response validation. `assistant_voice_work_orders.rs` owns a separate authenticated
socket mailbox: immediate request/receipt handling, eight pending requests, 32
retained receipts, 64 owners and at most 128 active external revision grants.
The MCP caller polls within three seconds. Controls require a unique idempotency
key, exact worker revision and opaque control version. A native decision claim
precedes mutation; recheck the renderer's version after that asynchronous claim.
Cancel is a no-op on terminal jobs, preserving findings. Read/cancel need enabled
desktop access to the exact Space but no AI or write grant; retry/steer additionally
need AI permission and a ready selected provider. Neither path grants note writes.

`src/lib/assistant/voiceWorkOrders.ts` sends only identity/readiness heartbeats.
`voiceWorkOrderHost.ts` merges admitted workers and pending reservations without
cloning their captured context. Stable inventory versions guard subsequent pages;
reservation generations guard revisions still numbered 1. Steering a waiting
worker admits that same ID with its original note/selection, consumes only that
member and invalidates dependent clarification routes. Admitted retry/steer uses
the existing reader with host-enforced search-only authority. Every provider
stage and result publication rechecks the exact native grant under a fresh vault
lock; revocation, owner loss and mailbox failure cancel only external revisions.
Terminal/superseded grants are released. No MCP operation controls the microphone,
playback, call connection, conversational focus, selection, navigation or saving;
external findings remain inspectable without unsolicited spoken commentary.
Reject external retry/steer of the currently focused worker before and after the
native claim; ask the user to return to the main conversation first. This prevents
the existing stale-focus handoff from reconnecting audio as a control side effect.

Public details expose bounded exact findings, evidence ranges, coverage and public
checkpoint decisions/open questions/finite next operations, never raw transcripts,
captured selections, discovery dumps, queries or private provider reasoning.
Working reads withhold all history-derived freeform content, including paraphrases;
explicit history is required to inspect it or continue/retry its scope. A new
working scope drops historical memory. Stale evidence also withholds content.
Return exact UTF-16 fragments, Unicode-scalar omissions and one shared max_chars
budget up to 12,000. This source/fixture contract is separate from installing the
updated connector or validating real voice/provider behavior.

`orion_get_editor_context` reads one exact native-issued
`orion_get_capabilities.editorTargets` entry. It requires enabled desktop
workflows and the exact allowed Space, independently of AI/write grants or a
voice call. `src-tauri/shared/editor_context_protocol.rs` owns its finite schema;
`src-tauri/src/assistant_editor_context.rs` owns a separate read mailbox. The
authenticated socket handles request/get immediately; the MCP tool polls within
a three-second bound, so waiting for a renderer cannot block research control.
Keep at most eight pending reads, 64 targets and a 30-second target lease.
Responses are consumed once; do not retain selected text as job history.

`src/lib/assistant/editorContext.ts` advertises only exact note/Space identity and
readiness. It sends text only for an explicit read. NoteView supplies the current
authored document ahead of parent/save debounce, with no forced flush; Flow,
unaccepted Chat review and generated writing previews are unavailable. A
selection drag becomes pending before the 180 ms settling period. Preserve
captures when other controls take focus, but invalidate them on navigation or
authored changes and recheck after an asynchronous poll.

`src/lib/editorSelectionContext.ts` projects the local capture before IPC. Working
view omits completed-task text; explicit history may include it. Return bounded
exact fragments and original DOM UTF-16 offsets, with scalar-count omissions and
truncation. Rich-editor carets use real ProseMirror positions; reading carets use
DOM UTF-16. A cursor supplies no surrounding prose and never becomes voice
context. Bounds are 12,000 Unicode characters and 128 fragments. The prefixed
`documentVersion` is a displayed-document fingerprint, not a native persisted
`expected_version`; it cannot authorize a direct write or edit-review proposal.
Readiness changes retain the target ID; changing its note, Space or renderer
session invalidates the old target. Native caller window ownership is implicit,
including immutable writing-window routes. Never silently pick another window.

`orion_capture_editor_action`, `orion_start_editor_action`,
`orion_get_editor_action` and `orion_cancel_editor_action` use the separate
`editorActionTargets` capability and native mailbox in
`assistant_editor_actions.rs`, with the strict shared
`editor_actions_protocol.rs` contract. Capture binds one finite Write amount,
Rewrite preset or Image quality/context choice plus bounded instructions to the
actual ready rich editor. It performs no generation, navigation or editing.
Never use the read-only context tool's DOM offsets as edit authority. The native
capture ID binds window/session/Space/note, actual ProseMirror selection and
effective target, displayed-document and selection versions, and an exact
persisted-note baseline. Original rich data stays local; the native mailbox
receives bounded private baseline/captured bodies only to verify freshness.
Public receipts expose no note body, generated prose or image bytes.

Start consumes that capture with an idempotent request ID; changed arguments or
a changed document/selection require a new capture. Do not revive an old capture
after moving the selection away and back or undoing a document change. A normal
autosave of the exact captured draft may advance only its body and update time;
other persisted edits invalidate it. The mailbox retains at most eight pending
actions, 32 receipts and 64 owners, with a 30-second owner/capture lease, three
seconds to answer a capture, 20-minute operation limit and bounded private text.
It is independent of the research executor. Flow, dictation, local composers,
uploads and existing reviews make new captures unavailable.

External generation requires enabled workflows, the exact allowed Space, AI and
workflow-write grants. Every actual native text/image provider dispatch and
publication checks its exact action/window/session grant and current settings.
Image research uses the existing low-effort reader stages and configured effort
for composition. External Enrich and Related Space image requests require the
saved existing-note context preference; they cannot substitute for the local
UI's explicit per-action consent. Authority travels as a separate native invoke argument,
never in model context; browser provider fallbacks reject it.

`src/lib/assistant/editorActions.ts` coordinates the owning App's mailbox with
the real rich editor via `editorActionHost.ts`. Local Accept must await a native
claim, then recheck the captured rich document before the existing one-Undo
transaction. Image bytes are persisted only after that claim. Discard or
cancellation before acceptance cannot mutate authored text. A physical text
provider request may finish after cancellation; keep its scheduler slot until
settlement and suppress its late result. External generation Retry requires a
fresh capture rather than silently repeating paid work.

Record the actual serialized body after acceptance and flush through the normal
revision-guarded save queue. Only fresh disk equality yields a `saved` receipt
and note citation; an accepted editor edit and a saved note are distinct states.
Save failure preserves the local edit without replaying insertion. An already
accepted transaction may finish saving after navigation in its owning session.
These implementation and fixture contracts do not establish installed-client,
live-provider or native interaction acceptance.

`orion_propose_note_edit`, `orion_get_edit_review`, and
`orion_cancel_edit_review` use a separate transient review lane. They do not
occupy the ordinary executor while a person considers a proposal. Discover
native-issued targets through `orion_get_capabilities.reviewTargets`; each is
bound to an actual window, renderer session, active Space and open note.
Submissions require an exact target, note and current opaque version. Never
navigate another window or switch its Space to satisfy a submission. Writing
windows additionally retain their immutable native note route.

Review access requires enabled workflows, the exact allowed Space and write
permission, but no AI permission or provider call. Reuse the existing in-note
focused/full-rewrite validation, decorations, Accept/Discard and one Undo.
Submitting or discarding a proposal does not mutate the note. A native decision
claim must precede acceptance; cancellation cannot pretend to undo a claim or
accepted edit. Receipt states distinguish editor acceptance from verified disk
persistence. Save failures retain the accepted local text and existing conflict
UI; never replay the transaction or report a saved citation before checking the
persisted body. The review is transient and independent of Chat history.
Completed-task working views cannot become whole-note replacements; explicit
history is required for a rewrite when the original has hidden completed tasks.
Keep source bodies and proposal base bodies out of external receipt/target data.

`src-tauri/shared/assistant_review_protocol.rs` owns the finite external review
schema. `src-tauri/src/assistant_review.rs` keeps its separate bounded native
mailbox and receipts; it never writes the vault or calls a provider. Review
commands receive the real Tauri caller window implicitly. Writing-window targets
must match their immutable launch route. `src-tauri/shared/note_version.rs`
preserves the independent MCP crate's existing opaque v1 projection for native
version checks. Do not substitute renderer timestamps or body-only hashes.

`src/lib/assistant/editReviews.ts` registers a window-local mailbox independently
from the single research executor. The App supplies its existing serialized save
queue and the real note surface supplies readiness. A proposal may enter review
in the same note's reading surface but must never navigate to a different note.
The rich editor awaits a native acceptance claim, then rechecks its document and
review identity before the existing single Undo transaction. Capture the actual
serialized body after normal React updates settle; only native verification of
that body on fresh disk can report `saved`. A failed receipt or save must never
replay the editor transaction. Keep local accepted text available to resolve a
save conflict. An admitted transaction may complete after navigation while its
window/session remains alive. Revoked grants prevent new proposals/claims.

Review targets have a 30-second lease; at most 64 live sessions, eight pending
reviews and 32 retained receipts are allowed. Limit individual base/accepted
bodies to 2,000,000 bytes, retained body/edit memory to 16 MiB and encoded
deliveries to 2 MiB. Pending reviews expire after 20 minutes; terminal receipts
after one hour. There is one pending review per target. Unknown fields and
caller-supplied acceptance, model, title and base-body arguments are rejected.
Keep a stable renderer session across ordinary navigation and grant changes;
when idle with no permitted target, it need not poll native storage.

- `src-tauri/shared/assistant_protocol.rs` defines the strict, bounded request
  contract. `src-tauri/src/assistant_bridge.rs` owns the per-user Unix socket,
  private descriptor/token, opt-in grants, queue, renderer lease, and commit.
  `src-tauri/mcp-server/src/workflows.rs` is a credential-free local transport.
  No separate daemon or TCP endpoint starts. The running app alone accesses
  Keychain and providers through existing native commands and scheduling.
- Optional `Settings.assistantAccess` hydrates to disabled for older vaults.
  Connections independently enables workflows, API use, workflow writes, and
  exact allowed Space IDs. These grants do not replace the installed connector's
  existing direct read/write access. Never let tool input override a grant,
  selected model, or existing-note AI-context preference.
- Every workflow requires explicit `space_id` and `request_id`. Jobs deduplicate
  identical retries while retained: at most 32 jobs or one hour, lost at app exit.
  Cap queued/active jobs at eight, retained input at 16 MiB, MCP messages at 8 MiB,
  and each result at 2 MiB. The renderer executes one job at a time, with a
  20-minute cancellation deadline and the existing provider scheduler bounds.
  Cancellation prevents new stages and late note commits; an atomic commit that
  already started finishes. Never release a physical provider slot early.
- `src/lib/assistant` reuses the existing import, generation, linked-article,
  enrichment, and hierarchical-overview engines. Context/research return exact
  versioned excerpts, host-built citations, partial coverage, and explicit AI
  interpretation. Research never writes notes or Chat. Follow-ups reject stale
  prior Space versions. Unknown usage is not zero or a dollar estimate.
- `assistant/research.ts` runs desktop MCP research through `runChatReading` in
  read-only search mode, followed by one structured findings-synthesis call.
  The bounded reader can use up to six calls; synthesis adds one. Explicit
  note/source IDs are priority references, not an exclusive corpus. The full
  supported question and comparison material remain reference context, without
  Chat history, active editor selection or write authority. Findings may cite
  only retained exact evidence; directories and prior interpretations are not
  evidence. `researchCheckpoint.ts` validates host-produced task memory from a
  succeeded prior job in the same Space, snapshot and working/history view.
  Retain at most 1,000,000 UTF-8 bytes with explicit continuity omissions inside
  the existing 2 MiB job-result contract. Missing older checkpoints start fresh;
  malformed or stale checkpoints fail. This does not retain hidden reasoning.
- `orion_search_space` explicitly runs the same adaptive exact-passage AI search
  as the app, with a 600-character query bound, no Chat history or note actions,
  immutable Space context, configured-provider policy, and partial coverage.
  MCP answers convert transient renderer anchors to stable Space-scoped note
  citations; source evidence retains its exact source ID/range and bounded
  related-note navigation. Never invent a native source route.
- `orion_export_word` accepts only `scope` (note/linked/space) and an exact
  `note_id` for note/linked scopes. It makes no provider call and changes no
  vault state. The running app prepares an editable DOCX and asks the user for
  its destination through Save As. No caller path is accepted. The native
  Word exporter checks the job lease, operation, grant, cancellation, and
  persisted Space freshness before the dialog and just before atomic replace.
  Native export enters the shared `committing` state for the atomic replace and
  records its own terminal result so cancellation or subsequent content changes
  cannot relabel a saved file or lose its chosen path.
  Existing enabled-Space workflow access is required; the note-write/API grants
  remain independent. A cancelled dialog returns `cancelled: true`.
- Import preserves all extracted source text up to its explicit 1.8 MB total
  bound. File inputs are exact paths from the captured request: native code
  validates regular files, extensions, and document/media bounds before using
  existing parsers, Vision OCR, Whisper, or HTTPS/YouTube fetching. Reprocessing
  passes original source IDs into `buildImportPayload`, preserving original
  timestamps and citation targets. Local recovery must be reported as recovery,
  never completed AI synthesis.
- Flush and freeze context before dispatch; reject changed knowledge, permissions,
  or settings. Commit through the existing advisory lock, expected revision,
  and atomic writer. Native scope validation prevents deletions, settings changes,
  or changes to another Space. Renderer saves coalesce against the latest live
  vault so a queued autosave cannot undo a workflow commit. Edits made during the
  commit window are merged as subsequent user edits, without resurrecting deleted
  records. Return saved citations only after atomic persistence succeeds.
- Workflow commits suppress automatic overview calls for that content version in
  the running app; explicit overview refresh or the next independent knowledge
  edit resumes normal maintenance. Local import must not trigger a hidden paid
  refresh immediately after completion.
- Private descriptor mode is 0600. The MCP transport verifies exact canonical
  vault identity, socket directory, and protocol before connecting, including
  advanced vault overrides. This is same-user OS authority, not verified identity
  of a particular assistant client. Never expose the token through MCP results.
- Include `src-tauri/shared` in release fingerprints. Test the exact packaged
  executable, not only source-level tool definitions. See
  `docs/mcp-intelligence.md` for the scope and verification contract.

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

## Codex plugin contract

Orion also bundles a zero-configuration Codex plugin. `codex/orion` is the
canonical authored source; `src-tauri/resources/Orion-Codex-Plugin` is a
generated, self-contained staging tree for the desktop bundle and must never
become the place where plugin behavior is edited. The staged layout is:

```text
Orion-Codex-Plugin/
  .agents/plugins/marketplace.json
  plugins/orion/
    .codex-plugin/plugin.json
    .mcp.json
    assets/
    server/orion-mcp
    skills/orion/
      SKILL.md
      agents/openai.yaml
```

The plugin combines a concise Orion usage skill with the same independent MCP
server used by the Claude connector. Its MCP command must be relative to the
plugin root and point only to the bundled `server/orion-mcp`; never ask the user
for a vault path, rely on Cargo, PATH, a shell expansion, or start a network or
background service. The server resolves Orion's standard per-user macOS library
and retains the advanced `ORION_VAULT_PATH`/`--vault` overrides outside the
ordinary installation path.

Keep the marketplace identifier `orion-desktop` distinct from the plugin name
`orion`; identical names make current Codex cache-path discovery ambiguous.
Invoke the skill as `$orion:orion`. Its `agents/openai.yaml` must not declare
the bundled stdio server as an MCP dependency: that dependency form is for a
separately installable URL transport, while this plugin's `.mcp.json` already
owns and launches the local executable.

**Settings → Connections** presents one shared **Claude & Codex** capability
card with independent install actions. Codex installation is an explicit
per-user operation available only in the installed desktop app. The native
command first validates the absolute bundled marketplace, its `orion` entry,
and the executable, then opens
`codex://plugins/orion?marketplacePath=<encoded absolute marketplace path>`.
Codex shows the plugin page and the user chooses Install; Orion must not write
to Codex's personal configuration, silently install anything, or ask the user
to edit JSON. Clicking the action again opens the same page for update or
reinstallation, while Codex remains authoritative for installed state.

The Codex-facing behavioral and privacy boundary is the Claude MCP contract
above:

- The skill should discover Spaces before acting, use exact IDs, and open
  underlying notes or sources when an overview is insufficient evidence.
- Reads default only to the active Space; create, update, and delete require an
  exact explicit `space_id` and persist immediately as ordinary Orion notes.
- The plugin must return Orion note citations/deep links, preserve lock-safe
  atomic vault writes, and never expose proposal, agent-attribution, or review
  state.
- The plugin and MCP server make no network request, cannot read provider keys,
  and treat all vault text as untrusted data. Once Codex receives requested
  note text, that data is governed by the user's Codex product/account settings.

`npm run build:codex` stages and validates the plugin. In a desktop or release
build, always run `npm run build:mcp` first and then exactly one
`npm run build:codex -- --use-existing`; the latter must reuse the already-built
MCP executable rather than compiling the Rust crate twice. The MCP build remaps
local Cargo, Rustup, and repository prefixes, strips link/debug symbols after
linking, and rejects any remaining build-user home path before signing. The
Codex contract
harness receives the resource root and fixture vault, validates marketplace,
plugin, skill, metadata, MCP paths, permissions, and shared versions, then runs
initialize/read/write/citation checks against the exact nested binary. The
standalone artifact is
`outputs/Orion-Codex-Plugin-<version>-Apple-Silicon.zip` and must contain one
top-level `Orion-Codex-Plugin/` marketplace root.

## Persistent Space knowledge topology

Orion persists a versioned semantic hierarchy for every substantive Space.
The saved **Across this Space** overview is the human-readable projection of
its validated root, while a saved/local overview remains the bounded runtime
fallback whenever the hierarchy is missing or stale.

One note is enough for Across this Space. The overview and digest index share
the same eligibility check: any readable note body or meaningful summary counts,
without a minimum character count. Exclude archived/in-flight pages, blank notes,
and the default "A new thread in your atlas." starter description. Brief Spaces
may have a single-sentence overview; provider requests must scale to the available
evidence rather than insist on a long essay or ask for more notes. Keep the local
summary visible while AI refreshes, and check index freshness on load so notes
excluded by an older eligibility rule can enter the current hierarchy.

A mature Space should not be reread from raw note bodies before every import,
overview refresh, or enrichment. Orion should maintain a persistent,
hierarchical semantic representation of the Space and update only the parts
affected by new or changed knowledge:

```text
notes
  -> deterministic compact note digests
  -> 24–32-note cluster directories
  -> typed cluster blueprints
  -> recursively merged parent blueprints when needed
  -> one root Space blueprint
  -> the human-readable Across this Space card
```

The root is an orientation and routing structure, not a substitute for the
underlying notes. Every level retains stable downward references so an
assignment can move from root, to a relevant cluster, to an exact immutable
note/version without putting the entire Space into one context window.

### Compact note digests

Every substantive note gets one host-built compact digest keyed by its exact
Space, note ID, and content version. A completed digest contains bounded,
structured metadata rather than an arbitrary opening excerpt:

- ID, exact version, title, aliases, tags, note/reference kind, source IDs, and
  body length;
- concept IDs and labels plus compact relationship hints whose endpoints remain
  inside the same Space;
- ordered headings and a deterministic whole-body sketch sampled across the
  beginning, middle, section boundaries, and end rather than only the first
  characters;
- a content fingerprint covering every note field that can affect semantics;
- explicit digest quality such as `complete`, `weak`, or `fallback`, with the
  reason and boundedness visible to host validation.

Digest construction is local and deterministic. It must be safe to repeat,
must not call a provider, and must never treat a stale editable summary as the
whole note. A changed content fingerprint invalidates the old digest and every
ancestor blueprint that includes it. Missing or weak digests may force a later
exact read, but cannot silently masquerade as complete semantic knowledge.
The digest content fingerprint includes its synthesis-contract version and
derived summary, so fixing digest construction also invalidates cached provider
blueprints without editing user notes or their timestamps.

### Cluster and root blueprints

Partition a complete directory into deterministic balanced ranges of roughly
24–32 digests. The host fixes every cluster's exact member note IDs, versions,
and fingerprint; a provider synthesizes only the cluster title and orientation
from that immutable packet. The resulting blueprint describes its thesis,
durable concepts, tensions, open questions, and important relationships, and
must not reproduce full note bodies. Structural validation rejects missing,
duplicate, substituted, stale, extra, unreachable, or cross-Space membership.

If all cluster blueprints do not fit one bounded merge packet, repeat the same
operation hierarchically. The root blueprint contains the Space thesis,
cluster summaries, routing vocabulary, unresolved tensions, and exact child
blueprint IDs/fingerprints. The visible **Across this Space** card is an
editorial projection of this validated root. It may link to a small set of
representative notes, but those links are navigation/routing hints rather than
evidence that every linked body has been opened.

A Space that fits one leaf cluster skips the separate cluster provider call.
Its root request must receive every current typed note digest, including each
whole-body sketch, rather than a clipped local blueprint or the previous root
copied into that leaf. The new root also replaces that leaf's orientation.
Larger Spaces merge completed provider children. Do not silently truncate a
root packet or call an unfinished local blueprint validated provider synthesis.
Do not carry an obsolete overview into a rebuilt root as evidence; cached
editorial context is usable only while that root remains current.

Never maintain this hierarchy as a growing conversation transcript. Each call
receives fresh typed child artifacts with exact fingerprints, and every merge
produces a new replaceable derived artifact. The last valid root stays visible
while refresh runs. A failed or stale refresh marks it stale and keeps the
previous valid hierarchy; it must not partially replace one cluster or root.

### Sequential incremental maintenance

Ordinary non-import maintenance should default to a calm sequential pipeline:

```text
changed notes
  -> rebuild their local digests
  -> route the delta to affected clusters
  -> update affected clusters one at a time
  -> merge the changed ancestor path
  -> refresh the root and Across this Space projection
```

Coalesce rapid edits and note creation into one pending delta while the current
refresh finishes. Five related new notes should usually cause one cluster
update followed by one root merge, not five readers and not a whole-Space
fan-out. Several unrelated additions may touch several clusters, but provider
width is derived from the number of affected clusters, never raw note count.
Prefer the sequential path for coherence and low background contention.

Cluster synthesis and ancestor merges currently run sequentially, including a
first large-Space build. If a future explicit rebuild parallelizes independent
clusters, cap physical provider calls at six and retain the same exact
membership barrier before merging higher levels. Rebase an affected cluster
from its current member digests instead of repeatedly summarizing prior
summaries, which prevents incremental semantic drift without rereading
unaffected note bodies.

Except for an explicit Space-scoped Chat question and one-generation consent in
the Generate composer described below, when `includeExistingNotesInAIContext` is disabled, the local digest/index may
still be maintained as private derived data for deterministic search,
fingerprints, and collision safety, but no overview, digest, cluster/root
blueprint, note-derived routing signal, or note body may be sent to a provider.
Use the existing keyless local overview behavior instead. Enabling the setting
permits only the minimum typed levels and exact notes required by the operation;
it never permits a blind whole-Space body upload.

### Import topology

Import consumes the persistent Space hierarchy without blocking on a fresh
whole-Space read. The long-import topology is:

```text
validated root Space blueprint (or current bounded overview fallback)
  -> one reading blueprint
  -> adaptive parallel source readers
  -> typed relevance routing and selective exact-note reads
  -> one writing blueprint that inherits the reading blueprint and readings
  -> 1–6 disjoint writer slots
  -> deterministic local validation and atomic assembly
```

The reading blueprint receives the root Space thesis, relevant cluster
summaries/back-pointers, import guidance, and the complete deterministic source
range manifest. It decides the questions, emphasis, likely relevance, and
comparisons before any source range is interpreted. It does not receive every
Space note body and may not establish source claims. If the hierarchy is
missing or stale, use the current saved/local **Across this Space** orientation
and bounded linked-note excerpts; do not delay the import for a hierarchy
rebuild.

Source readers then run with adaptive logical width and at most six physical
calls. Every reader inherits the same reading-blueprint thesis plus only its
exact source range and explicitly scoped Space comparison signals. It returns
source-supported claims separately from Space-lens interpretations. It also
returns distinct, importance-ranked synthesis seeds: semantic titles, theses,
exact claim IDs, and a typed `new | extends | contradicts | connects |
qualifies` Space contribution. Readers also identify deliberate durable
`linkPhrases` grounded in the seed's thesis or selected claims; older readings
may omit this optional field. These are semantic vocabulary, not mined tags or
keyword frequency. A seed proposes a durable knowledge object, not
a range summary or final note draft. Source claims are atomic; every claim is
partitioned into exactly one seed, a seed may combine at most four mutually
supporting claims, and seed titles and theses are unique within the reading.
Low-value material remains visible as low-importance seeds for an explicit
planner omission rather than disappearing during reading. Successful
siblings survive a closer read of an incomplete dense branch, and the host
locally restores exact canonical range coverage.

After reading, use the persistent root/cluster back-pointers to contract a small
candidate digest universe. The existing typed router classifies exact
note/version candidates as `unrelated`, `duplicate`, `extends`, `contradicts`,
or `uncertain`; it does not crawl every Space note. Complete exact routing
coverage is still mandatory for that contracted universe. Open full bodies only
for versioned `extends`, `contradicts`, or `uncertain` candidates, plus the
existing duplicate-owner exception. Routing remains read authority only and
does not grant revision ownership or source provenance.

The writing blueprint receives the original reading blueprint, every validated
canonical source reading, typed routes, and only the selectively opened
existing notes. It decides what deserves a note, what should be omitted as
irrelevant/repetitive, which canonical note may be revised, and how outputs are
partitioned into 1–6 non-overlapping writing slots. It must disposition every
seed exactly once as the primary object of an output, a justified merge into
one output, or a low-importance omission. Titles and output boundaries follow
ideas rather than files, chapters, pages, ranges, or source order. Claims from
distant ranges may combine when they establish one thesis; adjacent claims
must split when they establish different ideas. Evidence-rich books often
support ten or more notes or exact revisions, while sparse or repetitive
material may support fewer. This is an evidence-derived quality expectation,
never a numeric quota or permission to create filler. Each writer receives the
Space thesis, its exact output plan, its selected claims, its scoped existing
note versions, and no sibling output. Writers never inherit a growing parent
transcript or the whole Space.

There is no twelve-project-note cap or target fraction of seeds to merge.
Each output develops one clear thesis with distinct supporting details and no
repeated paragraphs. Qualifications remain beside their claims; source
assertions, conjectures, and editorial interpretations must not be conflated.
Keep the shared thirty-output atomic boundary, planned token budgets, and six
physical calls as explicit resource safeguards, never reasons to merge unrelated
ideas. The local repair planner coalesces only identical title-and-thesis seeds.

The writing blueprint plans durable phrase destinations and meaningful directed
connections before writers run. A concept may resolve to a returned argument
note as well as a canonical article; sentence titles are not the only vocabulary.
Connections use `supports`, `qualifies`, `conflicts`, or `related` with a specific
reason. Legacy untyped suggestions default to `related`; existing `contrasts`
relationships still validate. Assemble every note first, then resolve exact
same-Space destinations, canonical aliases, and typed relationships locally.
Shared source membership alone must never create a relationship. Display the
direction and reason in the existing connections inspector, not a graph canvas.

There is no final model that rewrites all accepted prose. The host validates
the two blueprints, complete source coverage, routes, note versions, ownership,
provenance, citations, links, tasks, output IDs, and aggregate limits, then
applies the result atomically. This preserves the useful `blueprint -> fan-out
-> blueprint -> fan-out` shape while keeping factual evidence, control flow,
privacy, and final assembly deterministic.

Single short sources still use the direct one-call path. Multiple short sources
use a deterministic local reading blueprint, parallel full-source readers, one
shared writing blueprint, and up to six disjoint writer slots. This skips the
long path's provider reading-plan call without losing exact coverage, typed
evidence, ownership, checkpoint recovery, or atomic assembly. The host may
repartition validated output ownership into disjoint slots; it must never
invent outputs to fill those slots. For a fresh Space, a batch of at most six
short sources totalling at most 24 KiB may also skip the provider writing plan
when its validated readings contain at most six distinct, non-overlapping,
all-new seeds. Preserve one output per seed and validate the host plan against
the same evidence/ownership contract before any writer starts. Explicit import
guidance, custom organization preferences, task lists, additional reader
preservation requirements, low-importance seeds, ambiguous overlap, and existing
notes retain the shared provider planner. Do not force the fast path or merge
unrelated seeds just to reduce latency. The persistent Space
hierarchy must reduce repeated context work, not add a planning tax to small
inputs. Import parallelism is for latency across independent source readings
and writer slots; background Space maintenance remains sequential by default.
The direct path has an eight-minute wall-clock safety boundary: five minutes
for primary synthesis and a three-minute finalization reserve. A root provider
transport may use four minutes within the primary window, retaining room for
an immediate transport retry; routing and other
non-root assignments remain capped at two minutes. Import opts into preserving
an active root transport across the soft finalization cutoff; it still obeys
its transport ceiling and the hard overall deadline. Keep the deadline error copy
duration-neutral so tests with deliberately shortened clocks and future budget
changes never report a false elapsed time. The fixed multi-stage pipeline keeps
its separate per-transport deadlines and checkpoint recovery rather than
inheriting this direct-path wall clock.

Tests must prove full initial note
coverage, exact incremental changed-note coverage, stable 24–32-note
partitioning, hierarchical overflow, weak-digest escalation, no cross-Space
members, fingerprint invalidation, last-valid-root recovery, sequential
five-note maintenance, bounded large rebuild concurrency, preference-off
privacy, no import-time whole-Space crawl, inherited blueprint context, scoped
reader/writer packets, route-gated exact reads, versioned ownership, and no
provider call after local assembly begins.

## Import pipeline

Import has four phases: Add, Review, Organize, Results.

`src/lib/providerScheduler.ts` owns one ten-call physical provider budget per
Orion renderer, shared by imports, maintenance, Chat, generation,
images, and speech. Run/workload queues rotate fairly; source reading also
rotates locally among sources. Slots wrap actual native/fetch transport
lifetimes, including response-body reads. A cancelled caller may stop waiting,
but an uncancellable transport keeps its slot until completion; cancelled
queued calls must never dispatch. Local extraction, fingerprints, cache IO,
and key-status metadata do not enter this pool. Multiple windows each own a pool;
move this authority into the native host before claiming an app-wide cap.
Fixed-import transport deadlines begin at physical dispatch through the
driver's `onProviderStart` hook; queue wait is not a provider timeout. The hook
is host-only and must never enter IPC or provider JSON.

Provider readiness uses a two-minute in-memory success cache, seeded by actual
successful calls or a valid key probe, and coalesces concurrent cold probes.
Changing/deleting a key or a provider failure invalidates readiness. No key or
credential-derived fingerprint is persisted. A probe is only a credentials
check, not evidence that the selected model or a future generation will work.

1. One calm Add surface queues textual documents, images, media, pasted text,
   ordinary webpages, and YouTube links. Choosing files progressively discloses
   the document/image or native media picker; pasted text uses a focused nested
   sheet.
2. Textual documents are parsed locally in the renderer. Meaningful selectable
   PDF text stays on the pdf.js fast path. Before range planning, strip only
   deterministic scan furniture: marginal page numerals, subsequent copies of
   exact recurring running heads, and soft line-break hyphenation. Retain the
   first recurring head as structure and preserve Orion's exact `## Page N`
   boundaries so cleanup cannot weaken provenance. Preserve damaged replacement
   glyphs as visible uncertainty and attach a source warning once their count or
   density is material; never silently guess scanned words. Before accepting a
   PDF, select only physical pages whose text is absent or materially damaged,
   send their exact page numbers with the original PDF to the bundled native
   Apple Vision helper, and conservatively replace a page only when recognized
   text has better glyph quality, plausible coverage, and lexical continuity.
   Healthy pages stay on the pdf.js path. PNG, JPEG, HEIC, and HEIF images use
   the same local helper. Public HTTPS webpages are fetched through the bounded native command
   and then parsed by the same renderer text/HTML path.
3. Media is decoded by AVFoundation and transcribed by bundled Whisper.
   Selectable PDF pages use four shared local extraction slots with stable
   physical page order and exact selective OCR coverage. This pool is independent
   of provider scheduling, OCR, downloads, and Whisper. Do not launch six Whisper
   processes: each already uses GPU, CPU threads, and decoded-audio memory.
4. Each input enters the queue immediately with its own preprocessing state.
   More inputs may be added concurrently. Closing and reopening Import preserves
   work in the active Space; changing Spaces clears it, and deleting an item
   means a late async completion must be ignored rather than resurrecting it.
5. Only successfully parsed text can enter Review or either organization mode.
   Ready sources may enter Review while other inputs are still preparing. Freeze
   the reviewed selection: a late extraction remains unselected until explicitly
   included, and may not invalidate another selection's retry checkpoint. After
   apply, remove only the exact organized intake IDs, retaining all other queued
   work. Space changes still clear the queue and ignore old asynchronous UI updates.
6. Manual mode creates one editable note per source.
7. Installed-app AI mode enters one bounded knowledge-orchestration run using
   the selected OpenAI Responses (`store: false`) or Anthropic Messages model.
   A genuinely short source can still complete in one direct root call, without
   paying for either planning stage. Before the run begins, an ordered
   selection that cannot fit one bounded synthesis is partitioned locally into
   deterministic batches. Process those batches in source order, preserve the
   already accepted batch results, and combine them only through the normal
   validated import payload; never truncate or silently drop a source to make a
   batch fit.
8. Long imports use a stable stage order with an adaptive reading topology:
   zero-provider local Space orientation, one reading blueprint, a dynamic
   parallel source-reading queue, one writing blueprint, parallel note writers,
   then local validation and assembly. The blueprints decide task-native focus
   and emphasis; the host owns source subdivision, physical concurrency,
   evidence reassembly, and every transition. Do not return to a free-form
   model-generated task graph for this path.
9. The reading blueprint receives the deterministic source-range manifest plus
   a bounded local orientation before any range is interpreted. Prefer the
   current persisted root Space blueprint and relevance-ranked cluster
   blueprints; if they are absent or stale, use the saved **Across this Space**
   overview and its valid same-Space notes that are visible or mentioned
   through the card's link vocabulary, with bounded excerpts from at most eight.
   Invalid, deleted, cross-Space, and duplicate references are ignored. If no
   saved overview is available, use the same keyless local overview shown on
   Home, built from workspace identity and at most four recent substantive
   notes; its visibly named notes may supply the same bounded excerpts. A saved
   overview with no valid visible/mentioned destination remains summary-only.
   Never crawl the whole Space or make a provider call to discover context.
   The orientation explains the Space and helps assign every exact range once,
   including focus questions, concepts, comparisons, and `mustPreserve`
   material. It is an untrusted lens, not evidence about the imported source.
10. Source readers apply that lens eisegetically but must keep projection
    visible: source claims cite source-only range support, while Space-derived
    interpretations separately cite claim IDs and related note IDs. A dense,
    incomplete, malformed, or otherwise range-local failed branch is
    divided deterministically into two exact child ranges when it is large
    enough; already successful siblings remain accepted. Child work inherits
    the canonical reading brief and does not infer from failed parent prose. An
    indivisible branch gets one compact repair reading. Provider timeouts and
    provider-wide failures fail the stage instead of multiplying source
    branches; the explicit Wave 2 setting may make its one bounded
    alternate-provider attempt before that failure is final.
    Adaptive subdivision is guarded by per-canonical-range and whole-run
    logical-task/attempt fuses (7/12 per canonical range; 48/72 per run). A
    persistently malformed provider therefore reaches a typed stopped state
    instead of expanding a binary tree indefinitely.
    Completed leaf readings may be served from a bounded local fingerprint
    cache keyed by Space, model, effort, reader brief, and exact range content
    (never by import-scoped source IDs, never across Spaces); every hit is
    rehydrated to the current contract and revalidated, and any mismatch is an
    ordinary miss, so correctness never depends on the cache. After every
    canonical range
    has complete locally reassembled evidence, one writing blueprint decides
    which notes genuinely belong, whether each is a note or canonical article,
    which existing destination may be revised, and how writer slots divide the
    work. A malformed or rejected writing blueprint gets one immediate
    corrective retry that names its exact contract violation. If it remains
    invalid after every source reading is complete, Orion recovers without
    user interaction: the host builds a create-only plan from the validated
    semantic seeds, coalesces only identical titles and theses, preserves exact selected
    claims, and schedules at most six bounded writer slots. It never creates
    `Source — Part N` titles or uses physical ranges as note boundaries. This
    repair cannot revise existing notes, invent claims, or widen Space access.
    Several small outputs may share one
    writing pass — the per-slot output and token caps are the division contract,
    not a mandatory slot count.
11. Writer slots run concurrently and return complete structured drafts for
    only their declared output IDs. Orion validates the drafts against both
    blueprints, source evidence, exact Space versions, links, provenance, task
    placement, and aggregate limits, then assembles them locally. A malformed
    writer result gets one exact corrective retry. If a multi-output slot is
    still contract-invalid, the host bisects only that slot and schedules its
    smaller children while retaining successful sibling slots; physical width
    remains six. If an irreducible one-output slot is still contract-invalid,
    Orion creates a transparent draft only from that output's planned thesis,
    exact selected claims, and selected Space interpretations. It never copies
    a private range summary or emits range/source scaffolding. Transport,
    authentication, timeout,
    cancellation, and provider-wide failures never trigger writer subdivision
    or local prose repair. After six exhausted contract-invalid writer
    assignments, a run-wide circuit opens and the host completes every
    remaining output directly from its already validated selection instead of
    spending more provider calls. There is no final provider call that rewrites
    already accepted writer prose.
12. Sources with at least four stable pages use page-aware ranges. Unpaged text
    retains the direct path until it exceeds the 60,000-character threshold.
    Initial canonical ranges are derived from source density and target about
    72 KiB and 12,000
    estimated tokens, with hard packet ceilings of 100,000 bytes and 25,000
    tokens. A Hegel-like book PDF is expected to begin with roughly nine logical
    ranges under those bounds. Initial preflight may allocate up to twelve
    canonical ranges, but that is not a final logical-reading cap: adaptive
    child tasks may widen the queue. Logical width is independent of physical
    width; the runtime permits at most six provider calls at once and schedules
    a wider logical plan across successive physical waves.
    Readers start at four, rotate fairly among sources, and grow to six only
    after a complete clean cohort. Original pending work fills idle slots while
    sibling requests run. Failed or repaired work cannot widen the current
    cohort; deferred repairs wait until the live original frontier settles.
    Validate, cache, checkpoint, and fingerprint settled ranges while siblings
    are in flight. The complete reading barrier still precedes every writer.
13. Existing-note context starts from the current root Space blueprint or the
    bounded **Across this Space** fallback, never an all-note provider fan-out.
    Before source reading, the fixed long path receives no automatic routing
    crawl. After every canonical source range has been read, it contracts one
    small candidate universe locally from the readings and persistent
    hierarchy, runs the typed routing barrier, and selectively opens only
    authorized exact note versions before the writing plan. The full Space
    snapshot may remain local for collision, version, and ownership checks but
    is not model context. A stale overview stays usable and is marked stale.
    As a narrow duplicate-prevention
    exception, the long-path writing planner may receive a title-only collision
    directory capped at 500 entries and 48 KiB; it contains no body or summary
    and grants no revision authority. The short direct path additionally
    contracts the hybrid typed-routing universe described under “Typed semantic
    note routing”: local anchors plus positive digest matches, capped to one
    inline range and at most one host-owned router assignment. Even a small
    Space must not be routed in full merely because its directory fits one
    provider call. This path is never a parallel shard crawl. If existing-note
    context is
    disabled, expose no overview, collision title, linked-note excerpt, digest,
    routing assignment, concept, relationship, or other note-derived context to
    the provider.
14. Project notes, canonical articles, concepts, relationships, and source
    provenance are applied once through the atomic import payload boundary.
    Blueprint packets and partial reader or writer work never enter the Space.
15. The adaptive long path has no shared 120- or 180-second stage/product
    cutoff. Its reading plan, each source-reading request, writing plan, and
    each writer receive an independent 300-second emergency transport-safety
    ceiling; user cancellation is the run-level stop. That ceiling is not a
    shared stage or product countdown. The genuinely short generic direct path
    uses the eight-minute bounded runtime described above. Its timeout or
    invalid-result recovery may enter the existing compact fixed-stage pipeline
    once, using the selected model and the same frozen input. Never fall back to
    the legacy network organizer. Exhausted recovery preserves the complete
    extracted text on its Source record and creates bounded editable notes.

The OpenAI-facing response envelope remains a strict root JSON object with
required `kind`, `payload`, and `calls` fields. Represent the inactive semantic
union branch as `null`, then normalize it to Orion's internal
`complete | coordinate` union after receipt. OpenAI rejects a root `anyOf`, so
never expose that internal discriminated union directly as its response schema.
Anthropic receives a deliberately compact strict envelope containing `kind` and
`dataJson`; Orion parses that inner branch and subjects it to the same complete
local protocol validation. Do not send the recursively expanded OpenAI schema
to Anthropic: its grammar has tighter union/constraint complexity limits.

Every completed source reading returns a substantive `summary`, complete range
coverage, source-supported claims, clearly separated Space interpretations, and
a strict assessment containing:

- `sourceAssessment.importance` and its source-grounded `rationale`;
- `spaceAssessment.relevance`;
- `spaceAssessment.novelty`;
- `spaceAssessment.focusConcepts`;
- `spaceAssessment.deprioritizedConcepts`;
- exact `spaceAssessment.reviewedNoteIds`;
- a supporting Space-lens `rationale`.
- nonredundant `synthesisSeeds`, each with a semantic title, thesis, exact
  source-claim IDs, importance, typed Space contribution, related note IDs,
  and rationale.

Relevance, importance, and novelty are distinct. A source can be unfamiliar to
the Space and still important; conversely, repetition can be highly relevant
but add little. The writing blueprint must consider every completed source
reading, but it may omit material assessed as low-value repetition or
tangential detail from the generated notes. Never imply that omitted prose was
absent from the source: the complete extracted text is always retained on its
local Source record.

The Review phase exposes one optional batch-level **Guide this import** field.
It applies to every selected document, pasted item, webpage, transcript, and
YouTube source in that batch, is persisted on each resulting source record, and
must be placed before general Space preferences in the organizer prompt.
Import-scoped instructions and the Space preference have independent
2,000-character bounds.

Current limits are 12 sources per batch, 25 MiB per document or image, and
5 MiB per fetched webpage. AI batches also cap extracted source text at
1,800,000 UTF-8 bytes as an intake and context-safety boundary. The intake may
auto-partition one ordered selection into several bounded synthesis batches,
using the reader's exact minimum payload-safe section count to enforce the
12-canonical-evidence-group ceiling as well as source count and bytes.
The per-batch limits still apply, and a single source above the byte or reading
cap remains an explicit singleton failure/landing rather than being clipped. Space
orientation is constructed locally and consumes no provider-call budget. The
adaptive long path is not governed by one shrinking 180-second clock: the
reading blueprint, each source-reading request, the writing blueprint, and each
writer receive an independent 300-second emergency transport-safety ceiling.
It is not a shared stage or product countdown. Cancellation must abort active
work and ignore late completions. The short generic direct organizer uses the
eight-minute orchestration boundary described above.

Initial source ranges are derived from source density and aim for approximately
72 KiB and 12,000 estimated tokens while enforcing hard ceilings of 100,000
bytes and 25,000 tokens. A Hegel-like book therefore begins with roughly nine
logical ranges, not a forced one-wave allocation. The initial canonical plan
may contain at most twelve ranges, but adaptive subdivision can increase logical
reading width beyond twelve; only physical concurrency remains capped at six.
Source-reading outputs cap at 10,000 tokens, the reading blueprint at 4,000, the
writing blueprint at 12,000, writers at 12,000, and the short direct root at
12,000. Reading and validation
reasoning is capped at medium even when writing stages use a higher selected
effort. The 30-new-note aggregate batch cap must fail visibly rather than
silently slicing model output.

Each transport failure is interpreted at its real scope. Range-local failures
may narrow only that branch while retaining successful siblings; provider-wide
authentication, availability, model, billing, schema, or rate-limit failures
must not create a split storm. A malformed typed routing response is
non-evidentiary and may safely degrade to create-only synthesis. A persistently
invalid writing plan must use the host-owned multi-note repair plan instead of
stopping for Resume. A persistently contract-invalid writing slot narrows at
runtime; once it owns only one output, the host may finish that output from its
already validated summaries and selected claims. An indivisible reading repair
or a terminal provider-wide writing failure preserves the source without
partial application.
Provider timeouts at reading-plan, routing, or writing-plan stages stop and
checkpoint that stage; they must not fall through to local planning and fan out
more calls. Contract-invalid plans may still recover locally.
There is no installed-app network retry through a legacy organizer after an
orchestration failure. The only cross-provider retry is the user's explicit
Wave 2 failover setting described below; it retries one eligible assignment,
not the import through a second organizer. `runAutomaticKnowledgeImport` owns
batch recovery: a direct deadline, provider timeout, malformed result, or
coverage/validation failure may enter the compact fixed-stage pipeline once.
This uses a local reading plan and the same provider/model/effort and frozen
source/Space contract; it is not a replay of the failed direct request. Explicit
authentication, billing/quota, unsupported-model, and request-schema failures
land immediately, without this extra work. Direct network retries remain owned
by the direct scheduler rather than another whole-import retry loop.

A failed fixed long-import stage must return a typed recovery checkpoint before
control reaches Import Studio. This checkpoint is an exceptional safety net,
not a normal interaction: contract correction, safe routing degradation,
host-owned writing-plan repair, and checkpoint-safe automatic retries run
without asking the user to click Resume. It contains the immutable reading plan,
successfully completed canonical source readings, validated adaptive child
leaves plus their exact pending binary frontier, accepted typed-routing
artifacts, an accepted writing plan when one exists, completed per-output
drafts and writer slots, recovery-circuit state, and monotonic physical-attempt
counters. The checkpoint schema is versioned; incomplete older shapes are
rejected rather than trusted.
Automatic resume reuses the same logical run and calls only unfinished canonical readings
or writer slots; it must never repeat already accepted provider work. Validate
the checkpoint against the frozen Space version, exact source fingerprints,
model, effort, guidance, and organization instructions before use. Any mismatch
invalidates the checkpoint; stale work must never be applied. Checkpoints are session-local,
never mutate the vault, and are discarded when the source queue, mode,
instructions, or active Space changes.

The landing ladder guarantees that an import with `landOnFailure` enabled never
terminally fails: a run that would throw instead lands deterministically with
zero provider calls, marked on the result as `landing { tier, code }` and led
by a warning beginning “Orion landed this import plainly”. Tier 1 assembles up
to thirty idea-first notes within the shared atomic boundary from the strongest
validated semantic seeds, their theses, and their exact grounded claims; it
groups only identical seed titles and theses, removes exact repeated paragraphs, but
never emits range headings, private reading summaries, claim inventories, or
Space-lens interpretations as evidence. Any additional candidates remain on
the preserved Source/readings for regeneration. Tier 2 preserves the parsed
source text structurally,
bounded to 60,000 characters per note, citing the source directly. Two
diagnostic codes always rethrow instead of landing: `cancelled` (user intent)
and `space-changed` (stale base). Landed notes are honest scaffolding the user
can regenerate later, never a disguise for a failed synthesis.

Results must show the exact failed stage, a redacted provider or validation
detail, retained reading/writing counts, a run ID, model, and recorded time only
when automatic recovery is genuinely exhausted. Landing retains the classified
safe diagnostic and session checkpoint; it must not render the normal success
heading. Automatic recovery reuses successful unchanged batches; queue,
guidance, mode, or Space changes discard that retained work. Redact API keys,
bearer tokens, and user-home path components. Do not expose Retry/Resume buttons:
the final incomplete result says **AI synthesis is incomplete**, explains that
recovery finished, and offers **Keep available notes**. This is still an explicit
atomic Add/Keep action, not an automatic vault write. Show the source preservation
explanation once, never concatenate duplicate fallback copy.

Progress must reflect the real staged pipeline without exposing orchestration
jargon. The user-facing stages are **Preparing the reading**, **Reading in
parallel**, **Planning the notes**, **Writing in parallel**, and **Final checks**.
Show completed/total reading and writing counts where they are known; reading
total may increase when one branch needs a closer pass. Keep the source title
and batch ordinal visible, retain Cancel throughout the installed run, and use
an indeterminate overall indicator rather than inventing a time percentage.
Never say worker, blueprint, fan-out, topology, deterministic, or split in the
normal Import progress UI. Automatic recovery explains the closer reading or
retained progress without requiring a recovery action. Prefer “closer read” when adaptive narrowing needs
explanation. Results
count prepared notes, never label a generated note as a source “page.”

### Typed semantic note routing

Orion exposes a host-owned semantic routing layer for consumers that need to
compare an assignment with frozen existing notes. Import uses it as a hybrid
contract, never as a mandatory whole-Space crawl: the short direct path
contracts at most one router assignment as mandatory initial coverage before
its root call. The fixed long path uses the root Space blueprint or bounded
**Across this Space** fallback before reading, then—only after grounded source
readings exist—contracts at most one hybrid routing range from that evidence
and the local hierarchy before its writing plan. Adding routing anywhere must
never quietly restore a parallel provider crawl of the whole Space, and
parallel routing shards must never compete with an import's own reading and
writing calls. When existing-note context is disabled, send no hierarchy,
construct no provider-visible note digest directory, and schedule no router
assignment.

The routing universe is chosen deterministically and locally before the run is
frozen. A hybrid run always starts with its explicit anchors and adds only
positive metadata/digest matches scored offline against the assignment material
and guidance, using title, alias, concept, tag, and summary signals. This local
prefilter applies even when the complete Space would fit one provider call, and
the selected universe is capped at 71 notes so it remains one virtual routing
range. Import anchors on Across this Space links; enrichment treats its origin
as direct evidence rather than routing it against itself, uses the origin's
prose for local relevance matching, and skips routing when no candidate remains.
Consumers that genuinely contract a complete larger directory partition it
deterministically into balanced 24–32-note ranges, refuse more than 100 ranges
(therefore more than 3,200 notes), and refuse a range whose note IDs exceed its
identifier-size safety bound; Import and enrichment do not use that whole-Space
form.

Routers see compact digests plus a bounded host-built synopsis of the
assignment material (source titles, headings, and a short opening excerpt for
imports; the origin note's title, summary, and opening for enrichment). The
synopsis is untrusted context and never source evidence, and router rationales
stay one short clause so a routing pass cannot consume the run's latency
budget.

The host builds compact local note digests and owns every routing assignment.
A model-written coordinator cannot invent, widen, or delegate a router job.
Each route must classify one exact immutable `noteId` + `noteVersion` as exactly
one of `unrelated`, `duplicate`, `extends`, `contradicts`, or `uncertain`.

Coverage is a barrier over the frozen contracted universe, not a best-effort
relevance hint. Before any consumer may expand a full note body, validate that
every expected range exists once and every exact contracted note ID/version was
routed once. Reject missing, duplicate, unknown/extra, stale, cross-Space, or
substituted coverage and keep the root assignment open for correction; never
accept partial routing output. Once routing is contracted for a run, a failed
or incomplete routing pass rejects the root result with a coverage diagnostic.
Only validated `extends`, `contradicts`, and `uncertain` routes may become
versioned full-note read candidates. `duplicate` remains a metadata/candidate
signal for deduplication and grants no body read by itself; `unrelated` never
expands. Routing is read-only orientation: it grants neither write/revision
authority nor source-evidence status, and its rationale cannot support a claim
about imported material.

After complete coverage validates, the root receives only bounded routed-note
metadata: exact ID/version, relation, short rationale, title, compact summary,
and duplicate candidates. It never receives a routed full body implicitly.
Contradictions rank first, then extends, uncertain, and duplicate, so bounded
selection cannot silently discard disagreement. A later assignment may open an
`extends`, `contradicts`, or `uncertain` body only by citing both its exact
frozen note reference and the exact router artifact that classified it.
`duplicate` may be opened only by an exclusive destination owner for that same
note and base version; ownership and routing authorization are both required.
A duplicate-routed note may not be replaced under its title or aliases without
that exact owner revision, and every duplicate match surfaces as a stable result
warning.

### Compact legacy organizer boundary

The remaining direct/browser organizer utilities, selected-text article path,
and compatibility wiki refresh use `buildCompactOrganizerContext`. That helper
is a deterministic, bodyless digest directory with a 56 KiB serialized budget,
not the retired arbitrary fixed-count payload of note-body slices.
Its records may contain title, aliases, summary, headings, tags, concepts,
relationship hints, a whole-body sketch, body length, frozen version, and digest
quality, but shared builders must leave `body` absent. Small Spaces may fit their
complete metadata directory; larger Spaces locally select graph anchors and
positive semantic matches before applying the byte budget. A bodyless record is
for orientation, title reuse, and deduplication only: it cannot authorize an
existing-note rewrite. Disabling existing-note context returns no directory at
all. Do not reintroduce a fixed note-count/body-slice fallback.

### Wave 2 acceleration and recovery

- The installed app keeps a bounded, best-effort fingerprint cache for
  validated source-range readings and typed-routing results. A routing key
  includes the Space, model, effort, assignment synopsis, and every contracted
  note ID/version. Rehydrate and revalidate every hit against the current frozen
  contract; corruption, mismatch, missing coverage, or an unavailable cache is
  an ordinary miss. Correctness must never depend on cached prose or routes.
- Import selections are partitioned deterministically and in order when source
  count, UTF-8 size, or minimum canonical reading count cannot fit one synthesis.
  `importBatching.ts` shares the exact page-aware, byte/token-safe minimum
  section calculation from `knowledgeOrchestration/context.ts`; byte division
  or file counts alone cannot establish reading coverage. Each bounded batch
  completes through the same orchestration and validation contract, completed batches are
  retained, and the combined result is applied through one normal import
  payload. An individually oversized source remains a visible singleton failure
  or deterministic landing; it is never silently truncated out of the queue.
- Provider failover is off by default and must remain an explicit setting. When
  enabled and the other provider has a configured key, one assignment that
  fails for an eligible timeout, network/availability, or rate-limit shape may
  retry exactly once with that provider's canonical default model. Never fail
  over authentication/billing errors or cancellation, never bounce repeatedly,
  and never reinterpret failover as permission to run a second organizer.
- Rolling provider-health memory is local, bounded, and best-effort. It may add
  a concise concern to preflight diagnostics but cannot silently choose a
  provider. A checkpoint-safe transient failure may auto-resume at most twice per batch
  with bounded backoff; cancellation, a changed Space, and unsafe checkpoints
  remain visible stops.
- The direct scheduler also retries typed transient transport failures at most
  twice inside its existing time budget. Native connection failures must be
  classified as retryable, without wrapping cancellation, credential, request
  schema, or explicit billing failures as transient. Do not replay the direct
  organizer after this scheduler exhausts its attempts; its one-time staged
  recovery is the narrowly authorized exception described above. The
  readiness check may retry transient connectivity/availability failures twice
  with 2- and 8-second abortable backoff before presenting Results.

## Adaptive source-reading orchestration

The long-import stage order remains stable while logical reading width may
change. Deterministic input preparation proves initial full source coverage and
constructs a bounded local Space orientation from **Across this Space** and its
valid linked notes. The reading blueprint chooses questions and comparisons for
that complete canonical manifest. A host-owned queue can then narrow only a
dense, incomplete, or range-local failed branch, retaining every successful
sibling. The writing blueprint receives locally reassembled canonical evidence
only after every original range is complete, then chooses a bounded set of
non-overlapping outputs. This keeps model judgment where it improves relevance
without letting it invent an unbounded control graph or scan the vault for its
own context.

The useful width distinctions remain:

- **Logical width** is the accepted, unresolved set of planned source readings
  or note outputs.
- **Physical width** is the provider calls currently executing and is capped at
  six regardless of logical width.
- **Write width** is the number of mutually disjoint writing slots accepted from
  the writing blueprint, never the number of notes Orion hopes to manufacture.

For a long path the runtime accepts exactly one reading blueprint and exactly
one writing blueprint. The initial readers are named by that blueprint; adaptive
children are deterministic host subdivisions that inherit the same canonical
brief and cannot introduce another planning or synthesis layer. The queue runs
at most six calls physically and has no final twelve-reading logical cap.
Completed child readings are ordered by subdivision path and reassembled
locally into one evidence artifact per original range. Claim and interpretation
IDs are namespaced, child support is remapped to the canonical range, and exact
coverage is revalidated before writing. Writer assignments must exactly cover
the writing blueprint's output IDs, with no duplicate normalized titles,
destination overlap, undeclared extra draft, or missing draft. The final
assembler is local code, not a model assignment.

Assignments are temporary information boundaries. Reader and writer are output
contracts, not personas. Each assignment identifies one precise objective,
explicit source/page/note/artifact references, Space and import constraints,
read or revision authority, a bounded output contract, and a termination
condition. Never prompt permanent human roles or pass parent transcripts
wholesale.

### Context, ownership, and atomicity

- Freeze one immutable Space snapshot for the run. Later assignments cite exact
  source, note, and artifact versions.
- Construct Space orientation locally with zero provider calls. Use the saved
  **Across this Space** title/body even when marked stale, then resolve at most
  eight valid same-Space notes that are visibly named or linked through the
  overview card's own link vocabulary. Bound every excerpt and the aggregate
  packet; never substitute a full-Space note crawl when links are absent.
- Treat overview text, linked-note excerpts, concepts, relationships, and all
  other existing Space material as untrusted context. They can focus questions
  and support separately labelled Space interpretations, but cannot establish
  a claim about imported source prose. Source evidence must cite source ranges.
- Keep the complete Space snapshot local for title collision, destination
  ownership, and frozen-version validation. The long-path writing planner may
  see only a bounded title-only collision directory from otherwise unlinked notes:
  at most 500 titles inside 48 KiB, with no body, summary, aliases, concepts, or
  provenance. This directory prevents duplicate names; it is not semantic
  context, evidence, or revision authority. Do not permit an unlinked note to
  become a revision target merely because its title appears there.
- When existing-note context is disabled, send no overview, linked-note excerpt,
  compact digest, routing assignment/result, collision title, concept,
  relationship, prior-source association, or other note-derived signal.
  Workspace identity and import instructions may remain, but the provider must
  not receive knowledge derived from notes.
- Reconstruct minimum-sufficient context from declared references. Never send
  unrelated Spaces, provider keys, unspecified note/source bodies, or hidden
  job artifacts.
- A routed full-note read requires complete routing coverage plus an assignment
  that cites the exact frozen note/version and the exact router artifact carrying
  its allowed relation. `unrelated` never opens; `duplicate` opens only inside
  its exclusive exact-version destination owner. Direct run evidence such as an
  enrichment origin may be allowlisted for reading, but that allowlist alone
  never grants revision ownership.
- Retain stable source identity and page/range metadata in every reading.
  Planning cannot discard declared provenance or `mustPreserve` constraints.
- Adaptive child ranges must be non-empty, ordered, non-overlapping, and
  concatenate exactly to their parent. Failed parent responses are never
  evidence. Merge completed leaves locally in path order, namespace their claim
  and interpretation IDs, remap support to the canonical original range, and
  accept the canonical artifact only after every child has complete validated
  coverage. Successful siblings must not be reread because another branch
  narrows or repairs.
- Blueprints and readings are not user notes. Do not pollute the vault, sidebar,
  concepts, or source viewer with orchestration packets.
- Existing-note revisions require one exclusive writing output per exact
  destination and frozen base version. Disjoint slots may run in parallel;
  stale drafts must be rejected rather than overwriting a newer local or MCP
  edit.
- Validate schema, provenance, citations, canonical reuse, concepts, links,
  task placement, ownership, and current versions before one atomic apply.

This produces evidence-first enrichment: useful new evidence is integrated into
natural prose instead of appended as `Context from` sections. It does not force
completed low-relevance or tangential material into a note merely to prove a
reader saw it; provenance and the preserved local source remain the audit trail.

### Resource, privacy, and verification boundaries

The selected provider and model remain the user's configured choice. Do not
silently substitute models for a planning, reading, or writing stage. The sole
exception is the explicit provider-failover setting: one eligible failed
assignment may retry once on the other configured provider's documented default
model under the Wave 2 boundary above.
Parallelism can reduce wall-clock time but may consume more tokens, so do not
market it as a cost reduction. Recovery retains canonical source/range identity
and exact input coverage; adaptive child paths are deterministic, and a late
result from a cancelled or superseded attempt is ignored.

Keep the orchestration core deterministic and its causal event projection
replayable. Tests must prove:

- a short import can complete in one call without a planning tax;
- page-aware sources begin the adaptive path at four pages, while a wholly
  short batch remains direct; once the adaptive path is selected, every short
  source in that batch receives one full-range reading;
- initial ranges derive their width from source density, preferring roughly
  72 KiB and 12,000 estimated tokens while respecting the
  100,000-byte/25,000-token packet ceilings; a Hegel-like book source begins at
  roughly nine logical ranges rather than being forced into one physical wave;
- twelve bounds only the initial canonical allocation, not final logical width;
  adaptive children may grow the reading total while active calls never exceed
  six;
- Space orientation requires zero provider calls during Import; fixed imports
  never schedule a pre-reading whole-Space semantic router and never block
  source reading on one;
- the reading blueprint prefers the current root Space blueprint plus bounded
  relevant cluster summaries, falling back to the saved **Across this Space**
  overview and excerpts from at most eight valid visible/mentioned linked
  notes; it ignores deleted, duplicate, invalid, and cross-Space references and
  names every planned source range exactly once without receiving imported
  prose;
- a stale saved overview remains a marked orientation lens, while a missing
  overview uses the keyless Home-card fallback and at most four visibly named
  recent notes; a saved overview without valid links remains summary-only, and
  neither case triggers a whole-Space crawl;
- disabling existing-note context removes the overview, linked-note excerpts,
  concepts, relationships, and every other note-derived signal from direct and
  adaptive long-path provider packets;
- the opt-in note router can only be created by the host, uses the exact five
  routing relations, and receives one immutable digest range rather than note
  bodies or source evidence;
- fixed long imports contract that range only after all canonical source
  readings finish, use the readings as the routing lens, validate exact
  candidate coverage, then pass the routes and authorized exact notes to the
  writing blueprint;
- every hybrid routing run applies the local anchor/positive-match prefilter,
  including a small Space, and contracts no more than 71 candidates behind one
  virtual range; consumers that explicitly require a complete directory from
  72 through 3,200 notes use balanced 24–32-note ranges with no more than 100
  assignments, and larger/unsafe directories fail explicitly;
- global routing validation rejects missing, duplicate, unknown/extra, stale,
  substituted, or cross-Space note coverage before any full body is loaded;
  only `extends`, `contradicts`, and `uncertain` become versioned read
  candidates, while `duplicate` remains a metadata signal and `unrelated`
  never expands;
- routed root context contains metadata only; every exact body read cites the
  matching router artifact, and a duplicate body additionally requires the
  exclusive destination owner at its frozen base version;
- each source reading separates source-supported claims from Space-lens
  interpretations, with exact claim, range, and related-note references;
- only a dense, incomplete, malformed, or otherwise range-local failed branch
  is subdivided; successful siblings are retained, provider timeouts and other
  provider-wide failures never recursively fan out, the one opt-in failover may
  run before they become terminal, and an indivisible branch gets one compact
  repair;
- every adaptive split creates two non-empty ordered children whose text
  concatenates exactly to the parent, and failed parent output never becomes
  source evidence;
- child readings are reassembled locally into exactly one validated canonical
  artifact per original range, with collision-free IDs, canonical support, and
  complete coverage before one writing blueprint assigns 1–6 disjoint slots
  and no more than 30 exact output IDs;
- every writer returns exactly its declared output IDs, and deterministic local
  assembly makes no provider call after those writers finish;
- no more than six provider calls run physically at once;
- the adaptive long path has no shared 120/180-second cutoff; its reading plan,
  source-reading calls, writing plan, and writer calls each receive an
  independent 300-second emergency transport-safety ceiling—not a shared stage
  or product countdown—while user cancellation aborts active work and late
  results are ignored;
- the short direct organizer retains its eight-minute bounded runtime, does
  not preempt an active root at its soft cutoff, and may recover a timeout or
  invalid result through the compact fixed-stage pipeline exactly once;
- every completed source reading has full coverage, source importance, Space
  relevance, novelty, focus, deprioritization, reviewed-ID assessment, and
  claim-grounded semantic synthesis seeds that partition every atomic source
  claim exactly once, with at most four mutually supporting claims per seed;
- no provider-visible note body or semantic signal falls outside the
  overview-linked target set; the long-path writing planner's bounded title-only
  collision directory is the sole exception and cannot authorize an unrelated
  existing-note revision;
- overview and linked-note material is always marked as untrusted lens context
  and never accepted as source evidence;
- the writing blueprint dispositions cover every synthesis seed exactly once;
  high/medium seeds cannot disappear, low-value repetition may be explicitly
  omitted, every output owns one primary seed, and distinct ideas are never
  forcibly merged to meet a numeric output ratio;
- final titles and bodies are idea-first and contain no Part-N/range/import
  scaffolding; deterministic writer repair uses only the planned thesis,
  selected claims, and selected Space interpretations, never whole reader
  summaries or range-heading bullet dumps;
- exhausted recovery or cancellation creates no legacy network workflow and
  cannot partially apply completed siblings; the explicit one-request provider
  failover is not a second organizer;
- a terminal fixed-stage failure retains accepted siblings in a validated
  session checkpoint, and automatic resume never calls those assignments again;
- assignment context never crosses Spaces, owners cannot overlap, and stale,
  cancelled, invalid, or late work cannot partially mutate the Space;
- every canonical-note revision matches an exact frozen destination version,
  and every returned output has one non-empty, resolvable provenance record;
- final application preserves source provenance, citations, links, tasks,
  canonical identities, and prior useful prose.
- cached reading/routing hits are revalidated and behave exactly like misses
  when stale or malformed; ordered auto-batches preserve every source and
  completed batch; eligible checkpoint auto-resume and provider failover stay
  within their bounded attempt counts.

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

The top-bar Share or export action supports a self-contained web article,
an editable Word document, and portable Markdown files. All formats share three active-Space scopes: the
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
- Web articles inherit the complete active appearance palette through the
  shared theme resolver: preset, accent, canvas, surface, text warmth,
  contrast, and validated custom colors. Explicit light or dark mode remains
  fixed; System remains adaptive in the exported browser. Embed only derived
  CSS values, never the raw Settings record, and retain the neutral print
  palette.
- Include citation titles, source kinds, and validated public `http(s)` source
  URLs as attribution. Never include raw source bodies, source filenames,
  import guidance, Chat, settings, provider keys, import-draft state, dormant
  Studio data, another Space, or the vault schema itself.
- Do not execute raw HTML from a note or interpolate user text into scripts or
  styles. Keep all CSS and fixed navigation JavaScript inside the file, load no
  remote assets, and retain the restrictive export CSP. The browser file must
  have no dependency on Orion, a server, or the network.
- The native `export_web_page` command revalidates a non-empty HTML doctype,
  enforces a 16 MiB document-shell bound before managed images and a 128 MiB
  final offline-file bound, asks for an explicit local destination, then flushes
  and atomically replaces that file. Browser preview uses a normal Blob
  download. A renderer-provided path is never accepted.
- Markdown export continues to write portable UTF-8 notes with title/tag
  frontmatter and no overwrite, but it uses the same scope resolver as web
  export. Adding a new export format must not weaken these scope/privacy rules.

`src/lib/wordExport.ts` lazily loads the DOCX library and converts the semantic
scoped HTML export to OOXML. Preserve headings, emphasis, safe external and
included-note links, lists/tasks, tables, code, quotes, text alignment, image
captions, document/paragraph margins, and citation attribution. Document body
margins become per-note paragraph insets, with paragraph percentages applied
inside the remaining width. Preserve list hanging indents and quote/code
padding, constrain tables/images to that width, and reset document insets for
table-cell content and the next note. Headers and references retain their own
layout. Word uses document flow; note frames and
free image placement become ordinary Word content. Managed raster attachments
use the native opaque-ID resolver; WebP is converted only in the exported copy.
No remote images are downloaded. Bound text to 16 MiB, each image to 12 MiB,
and final document to 128 MiB. `word_export.rs` validates the ZIP package,
entry paths, content types, CRCs, expanded sizes, and required OOXML parts before
Save As; it flushes then atomically replaces only the user-selected `.docx` file.

DOCX imports use Mammoth semantic HTML with embedded style maps and external
file access disabled, then `docxImport.ts` delegates to the bounded inert HTML
extractor. Its Word profile retains leading checkbox glyph tasks and safe
mailto links without changing ordinary HTML import. Preserve headings, emphasis,
lists, actual table headers/data rows, quotes, literal punctuation/entities and
code spacing. Embedded pictures remain descriptive alt text during extraction;
never read their bytes or load arbitrary image paths. Return explicit conversion
warnings for omitted pictures and simplified structures alongside Mammoth's
warnings. Both
Import Studio and `orion_import` use this same parser. Markdown import and MCP
note writes preserve Orion's portable blocks/table/alignment/margins/image
metadata. Mammoth's semantic DOCX extraction does not retain paragraph indents;
do not claim that importing a Word document restores Orion margin settings.
Validate real generated DOCX bytes through the shared file parser, import
payload and repeated production-editor save/reopen cycles, including headerless
tables with a blank first data row and exact literal code.
Word export must omit `tableHeader` on data rows rather than serialize false:
the current Mammoth reader interprets the presence of `w:tblHeader` as true.
Imported multiple header rows keep their grid/content with one clear warning
that portable Markdown retains only the first row as a header.

Local import preserves the complete parsed/extracted text in its source record.
HTML inputs share `htmlImport.ts` across Import Studio and desktop MCP import.
Parse into detached inert template content, never attach imported nodes or
resolve resource properties. Bound input, node count, nesting and generated
output before returning content; fail without creating a partial source.
Preserve semantic headings, paragraphs, marks, safe absolute HTTP(S) links,
lists/tasks, quotes and simple tables. Headerless tables need their portable
metadata plus synthetic header; real blank rows must remain. Escape authored
Markdown punctuation and ignore imported Orion metadata. Unknown containers
must preserve readable descendants and block boundaries. Images are descriptions
only; unsupported links, complex tables and styling get bounded warnings and
readable fallbacks. Inline/fenced code uses the shared literal serializer,
including edge spaces, dynamic backticks and table pipes. Never fetch resources,
interpret interactive HTML or claim full original-layout/raw-HTML preservation.
Validate through `parseTextImport`, the real import payload and repeated editor
reopening, with a separate real-browser passive-resource probe.
Import payloads carry their originating snapshot version. Keep frontmatter at
the start when adding a generated note heading. After a guarded local or
assistant import merge, reconcile citations only for imported note IDs and
sources that occur exactly once in both the original and merged active Space.
Attach both provenance arrays in the same immutable update without changing
source content. Code, images, raw HTML, metadata and generated References do
not establish citation edges. Preserve ordinary imported-source provenance;
never fetch missing targets, remap IDs or look in another Space.
The editable note copies at most 200,000 UTF-16 units of that text through
`importNoteExcerpt.ts`, ending before an incomplete top-level Markdown unit.
Keep Orion frames balanced and table metadata attached to its table; never cut a
fence, link, list, frontmatter or surrogate pair. Oversized single structures are
omitted from the excerpt, so it may be much shorter than the cap. A generated
title and an explicit shortened-excerpt notice are additional. Do not silently
truncate the source or claim original binary layout is preserved.

## Note image attachment contract

The rich editor accepts local PNG, JPEG, GIF, and WebP images from its Image
tool, the clipboard, or drag and drop. A note persists ordinary Markdown image
syntax whose source is a compact `orion-image://localhost/<asset-id>` reference;
never put native absolute paths or desktop base64 payloads in note bodies or
`vault.json`. The filename-derived alt text must remain visible to Markdown,
MCP clients, exports, and assistive technology, and users can select and delete
the image as one editor node.

The native `save_note_image` boundary accepts at most 12 MiB per image, validates
the opaque asset ID, safe filename, canonical MIME, decoded byte count, and file
signature, then atomically writes the bytes under the private app-data
`attachments/images` folder. SVG and other active document formats are never
accepted. The read-only `orion-image` protocol may resolve only one validated
asset ID from that folder, returns a signature-derived content type with
`nosniff`, and must never accept a renderer-provided path. Browser preview may
use a bounded raster data URL because it has no native attachment store.

Web export retains managed `<img>` elements and the native save boundary replaces
their Orion URLs with raster data URLs, keeping the final HTML offline and within
its restrictive `img-src data:` CSP. Markdown export copies each referenced image
into an adjacent `orion-images` directory and rewrites the exported Markdown to a
relative path. Missing or damaged managed images must fail export clearly rather
than silently producing a broken article. OCR source imports remain a different
pipeline: they discard original source bytes after recognition and never become
note attachments automatically.

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
  applies before OCR as well as to ordinary documents. Whole-PDF fallback is
  limited to 50 pages; the selective PDF contract instead accepts one sorted,
  unique list of at most 512 exact physical page numbers and may open a larger
  PDF while rendering only that list. Reject images above 100 megapixels; downsample source images to a
  4,096-pixel longest edge and render PDF pages to at most 2,600 pixels. Bound
  recognized output to 100,000 characters per page and one million characters
  per document.
- Keep healthy PDF pages on the pdf.js fast path. A page becomes a Vision
  candidate only when it has no meaningful selectable text or at least five
  damaged replacement glyphs at a density of 0.2% or more. Pass the exact
  one-based page list to one native invocation; PDFKit renders only those pages
  serially and Vision returns the same physical numbers. Merge before running
  scan-furniture normalization, preserve every `## Page N` boundary (including
  blank pages), and never append selectable and recognized copies together.
  For damaged pages, accept Vision text only when it reduces corruption,
  retains plausible text volume, and overlaps the embedded vocabulary. A weak
  or failed page keeps its original text and a warning; a fully scanned PDF
  still fails clearly if local recognition cannot recover meaningful text.
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

The installed Orion app is self-contained on Apple Silicon macOS 13.3 or later. It bundles:

- `whisper.cpp` 1.9.1 as `Contents/Frameworks/whisper.framework`;
- the custom `Contents/MacOS/orion-whisper` sidecar;
- exactly one multilingual model, Small in the ordinary edition or Medium in
  the `.m` edition, as `Contents/Resources/models/ggml-model.bin`;
- official standalone `yt-dlp_macos` as `Contents/MacOS/yt-dlp`;
- Deno as `Contents/MacOS/deno`.

Settings retain only `whisperLanguage`, blank for automatic detection. Legacy
`whisperUrl`, `whisperModel`, and `ytDlpPath` properties remain accepted by the
snapshot validator for migration but are ignored and are not shown in the UI.

`orion-whisper` uses AVFoundation to decode a selected audio or video track
directly to 16 kHz mono Float32 samples and calls the whisper C API. It writes
only the finished transcript to stdout and diagnostic detail to stderr. Rust
passes exact model and media paths as structured process arguments and captures
the result. Imported media remains path-based and never crosses renderer IPC or
HTTP. Note voice memos are the narrow exception: the renderer records a
continuous session as bounded M4A segments and sends each one through a
sequential native command while the microphone continues recording. The Small
edition uses independent two-minute invocations. The Medium edition starts one
persistent sidecar per dictation, loads the model once, and processes 30-second
windows with the prior two seconds of decoded audio prepended for boundary
continuity. The host validates the name, MIME type, MP4 signature,
encoded/decoded sizes, and temporary-file lifetime before invoking the sidecar.
Segment transcripts stay buffered until recording stops; the renderer removes
overlap duplicates and only then inserts and persists the combined ordered
transcript. Silent intermediate windows are valid. The overall dictation
session has no fixed duration limit.

Imported media uses a separate bounded path: decode five-minute windows with
two seconds of overlap and reuse one loaded Whisper context. Check allocation
limits before extending decoded buffers; cap a file at 12 hours of decoded
audio and the finished transcript at 2 MiB. Keep the edition's selected model.
`src-tauri/src/media_jobs.rs` owns each import request, exact window identity,
cancellation, and subprocess lifetime. At most eight requests may queue; one
physical media subprocess runs across windows. Bound download/transcription
stages to 20/60 minutes and a request to 90 minutes, including slot wait time.
Drain bounded stdout/stderr pipes, terminate the owned process group before
reaping its leader, and finish cleanup before dropping temporary media. Removing
an input, changing Space, or closing its window cancels the owned request;
application Quit drains these jobs after the successful vault-save handshake.
Batch results return completed transcripts and per-file failures so a later
failure or deadline does not discard earlier successes. Cancellation prevents
late queue commits. Desktop workflow imports share this ownership boundary.

The upstream framework is built for macOS 13.3, which defines Orion's current
minimum system version. The model must be at least 400 MiB or setup validation
treats it as incomplete. `THIRD_PARTY_NOTICES.md` records artifact versions,
hashes, origins, and licenses. `ORION_WHISPER_MODEL=small|medium` selects the
edition for the transcription helper, renderer timings, Tauri resource map,
release fingerprint, and final bundle verification. Each build verifies the
selected model's exact byte count and SHA-256, and the release source
fingerprint covers that model. Do not replace a bundled artifact without
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

The pinned downloader is yt-dlp 2026.08.19. The native build verifies its
upstream byte hash and version before use. Release fingerprints include the
actual downloader and Deno executables and their license records, and final
bundle verification checks the downloader version. Apply a 2 GiB encoded-file
ceiling to the downloader, including the inherited Unix file-size resource
limit, so an absent remote Content-Length cannot bypass it.

## Ordinary local search

`src/lib/localSearch.ts` serves the command palette, Notes, and Sources. Match
literal case-insensitive phrases across complete note bodies and preserved
source text, allowing whitespace and line breaks within a phrase. Rank titles,
aliases, tags, and body matches before limiting results; bound only the displayed
excerpt. Search only the supplied active Space. Source results open their exact
source ID through the preserved source viewer. Do not scan a closed palette or
truncate searchable bodies to the preview length. Plain-language multi-word
queries can fall back to stopword-aware relevance matches; quoted phrases and
punctuation stay literal. Filter All/Notes/Sources/Concepts before the result
limit, highlight matches, and open the matching note or source passage even
when that item is already open. MCP `orion_search` follows the same discovery
rules and reports bounded scan coverage/truncation.

MCP-created excerpts may use `orion-excerpt:v2:` percent-encoded JSON containing
only `noteId` and `passages: [{text}]`. Keep v1 range-based excerpts compatible.
Validate v2 metadata, limits, and the exact note URL; it never carries invented
visible-text offsets. V2 highlighting requires a unique exact match in both the
current canonical visible text and rendered prose. Preserve the same excerpt
styling, hidden metadata tooltip, Backspace/Undo, and Markdown import round trip.

AI search is an explicit action in the command palette, never a paid request
while typing. `runSpaceSearch` reuses the bounded adaptive Chat reader with no
history and no note-write authority on any request. Require exact evidence
citations or a clear evidence gap; cancellation/query/Space/content/model
changes discard stale replies. Answers remain transient and do not create Chat
history. Ordinary local search remains useful without a key. The explicit Ask AI
control sits at the right of the search field. Local matches lead while typing;
requested answers use a separate reading view, with Matches/Answer controls that
retain the current result without another provider call. Kind filters belong only
to matches. Keyboard result navigation applies only in the matches view; never
open a hidden match from the answer view. Keep one progress message, visible stop
and retry, exact citation details, and partial-coverage disclosure.

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

The editor exposes **Link** beside a text selection without an AI key. The
formatting toolbar and Cmd+K remain secondary ways to open the same anchored
composer. Its first view is **Search notes or paste a URL**: search only the
active Space's notes, link directly to an existing note, or add a web address.
Applying either destination preserves the selected visible words and their
formatting, writes an ordinary rich-editor link mark through portable Markdown,
and remains undoable. Reject a stale captured document before applying it.
With no selection, a destination can insert its note title or web address.
Opening Link within an existing web link captures the complete marked phrase
and offers **Update link** and **Open**.

`src/lib/externalLinks.ts` normalizes recognizable bare domains to HTTPS and
accepts bounded HTTP/HTTPS web addresses only. Reject executable or unsupported
schemes, embedded credentials, control characters, and malformed addresses.
While editing, an ordinary click places the caret; only **Open** or Cmd-click
(Ctrl-click on other platforms) routes a web link through the desktop opener
to the default browser. Browser preview uses its ordinary browser fallback.
Reopening a saved note must preserve its URL and original visible wording.
Do not turn pasted web destinations into concepts or AI requests.

**Create a linked article** opens the existing article path in the same
composer. An empty destination selection creates or reuses the exact named
article, then registers it as the concept's canonical target. The user chooses
either an AI-written definitional article—with an optional page-specific instruction—or a genuinely
blank article. Only the AI choice queues a linked-article job, and Restart must
retain its instruction. A non-empty destination selection is an explicit
compatibility override for an existing manual/legacy branch. Never default a
new phrase to the note currently being edited.

A short, safe text selection can become the inline link label as before. A
multi-block, long, or code-bearing selection is contextual material instead:
the user may supply a bounded page title or, when the selected AI provider is
configured, leave it blank for Orion to name from the selected passage and the
Space's existing vocabulary. Resolve and validate that title before creating a
concept, note, or generation job. Orion then inserts only the linked title
immediately above the containing block, and the original selection remains
content- and formatting-equivalent in Markdown. Short selections continue to
use their exact selected words by default without an AI request; a custom title
on a short selection chooses the same contextual behavior. A **Generate title
with AI** checkbox opts a short selection into the same bounded naming flow,
even when its selected words already fill the title field. Keep naming off by
default for short selections, disable it for explicit existing destinations,
and preserve the typed title when the checkbox is turned off. Never wrap a code
block or a whole passage in a link mark, replace the selection with its title,
or lose its formatting. Pass the bounded selected text to AI linked-article
generation with special weight, and retain it across Restart without persisting
a parallel vault schema.

AI title generation checks the complete current Space's title/alias vocabulary
locally after each response. Reuse a single existing destination under its
canonical title. If a suggestion names the origin note (including retained
concept aliases) or has ambiguous destinations, retry with that rejected title
excluded, for at most three naming calls total. Recheck the captured Space and
origin ID between attempts; cancellation must prevent further provider calls.
Move focus to Cancel while naming so Escape remains available when the other
controls are disabled.
Keep the composer and instructions available if naming cannot resolve a title.
The existing-note AI-context preference also gates the naming request's other
note summaries and concept vocabulary; local collision checks remain available
with it disabled.

The composer identifies a populated existing destination as **Link existing
article**. Registration rechecks collisions before creating any note or job,
preserves existing prose, and reports reuse. A reused empty article queues
generation with its actual canonical title, even when the selected link phrase
was an alias. Explicitly linking an inactive alias re-enables the original
concept without creating a duplicate page.

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

## Generate from New note

**+ New note** and `⌘N` still create a blank page. The generation chevron and
composer stay hidden without a key for the selected AI provider. When configured,
the chevron opens one Generate composer: kind (Note, Podcast, Slide
deck, Slide deck with narration), optional instructions, a **Use notes from this
Space** checkbox, and one Generate action. The checkbox defaults to the global
context preference each time the composer opens. Explicitly enabling it grants
note context for this generation only, never changes the global preference,
and travels with that job on restart. With it off, no note bodies, digests,
concepts, or overview may enter generation requests; require user instructions.
Each kind is an ordinary note. Do not add presentation or podcast schema, a
Playground route, or Share-as-create.

Generation is a transient job (linked-article pattern: attempt ownership, late
results ignored, Restart/Delete). Ordinary generated notes use one writing
pass that begins with one bounded H1 title, followed by the article body. Parse
and validate both before committing, remove that first heading from the body,
and update the note title, slug, and canonical vocabulary together. Never keep
the user instruction as the completed note title. Preserve a title the user
edited while generation ran and an explicit desktop-workflow title. Invalid or
empty title/body output remains a retryable generation error. Decks and podcasts use one bounded JSON outline, then up to six disjoint
copy writers with a shared thesis and ordered section titles. Outline planning
caps high/xhigh effort at medium; writers retain the selected effort. Validate
exact Space-local note IDs and unique headings, and reject partial copy on
failure. Assemble accepted copy locally with no final model rewrite. Each
slide is then a complete `gpt-image-2.5-sunburst` 16:9 image
that letters the title and bullets in distinctive fonts, in same-kind waves
of at most six, never mixed with copy. The slideshow shows that image only:
no HTML type overlay even as a fallback, and speaker notes stay off-screen
for Play. Cancellation stops later stages and ignores late responses; the
native Chat transport itself is not cancellable.

When authorized, generation uses a validated hierarchy or clearly marked
saved/local overview for orientation, a relevance-ranked directory of at most
48 deterministic whole-body note digests, and bounded exact note excerpts.
The planner sees the directory and at most four initial note excerpts; each
writer sees only notes referenced by its assigned sections. Authored notes
are primary material even when the Space has zero Sources. Never infer that
zero Sources means an empty Space or describe digest/overview text as a full
read of the underlying notes. Preserve excerpt omission markers and native
request bounds. Generation does not trigger a whole-Space provider crawl or
alter the sequential background maintenance pipeline.

Play on the note
header speaks existing prose, or times a deck to its speaker notes, with
System speech by default, `gpt-4o-mini-tts` if an OpenAI key is selected, or
ElevenLabs if that optional keychain account is selected. ElevenLabs is voice
only: never a writing provider, never Wave 2 failover, never a knowledge-base
upload. The vault stores `elevenLabsApiKeyConfigured`, `speechVoice`, and an
optional `elevenLabsVoiceId` (not a secret). Empty uses Orion’s default voice;
a pasted ID must be 8–40 ASCII alphanumeric characters.
Settings → Voice also stores `elevenLabsVoices`, a list of `{ name, voiceId }`
presets with non-empty names of at most 80 characters. Older vaults may omit
the list; hydration preserves an existing valid ID as “Saved voice”. Adding,
renaming, removing, and selecting voices stay entirely in Settings. The active
`elevenLabsVoiceId` still drives Play; removing its preset resets it to the
Orion default. Presets are local metadata, never credentials or provider-side
voice changes, and share the existing application-wide settings scope.

## AI actions where you write

Keep the request boundary, non-destructive preview state, captured cursor, and
single-transaction acceptance together when changing these interactions.
Inline Write/Rewrite, image generation and AI link naming use
`editorAIWorkingContext.ts` before assembling provider input. The rich editor
captures a separate transient working projection from the full ProseMirror
document, so selecting part of a checked item cannot lose its task ancestry.
Removing checked subtrees from this nondispatched copy must never change the
authored document, captured replacement, preview, acceptance or Undo. Direct
selections/carets in a checked subtree, and normalized replacements crossing one,
require an explicit current instruction to include completed tasks; otherwise
stop before the provider call with an actionable explanation. AI page naming has
no history instruction and offers manual naming instead. Local links stay usable.
Filter live surroundings, related notes/sources and cached derivatives separately;
never replace an authored range with a filtered body. A plain selected fragment
without a rich capture cannot establish its boundary in a note containing checked
work. Note content and prior requests never grant history access.

AI-created linked articles use that same captured context, including when the
page title is entered manually. Validate before creating the placeholder/link;
blank articles and existing manual destinations remain local. Linked jobs retain
their capture only in transient UI state. Retry and late result merging recheck
the original source body. The editor supplies an exact post-link body receipt
through its normal serialization (including frontmatter/references) only after
a successful transaction, so Orion's own inserted link is allowed without
accepting arbitrary later changes. Do not replace this with broad Markdown
normalization or retarget a stale capture to the current selection.

Image research keeps working/history indexes and resumable sessions separate.
Its index uses offset-preserving Markdown masking, then supplies only exact
visible original spans to the planner. Rich-context offsets are not source
offsets. Retain original unfiltered evidence versions locally and recheck them
before reuse/publication, including changes hidden by masking. Ordinary unfinished
nested tasks remain discoverable under the shared Markdown working-view rules;
direct rich selections inside a checked ancestor remain protected as a unit.
AI actions become available from their configured provider keys; there is no
editor AI toggle or persistent Continue button. Selecting text, opening a
composer, or changing an amount must never start a provider request.

`/write` and **More → Write with AI** open the same compact, anchored composer
near the captured body cursor. The command consumes only its slash prefix and
preserves surrounding prose. Write captures the collapsed end of the selection;
rewriting remains a separate selection action. Reject submission if the captured
document changed while the composer was open.

- Show one native three-stop **Amount of text** slider and one optional
  **Custom instructions** field. The stops map to **Sentence**, **Paragraph**
  (default), and **Section**; show the current semantic value as the slider
  changes and retain the quiet **Less** / **More** endpoints.
- **Write** is the sole generation action. An empty instruction continues from
  the captured cursor. A sentence can continue at a meaningful caret;
  paragraph and section output attach after the current top-level block. With
  no meaningful caret, continue at the end of the document. The instruction is
  request-scoped and clears after submission.
- Opening the composer focuses the slider. Preserve its native keyboard
  controls and accessible semantic value. Escape and Cancel close the composer
  and restore the captured body cursor and editor focus. Clicking outside
  closes it without stealing focus from that outside target.
- Keep the composer inside the visible writing area at normal and narrow
  widths. Live Write, Rewrite, image and Link inputs share the frosted HTML
  surface; the toolbar and More retain their existing native Regular Liquid
  Glass. These live composers are not identical native glass surfaces and must
  not snapshot editable text into the native chrome painter.
- Do not expose provider/model selection, prompt history, Chat history, or a
  context engineering panel here. Use the Space's configured provider/model.
  Write and ordinary rewrite operations receive only the bounded live editor
  context; only **Enrich** may retrieve additional active-Space knowledge.

A non-empty text selection exposes compact **Rewrite ▾**, **Generate image**,
**Link**, and **Comment** controls beside the passage. Link and Comment remain available without keys.
`src/lib/editorAICapabilities.ts` gates writing and rewriting on the selected
provider's configured key. Image generation also requires an OpenAI key for
rendering, including when its selected planning provider is Anthropic. Check
both dependencies even for Selection only; do not silently change the planning
model. Keep unavailable actions discoverable with action-specific explanations,
without disabling local writing or links or issuing a request.

Clicking **Rewrite** opens one anchored instruction field; submitting it blank
requests Orion's best meaning-preserving rewrite, while typed text supplies a
request-scoped custom direction. The chevron contains text-labelled presets
rather than an icon grid:

- **Clarify** — improve logic and structure without reducing complexity.
- **Tighten** — make the passage shorter while preserving its meaning.
- **Simplify** — use easier language and sentence construction.
- **Expand** — develop the thought with relevant explanatory detail.
- **Enrich** — integrate relevant knowledge from the active Space.

Do not add a separate **Custom** menu row because the main Rewrite action is
already the custom-instruction route. Rewrite, Clarify, Tighten, and Simplify
must preserve factual claims and must not silently add new knowledge. Expand may
develop implications already grounded in the selection. Enrich is the explicit
permission to retrieve and weave in additional Space knowledge.

**Enrich** is the distinctive Orion operation. Its menu description is
“Integrate relevant knowledge from this Space”; do not rename it “Orion Enrich”
or “Connect to Space”. It must work on a sentence, passage, or an entire selected
note. For a whole-note enrichment, produce one coherent integrated revision:

- preserve the author's voice, useful prose, headings, tables, task lists,
  links, code, and existing numbered citations;
- weave relevant knowledge into the paragraphs where it belongs rather than
  appending `Context from`, source-inventory, AI-summary, or change-log sections;
- leave unrelated passages unchanged;
- add Orion's numbered source citations when introducing source-grounded claims;
- never cross the active Space boundary or invent facts to make the revision
appear richer.

**Generate image** opens the compact composer with optional **Image direction**,
independent **Fast / Detailed** rendering and **Selection only / Related Space**
context choices. Detailed is the default; context initially follows
`includeExistingNotesInAIContext`. Choosing Related Space is explicit consent for
that image only, without changing the shared preference. Fast uses
`gpt-image-2.5-flare`; Detailed uses `gpt-image-2.5-sunburst`. Both use the one-shot
OpenAI Image API, even when Anthropic plans the illustration. Do not offer image
generation without an OpenAI key or silently substitute a model. These choices
are transient captured-request state, not new persisted settings.

`src/lib/aiImages.ts` owns an adaptive, read-only research tree. The selected
Intelligence model derives relevant local queries from the exact selection,
optional direction, title and captured surroundings (1,200 Unicode characters on
either side). There is no arbitrary note directory or overview supplied as
evidence. `src/lib/imageContextSearch.ts` maintains an incremental Space-local
passage index with term rarity, phrases, headings, titles, aliases and associated
concepts. It has no embeddings, external search or arbitrary file/URL access.
Search yields during expensive work, preserves exact UTF-16 offsets and versions,
and retrieves about 8,000 characters per reader, selected for relevance rather
than a fixed note count. Live editor text overrides the saved origin body.

Independent questions fan out to at most three concurrent readers. Readers
compress exact supplied passages, preserve disagreements and return cited
findings plus optional queries for important gaps. Branches can deepen through
three refinement levels; equivalent repeated queries page past their already
read ranges. Distinct questions may share evidence without paying its byte budget
twice. Mergers reduce findings using exact support. Grouping measures serialized
packet sizes, and reader admission reserves the remaining reduction tree using
worst-case bounded summaries and queries. A merge-only 6,000-character selection
excerpt is explicitly marked when truncated; search, reading and final composition
retain the exact full selection. Partial coverage must be disclosed, never presented
as exhaustive Space knowledge.

Emergency ceilings are 18 research calls and four minutes per attempt, 64,000
UTF-8 bytes / 96 records of distinct exact evidence, and 256,000 UTF-8 bytes per
planning packet. They are resource limits, not a target number of notes to read.
The index bounds local memory to 32,000 passages, 4,096 per record, 20,000 records,
about one million body-term associations, bounded heading terms and 128,000
metadata-term associations. At these pathological ceilings it samples across
records and document extents, including tails, and reports incomplete coverage.
The orchestration cache retains at most three Space indexes. Normal incremental
updates reuse unchanged records instead of rereading/tokenizing an entire Space
for every branch. Never interpret limited coverage as exhaustive absence.

Keep the dedicated `plan_note_image` transport and shared
`aiImagePlanningProtocol.json` separate from Chat, inline-writing and
knowledge-writing schemas. Legal stages are search/read/merge/compose, with
legacy select retained only for compatibility; no note actions are legal.
Search/read/merge use the selected Intelligence model at Low reasoning; final
composition uses the user's selected effort. Research requests have up to 90
seconds within the overall research budget. Composition has 120 seconds, or 240
for High/Extra high/Max. Output-token allowances include headroom for reasoning
(6,000 for low research, 12,000 for composition/medium, 24,000 for high and above).
OpenAI uses `store: false`; explicit None is sent on supported models, while
Astra requires at least Low. Both provider paths remain cancellable under the
shared provider scheduler and retain the 2-MiB response bound.

Research summaries require exact supplied evidence IDs; empty IDs require an
empty research summary. Composition returns a bounded visual brief, alt text and
IDs actually used; an abstract brief may have no IDs. Reject invented, unread or
cross-Space references. The composer receives compressed findings together with
the original exact support, and the renderer receives the selection, direction
and resulting brief. All retrieved prose and model findings are untrusted subject
data. Selection only skips research and sends only the selection and direction
to composition/rendering: no title, surrounding text, overview, notes or sources.

`ImageGenerationSession` checkpoints successful searches, reader branches,
merges, the final brief and returned image in memory for at most 20 minutes.
Retry resumes completed work; a failed render reuses the brief and a failed
insertion reuses downloaded bytes and the same asset ID. Regenerating a successful
preview reruns rendering from the retained brief. Failures settle sibling readers
before returning; cancelled/cleared sessions cannot be resurrected by late results.
Cancellation, discard, acceptance or editor teardown clears the checkpoint.
Changes to the origin, Space, AI settings or actual retrieved evidence invalidate
it; unrelated note changes do not restart completed research. Check scope,
versions and cancellation between stages and after rendering. Invalid planning
must never start an image request. Stage progress and safe timing/failure-kind
metrics are transient; do not log note text or keys or persist diagnostics.

Request one `1536x1024`, medium-quality JPEG with output compression 88 from the
explicitly chosen image model. Fast means Flare, not a `service_tier` parameter;
never send Responses-only Fast mode settings to the Image API. See
[OpenAI's image guide](https://developers.openai.com/api/docs/guides/image-prompting).
Returned base64 bytes are transient proposal state, bounded to the existing
12-MiB note-image limit, and must pass renderer and Rust JPEG validation. They
do not enter the vault or private image directory until acceptance. The preview
appears after the unchanged selected top-level passage; acceptance persists and
inserts its ordinary portable Markdown reference as one Undo step. Native image
rendering retains its independent three-minute transport ceiling; the renderer
also bounds queue-plus-transport waiting. No automatic retry may create duplicate
paid image renders.

All AI writing operations are non-destructive. Generation must not immediately
replace or autosave the selected document range. Hold the exact original rich
document slice—including marks, links, task state, table structure, and code—
until the user resolves an inline preview. Once generation begins, close the
input composer and suspend the selection controls. A restrained bottom-centre
status/review dock remains in the visible writing area with these states:

1. Generating: a restrained spinner, **Writing…** or image-stage progress, and
   **×** to cancel.
2. Preview: three icon-only controls **✓  ↻  ×**.

There is no idle dock after the operation is resolved. Keep enough editor
padding that the status/review dock does not cover the final lines.

The tick accepts the proposal as one editor transaction and then autosaves; one
ordinary Undo must restore the complete original. Refresh generates another
proposal with the same action, length, and custom instruction without first
accepting the prior attempt. X discards the proposal and restores the original
exactly. After accepting, return to ordinary writing. After discarding a
Rewrite, restore the prior selection and its selection controls when practical.

Every icon-only state needs a visible tooltip, accessible name, focus style,
keyboard operation, and reduced-motion treatment. The tick may carry the theme
accent; Refresh and X remain neutral until interaction, with X using danger
color only on hover/focus. Hide or suspend these overlays while another editor
composer such as Link or Citation owns focus rather than allowing controls to
overlap.

Provider requests use the dedicated `inline-writing` mode on Orion's existing
native AI transport. That mode supplies writing-specific system instructions
and a 12,000-token output ceiling; it must not inherit Chat's conversational
framing or history. The request still uses the active Space's selected provider,
model, reasoning effort, and Keychain-held credential. Pass cancellation through
the shared scheduler so queued work cannot start after cancellation, and
immediately reject or invalidate late results. An in-flight native/provider
request may already be running; do not promise that cancellation reverses an
already-started request or its API usage.

## Chat contract

The visible route and navigation label are **Chat**. It is one persistent
conversation scoped to the captured active Space, not a thinking-card workspace.
A quiet bottom-right circle opens the same conversation beside the document.
It appears when the selected provider is configured and is hidden during Flow
and on the full Chat route. `ChatDock` keeps one `ChatView` mounted across collapse and expansion, retaining the draft,
pending prompt, cancellation and reply. Space changes remount transient UI;
history stays in that Space's existing `studio.messages`. The panel is nonmodal
and does not replace the editor or its scroll position. Writing windows keep
Chat compact so expanding it cannot replace their bound draft.

Empty Chat generates suggestions from the substance of the active Space, with
up to two ideas in the compact panel and four on the full route. The bounded
context builder in `src/lib/chatSuggestions.ts` selects exact working passages
from the attached note, its connections and recent material. Exclude completed
tasks and their continuation text, frontmatter, fenced/quoted examples and
portable block metadata; stale summaries/overviews must not revive retired work.
Use at most eight 2,000-character passages and twelve directory hints, within a
32 KB context. Directory titles alone are not evidence.

The dedicated read-only `chat-suggestions` mode uses the selected provider,
model and reasoning setting. Its shared JSON protocol asks for specific,
evidence-grounded possibilities, not stock capability prompts or title-swapped
templates. Native and browser validate the context, 2–4 distinct bounded prompts,
evidence IDs and intent; this mode accepts no creation/edit authority or read
requests and sends no legacy note bodies or chat history. Note text is untrusted
data. Suggestions are transient and consume API usage. Generation is debounced,
uses the shared provider scheduler, and is suppressed while hidden, typing,
talking or sending. Cache a bounded number of batches in the current window;
reopening unchanged context reuses a batch. Refresh explicitly generates new
ideas, with previous prompts provided to avoid repetition. Space/content/focus
or model changes invalidate the visible batch; discard late responses. Failed
generation stays quiet and offers explicit retry, never canned filler or an
automatic retry loop. Empty content does not call a provider.

The visible suggestion is the exact prompt placed in the composer. Selecting it
only fills and focuses the composer; it does not send or create anything. Edit
ideas exist only for the attached note, and that target stays captured with the
draft through navigation and refinement. Show the original target when it differs
from the current note. A deleted or cross-Space target must fail closed without
losing the draft. Explicit Send still uses normal Chat authority, reading, edit
review and persistence boundaries.

An optional current-note ID is captured on send and resolved only inside the
captured Space. It enters the reading packet as a routing hint, never a note
body or write permission. Exact passages still require the ordinary read loop.
The circle reuses the bounded native chrome paint bridge with `surface: chat`,
its own window-owned sequence receipt and a circular clip over the same Regular
material as the toolbar. It never owns keyboard or accessibility input. Browser,
older macOS and accessibility fallbacks keep opaque readable chrome. Chat's live
text panel uses a restrained frosted CSS surface; it does not snapshot the text
or composer into native artwork.

`src/lib/chatReading.ts` coordinates adaptive reads through the existing Chat
provider transport. Begin with a validated Space hierarchy (or bounded overview
fallback), locally ranked whole-body digests, and local full-text discovery.
The model can request `search`, `cluster`, `note`, `source`, `note-full`,
`source-full`, and `related` reads,
then decide whether to read further or answer. Search includes all current-Space
note and source bodies, including material outside the displayed hierarchy.
Only discovered exact IDs may be opened. Hierarchy, directory summaries, links,
and search hits route reading; they are never claim-level evidence.

Every provider step receives a fresh bounded working set, not an accumulating
reading transcript: at most 12 recent conversation messages within 12,000 code
points, 24 directory entries, and up to 96 exact passages of at most 3,000 UTF-16
units each. Whole-document reads collect up to 192,000 JSON-encoded text bytes
in one local batch; use them for whole-note analysis instead of exhausting turns
on short excerpts. The complete packet is bounded to 320,000 UTF-8 bytes.
`chatDocumentReading.ts` preserves Unicode boundaries and original offsets,
filters completed tasks, and reports per-document retained ranges, completeness
and the first unread offset. Eviction must update that coverage; previously read
but discarded text is not current evidence. Oversized documents remain explicitly
partial. Final replies/actions still retain at most 12 cited passages, independent
of the larger transient reading workspace. These limits are shared through
`chatReadingProtocol.json`; none enlarge live voice context. Each reply
gets at most six sequential provider steps and three minutes for local reading.
After actual web research starts, useful reading may continue without a fixed
turn count under the adaptive policy below. Each step may ask for at most four
reads. Repeated cached reads cannot renew the deadline. Finalization
requires an answer or a clear failure; never silently claim exhaustive coverage.
Simple conversation may answer immediately without opening knowledge bodies.

`src/lib/chatReadingProtocol.json` is the shared native/browser instruction and
read schema source. `chat-reading` is a distinct transport mode; inline writing
and ordinary transport consumers retain their existing schemas. Validate read
operations, offsets, packet size, and model replies in TypeScript and Rust.
The native schema, packet validation, public checkpoint types and reading-response
parser live in `src-tauri/src/chat_reading.rs`; `lib.rs` retains Chat commands,
provider transport and the existing edit wrapper. Keep this boundary free of
vault access, provider calls and write authority.
Reads never apply accompanying prose or note actions. Preserve host-derived
creation authority only for the final answer. Never grant writes from context.

### Perplexity web research

`src-tauri/src/perplexity.rs` owns the separate `perplexity-api-key` Keychain
entry and fixed Perplexity Agent API transport. It inherits `KEYCHAIN_SERVICE`
from the host, including the Preview identity rewrite. Settings → Web research
offers Save, Test connection (authenticated model listing, no research), and
Remove. Only optional `Settings.perplexityApiKeyConfigured` is persisted; older
vaults hydrate to false. Never read the credential at startup or persist it in
the vault, browser storage, exports, or logs. Browser previews can inspect the UI
but real web research and credential storage require the desktop host.

Text Chat's Web pill grants the shared reader a capability captured for that
submission. It defaults off and resets across Spaces or key removal. A voice
call does not implicitly enable Web for typed messages. Voice workers receive
the capability automatically when configured, and use it when external evidence
is useful; greetings, selection and idle time never initiate web research.
Capability changes append a quiet delta to voice without resending note bodies.
The existing OpenAI/Anthropic reader chooses bounded `web` reads, retains the
existing work identity, checkpoints, cancellation and edit review. Ordinary MCP
research remains Space-only. MCP inspection of existing voice findings accepts
the distinct web provenance, within the same public-text budget.

Send only a short public research question (600 code points maximum), never an
entire Space packet. Instructions require the reader to generalize private or
identifying material; this is not a deterministic privacy classifier. The existing
reader chooses `depth: quick | standard | deep` for each new web request from
the current user's question and actual evidence gaps. It uses null for local
reads and retained web pages. Older responses without depth remain valid and
default to standard. The shared `src/lib/webResearchProfiles.json` fixes model,
reasoning, tools and budgets: quick uses GPT-6 Luna/minimal with 5 steps and
110 seconds; standard uses Luna/medium with 12 steps and 240 seconds; deep uses
GPT-6.1 Sol/high with 24 steps and 480 seconds. These are ceilings, not required
work. All profiles permit only web search and URL fetch; no dynamic preset may
silently add tools. There is no extra classifier call or user depth selector.
There is no fixed paid-lookup quota or total web-research turn/time ceiling.
The reader continues with specific evidence gaps in the current user question
and is instructed to finish when adequately supported. Two consecutive lookups
that fail or add no new source excerpts require final synthesis with remaining
uncertainty; new retrieval timestamps and response IDs do not count as evidence
progress. Exact repeated reads also retain their no-progress stop. Local-only
reading keeps its three-minute deadline. An actual new lookup renews both the
reader and outer voice-worker deadline to its profile allowance plus one minute
for the answer; cached reads cannot renew it. Cancellation and individual
provider timeouts remain effective throughout. Higher-depth requests may revisit
insufficient lower-depth results; equal/lower-depth requests reuse retained
evidence. Checkpoints retain cumulative attempts/completions separately from
the bounded result cache and read journal. A normalized 128-entry lookup journal
prevents silently paying again for recent evicted results or failed queries;
2,048 evidence fingerprints track novelty separately from citation retention.
An explicit resumed retry/continuation may retry a prior failure and starts a
fresh no-progress streak. Source evidence and citation counts remain bounded.
Legacy retained results are treated as quick. Native admission/polling remains
bounded to the selected profile plus best-effort remote cancellation. Cancellation is
window/request scoped, including cancel-before-admission; late output cannot
publish. Provider cancellation acceptance is not confirmation of remote stop.
Do not retry a paid POST automatically after an ambiguous network failure.
`perplexity/transport.rs` shares one fair request lane across the app's workers
and windows. Admission, model checks, status polls and cancellation are paced
at least 1.1 seconds apart; background provider runs can still proceed in
parallel. Poll intervals grow from two to six seconds. Explicit HTTP 429
rejections honor `Retry-After` (seconds or HTTP date) with bounded backoff and
up to three retries, sharing the cooldown across requests. Poll retries keep
the admitted run ID. Request, token and model-capacity limits receive separate
safe diagnostics; raw provider error bodies never enter logs or voice context.
A cancelled queued request makes no HTTP call. Admission retains its response
ID if cancellation arrives in flight, so the host can attempt remote cancel.
All waits remain inside the per-lookup deadline; remote cancellation is bounded
to eight seconds and can be prevented by a longer shared provider cooldown.

Web evidence uses `kind: web` with validated HTTP(S) URL, retrieval date and
optional publication date. Its UTF-16 range addresses the retained provider
search excerpt, never the full remote page. Collect search output batches and
map citation numbers by provider source ID, not array order. Synthesis alone is
not a source. Saved replies/notes retain excerpts and ordinary web links through
the existing portable citation footer; local source arrays remain unchanged.
Completed reads resume from local checkpoints. Public findings may arrive at
existing reader checkpoints; individual Perplexity calls currently poll to a
terminal response, rather than stream provider tokens or reasoning into voice.
Do not reject a successful research answer because its synthesis is longer than
one model packet. The bounded native HTTP response retains complete synthesis
and validated source excerpts. The shared reader keeps up to three full results
in transient `webResults` checkpoint state, never the vault or live voice context.
It supplies contiguous Unicode-safe synthesis pages of at most 12,000 UTF-16
units, with exact range and `nextStart`. A `web` read with the returned response
ID, empty query and numeric start reads that worker's retained result locally;
it cannot access another worker or make a provider call. Only new lookups with
empty ID, public query and null start make a new paid lookup. Cache retention is
a memory bound, never an admission quota. Preserve
source IDs across pages and resume without repeating paid searches. A partial
page is not a full synthesis read. Source evidence remains usable when the
provider returns excerpts without synthesis.
Read-only voice research without a cited finding receives an actionable
`CHAT_RESEARCH_UNGROUNDED` failure after bounded correction, not a completed
worker claiming that nothing exists in the Space. A returned web error remains
specific; partial successful evidence is still usable. Quiet voice findings
retain the cited spoken summary even when the longer reply is omitted from
live context, so the main conversation can use it independently of narration.
Live provider, billing and microphone acceptance remain separate from fixtures.
The reader also attaches a transient host-observed `ChatResult.webResearch`
outcome (attempts, completed lookups and an optional bounded issue). Provider
JSON cannot establish it. Voice summaries, checkpoint updates and a completed
worker's conversation retain that outcome, so a failed follow-up does not erase
earlier web evidence or become a misleading blanket claim that web never worked.

Chat questions explicitly request the current Space's knowledge. As before,
the Settings switch for existing-note context governs imports and enrichment;
it does not disable explicit Chat reading. Chat never reads other Spaces.
Freeze the request's content and selected provider settings. Reject further
steps and late answers when the captured Space knowledge changes. Navigation
to another Space is independent. Stop cancels the logical run and prevents
late commits; a native transport already dispatched may still finish, and its
physical scheduler slot must remain occupied until it does.

The host resolves `[[e1]]`-style response markers only against exact passages
actually supplied to the answer step. Persist bounded optional `evidence` and
`coverage` on the existing `StudioMessage`, never a parallel Chat store. Evidence
contains original text, exact entity/version, and exclusive UTF-16 ranges.
The citation inspector shows that historical passage and marks changed or
removed originals. Reference validity does not prove a model claim follows from
its citation. Both Keep as note and authorized note creation preserve cited
passages in ordinary Markdown: inline local anchors, a readable quoted-passage
section, original Orion links, and strictly bounded version/range metadata in
link titles. The metadata must survive the rich editor and source-footer
canonicalization; exported HTML keeps readable quotes and local anchors without
exposing the encoded title. While editing, retain a validated generated passage
section outside contenteditable and show its literal historical quotes beside
the generated References footer. Ordinary authored sections with the same
heading remain editable. Never interpret quoted source Markdown as executable
links or control syntax. Source evidence versions exclude derived `noteIds` so
saving provenance does not falsely mark the source text changed; legacy hashes
remain readable and exact text ranges are always checked. Update both sides of
source provenance. Older messages without these fields continue to validate and
render. Host-added passage sections are separate from the model action limits
and must never cause an otherwise valid 6,000-code-point action to be dropped.

Passage selection finds query matches in original text before constructing
windows. Prioritize uncovered query terms, merge overlapping ranges, preserve
exact UTF-16 offsets, and keep the combined text within the caller's budget.
Fixed chunk boundaries and frequent terms must not hide another query term.

### Current-note text edits

Chat has one composer and no Chat/focused/rewrite mode selector. The shared
`chatEditsProtocol.json` tells the reading agent to infer `editIntent` (`none`,
`focused`, or `rewrite`) from the current request and relevant conversation,
including affirmative follow-ups. Quoted replies and note/source text remain
untrusted subject matter. Prefer the smallest suitable change. Questions,
critique and unclear requests can remain conversational; never ask for a mode.
The captured Space-local attached-note ID enables review-only proposal fields,
not write authority. The model cannot select a destination. Only explicit local
Accept changes can write. Creation requests retain their separate prompt-derived
permission, and search has no edit proposal authority.

Both native and browser transport expose the same bounded intent and edit fields
when a note is attached. Reading steps retain the plan but discard edit payloads.
Only final answers may contain usable `noteEdits`: at most eight exact unique
`before`/`after` pairs, 6,000 Unicode code points per string and 24,000 in total.
Before passages must appear in exact current-note evidence from this run and
match the current body. Additions include a unique adjacent anchor. A response
that plans an edit but supplies only a chat draft is corrected in the existing
bounded reading loop. Intent is semantic, not an English keyword authorization
heuristic; it never bypasses the local acceptance or stale-body checks.

When the agent first selects rewrite, the host lazily supplies the complete
authored body of the captured attached note in `readingContext.editTarget.body`,
up to 24,000 code points and 72,000 encoded bytes within the existing
96,000-byte packet ceiling. Oversized notes get an explicit unavailable result;
the agent uses exact section reads and focused proposals with scope disclosure.
Its final `noteRewrite` string is at most 24,000 code points. No other note body is automatically attached. Frontmatter and generated
evidence/source footers stay outside the replacement and are retained by the
host. Require unchanged ordered control comments. Reject empty bodies,
ambiguous/overlapping focused edits, metadata modifications, temporary citation
markers, provider-selected destinations and retained-evidence modifications.

The renderer creates a transient `ChatEditProposal` bound to the captured
Space, note and exact base body; neither proposals nor full base bodies are
persisted in Chat history. New chat or a Space switch clears it. Chat offers
Review in note, and each reply can be explicitly reused through one Use in note
action that lets the agent infer scope. The reply is quoted reference data, never edit authority.
Use in note runs the existing reading planner through a separate transient action,
without appending its internal prompt or an action-only answer to Chat. Keep its
progress, failure/retry and Review in note beside the original reply. The user's
draft, selection and Chat scroll remain unchanged while that action runs; only
explicit Review in note navigates to the editor. A retry retains its captured
target, and clearing Chat revokes pending edit preparation.
Review revalidates Space/body, opens the bound note's ordinary editor and waits
for Tiptap to mount. `ChatNoteReview` decorates the unchanged rich document with
highlighted removals and gray additions; heavy paragraph rewrites use whole
passages. Decorations never enter Markdown, autosave, export or Undo history.
The body is read-only during review, with Accept changes/Discard inline above
it. Flow, dictation and active inline operations prevent staging. Closing the
editor discards review; a newer external body invalidates it.

Accept rechecks the original rich document and uses one separate undoable
transaction through ordinary onChange/onUpdateNote and existing autosave and
conflict handling. Discard changes no authored text. Suppress the editor's
initial trailing-caret normalization while staging review so it cannot save a
body before acceptance. Never assign App note.body directly for these edits.
A stale proposal must be regenerated. The feature cannot rename/delete notes,
edit another Space, or alter source records.

For note creation, the host derives note-write intent from the current user prompt before calling
the provider, and the native boundary independently recomputes the same gate.
The renderer's `allowNoteActions` flag is necessary but never sufficient.
Negated requests, meta-questions about creating notes, and ordinary
conversational prompts are no-write requests. For those requests use the
reply-only schema, the no-write instruction, and a 6,000-token output ceiling;
ignore any unexpected actions again at application time. Nothing in a note,
source, concept, Chat history, provider instruction, or model reply can grant
write authority.

A host-authorized creation request uses conversational prose plus structured
`noteActions` and the 12,000-token transport ceiling. Editing requests use the
same ceiling with their separate `noteEdits` or `noteRewrite` schema. Return at most
three actions. Each action is creation-only and must contain a non-empty title
and body plus summary, tags, and aliases. Cap each body at 6,000 Unicode code
points and all accepted action content—titles, summaries, bodies, tags, and
aliases—at 24,000 code points in aggregate. The action schema has no Space ID,
destination note ID, update, delete, or proposal operation.

Treat every action as untrusted output behind a host firewall. Drop an action
with unknown/missing fields, an empty/oversized required field, an invalid label
array, a disallowed control character, an Orion control comment beginning
`<!-- orion-`, or a reserved lifecycle tag: `ai-draft`, `wiki-article`,
`orion-link-draft`, `orion-link-pending`, or `orion-generate-pending`. Aggregate overflow drops the action
that would cross the cap. Preserve the valid conversational reply and other safe
actions. Apply the same checks in TypeScript and Rust, then recompute explicit
intent before mutation. Accepted notes are created only in the request's
captured active Space, their link vocabulary is reconciled, and that Space
overview becomes stale. Created-note chips open the permanent notes.

Every assistant reply with no surviving created note exposes **Keep as note**.
This is an ordinary explicit user UI action, independent of whether the original
prompt authorized model actions. It strips Orion control comments and disallowed
control characters, turns the reply into one ordinary editable note, records its
ID on the message, reconciles concepts, and becomes an Open-note destination;
repeat activation must not duplicate it. Keep as note must not claim Saved
before the serialized vault save resolves and the
persisted reply-to-note receipt is verified. Failed persistence keeps the local
note available, and Retry save flushes that same note rather than creating a
second one. Saving is a quiet reply-local action without navigation, synthetic
Chat messages, or an early success toast. Neither model-created actions nor Keep
as note may introduce a review queue, reserved lifecycle tag, agent attribution,
card, or new note lifecycle.

For vault compatibility, Chat history remains in `Space.studio.messages`.
Existing `studio.cards`, `selectedCardIds`, `activeConceptId`, `view`, `zoom`,
`chatCollapsed`, and `canvasCollapsed` fields must continue to validate and
round-trip, but they are dormant compatibility data. Do not render them, mutate
them as a workflow, include them in Chat requests, or use them to reactivate
card proposals, selection, promotion, dialectic, or canvas UI. Do not add a
parallel Chat persistence field without an explicit schema migration.
`StudioMessage.createdNoteIds` is optional so older vaults continue to validate.

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
  route-and-owner rules above. Concepts must be inferred from semantic roles,
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

## UI principles

The app identity is the teal/cobalt Imprint O with no wordmark. The sidebar uses
only the freestanding O: `assets/brand/orion-imprint-symbol.png`, exported to
`public/orion-symbol.png`, with transparent surroundings and central hole. Never
add a background tile behind this sidebar mark. The original rounded renderer
master `assets/brand/orion-imprint.png` and `public/orion-mark.png` remain for
the favicon/startup screens and Codex plugin artwork.
Native desktop exports in `src-tauri/icons` instead come from the opaque,
full-bleed RGB `assets/brand/orion-imprint-native.png`. Do not export the rounded
transparent renderer tile as ICNS: macOS wraps it in an unwanted white tile.
Verify native changes using `NSWorkspace.shared.icon(forFile:)` on an actual
app bundle, not only by opening the source PNG. Release fingerprints include
both masters, public assets, and native icons so a changed icon cannot reuse a
stale app.

`themeIcon.ts` recolours the approved symbol's luminance while preserving every
alpha value; `public/orion-symbol-source.png` is an exact copy of the high-resolution
symbol master. Rendering is debounced, cached to four colour choices, and never
animated continuously. `useThemeIcon` serializes native changes, ignores late
renders, waits for vault hydration, and follows live resolved System colours.
Original restores the original mark. `theme_icon.rs` accepts only a bounded
512-pixel PNG (or nil reset), never a file path. On the main thread, only the
preferred library window may update the app-global icon. The public
`NSApplication.applicationIconImage` owns the in-memory running Dock image.
Finder always uses the packaged icon. Never call `NSWorkspace.setIcon` on the
app bundle: its FinderInfo/ResourceFork metadata invalidates strict signature
verification after launch. Never replace packaged ICNS, re-sign an installed
app, elevate permissions, target another installation, or modify a vault for this.
The same runtime-only path works from writable, read-only and translocated
bundles. Keep `set_theme_icon`'s bounded PNG/nil input and applied receipt;
Appearance must not promise Finder recolouring or request a writable install.
Release verification must pass `codesign --verify --deep --strict` before and
after launch and theme changes. Do not strip user metadata during launch;
reinstall the clean app to replace a legacy bundle carrying a custom Finder icon.

With native glass active, New note and its generation chevron share one light
rim and translucent surface that exposes the existing AppKit material. Keep
the text opaque, the chevron separator inset, and solid styling when glass is
off or accessibility requests reduced transparency/increased contrast. The
control follows the shared glass tint with a small additional 12% surface tint
to remain slightly more opaque than its surroundings. It adds no appearance
setting or native material view. Compact sidebars stack the two actions inside
one outline. Gate this treatment on `data-native-glass`, whose native response
already handles accessibility; unsupported positive transparency media queries
must not suppress the treatment in WKWebView.
Selected navigation pills and the open/hovered Space switcher use the same
translucent treatment. Generate and Space dropdowns use a stronger bounded tint
derived from shared glass opacity, with a web backdrop blur to keep underlying
navigation from showing through their text. This is a renderer popover over the
existing AppKit frame, not an independent native glass view. Their selected rows
and New blank space control stay translucent; all overrides require native glass.
Keep these fills uniform and translucent: do not paint gradients or simulated
diagonal highlights onto the controls or popovers. Popover tint tracks the shared
setting plus 12 percentage points, bounded to 24–92% for readable content.

Typography uses two deliberate brand roles: bundled Hanken Grotesk (400) for the
interface and default note text; bundled Lora (400) for the Home headline and
its supporting paragraph, plus note titles on Home, Notes, and the open note.
Small navigation uses Hanken Grotesk 400 and
controls keep stronger weights for readability. The editor toolbar’s Note font
dropdown owns the shared Sans serif / Serif choice; do not place it in Settings.
`Settings.noteTypeface` accepts
only `sans` or `serif`, is optional at the storage boundary, and hydrates to
`sans`; the app-shell attribute applies it to reading and rich editing without
changing persisted prose. Do not add a font catalogue or use serif type for
ordinary UI headings. `public/fonts` contains the four unmodified variable TTF
faces (Hanken Grotesk 100–900, Lora 400–700, upright and real italic), their OFL copyright
and licence texts, and pinned source/checksum metadata. Keep these assets local
and preserve their licences in renderer builds; do not fetch fonts at runtime.
`src/App.css` defines the faces and `index.html` preloads the upright fonts.
See `docs/typography.md` for font roles and the reading scale.
Primary navigation and sidebar notes are 13 px, note text is 18 px sans / 19 px serif, and the
Space overview uses a 22 px heading and 13 px body text in a 460 px tall card; the body matches the task empty state. Keep the adjacent
task card aligned at that height, with both bodies independently scrollable.

Selected sidebar notes use the full-row background highlight without a decorative
outline on the inner note button. Preserve keyboard focus-visible outlines.

Keep the sidebar footer anchored at the bottom in both expanded and compact
layouts. Expanded sidebars place the collapse toggle first and Settings beside
it. Compact rails stack Settings above the sidebar toggle, with no divider
above those bottom controls. The navigation
divider stays below Chat; hiding the note list must not pull the footer upward.

Orion should feel calm, editorial, and spatial rather than dashboard-heavy.
Reuse the existing colors, surfaces, typography, radii, and compact scale in
`App.css`. Prefer a single clear action and progressive disclosure. Preserve:

- direct editing with the animated toolbar;
- note dictation in that sticky toolbar, with the body insertion point preserved
  and mapped through edits while on-device transcription is running;
- one contextual toolbar at the original width around a restrained reading
  measure. Its main controls switch between text, selected-image and table actions while keeping
  the current object selected. Lower-priority tools move into a bounded
  contextual More menu as width narrows; no toolbar region scrolls horizontally.
  More stays at the far right after the fixed Undo/Redo group. Menus use fixed
  icon and text columns. Preserve portable Markdown controls
  for strikethrough, inline and fenced code, dividers, tasks and editable tables;
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
- `noteCodeSerialization.ts` preserves literal code through the instance-scoped
  `NoteMarkdown` serializer wrapper. Work on a transient JSON copy; collision-free
  placeholders must be restored before returning Markdown, never persisted.
  Derive inline/fenced delimiters from real content and protect code spacing
  from general mark/table trimming. Ordinary table pipes need correct escaping.
  An odd backslash run before a table-code pipe uses adjacent code spans joined
  by exactly `<!-- orion-code-join -->`; only the matching inline-code triple
  inside a table is merged by reading/export. Literal comments, other comments
  and comments outside that shape remain untouched. Keep three-reopen and
  reading/export equivalence checks. Inline line endings follow CommonMark;
  use fenced code for literal newlines. Do not patch Tiptap globals/node_modules,
  mutate editor state while saving or introduce an autosave exception for
  ordinary code typing;
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
  Signal Decay, Field, Quiet Loom, Nova, Flux, Tidal Glass, Prism Drift, Nebula,
  Emberwake, Gravity Silk, and Mirage, with curated or custom accent and motion controls;
  only the active renderer should load or animate. The nine original procedural
  effects share a local WebGL lifecycle with no external artwork or shader
  dependency, a 600,000-pixel
  budget and 30 fps cap, hidden/offscreen suspension, static fallbacks, and
  context-loss recovery. Still draws only on resize or pointer input; system
  reduced motion also disables pointer response. The seven full-field effects
  (Flux, Tidal Glass, Prism Drift, Nebula, Emberwake, Gravity Silk, Mirage)
  occupy the whole hero rather than a central object;
- direct canonical article navigation, with the right-hand connections canvas
  reserved for unresolved legacy ambiguity instead of a graph;
- route-aware Back/Forward: a note opened from Notes returns to Notes, a note
  opened from Home returns to Home, direct destinations open at the top, and
  history traversal restores the exact saved scroll position;
- a dedicated Favorites section above one complete active-Space sidebar note
  list, both preserving the stored note-array order when notes are opened;
  favorites remain in All notes so that list is genuinely complete;
- a scrollable left-hand outline derived from H1–H6 Markdown, with stable
  duplicate-safe anchors, an editorial reading scale, and the current section
  emphasized as the user reads, including the final section at scroll end.
  The note title remains separate, the heading picker previews all six levels,
  and deeper headings remain legible. Never reserve the outline grid column
  when no outline exists, and hide the rail only where the window cannot support it;
- note sources, backlinks, and related notes in an on-demand right-hand
  connections inspector that overlays the reading canvas rather than
  permanently shrinking it. Source entries open the preserved text or
  transcript, metadata, original URL when available, and the notes it shaped;
- no reference-hover popovers on automatic or explicit concept links;
- strong empty states with no fake content;
- keyboard access, focus trapping, visible focus, reduced-motion behavior, and
  useful ARIA labels;
- draggable native window chrome across the full top bar, including the blank
  sidebar strip and gaps around controls. The top bar uses Tauri's `deep` drag
  region so non-interactive descendants participate; buttons and other controls
  retain normal input. The Space switcher stays above the sidebar drag strip in
  stacking order so its entire button remains clickable;
- Chat uses one continuous background behind the thread and composer; do not
  add a composer-width backdrop that creates vertical seams across that room;
- one calm Share or export sheet whose default is an offline web article, with
  explicit format and scope choices plus a plain privacy summary; do not turn
  export into a settings dashboard or imply that a local file is already a
  hosted public URL;
- desktop layouts down to the configured 1024×680 minimum, plus responsive
  browser-preview layouts.

Do not introduce a separate Markdown editor, read/write tabs, a Link Lens button,
or a persistent import button floating over unrelated screens.

## Editor and narration contract (0.4.6)

Orion 0.4.6 includes the six editor changes and narration/usability additions
developed on `codex/editor-preview` in both Whisper Small and Medium editions.
Preserve them as supported product behavior. Release publication requires the
normal packaging and verification procedure; historical preview checks do not
certify new release artifacts.

Development builds continue to use `app.orion.desktop-preview` and its separate
persistent library. Never copy, reset or seed the normal vault for a preview or
release check. Installing a release retains Orion's existing application identity
and library; the preview library is not automatically transferred. See
`docs/editor-preview.md` for scope, interactions and limitations. LaTeX is outside
this integration's scope.

- Written-note Play builds its script from the displayed title, summary and
  prose through `noteNarration.ts`. Compact DOM text spans retain UTF-16 offsets
  across formatting and line breaks without rewriting the document. Custom
  Highlights dim unread words; Follow text disables that decoration. Pointer
  seeks require an actual glyph hit and preserve selection gestures and modified
  link clicks. Pause retains the current word, while editing, changed wording,
  navigation and Stop clear the timing map. Keep the Markdown subtree stable
  across playback ticks. The playback slider also supports arrow keys/Home/End.
  Seeking immediately updates three disjoint highlight ranges, even while audio
  loads: all preceding text uses the normal foreground, the current word has the
  active highlight, and only following text is dim. Do not restore the visible
  Click text to jump hint; retain the Passage timing fallback when needed.
- Formatted empty paragraphs retain their margins and justification through
  unescaped `&nbsp;` markers. Strip paragraph metadata before recognizing a blank
  marker, and preserve every formatted blank on repeated save/reopen. Escaped
  literal entities and code must never be globally decoded to repair old data.
- System narration uses actual speech word-boundary events. ElevenLabs uses
  the original-text alignment from its `/with-timestamps` response. OpenAI
  keeps its existing speech request and optionally aligns the generated MP3
  locally with bundled Whisper's separate `--align` mode. `speech_timing.rs`
  validates and conservatively matches acoustic words to the original script;
  never infer word positions from an elapsed-time percentage. Failed alignment
  keeps playable audio and visibly falls back to passage timing. No additional
  transcription provider call is made. Native alignment owns a temporary 0600
  file, window-scoped media job and existing shared Whisper process slot;
  120-second execution, 12-MiB audio, 600 decoded seconds, 8192 tokens and
  256-KiB alignment output are bounded. Existing dictation modes and recording
  deletion stay unchanged. Cloud note playback lazily generates 1200-character
  passages with at most one following passage prefetched; seeking reuses cached
  audio/timings. The optional `trackWords` IPC field defaults false for decks.
- Written-note Download narration captures the same complete displayed script.
  `narrationDownload.ts` reuses the same 1200-character cloud passage/cache keys,
  decodes complete files, then packs one 24-kHz mono 16-bit PCM WAV; never simply
  concatenate MP3 containers. Bound downloads to 80,000 UTF-16 characters and
  128 MiB; reject oversize output rather than truncating it. Abort on navigation,
  changed wording, editing or explicit cancellation. Existing provider gates
  apply to missing passages; never fall back to a different provider silently.
  `narration_export.rs` accepts exactly one bounded WAV or system script and a
  window-scoped media job. Only a native Save As dialog supplies the destination.
  Mac system speech exports AIFF locally through `/usr/bin/say`, using private
  temporary files, cancellation, a 300-second deadline and kernel file-size
  limit. Final writes are flushed and atomic. Browser previews support cloud
  downloads only. Do not change dictation retention or vault data for export.
- Space renaming stays in the existing switcher, using exact IDs, normalized
  bounded names and duplicate checks. Reject a changed original name rather
  than overwriting a concurrent rename. Preserve the existing vault merge/save
  path and every Space's content/navigation identity.
- Import supporting text has a 13px minimum, with 14px inputs/actions and 16px
  source titles. The editor's AI control uses a standalone monochrome sparkle
  without adjacent text, accessibly named AI tools because it includes both
  text and image actions. Its tooltip describes those capabilities. Preserve
  provider gates and preview/accept behavior; merely opening it performs no
  generation. Narrow layouts move secondary tools into More without scrolling.
  Keep redundant file-count/size/privacy captions out of the import intake;
  retain the actual validation limits and actionable error messages.
- Keep the toolbar's original width. Its text, image and table modes share
  contextual More at the far right after Undo/Redo, using only the ellipsis
  without a chevron in every context. Move lower-priority actions
  into More as width narrows; do not add horizontal scrolling. Align menu icons
  and labels in fixed columns, and preserve the selected object during actions.
  Opening text More by pointer focuses the menu container without an outline,
  never the native Text style select. Enter, Space and Arrow Down open at the
  first enabled control; Arrow Up opens at the last. Preserve native select
  keys and ordinary Tab navigation. Escape returns focus to More, and all
  opening paths preserve the editor selection.
- Justify text toggles selected prose paragraphs/headings with one undoable
  transaction (Cmd+Shift+J). `NoteStarterKit` and `NoteTaskItem` preserve it through
  tight/loose lists using only the exact inline suffix
  `<!-- orion-text:v1 justify -->`. `remarkNoteTextAlignment` hides that marker
  and applies the same bounded attribute in reading and offline HTML. Preserve
  code examples, links, task line indices and ordinary left-aligned Markdown;
  never accept arbitrary CSS. Table cells keep their separate GFM alignment.
  Reading tasks recursively remove the GFM-generated checkbox before adding the
  interactive control; leave nested lists to their own item renderer.
- Note actions (Done/Edit, Play, Find, Favorite and Delete) sit above the title
  and subtitle. Keep the heading and subtitle together and omit the divider
  above the formatting toolbar. Do not show concept/source counts in the header.
  Editing removes the header bottom padding and uses a 12px editor gap, bringing
  the toolbar directly under the subtitle without changing its sticky behavior.
- Margins toggles a horizontal ruler beneath the toolbar, available through
  More at narrow widths. Keep the toolbar below the note title and subtitle,
  with the ruler directly below it in the same inline sticky formatting dock.
  The dock sticks only after scrolling past the note heading; never move the
  formatting controls above the heading to work around native tracking.
  Disable vertical elastic overscroll in the writing pane while editing:
  WebKit rubber-banding occurs outside the DOM/native geometry contract. The
  toolbar and More formatting menu use untinted native Regular Liquid Glass.
  The shallow toolbar clips a 224-point-high Regular surface to its normal
  rounded bounds, matching the menu's scattering without a second material,
  tint, or blur filter. Its foreground is drawn at the original toolbar size in
  the middle of that surface; never stretch the controls. The pass-through clip
  owns the original toolbar frame, so scroll motion and hit targets stay aligned.
  Extra material opacity produces a flat grey bar; an unpadded shallow Regular
  surface remains too clear. The ruler retains Clear with no tint or added
  frosting. The toolbar clip, ruler and menu are children of one
  full-viewport pass-through NSView, with their frames updated together. Keep
  macOS's Liquid Glass appearance preference in the native QA matrix: Clear
  still follows the system tint amount. The unchanged earlier preview also
  appeared opaque with maximum system tint; grouping and parent geometry were
  not established as the cause. Never override the system preference through
  undocumented defaults. Keep the ruler aligned to the actual writing
  surface, with independent draggable markers and measured ticks on a 44px track.
  `src-tauri/src/ruler_glass.rs` hosts the scale/handles in Clear's `contentView`.
  `nativeToolbarPaint` paints only the existing local toolbar glyphs, labels and
  control states into a bounded transparent foreground inside Regular's
  `contentView`. Group toolbar controls with whitespace, never vertical rules;
  preserve active-button outlines and keyboard focus rings. The native painter
  draws controls only, not group containers or spacers. Accept only bounded PNG bytes (maximum 4096x160 pixels and
  350,000 encoded characters), never arbitrary SVG, a path or a URL. No document
  content is read by this paint path. More formatting uses a third native
  Regular glass surface above the ruler, retaining both underlying materials.
  Its local control foreground has separate limits of 1024x1536 pixels and
  700,000 encoded characters, within a 512x768 CSS-pixel viewport-bounded menu.
  Menu scrolling repaints its clipped controls and scroll indicator; closing it
  hides only that surface. Reuse foregrounds during document scrolling.
  DOM controls remain the sole source of selection, input, accessibility, undo
  and persistence. `NativeFormattingDock` owns `useNativeRulerGlass`, which
  coalesces layout/appearance updates and dispatches scroll geometry immediately
  without another frame or previous IPC acknowledgement. Once artwork is
  acknowledged, `move_ruler_glass` sends only bounded coordinates tied to that
  artwork revision, never PNGs. It only translates existing visible surfaces;
  resizing, repainting and material changes use the full command. Retry invalid
  motion once through the full path before falling back. Per-WebView monotonic
  revisions reject stale native arrivals and renderer responses. Hiding removes
  native content while retaining only a hidden noninteractive revision receipt.
  Keep the host at viewport bounds and translate the glass views without
  relaying out foregrounds. Scoped AppKit and Core Animation transactions disable implicit
  animation. Vertical scrolling must not recalculate paragraph margin state.
  Hide DOM artwork only after native activation succeeds. Restore HTML controls
  for other overlapping menus/dialogs, active numeric toolbar editing, paint failures,
  unsupported systems and accessibility requests. The ruler fallback is solid;
  never imitate native glass with a CSS shader or specular top stroke. The editor
  material does not change the shared window-frame material.
  Put fallback borders on the absolute backplate so they never offset measured horizontal geometry; do
  not clip the edge handles or focus rings. Extend only the glass backplate by
  8px at either end to give endpoint labels room inside its corners, offset the
  margin shading by the same amount, and omit the 0/100 tick strokes so no stray
  vertical lines touch the rim. Keep the document/selection scope screen-reader
  only through the ruler's accessible description, with no visible caption or
  close X. A small RotateCcw reset icon sits below the ruler on the right, named
  and titled Reset margins; the toolbar toggle hides the ruler. Do not restore a
  separate ruler popover, stacked sliders or numeric-entry panel. Handles expose
  keyboard slider semantics: arrow keys, Shift for larger steps and Home/End.
  A collapsed text selection targets the document body; a highlighted range
  targets the intersecting ordinary paragraphs/headings, including list and
  quote prose, while excluding tables and code. Never require or create a
  `noteBlock`. Left and Right are independent integer percentages from 0 to 25
  of the available writing width, with immediate reflow and a scope-local Reset.
  The visible ruler follows the current selection. Capture the target and
  measured geometry at drag/keyboard start and map it across editor
  transactions; mixed values must not overwrite the other side. Pointer
  movement reflows live, and release/cancellation ends the adjustment. Changes
  emitted by the rich editor may return through the parent after a newer drag
  update; consume pending local Markdown echoes in order without replacing the
  document or selection. Retire acknowledged echoes so genuine external edits
  and reverts still load normally. Changes retain ordinary undo/redo, with each
  drag grouped separately from later
  drags and surrounding typing. Document margins affect the body only, leaving
  note headers and the toolbar stable, in both library and writing windows.
  `src/components/editor/NoteMargins.ts` stores document attributes through the
  `NoteMarkdown` manager and changes paragraph attributes without wrapping
  content. `src/lib/noteMargins.ts` validates only the exact document prefix
  `<!-- orion-document-margins:v1 LEFT RIGHT -->` after optional frontmatter and
  paragraph/heading suffix `<!-- orion-paragraph-margins:v1 LEFT RIGHT -->`.
  Zero defaults need no metadata. Preserve literal code examples, existing
  justification suffixes and list/task structure; reject arbitrary CSS.
  `remarkNoteMargins` consumes valid suffixes into bounded numeric attributes
  for reading and offline HTML. Markdown exports/imports retain the markers;
  Word exports translate them into real indents. This adds no note schema or
  shared application preference, and DOCX import does not restore the margins.
- The contextual More menu's optional Block controls action uses a three-rectangle icon and
  wraps the current top-level content or adjacent selected nodes in one persistent
  `noteBlock` within the same Tiptap document. It is not a shared setting or a
  separate note format. `NoteBlock.ts` preserves ordinary rich children between
  exact `<!-- orion-block:v1 -->` and `<!-- /orion-block -->` Markdown comments;
  parsing is bounded, preserves fenced examples, and flattens nested wrappers.
  `remarkNoteBlocks` in `src/lib/noteBlocks.ts` gives reading and offline HTML the
  same grouping without exposing those comments. Whole lists, tables, images and
  excerpts retain their own structure and attributes.
  Ordinary prose coexists outside blocks. Clicking outside a block hides its
  controls without unwrapping it; selecting its content restores them. Keep an
  ordinary writable paragraph after the last block. Enter in a block's direct
  paragraph or heading splits it into persistent sibling blocks and puts the
  cursor in the new block; Shift+Enter inserts a line break in the same block.
  Enter in ordinary prose outside blocks stays ordinary. Lists, tables, code and
  nested quotes keep their existing Enter behavior. An open slash menu consumes
  its Enter choice before the block keymap. Clicking Block controls while
  inside a block explicitly unwraps it without deleting its children. Wrapping,
  unwrapping, deletion and movement each have an independent Undo step.
  `NoteBlockControls.tsx` adds no visible box, outline or decorative corners.
  Small plus controls sit just above/below the active block, with trash at its
  upper right and a hamburger move handle on the left. The upper plus, hamburger
  and trash share one horizontal centre line above the block, clear of table
  selection controls. Plus circles are 20 px
  with 12 px glyphs; the 12 px hamburger sits in a 20 px control. Invisible 4 px
  hit-area expansion keeps the controls easy to target without enlarging their
  visual footprint. Dragging the handle reorders the
  persistent block; Arrow Up/Down moves it one adjacent sibling. `useBlockReorder`
  keeps the original document unchanged until drop, supports bounded auto-scroll,
  and cancels on Escape, pointer cancellation, lost capture, blur, changed content
  or unmount. `noteBlocks.ts` validates immutable captured targets and top-level
  boundaries, rejects drops into the source itself, and preserves child attributes
  plus text, image and table-cell selections through movement.
  `BlockInsertMenu.tsx` reuses slash vocabulary/icons with Text as the base choice,
  keyboard navigation and scroll room below the boundary. Plus actions insert new
  persistent blocks. Deferred choices reject changed content; cancelling a picker
  never inserts a placeholder. Controls and drag indicators remain outside
  ProseMirror's owned prose. `blockGeometry.ts` positions controls in the available
  text lane using intrinsic image/caption bounds and live drag exclusions; geometry
  reads are batched with requestAnimationFrame. Preserve normal image size, free
  placement and live wrapping. Text style/Header choices live in the contextual
  More menu, alongside Block controls in every editing context. Compact image
  tools also move alignment and width into More while
  keeping placement visible.
- `SlashMenu.tsx` and `slashCommands.ts` expose the compact icon menu only for a
  slash prefix at a word boundary within ordinary text, including the middle of
  an existing paragraph. Replace only the command range and preserve surrounding
  prose. Keep URLs, paths and code literal.
  Commands are write, comment, block, heading, todo, bullet, numbered, divider, image,
  code, link, excerpt and table; H1–H6 also have direct shortcuts. `/write` opens
  **Write with AI** and requires an explicit Write submission before generation.
  `/comment` selects the current paragraph after removing only its command token,
  or the immediately preceding nonempty non-code text block on the next line. A blank
  paragraph between them (two Enters), or an empty note, creates a standalone note
  comment in the same modal. Its optional anchor `scope: "note"` requires empty
  quote/text, persists as metadata without invented prose, and remains current as
  the note evolves. Renderer and MCP validators accept this additive schema; legacy
  passage anchors retain exact quote requirements. Note comments can continue in
  Chat or generate an article; text additions/rewrites require explicit passage
  attachment first. Opening/saving makes no provider call. Stale command ranges remain unchanged. The command is available only when the comment
  handler is mounted, is excluded from block insertion, and is suspended while its
  modal is open. `passageCommentSelection.ts` owns the one-step undoable selection.
  In tables, `/delete` offers row, column or table. The menu stays below the caret with a bounded,
  scrollable height and aligned icon/text columns. Preserve keyboard choice,
  Escape, the captured insertion point and single-transaction replacement. Reject deferred insertion
  when the captured document changed.
- `ExcerptPicker.tsx` receives only the active Space's notes. Search titles and
  complete visible bodies, show a scrollable full-article text reader and jump
  to the matching passage. Selections preserve exact visible words, merge
  overlaps and join separate passages in source order with an ellipsis. Bound
  each excerpt to 12 passages and 12,000 characters from one source note. A
  changed source requires a fresh selection; never insert from stale offsets.
- Excerpts remain editable, frozen Markdown blockquotes with an attribution
  link, not synced content or a parallel block schema. `noteExcerpts.ts` owns
  bounded `orion-excerpt:v1:` metadata in the optional `orion-note://` link title.
  Hide reserved titles from tooltips. Backspace immediately after an excerpt
  removes it as one undoable edit; do not restore a Change excerpt button.
  Source navigation stays inside the current Space and reveals exact preserved
  wording only when it can be located without guessing. Source edits/deletion
  never silently rewrite the quote or select a same-title note elsewhere.
  Reading and editing share the note's body typography, a calm left rule,
  compact spacing and a 12 px bottom-right attribution. Suppress decorative
  quotation marks only for excerpts; ordinary quotation styling stays intact.
- `NoteImage.tsx` preserves the ordinary image node and managed attachment
  contract. Corner resizing maintains proportions. Pointer drag sets continuous
  horizontal position and a vertical offset from an internal paragraph anchor,
  keeping the image at its displayed size and full opacity during the gesture.
  Text must wrap live around the moving image and caption before release. Use
  transient editor-owned exclusion decorations; do not save intermediate drag
  positions or rewrite the prose DOM. Commit the completed move once so Undo
  restores the original placement; cancellation restores the original flow.
  Do not show a scaled thumbnail, destination outline or position label. Clip
  the moving image at the writing viewport instead of shrinking it. Never snap a drag
  to left/centre/right or visible paragraph boundaries; alignment presets are
  explicit shortcuts. Avoid WebKit's native bitmap drag ghost. Layout and
  caption use bounded `orion-image-layout:v1:` image-title metadata validated by
  `noteImageLayout.ts`, shared by editing, reading and offline HTML. Optional
  `xPercent` is null for legacy alignment or clamped to 0–(100-widthPercent)
  at hundredth-percent precision; `offsetY` is 0–10000 px from the anchor.
  Width is 15–100%, spacing is 8–40 px, and captions are at most 500 characters.
  Free layouts use a floated exclusion wrapper and an intrinsic image/caption
  box. Preserve normal editable prose; do not replace ProseMirror-managed text
  with manually measured line DOM. Wrap text flows on the roomier side, while
  Above & below excludes the complete image band. Both restore full-width prose
  above and below. In line remains on its own line, and dragging it enters Wrap
  text. This is not simultaneous two-sided wrapping around a centred image.
- `NoteTable.ts` keeps real Tiptap table transactions and native column
  resizing. `TablePicker.tsx` offers the hover/keyboard grid, header toggle and
  custom size bounded to 12 columns and 20 rows. Contextual row/column rails
  support selection, with numeric count fields and chevrons at the table edges.
  Count reductions require confirmation before removing nonempty content.
  Keep additional actions in contextual tools, not a floating bar below the
  table. Table width is 35–100%, and Tab at the last
  cell adds a row. Controls disappear when selection returns to prose.
  Preserve undo and cell data.
  The table toolbar exposes row/column insert/delete, header, banding and width
  with icons and hover labels, without a redundant Table rows-by-columns label.
  Width shows just its percentage select with a Table width tooltip/accessibility
  label; do not add a decorative non-clickable icon beside it.
  At narrower widths move secondary actions into More, keeping the core row and
  column actions visible and native select keyboard behavior intact.
  Optional adjacent `orion-table:v1` JSON comments carry bounded width,
  column-width, header and banding metadata while the
  table remains GFM. `noteTables.ts` is the pure validator/read-rendering helper.
  Its remark filter hides only validated adjacent table metadata in the reading
  tree while retaining source positions and visible code examples.
  Headerless GFM uses a synthetic empty header; suppress that header without
  deleting an author's row. Never interpret metadata as arbitrary CSS or HTML.

## Writing sessions

The rich editor's clock button offers an ordinary writing timer and optional
Flow drafting. `writingSession.ts` owns the deadline-based state machines;
`WritingSessionControl` expands setup and status directly inside the toolbar;
there is no modal, popover, or separate writing surface.
The ordinary timer is transient and per window, survives editor/navigation
remounts, and supports pause/resume/stop without affecting normal autosave.
Neither mode adds a vault field or makes provider calls.

`FlowWriting` is a ProseMirror plugin that appends a new writing paragraph to
the real editor and protects all pre-session nodes. Its unsaved rich-text
passage starts timing with the first text input. After 30% of the chosen
5/10/20-second inactivity interval it gradually dims through node decorations;
expiry deletes it. All provisional transactions and their removal exclude
history, and RichNoteEditor suppresses their onChange publication. Expired text
must never reach autosave or Undo/Redo. Actual text changes reset inactivity;
IME composition pauses both clocks. Compare absolute deadlines on every input,
tick, and Stop so suspended callbacks cannot rescue an expired passage.
Finishing the 1–180-minute timer or choosing **Stop and keep** commits the rich
passage in one separate Undo group and resumes normal autosave. Existing note
content is never subject to expiry. Leaving the editor or closing Orion loses
unfinished Flow text. An external note replacement ends Flow before loading
the newer document. Sessions belong to their exact editor and never transfer
across notes or Spaces. Native toolbar paint includes the inline timer labels.

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
    `./script/package_release.sh <release-label>` for the ordinary Small
    edition, or `ORION_WHISPER_MODEL=medium ./script/package_release.sh
    <release-label>.m` for the Medium edition, so the DMG is staged to a new
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

Never claim the media workflow was end-to-end verified unless the exact
finished app bundle downloaded a real bounded YouTube source with its bundled
`yt-dlp` + Deno and transcribed that downloaded media with its bundled model.
A compile, unit test, or setup-version check alone verifies integration shape,
not decoding, model inference, or current YouTube extraction.

## Space voice and completed-task working views

`SpaceVoice.tsx`, `liveVoice.ts`, `voiceResearch.ts` and native `live_voice.rs`
own optional GPT-Live client delegation within the current Space and window. Never start
the microphone or reconnect automatically. Authenticate the fixed-endpoint native
SDP handshake with the OpenAI Keychain entry, never a renderer key. Keep audio
storage off, input/output lifecycle bounded, and the selected Intelligence model
for research. Voice receives compact context and cited assignment results, not an
entire Space. A fresh main conversation offers one neutral welcome after two
connected seconds, with microphone input continuing. The call lifecycle cancels
it on user/assistant transcripts, measured input/output activity, delegation,
commentary, mute, Stop or disconnection. Repeated connection status, reconnect,
worker switches and navigation cannot replay it; Clear resets the conversation's
opening eligibility. Existing work also suppresses a new welcome. Send the
trusted opening once through `instructions`, never as a synthetic user request.
The native policy stays quiet until user speech or that explicit opening; context
cannot initiate a topic. Natural pauses and unfinished thoughts remain listening
opportunities. Available worker capacity alone is not a research reason; retain
organic investigation of useful evidence gaps and exact requested counts.
Startup context includes bounded exact working passages of the open
note, note/source counts and up to twelve note titles; it must never mistake a
missing excerpt for missing note access. Send new note passages only when the
open note identity changes (or clear the context when it is deleted), never after
typing pauses, title changes or directory refreshes. Those passages are a
navigation-time snapshot; retrieve fresh evidence for later edits. Basic access questions resolve locally, while broader
questions retrieve evidence through independent work orders. Explicit spoken
assignments do not wait for a provider delegation. Read requests use the ordered
intent router to choose one useful worker or a complementary team; do not require
literal worker/parallel keywords or ask the user to specify each worker's topic.
An explicit count plus reading all notes partitions the actual Space-local note
IDs without a planning call when each worker has 1–24 notes. Other distributions
use the bounded router. These references are read-only and bypass the unrelated
open-note focus; full document reads and honest coverage remain the reader's job.
Single explicit writing requests retain the direct authorizing transcript path.
`voiceNoteEdits.ts` owns a direct unsaved-edit lane for explicit note revisions,
independent of research workers and orb reservations. Capture the original note
and selection, deduplicate delayed delegation, and cancel only a superseded edit.
Use `runChatReading` with `purpose: edit`: read the target first, disable creation,
retain strict freshness, and require a validated proposal rather than a chat-only
draft. The current user request stays verbatim. Reuse the ordinary note review,
Accept/Discard and Undo; this lane has no persistence callback. Surface rejected
review promises. Space teardown cancels preparation; ending audio alone does not
discard an already admitted edit. Explicit cancellation remains available.
Quiet updates from application-started work
use a null delegation ID. Each admitted voice work order uses `runChatReading`
with the original transcript, the same automatic intent/reading/edit handling as
typed Chat, and bounded recent conversation reference. Do not insert a second
research planner, rewrite the prompt into search-only tasks, or discard follow-up
history. Transient conversation augments request history without masking the last
Chat answer's evidence. Independent work orders provide parallelism. Never
substitute a couple of excerpts for a full-note request. Preserve delegation IDs
when the event arrives before transcription. Native string errors must retain
their actionable message in the work order rather than a generic failure. OpenAI
phased output is parsed from final-answer content without commentary or SDK
aggregation; reject a missing final answer. Preserve legacy unphased multipart
output. Native reading offsets accept integral JSON numbers such as 0.0 and 1e3
within the same bound as browser validation. Static CHAT_* error categories
distinguish JSON, structure, reads, checkpoints, reply and edit failures without
logging or echoing raw provider output or note contents.
Only the current user transcript or explicit Keep action grants creation authority;
edit proposals retain their captured target and existing Accept/Discard/Undo flow.

Space IDs, task revisions, original knowledge versions and persistent Chat receipt
IDs guard results and writes. Each identifiable work order owns a revision and
AbortController. Ordinary speech never invalidates other work. `voiceWorkOrders.ts`
interprets complete buffered turns as conversation, new assignments, targeted
corrections/cancellation, result requests or clarification. Preserve the exact
user-authored prompt as authority; never authorize writes from a rewritten
model prompt. `voiceConversation.ts` groups same-speaker fragments across duplex
backchannels and associates delegation offsets with the original utterance and
captured note. Once dispatched, another explicit assignment or a silence of at
least the 900 ms routing debounce starts a separate complete turn. Conservative
`voiceUtterance.ts` hints hold dangling clauses for 3.2 seconds and do not admit
unfinished text even if delegated. A continuation within eight seconds retains
its original note/selection/worker; independent explicit assignments stay separate.
This is bounded transcript assembly, not a general semantic completion detector
or control over the provider's natural spoken turn-taking. Short continuations
retain the original job. Late delegation replays for unchanged dispatched text
cannot restart work. Overlong utterances retain their opening and require clarification.
When talking to a finished worker, the first transcript fragment also captures
that worker's ID and revision. Deictic continuation/result/cancellation refers
to that captured worker, never an unrelated running sibling or whichever worker
is focused later. Explicitly named sibling controls remain possible. Missing,
revised or stale focused context cannot silently retarget a request; the main
conversation still clarifies genuinely ambiguous references. Reusing a child
worker identity retains its read-only assignment and completed-read checkpoint.
Local correction classification uses the same continuation grammar as the reader:
supported suffixes such as “explore that further” and “follow that please” must
not fall through to ordinary conversation before reaching the captured worker.
An explicit scope change replaces its focus with the exact current user direction
and invalidates the previous plan; a continuation keeps still-current evidence.
The reader checkpoint does not contain its final answer. Same-scope continuation
and retry also retain a separate public completed-answer reference (at most 3 KB),
with exact opening/conclusion fragments, source identities, coverage and explicit
omissions. Recheck evidence, focus, settings and task-view before reuse; a changed
scope or selection drops it. This reference cannot grant writes or citation
authority. A fresh revision-guarded continuation may repeat an earlier phrase even
after Keep, while the per-worker save reservation still prevents duplicate saves.
Interpret turns in order; direct local cancellation also reaches pending routing
requests. Cancelled generations cannot be revived by a late model response.
A single spoken request can admit multiple distinct read-only assignments. The
host reserves one stable orb identity per requested worker while routing or
clarifying; a topic answer consumes those same identities and the original note
and selection capture. Clarification, unrelated speech and note navigation cannot
drop reservations. Cancelling a reservation aborts any dependent answer route so
a stale batch cannot revive it. Generated child scopes never grant save/edit
authority; the exact current transcript remains the prompt and search purpose
strips writes. Existing single-worker explicit save/edit requests retain their
normal authority and review flow.
Reference-only clarification answers such as “this note” and “what I highlighted”
may complete that original request. They still require a complete validated batch
of scopes; a generic comment or a compound new instruction is not a reference-only
answer. Do not use blanket deictic-word rejection to strand pending workers.
Broad subjects, current conversation and the captured note are sufficient for
the router to choose research angles. Incomplete counts or unnecessary topic
questions get one internal repair attempt rather than becoming user planning
questions. A repeated planning failure is an explicit error, never a claim that
research started. Count corrections retain a uniquely resolved existing worker
for the first scope if the model omitted its ID. Ambiguous cancellation/steering
targets still require identification; generated scopes never grant write authority.
Scope planning receives the original captured note's ID, title bounded to 200
Unicode characters and current content version as reference metadata. Keep its
body/summary with the research reader. Missing or duplicate original note IDs
require clarification and cannot silently fall back to current navigation.

`voiceReservations.ts` owns pending groups, turn aliases, cancelled turns and the
current clarification. It captures the original note/selection and preserves the
surviving worker IDs when a member is cancelled or corrected. Group revisions and
call epochs reject answers captured before a group changes or a reconnect clears
pending state. Consume a valid reservation before admitting its workers. Keep
provider routing, admitted work, audio and React publication with their existing
owners; this class is not a second work-execution or persistence system.

`voiceTurnRouter.ts` owns the ordered interpretation queue, transcript debounce,
route deadlines and AbortControllers. Cancelling or expiring a route releases
its slot immediately even if the provider never settles; stale continuations
cannot clear a newer route. `voiceCallLifecycle.ts` owns one transport recipient,
call epochs, mute, current-call delegation IDs and the accepting-input boundary.
Stop rejects new events immediately; callbacks from an old call cannot mutate a
reconnected call. `voiceFindingScheduler.ts` owns the finding queue, delivery
timer and transcript/audio timing. `SpaceVoice.tsx` retains semantic decisions,
the admitted research engine, conversation references, selection and UI
publication. Ending audio preserves admitted work; leaving the Space disposes
its coordinator. None of these transient owners adds vault state.

There is no six-worker or cumulative admission limit. Up to ten workers execute at
once; additional jobs remain visible and cancellable as queued, with execution
deadlines beginning only on dispatch. Retention bounds 24 terminal records,
never running/queued jobs. Router responses plan at most 24 distinct scopes per
page and automatically page larger requests, validating the whole batch before
admission. One utterance has a 1,000-worker allocation guard with an explicit
clarification for larger counts; no silent truncation. Provider routing context
and reconnect context remain bounded and report omitted identities as retained
work, never cancellation. Physical calls still use the global provider scheduler.

Voice opts into the shared reader's bounded `checkpoint` response field. A read
step can include a concise public finding with exact citations, public task
decisions and unresolved questions; ordinary accompanying prose and actions are
still discarded. The host validates retained citation IDs, suppresses duplicate
findings, publishes up to six useful updates on the work order, and queues them
through the same revision-aware spoken-delivery path. A progress label is never
a research finding. Checkpoints cannot save notes or bypass edit review.
`chatReadingCheckpoint.ts` holds session-local continuity: exact evidence and
versions, discovered IDs, completed operations, public findings/decisions,
unresolved questions and pending reads. A corrected work-order revision resumes
its last completed local read boundary; stale evidence and decisions based on it
are removed before the next provider call. An explicit failed-job `retry` can
resume that boundary, while duplicate delegation replay cannot restart work.
Only retained current passages are citation authority; evicted ranges can be
read again. Packet continuity is bounded separately to leave room for evidence.
This preserves task memory across model invocations, not hidden chain-of-thought
or an uninterrupted model process. Completed/current workers expose a bounded
`conversationContext` for optional conversations, never new write authority.
Its bounded answer and passage excerpts explicitly declare missing content and
coverage rather than implying that the entire result was handed to voice.

Read-only search and voice Chat work can opt into evidence-dependent freshness: recheck opened
note/source versions and provider/context settings instead of rejecting an
unrelated note edit. Ordinary Chat, note creation and edit proposals retain
strict snapshot checks. The shared reader promotes any focused/rewrite intent
back to the original full snapshot before preparing an edit, even when the run
started as read-only. A clarification without creation actions never triggers a
save. One persistence reservation per work-order ID is shared
by revisions and Keep, with stable host receipt ID `<job>-save`; cancellation
cannot undo an atomic write already in progress. Retain its confirmed receipt
without announcing a superseded result. Reconnect restores bounded conversation,
quoted user decisions/corrections, jobs and receipts without rerunning them.

`voiceFindingScheduler.ts` keeps incoming findings in a local inbox and rechecks
job revisions before preparation and delivery. Worker arrivals do not immediately
append reference text to the speaking connection.
It retains one current pending finding per retained worker, with no smaller
twelve-result speech cap. Prune queued updates and deduplication records with the
research engine's current revision/sequence, including already offered entries.
All retained terminal jobs appear in the scrollable work summary. Completed
results distinguish Combining findings, Ready in work summary, Waiting for a
pause, Voice summary unavailable and Shared with voice; the last means locally
sent, never provider acceptance or audible proof. A failed synthesis preserves
research and exposes Retry voice summary without a continuous retry loop.
Read aloud explicitly requests a retained answer without opening its worker.
`voiceFindingSynthesis.ts` prepares up to four current interim/final findings
after a 1.2-second collection window using one read-only call to the selected
Intelligence provider/model/effort. It never waits for the entire team. There is
one preparation slot per conversation, a 45-second deadline, and at least eight
seconds between prepared offers. `voiceSynthesisProtocol.json` is the shared
native/browser contract; `src-tauri/src/voice_synthesis.rs` validates it. The
`voice-synthesis` Chat mode has no research tools, note creation or edit authority.
Its bounded 32 KB payload includes recent conversation, at most three previous
offers (not proof of hearing), whole findings and exact worker-local references.
The model returns one contribution of at most 900 Unicode characters and an
exact included/deferred finding-key partition. Related evidence can be combined;
disagreement, coverage and failed-web qualifications must survive. Unrelated or
redundant findings remain local for another relevant turn. Neither preparation
nor delivery marks research as finished or resets a worker's checkpoint.
Completions take priority when filling a preparation batch. Do not prepare an
interim-only batch without its renewed speaking allowance: it would occupy the
single prepared slot and strand a later final result behind throttled chatter.
New user turns, corrections, cancelled/revised workers and newer finding
sequences invalidate stale preparation and prepared speech. Background
preparation can run during assistant playback; delivery cannot. Fit fewer whole
findings when needed rather than clipping caveats or source names, reserving the
24,000 UTF-16 transport boundary for exact included provenance and the summary.
After the floor guard clears, pair exact included provenance in `thinking` with
the actual consolidated summary in `commentary`, never another instruction to
wait. Preserve the current client delegation ID when all included findings share
it; use null for cross-task summaries. Rejected commentary retries the same pair
without repeating synthesis. Worker text never enters trusted instructions.
Background preparation cannot block the main voice's direct answer from existing
knowledge or justify thinking/waiting placeholders. Explicit
results/saves bypass synthesis and retain exact provenance pairing. Synthesis
quality and natural timing still require live-provider acceptance.
`voiceFindingDelivery.ts` keeps worker identity, stage, evidence/coverage and
confirmed-save/proposal state and complete bounded answers in local reference
metadata. Detailed answers are not automatically copied into speech. Commentary carries
its exact quiet packet so delivery can pair current worker/revision/sequence and
bounded exact source identities/titles immediately before the finding, even when
several workers finish out of order. A rejected reference send holds commentary;
retries repeat the pair. Remap delegation IDs against the receiving audio call.
Switching between finished workers and the centre preserves admitted findings
while resetting old audio pacing; only the main conversation offers them. Stop
and explicit reconnect still clear pending speech. Capture the exact completed
revision when opening a worker, including for later transcript binding. A newer
quiet-only finding supersedes older queued speech from the same worker through
its delivery sequence. Stale,
revised or evicted focused results hand an ongoing call back to the centre, but
cannot restart a stopped or disconnected call. Automatic stale-result handback
waits for output audio and arriving assistant transcripts to settle; explicit
orb selection closes the departing audio immediately while retaining its text.
Voice-enabled reading packets request a validated `voice` presentation object:
an 80-character assignment label and a 360-character final spoken summary with
exact evidence citations. This is transient presentation, never write authority.
Reading steps retain only the label. Rename the existing job without changing
its ID, scope or original prompt. Offer the short final finding automatically
through the centre; opening the finished orb remains optional. Its encoded
commentary budget is 1,600 bytes including qualifications. Legacy/no-summary
answers retain the 480-byte complete-finding rule; never clip a long answer.
Explicit result requests may offer the full bounded
answer; confirmed saves and proposal review keep short actionable acknowledgments;
do not prepend repeated research-status or unsaved-status announcements. Keep
partial coverage explicit where it limits the finding, preserve ending caveats,
and never turn an oversized reply into a misleading prefix. Explicit Keep gets
a brief acknowledgement only from a confirmed save receipt. These channel
choices do not establish that the provider spoke naturally or was heard.
`voiceContextUpdates.ts` sends changed job fields and confirmed receipts only,
with full bounded context reserved for connection/reconnect. It uses validated
`session.usage.updated.context_window.usage_ratio`, retaining the last known
ratio when a later event omits it. At 80% usage it omits optional note excerpts
and progress; at 85% it sends one bounded 6 KB continuity checkpoint, rearmed only
below 75%. This never restarts a call or a job. Detailed evidence stays local.
`voiceDeliveryTiming.ts` uses arriving transcripts as the primary speech signal;
local mic/output energy can extend only a short quiet interval. Unrelated intent
routing never holds a completed result. A finding held for its own correction
stays queued while the oldest eligible unrelated finding can pass it. Recheck
its revision after correction and retain pacing between actual accepted sends.
Findings, job/status changes, navigation context and continuity checkpoints wait
locally while voice is speaking. A selection bound to actual user speech retains
its existing priority-context path. GPT-Live has no turn-done event, so delivery
uses both playback activity and the accumulating assistant transcript: require
a completed sentence needs 2.8 seconds of settled playback/transcript; an unfinished
fragment or ellipsis needs eight seconds of continuous quiet since the latest
playback or assistant transcript. Missing punctuation or a dropped final delta
cannot hold findings/context indefinitely. Active output and fresh transcripts
always reset the guard; a finding's age never overrides them. With no assistant text, the
existing 1.5-second quiet guard remains. An actual human turn can take over an
interrupted fragment; noise cannot. This is a conservative turn-boundary
approximation, not a provider-confirmed semantic end of thought. Input-noise
waits retain a 12-second cap, but it cannot override audible output or arriving
transcripts. Continuous human speech always retains the floor. Interim commentary is limited to one unsolicited short
finding after user speech, at least twelve seconds apart. Each completed worker
answer bypasses that interim allowance, retaining output pacing and exact
revision/sequence deduplication. Assistant transcripts, mic noise, time passing and orb handoffs
cannot renew that budget. Explicit result requests and confirmed actions bypass
the unsolicited limit. This is an offer, not forced playback or proof of hearing. Pending corrections still resolve first
under the bounded routing timeout, and every offered result rechecks its revision.
Transport chunks prefer sentences, then words/graphemes; the conservative 480-byte
fallback remains until a verified GPT-Live tokenizer mapping is available for the
API's 500-token cap. No provider speech-start/stop or audio-done event is assumed. Sent
commentary cannot be retracted or treated as heard. Keep result controls inside
the expandable work summary. End voice immediately releases capture and closes
the connection while already requested work can finish. ChatDock owns the
mounted call outside its hidden Chat panel. Collapsing/clearing Chat and note or
view navigation preserve it. Flow, Space changes and window teardown close
capture and cancel work. An inherited sidebar toggle counter must never start a
new Space's microphone. Mute gates only input; playback and work continue.
Permanent loss of every microphone track disconnects with a capture-loss message,
clears both audio envelopes and preserves admitted work. Require explicit
reconnect; never reacquire capture automatically. Temporary track mute can recover
in place. Unregister ended listeners before intentional stream disposal.
Persist through the serialized window-vault path,
verify saved note IDs, then announce a save. Never equate a context-append ACK with
played speech. Live microphone/provider QA remains a separate verification gate.

`voiceSelection.ts` owns a transient current-Space, per-window selection store.
`useVoiceSelection` captures exact displayed body text after a 180 ms settling
interval, with note/Space identity, authored note version, and UTF-16 DOM text
range (never pretend these are Markdown offsets). Dragging does not stream
updates. Voice controls preserve the capture; deselection within the note,
note navigation, or authored changes clear the current reference. The first
user transcript fragment copies its selection into the immutable voice turn,
so later highlights/navigation cannot redirect an admitted assignment. Provider
context contains only a bounded reference packet; large selections retain their
full local range and use the shared note reader. Changed selected-note versions
withhold all selected text at the context boundary and fail clearly before
starting research. Ranges crossing unaccepted Chat/AI proposal widgets are not
authored-note selections and clear the captured reference. Completed tasks and their descendants
remain masked in selected reference text unless the actual current user request
explicitly asks for history. A highlight produces a local Selected text cue only;
it sends no provider update until a user transcript publishes the reference bound
to that utterance. Replacement and deselection also wait for the next spoken
turn. Starting a call never publishes an unmentioned highlight. The voice uses
selection only when the user refers to it; unrelated speech must not prompt
commentary on the passage. Selection never starts speech, research or editing.
Explicit editing still
uses the ordinary proposal and actual-note Accept/Discard/Undo path.

`taskWorkingView.ts` and MCP `working_view.rs` construct transient working views
before discovery or provider context. Mask completed checkbox text/continuations,
preserve standalone requirements, and remove cached derivatives that could leak
completed work. Do not modify the vault during reads. MCP task listing stays open
by default; `completed`/`all` explicitly request history. Other reads accept scoped
`task_view: working|history`; ordinary reads use working. Desktop context, research
and search share this contract and do not reuse history interpretations in working
mode. Original note/source versions and line/scalar offsets remain write authority;
renderer citations retain exact original UTF-16 passages. A filtered note body is
never a full replacement. Legacy whole-body updates containing completed tasks
require an explicit history read plus its current expected version. Document any
remaining prior-conversation exposure rather than claiming old model context was
erased. See `docs/space-voice-and-working-context.md`.

Chat automatically carries the open note into the composer and retains that
context when expanded. Do not expose an Attached note dropdown or editing-mode
selector. To change the edit target, navigate to the note; the model still cannot
choose a different destination, and each proposal names its captured target.

The empty Chat composer shows an audio-wave voice button in the send position.
Typing replaces it with Send when idle. During a call, the same position shows
a square Stop voice button even if a draft is being typed. Starting voice from
the sidebar leaves the current note open; ordinary Chat navigation still opens
Chat. A bottom-right glass pill exposes mute/end, Chat and a work summary.
When either full or compact Chat is open, the same call renders its orb scene
inside Chat and docks controls above the composer; no fixed pill overlays Chat.
The idle welcome also uses the orb identity. Stable presentation portals keep
the call owner outside the hidden/remounted Chat view and retain its motion model.
Keep transcripts transiently for delegation, without elapsed-time or provider
copy in the composer. Research results, citations, saves and actionable errors
remain in the expanded summary.

`VoiceConstellation` and `voiceOrbMotion.ts` use actual normalized input/output
PCM levels from `LiveVoiceConnection`, gated on track availability and local
playback. No synthetic speech envelope, transcript or append ACK may animate
speaking. The selected recipient (main or one finished worker) owns the audio
gesture. Sidebar/pill/expanded circles share one SpaceVoice-owned physical field
and the adaptive icon palette; advance that field once per animation timestamp.
Keep the approved gravity study's asymmetric orbits, central proportions and
mixed-size ambient field. Worker updates arrive on one shared flight clock and
give the centre a finite receiving gesture; they must never masquerade as speech. See `docs/voice-constellation.md` for bounded motion and controls.
Only completed, current workers with results may open conversations. Switching
explicitly disposes the old audio connection before starting the selected one,
with bounded retained evidence and separate conversation context. Further work
on that worker preserves its identity and hands the call back to the centre.
Update sequences and completion drive distinct visual transitions. Returning a
completed orb to the swarm is visual dismissal, never result deletion; returning
a researching orb cancels only its job. No result opens a panel or captures the
writing cursor automatically.

### Voice follow-up lifecycle and recovery

The work summary's Clear voice chat action requires an inline confirmation and
ends audio before replacing its transient coordinator. Clear routing, retained
voice conversations, results, motion and queued commentary; cancel research and
edit preparation. Do not delete saved notes, typed Chat or already prepared note
review. A save already admitted to the native atomic writer can finish. Fence
old transport and coordinator callbacks; clearing must never start capture.
An undecided ordinary delegation can retain an internal cancellable reservation
but `provisional` jobs must not render as research orbs. Explicit reservations
remain visible. Circular indicators reflect actual routing/research or edit
preparation, independently of speech; reduced motion retains a static ring.

Structured reading permits one format-only retry for CHAT_JSON, CHAT_STRUCTURE,
CHAT_FINAL_MISSING or CHAT_VOICE under its existing deadline and authority. Keep
successful reads and checkpoints; never interpret malformed prose as actions.
The separate knowledge orchestrator reserves each assignment's final permitted
turn for grounded synthesis, forbids further coordination there, and preserves
its hard cap, validators and diagnostics. Automated fixtures do not establish
that the live provider delivered speech or explain an unrecorded failed response.

### Passage-anchored Chat discussions

Typed Chat captures the settled editor selection on Send, including its exact
Space/note/version. `runChatReading` treats it as bounded reference data and reads
that note for evidence; highlight alone grants no edit authority. Expanding Chat
retains the captured note and selection. Replies retain their original passage
anchor; later highlighting cannot retarget an existing reply.

`Note.discussionThreads` is optional, bounded metadata (32 threads, 30 messages
per thread, 12,000 UTF-16 units per text). Older notes require no migration.
Threads never become Markdown, note exports, narration, or model document nodes.
The small passage icon previews on hover/focus with explicit left-aligned text.
Clicking opens a compact floating modal with a frosted WebView surface and
an auto-growing pill composer. Use one translucent, blurred surface with quiet
controls rather than stacking opaque Chat fills. Reduce Transparency, Increase
Contrast and forced colours use solid surfaces. Live text and input stay in the
WebView; never send them to the native toolbar's static bitmap painter.
Comment creation renders a transient marker through the same placement path as the saved
thread. Anchor both modal states to that marker; never use the whole note bounds
as the creation anchor. Keep the panel origin independent of content height,
with bounded scrolling near the viewport edge. Draft markers are not persisted.
Initial comments have no response header; only
actual assistant follow-ups use Chat response styling. A human opening comment
is rendered as plain annotation prose with a subtle **You** label; subsequent user
prompts stay in the bounded persisted context but are not rendered in the comment
conversation. Its portal lives outside the prose; opening it must
not change paragraph geometry. Escape/outside click closes it, keyboard focus is
contained while open and returns to the icon on close. Unsent replies survive
closing; generated note actions close the chat to reveal the ordinary review.
**Continue in Chat** binds the main Chat surface to the exact Space/note/thread
and carries the unsent reply. The note metadata stays the single conversation
source; never clone the exchange into `studio.messages` or introduce a chat-history
list. Replies in either surface commit to the same thread with the same approval,
version and Space guards. **Back to the note** uses exact passage navigation;
**Space chat** restores the ordinary Chat and its draft. Thread reader history is
projected from that thread only, with saved citations restored and unaccepted
messages excluded. Cached history remains withheld when task masking is active.
`PassageThreads` uses ProseMirror decorations while editing and separate DOM portal
hosts while reading. Comment controls preserve the authored selection. Exact
unique quote matching fails closed after ambiguous or missing edits, retaining the
thread for explicit reattachment. Keep text model offsets free of comment widgets.

`useVoiceSelection` paints the captured range with a CSS Custom Highlight (an
inert geometry overlay on older WebKit). It never restores the native selection
or inserts markup into the note when a composer takes focus. A released range
is captured before focus leaves even inside the settling delay; unfinished drags
remain uncommitted. Deselecting inside the prose, changing its authored version,
navigation and unmount remove the highlight along with the captured reference.

**Comment** on a selected passage opens a local draft through the same
`PassageThreadModal` as existing discussions. Reading view exposes a small
selection-adjacent Comment button; editing includes it in the existing selection
menu. `PassageCommentComposer` captures the original Space/note/version and keeps
its unsaved draft on dismissal until another passage or note replaces it. Enter
adds a line; Save comment or Cmd/Ctrl+Enter saves locally. Opening, typing, saving
and reopening never call a provider. The first persisted message has role `user`
in the existing thread schema, with no new attribution field or migration.
`addHumanPassageComment` validates the exact current anchor, bounds and Space;
its stable draft ID prevents duplicates after a failed save. The normal serialized
vault save remains authoritative. The source prose, exports and Space Chat history
stay unchanged. An explicitly submitted follow-up is the request boundary; there
is no separate Ask Orion action pill. Existing action pills may use the human opening annotation as reference;
later hidden user prompts are not standalone actionable comments. Proposal review,
completed-task filtering and article-generation authority remain unchanged.

The Chat reply action **Comment on passage** saves the captured reply as an open
thread. MCP **orion_propose_passage_comment** requires exact Space, note version,
unique visible quote, thread ID and fresh message ID. It atomically writes pending
metadata only, optionally carrying addition/rewrite text. Existing-thread proposals
return to pending review. **orion_get_passage_threads** reads scoped metadata;
working views omit cached discussions when task masking could expose completed
work. These two local tools need no provider or running desktop app. They never
change prose or silently accept a review. Pending comments expose Accept comment
and Discard; acceptance does not accept a document change.

Follow-up discussion reuses the bounded Chat reader, revokes on unmount/cancellation
and changed Space, and validates the captured passage/thread before saving. Add to
Note inserts after the containing block through normal Accept/Discard/Undo review.
Only the comment's prose enters that edit: remove its validated portable citation
footer and temporary citation links, preserving evidence on the thread. Keep
the shared focused-edit limits and provide a shorter-passage/Generate article
recovery message when the authored change itself exceeds them.
Suggest Rewrite uses the same review path. Focused proposals explicitly record
their mode; an omitted legacy mode still means focused, as in the ordinary
editor review. Passage discussions pass an exact `editBoundary` to the reader,
separately from voice's reference-only `editPassage`. Validate that boundary
against current authored text and the requested task view before a provider
call. Every reading packet retains the exact boundary and scope instruction.
Validate proposed ranges inside the existing bounded correction loop, rejecting
full-note rewrites without admitting a broader rewrite target. Only a valid
proposal may enter thread history and the ordinary review; retain the App's
final scope check and all stale-body/Space guards.
**Generate article** is explicit
authority to queue a new article through the existing Generate pipeline, not a
raw reply-copy form. Capture the accepted comment and its exact original passage
as bounded, untrusted reference material; strip the portable citation footer and
internal citation markers before generation. A configured selected provider is
required. The explicit passage remains available when general Space context is
off; other notes still follow that preference and completed-task filtering.
Create the placeholder and comment's saved note receipt together, preserve the
current note/Chat route, and expose Writing/Ready or actionable failure in the
existing sidebar queue. **Open article** recovers that destination. Restart keeps
the same note ID and captured reference; repeat clicks or a save retry cannot
create duplicates. Generation commits only to its captured Space and placeholder,
never over intervening user prose. The new article gets an AI-written title and
body, while the source note and Chat history remain unchanged. No new vault writer,
provider endpoint, or persisted generation schema is introduced.

Human comments support local **Edit comment** with Save/Cancel in the floating
thread, preserving replies, identity and passage context. **Delete comment** removes
only that thread through the ordinary serialized save. Backspace/Delete on a focused
marker removes it; at an adjacent writing cursor the first key selects the marker,
leaving prose untouched. Keyboard events inside the modal edit text normally.
Slash-created comments carry an optional bounded `anchor.cursor` with 256 UTF-16
units of authored text before and after the insertion point. Their icons render at
that cursor (including empty paragraphs), independent of their passage reference.
Renderer and MCP validators accept older anchors without it. Resolve exact unique
neighbours and fail closed on ambiguity; never persist raw ProseMirror positions.
Comments still remain metadata and are excluded from exports and narration.

### Sidebar navigation sizing and Chat mark

Collapsed and responsive icon-only navigation gives `.sidebar-nav-row` an explicit
44 px width. Preserve this wrapper width: the voice stylesheet sets its child to
100%, and an intrinsic wrapper shrinks the selected background to the icon.
`ChatVoiceMark.tsx` uses the user-supplied Group 3-4 SVG with currentColor for the idle
Chat icon, including SidebarVoiceIndicator. The combined mark is the single Chat entry; do not add a separate sidebar voice
button. Start voice through the existing Chat composer. Chat uses the same row
width as the other navigation entries; active calls still show the constellation.

### Markdown import subtitles

Plain Markdown imports leave the note summary empty. Preserve frontmatter and
body text in the source and note; do not turn their first characters into a
subtitle. `importSummary.ts` hides legacy mechanical Markdown excerpts only
when they exactly match their linked original source. Authored summaries and
explicit AI-organized summaries remain supported; no vault migration is needed.
