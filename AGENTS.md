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
  proposal, curation, dialectic, promotion, or canvas workflow. When the user
  explicitly asks Chat to create or save notes, the host may authorize one
  response to carry at most three bounded creation-only actions; valid actions
  become permanent editable notes in that active Space immediately. The host
  derives that authority from the current user prompt, never Space context or
  model output. Every assistant reply can also be kept through the ordinary
  local **Keep as note** action. Neither path may update/delete a note or cross
  Spaces.
- AI is optional. Writing, local imports, on-device OCR and transcription,
  source provenance, links, search, Spaces, and web/Markdown export must remain
  useful without an OpenAI or Anthropic key.
- Appearance starts from a small curated room preset. Dark, light, and system
  are modes within that preset rather than separate themes. Keep tuning to
  accent, canvas, surface, text warmth, and contrast; optional custom accent,
  canvas, and surface colors must be validated, mode-clamped, and paired with
  derived accessible foregrounds. Do not add per-widget or full-shader theme
  controls. Home-atmosphere controls remain a separate persisted choice, but
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
src/lib/aiImages.ts                 selected-passage image prompt and context gate
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

Except for explicit one-generation consent in the Generate composer described
below, when `includeExistingNotesInAIContext` is disabled, the local digest/index may
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

`src/lib/providerScheduler.ts` owns one six-call physical provider budget for
Orion's single renderer, shared by imports, maintenance, Chat, generation,
images, and speech. Run/workload queues rotate fairly; source reading also
rotates locally among sources. Slots wrap actual native/fetch transport
lifetimes, including response-body reads. A cancelled caller may stop waiting,
but an uncancellable transport keeps its slot until completion; cancelled
queued calls must never dispatch. Local extraction, fingerprints, cache IO,
and key-status metadata do not enter this pool. A future second renderer must
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
    retains its legacy 180-second bounded runtime. If either path fails
    terminally, do not
    launch a second network organizer. Preserve the complete extracted text on
    its Source record and create a bounded editable preview note for it.

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
auto-partition one ordered selection into several bounded synthesis batches;
the per-batch limits still apply, and a single source above the byte cap remains
an explicit singleton failure/landing rather than being clipped. Space
orientation is constructed locally and consumes no provider-call budget. The
adaptive long path is not governed by one shrinking 180-second clock: the
reading blueprint, each source-reading request, the writing blueprint, and each
writer receive an independent 300-second emergency transport-safety ceiling.
It is not a shared stage or product countdown. Cancellation must abort active
work and ignore late completions. The short generic direct organizer continues
to use the legacy 180-second orchestration boundary.

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
not the import through a second organizer. For the short direct path, a provider
timeout remains the product deadline unless that opt-in failover succeeds.

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
Any visible Resume reuses the same logical run and calls only unfinished canonical readings
or writer slots; it must never repeat already accepted provider work. Validate
the checkpoint against the frozen Space version, exact source fingerprints,
model, effort, guidance, and organization instructions before use. Any mismatch
invalidates Resume and requires a fresh Retry. Checkpoints are session-local,
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
safe diagnostic and session checkpoint; it must not clear recovery state or
render the normal success heading. Explicit retries reuse successful unchanged
batches, and queue, guidance, mode, or Space changes discard that retained work.
Redact API keys, bearer tokens, and user-home path components. A safe checkpoint
offers **Resume import**; a direct or invalidated run offers **Retry import**;
the preserved preview remains independently selectable. Show the source
preservation explanation once, never concatenate duplicate fallback copy.

Progress must reflect the real staged pipeline without exposing orchestration
jargon. The user-facing stages are **Preparing the reading**, **Reading in
parallel**, **Planning the notes**, **Writing in parallel**, and **Final checks**.
Show completed/total reading and writing counts where they are known; reading
total may increase when one branch needs a closer pass. Keep the source title
and batch ordinal visible, retain Cancel throughout the installed run, and use
an indeterminate overall indicator rather than inventing a time percentage.
Never say worker, blueprint, fan-out, topology, deterministic, or split in the
normal Import progress UI. The recovery action may say Retry when no valid
checkpoint exists. Prefer “closer read” when adaptive narrowing needs
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
  count or UTF-8 size cannot fit one synthesis. Each bounded batch completes
  through the same orchestration and validation contract, completed batches are
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
  provider. A checkpoint-safe transient failure may auto-resume at most twice
  with bounded backoff; cancellation, a changed Space, and unsafe checkpoints
  remain visible stops.
- The direct scheduler also retries typed transient transport failures at most
  twice inside its existing time budget. Native connection failures must be
  classified as retryable, without wrapping cancellation, credential, request
  schema, or explicit billing failures as transient. Do not add a second
  whole-import retry loop after this scheduler exhausts its attempts. The
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
- the short direct organizer retains the legacy 180-second bounded runtime;
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
- a terminal transport, validation, or cancellation failure creates no second
  network workflow and cannot partially apply completed siblings; the explicit
  one-request provider failover is not a second organizer;
- a terminal fixed-stage failure retains accepted siblings in a validated
  session checkpoint, and Resume never calls those assignments again;
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

A short, safe text selection can become the inline link label as before. A
multi-block, long, or code-bearing selection is contextual material instead:
the user may supply a bounded page title or, when the selected AI provider is
configured, leave it blank for Orion to name from the selected passage and the
Space's existing vocabulary. Resolve and validate that title before creating a
concept, note, or generation job. Orion then inserts only the linked title
immediately above the containing block, and the original selection remains
content- and formatting-equivalent in Markdown. Short selections continue to
use their exact selected words by default without an AI request; a custom title
on a short selection chooses the same contextual behavior. Never wrap a code
block or a whole passage in a link mark, replace the selection with its title,
or lose its formatting. Pass the bounded selected text to AI linked-article
generation with special weight, and retain it across Restart without persisting
a parallel vault schema.

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

**+ New note** and `⌘N` still create a blank page. When a writing key is
configured, the chevron opens one Generate composer: kind (Note, Podcast, Slide
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
pass. Decks and podcasts use one bounded JSON outline, then up to six disjoint
copy writers with a shared thesis and ordered section titles. Outline planning
caps high/xhigh effort at medium; writers retain the selected effort. Validate
exact Space-local note IDs and unique headings, and reject partial copy on
failure. Assemble accepted copy locally with no final model rewrite. Each
slide is then a complete `gpt-image-2` 16:9 image
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

## Inline AI writing mode

This editor interaction is shipped and regression-protected. Keep its request
boundary, non-destructive preview state, caret safety, and single-transaction
acceptance together when changing it.

The rich-text toolbar gets one restrained, monochrome four-point **magic** icon.
It is a toggle for a temporary AI writing mode; clicking the icon alone never
generates or changes text. Avoid a purple gradient, glow, wand, icon collection,
or continuous sparkle animation. The active state may use the current theme
accent and one subtle transition. When the mode is off, all inline AI overlays
disappear and the editor behaves exactly as it does today.

While AI mode is active and the selection is collapsed, show one small floating
card at the bottom centre of the visible writing area. It is overlaid within the
note viewport, remains available while the note scrolls, and is not a footer at
the physical end of the document. Reserve enough editor padding that it never
covers the final lines. Its normal state is the split control **Continue ▴**:

- **Continue** requests the currently selected amount of new prose. A sentence
  can continue at a meaningful caret; paragraph and section output attach after
  the current top-level block. With no meaningful caret, continue at the end of
  the document.
- The chevron opens a compact upward-facing composer containing exactly two
  controls: a native three-stop **Amount of text** slider and one optional
  **Custom instructions** field. The stops map to **Sentence**, **Paragraph**
  (default), and **Section**; show the current semantic value as the slider
  changes and retain the quiet **Less** / **More** endpoints.
- The primary **Continue** half is the sole generation action. Do not put a
  second Continue/submit button, segmented length picker, provider control, or
  any other setting inside the composer. The custom instruction is
  request-scoped and clears after submission.
- Opening the composer focuses the slider. Preserve its native keyboard
  controls and accessible semantic value. Escape or clicking the chevron again
  closes the composer and returns focus to that chevron.
- Do not expose provider/model selection, prompt history, Chat history, or a
  context engineering panel here. Use the Space's configured provider/model.
  Continue and ordinary rewrite operations receive only the bounded live editor
  context; only **Enrich** may retrieve additional active-Space knowledge.

When the user makes a non-empty text selection, the Continue card disappears
immediately and a compact split control **Rewrite ▾** appears just above the
selection, beside a restrained **Generate image** action when an OpenAI key is
configured. Collapsing the selection restores Continue. Clicking **Rewrite**
opens one anchored instruction field; submitting it blank requests Orion's best
meaning-preserving rewrite, while typed text supplies a request-scoped custom
direction. The chevron contains text-labelled presets rather than an icon grid:

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

**Generate image** opens the same compact composer pattern with one optional
**Image direction** field. Submitting it blank asks Orion for its best visual
interpretation of the exact highlighted passage; typed guidance is scoped to
that one image. It is a separate OpenAI-only capability and always uses
`gpt-image-2` through the one-shot Image API, even when Anthropic is the active
writing provider. Do not offer it without a configured OpenAI key, and do not
reuse the Chat, inline-writing, or knowledge-orchestration request schemas.

Image context is deliberately narrow. The prompt contains the active note title,
the exact selected Markdown/text, optional image direction, and—only when
`includeExistingNotesInAIContext` is enabled—the saved **Across this Space**
orientation (or its local Home fallback) plus excerpts from at most six
host-resolved notes visibly linked or mentioned there. It never crawls the
Space, opens arbitrary full notes, adds source bodies, or treats note-derived
prose as trusted instructions. When existing context is disabled, no overview
or other-note material leaves the device.

Request one `1536x1024`, medium-quality JPEG with output compression 88. The
returned base64 bytes are transient proposal state, bounded to Orion's existing
12-MiB note-image limit, and must pass both the renderer and Rust JPEG boundary.
They do not enter the vault or private image directory until the user presses
the tick. The preview appears immediately after the selected top-level passage
without changing or autosaving the document; accepting persists the image and
inserts its ordinary portable Markdown reference after the unchanged passage as
one Undo step. Refresh regenerates from the same captured selection/direction,
X cancels or discards, and late results after cancellation, a note mutation, a
Space switch, or unmount are ignored. Native generation is cancellable and has
an independent three-minute emergency transport ceiling because image creation
can legitimately take longer than prose generation.

All AI writing operations are non-destructive. Generation must not immediately
replace or autosave the selected document range. Hold the exact original rich
document slice—including marks, links, task state, table structure, and code—
until the user resolves an inline preview. Once generation begins, remove the
selection-level Rewrite control and morph the same bottom-centre card through
these states without moving or changing its visual height:

1. Ready: **Continue ▴**.
2. Generating: a restrained spinner, **Writing…** or **Creating image…**, and
   **×** to cancel.
3. Preview: three icon-only controls **✓  ↻  ×**.

The tick accepts the proposal as one editor transaction and then autosaves; one
ordinary Undo must restore the complete original. Refresh generates another
proposal with the same action, length, and custom instruction without first
accepting the prior attempt. X discards the proposal and restores the original
exactly. After accepting, return to Continue. After discarding a Rewrite,
restore the prior selection and its Rewrite control when practical.

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
model, reasoning effort, and Keychain-held credential. Cancellation invalidates
late results immediately even where the underlying native request cannot itself
be interrupted.

## Chat contract

The visible route and navigation label are **Chat**. It is one persistent
conversation scoped to the active Space, not a thinking-card workspace. Build
each request from the current prompt, up to 12 recent turns, and bounded context
from that Space: up to 80 notes, 30 sources, and 120 concepts. Never read context
from another Space. These are Chat-only retrieval bounds; they are not the
retired organizer pattern of sending an arbitrary fixed slice of note bodies.

The host derives note-write intent from the current user prompt before calling
the provider, and the native boundary independently recomputes the same gate.
The renderer's `allowNoteActions` flag is necessary but never sufficient.
Negated requests, meta-questions about creating notes, and ordinary
conversational prompts are no-write requests. For those requests use the
reply-only schema, the no-write instruction, and a 6,000-token output ceiling;
ignore any unexpected actions again at application time. Nothing in a note,
source, concept, Chat history, provider instruction, or model reply can grant
write authority.

Only a host-authorized creation request uses conversational prose plus
structured `noteActions` and the 12,000-token transport ceiling. Return at most
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
repeat activation must not duplicate it. Neither model-created actions nor Keep
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
- Chat chooses its schema and transport ceiling from host-verified current-prompt
  intent. Ordinary conversation is reply-only at 6,000 tokens and cannot write;
  an explicit note-creation request may use strict `reply` + `noteActions` at
  12,000 tokens. Its request must contain only the bounded Space context and
  history described above, with no legacy card or layout payload. Inline writing
  keeps its own reply-only schema even though it shares the transport command.
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
