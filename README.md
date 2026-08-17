<p align="center">
  <img src="public/orion-mark.svg" width="72" height="72" alt="Orion">
</p>

<h1 align="center">Orion</h1>

<p align="center">
  A local-first, AI-assisted knowledge atlas for turning source material into a connected personal wiki.
</p>

Orion is a Tauri desktop app for importing files or pasted material, organizing it into focused project notes and canonical wiki articles, and exploring the concepts that connect them. Write directly on the finished note—there is no read/write split and no Markdown knowledge required. Each recognized term belongs to the active Space and normally opens its one named wiki article directly. The right-hand connections canvas is reserved for unresolved, multi-target terms carried forward from the legacy link model; links do not open reference-hover cards.

AI is optional. Manual notes, local imports, linking, search, contextual navigation, and portable web or Markdown export work without an API key.

Each project can live in its own **Space**. Use the switcher at the top-left to create a completely blank Space or move between existing ones. Notes, imports, sources, concepts, relationships, link suggestions, navigation history, and the active note are isolated per Space, so matching vocabulary in two projects cannot accidentally cross-link. Existing single-project vaults migrate into the first Space automatically.

Every Space also has **Chat**, one persistent AI conversation grounded in bounded context from that Space and its recent message history. Switching Spaces switches both the conversation and the material available to it. Chat is a single conversation surface; it has no card, dialectic, or canvas workflow. When the current user prompt explicitly asks to create or save notes, Orion's host can authorize up to three validated creation actions as permanent editable notes in that Space; Space content and model output cannot authorize a write. Any ordinary reply can still be saved with **Keep as note**.

## Download

[Download Orion for Apple Silicon](https://github.com/zug11/orion/releases/latest/download/Orion-0.4.1-Apple-Silicon.dmg). Orion requires macOS 13.3 or later. Release builds produced from this source include on-device Apple Vision text recognition, the offline Whisper model, `yt-dlp`, and Deno.

## What is included

- A polished React/Tauri desktop workspace with home, notes, sources, Space-scoped Chat, settings, and contextual backlink views.
- A top-left Space switcher for separate projects, with blank-space creation and strict concept/link isolation.
- AI-assisted Import using the selected OpenAI or Anthropic model with strict
  structured output. Short material can take a bounded direct one-call path;
  longer batches use a Space-guided reading plan, an adaptive parallel reading
  queue, a connected-note plan, parallel writing, and local final checks, with
  up to six provider calls running at once.
- A persistent per-Space AI conversation with bounded recent history and note,
  source, and concept context. Host-verified explicit note requests can create
  up to three ordinary active-Space notes immediately; normal conversation is
  reply-only, and **Keep as note** saves any other assistant reply without
  introducing proposals or review state.
- Manual import fallback that creates one immediately editable note per source.
- Local extraction for text, Markdown, JSON, CSV/TSV, HTML, PDF, and DOCX,
  plus on-device Apple Vision text recognition for PNG, JPEG, HEIC, and HEIF
  images and scanned PDFs.
- Fully offline media transcription for MP3, MP4, M4A, WAV, WebM, OGG, FLAC,
  and MPEG media using the bundled Whisper base multilingual model and
  Metal-accelerated `whisper.cpp`.
- A self-contained YouTube → bundled `yt-dlp` + Deno → bundled Whisper workflow
  whose temporary download is deleted after transcription, including on errors.
- A direct rich-text writing surface with an animated, lightweight toolbar for
  headings, bold, italic, strikethrough, inline and fenced code, lists, to-dos,
  quotes, dividers, editable Markdown-compatible tables, reusable concept links,
  unlinking, and citations to preserved Space sources. Table cells stay directly
  editable, with contextual row, column, header, and delete controls; Undo and
  Redo stay pinned inside the toolbar while its formatting region adapts. Source
  citations appear as compact first-occurrence numbers in the prose and generate
  a deduplicated References list at the end of the note. Both remain portable
  Markdown links and open the full preserved source. Creating a new named concept link offers either a blank page or
  an AI-written definitional article, with an optional page-specific instruction.
  Unlink keeps the words and destination article while disabling that phrase’s
  automatic links until it is taught again. Every note can also be deleted from
  its header with relationship, concept, provenance, and dead-link cleanup.
  Finishing a substantive note cross-pollinates every meaningfully affected wiki
  article in that Space as integrated prose.
- Local note images from the toolbar, clipboard, or drag and drop. PNG, JPEG,
  GIF, and WebP pixels stay in Orion's private data folder while the note keeps
  a small portable Markdown reference and useful filename-derived alt text.
  Offline web export embeds the images; Markdown export copies them into an
  adjacent `orion-images` folder and uses relative links.
- An opt-in inline AI writing mode in the editor: Continue at the caret, or
  select anything from a phrase to a complete note and choose Rewrite, Clarify,
  Tighten, Simplify, Expand, or Enrich. Enrich retrieves relevant knowledge only
  from the active Space. Every result appears as a non-destructive proposal with
  Accept, Try again, and Discard controls; accepting is one ordinary Undo step.
  With an OpenAI key, the same selection overlay can also generate an editorial
  image with `gpt-image-2`, using optional visual direction and bounded
  **Across this Space** context. The image remains a disposable preview until
  accepted, then becomes the same private, portable note-image attachment used
  by pasted and dropped images without replacing the highlighted prose.
- Automatic concept recognition from canonical article titles, deliberate aliases, semantically inferred AI vocabulary, and phrases explicitly taught through the Link tool. Tags remain organizational metadata rather than link vocabulary.
- A scrollable Space to-do card on Home, derived from standard Markdown task lists in every note. Each open task retains its source note and best matching canonical concept and can be completed from Home or directly from the note’s reading surface without entering edit mode.
- A living Space overview beside Tasks, with an editorial title and scrollable
  orientation that refreshes as imports, completed edits, generated articles,
  deletions, or MCP writes change the Space. Orion keeps the previous overview
  readable during refresh and supplies a local keyless orientation when AI is
  unavailable.
- A persistent semantic hierarchy behind that overview: deterministic
  whole-body note digests feed stable 24–32-note clusters, recursively merged
  blueprints, and one root Space blueprint. Ordinary changes update affected
  clusters sequentially instead of asking a provider to reread every note.
- Direct navigation to canonical Space articles, with the right-hand connections canvas retained only to disambiguate unresolved legacy terms.
- Search and command palette across notes, concepts, sources, and actions.
- Favorites above a complete per-Space sidebar note list, both ordered by when
  each note was last opened, with never-opened notes at the bottom and deletion
  available from both the sidebar and Notes index.
- Clickable Sources that open the preserved extracted text or transcript,
  provenance metadata, original URL when available, and the notes shaped by the
  material. A source can be permanently deleted from either the Sources index
  or its viewer without deleting the notes it shaped; Orion removes the stale
  provenance attachments after confirmation.
- A bundled, local Claude Desktop connector that can search, cite, create,
  fully edit, and delete notes in an explicitly selected Space without making a
  sync copy or using an API key.
- A bundled, zero-configuration Codex plugin with an Orion skill and the same
  local, read-write Space tools. Orion opens it for installation in Codex
  without asking the user to find `vault.json`, edit JSON, or understand MCP.
- Automatic local persistence, OS-keychain API-key storage, and native export
  to either a self-contained interactive HTML article or portable Markdown
  files. Export scope can be the open note, that note plus one deliberate hop
  through its visible links, or the entire active Space.
- Three persisted, reduced-motion-safe home atmospheres: Line Waves,
  pointer-reactive Signal Decay, and responsive Field. A compact tuner offers
  a theme-derived accent, three deliberate alternatives, and Still, Calm, and
  Alive motion characters. The canvas room and readable strokes inherit the
  complete active appearance palette, including a live System-mode change.
- Four curated reading-room presets with dark, light, and system modes, plus
  restrained accent, canvas, surface, warmth, and contrast tuning. Optional
  custom colors are clamped to the active mode and Orion derives accessible
  foregrounds automatically.

## Codex plugin

Open **Settings → Connections → Install in Codex**. Orion validates its
bundled local marketplace and opens Orion's plugin page in the Codex app; choose
**Install** there to confirm the per-user installation. The plugin includes the
Orion skill and a self-contained Apple Silicon `orion-mcp` server. It resolves
Orion's standard macOS library automatically, so there is no vault-path field,
API key, background service, JSON editing, or manual MCP configuration. Open
Orion once before first use so its local library exists.
The install action is available only in the installed Orion desktop app, not
the browser development preview.

In Codex, ask to use Orion—for example, “find my notes about Comte”, “summarize
this Space with citations”, or “write this as a note in my Research Space”. The
plugin teaches Codex to discover the Space first, inspect the relevant notes or
sources rather than treating the living overview as complete evidence, and use
Orion citations when referring to a note. It exposes the same nine tools listed
under the Claude connector below, including full create, update, and delete
operations. Writes are direct ordinary Orion notes, not proposals or
“AI-authored” records, and persist through the same lock-safe `vault.json` path.
Orion can remain open; it reloads a newer external write when it returns to the
foreground.

Read operations default only to Orion's active Space when no `space_id` is
given. Every write requires the exact Space ID, and neither reads nor writes can
implicitly cross Spaces. The plugin rereads the vault on every call, makes no
network request, and cannot read either provider key. Text that the user asks
Codex to retrieve is then handled under their Codex product and account
settings, just as text returned by any local MCP tool would be.

Clicking **Install in Codex** again opens the same bundled marketplace
page for update or reinstallation; Codex remains in control of whether the
plugin is installed. The distributable source lives in `codex/orion`; build and
release tooling stages a self-contained copy under
`src-tauri/resources/Orion-Codex-Plugin` for the app bundle.
The plugin build also produces
`outputs/Orion-Codex-Plugin-<version>-Apple-Silicon.zip`, with one top-level
`Orion-Codex-Plugin/` marketplace root for inspection or separate distribution.

## Claude connector

Open **Settings → Connections → Install in Claude**. Orion opens its bundled
`Orion-Claude-Connector.mcpb`; Claude Desktop then presents the local extension
installation prompt. No vault path is requested: the connector automatically
opens Orion's per-user macOS library. Open Orion once before first use so the
library exists. Advanced manual launches can still override the location with
`ORION_VAULT_PATH` or `orion-mcp --vault /path/to/vault.json`.

The connector supplies nine Space-scoped MCP tools:

- list Spaces and their content counts;
- browse the active Space by default, or one explicitly chosen Space;
- search notes and concepts, defaulting to Orion's active Space;
- read one note with its concepts, provenance, connected notes, and explicit
  bounded `linksTo` / `linkedFrom` navigation;
- read a bounded passage from one source;
- read the bounded living Space overview with related note citations;
- create a complete ordinary note;
- edit any supplied fields on an existing note;
- delete a note and clean its references.

The connector is a self-contained Apple Silicon executable. It runs as a local
Claude Desktop child process, rereads the real vault on every tool call, and
makes no network requests. Read results include clickable `orion://` citations
that open the exact note in its original Space. Creates, edits, and deletions
are saved immediately as ordinary notes without agent attribution. Search never
spans every Space implicitly. Read tools default only to the active Space;
writes require an exact Space ID. The overview is for orientation, so Claude
still opens underlying notes or sources when evidence, citations, detailed
facts, recent changes, or comprehensive coverage matter. Content writes mark an
existing overview stale for Orion to refresh without giving the connector
network or provider-key access.

Note detail and successful create/update results expose `linksTo` and
`linkedFrom`. Orion derives these directed, Space-local relationships from its
explicit links, concept associations, and persisted relationship records. Each
direction returns at most 50 citable note identities with an explicit
truncation flag; it never embeds the connected notes' bodies. Browse and search
remain compact discovery operations.

## Architecture and trust boundary

```text
files / images / pasted text / recordings / webpages / YouTube
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
  • reads the selected provider key from the OS credential store
  • calls OpenAI or Anthropic over HTTPS
  • recognizes image and scanned-PDF text on-device with Apple Vision
  • decodes media with AVFoundation and transcribes it with bundled Whisper
  • safely fetches one bounded public HTTPS webpage at a time
  • downloads one YouTube source into a self-deleting temporary folder
  • atomically saves one offline web article or a folder of Markdown notes

Claude Desktop extension (separate local process)
  • rereads vault.json for each MCP tool call
  • exposes bounded active-Space reads plus direct editing in one explicit Space
  • surfaces the living overview and related Orion note citations
  • shares Orion's cross-process vault lock and atomic replacement protocol
  • returns deep links to exact Orion notes and makes no network request

Codex plugin (separate local process)
  • opens its bundled marketplace in Codex with no vault-path or MCP configuration
  • combines an Orion usage skill with the same bounded read-write MCP server
  • requires an exact Space for writes and never reads provider credentials
  • returns deep links to exact Orion notes and makes no network request
```

The desktop renderer never receives either saved API key. It persists only the
non-secret configured/not-configured settings and does not read Keychain while
Orion launches; the Rust host accesses the credential only for explicit key or
AI actions. This avoids a password prompt merely to open Orion. The Rust host
adds the appropriate authorization header only when making the selected
provider request. The desktop
content-security policy blocks arbitrary renderer network access.

Document and pasted-text parsing happens locally in the renderer. Images and
Textless or materially damaged PDF pages use a bundled native helper linked to
macOS's system-supplied Vision framework; healthy selectable-text pages remain on
the faster pdf.js path. Ordinary webpages are fetched by a bounded native HTTPS
command and their returned HTML or text is parsed through the same local
extraction path. In AI mode, Orion sends the selected source text plus the
enabled, overview-routed existing-note context to the selected provider. It
never performs a provider-powered whole-Space context crawl. In manual mode,
it makes no AI request. See
[Privacy and data behavior](#privacy-and-data-behavior) for the precise payload
and browser-preview caveat.

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

- An OpenAI or Anthropic API key with access to the selected model is optional
  and required only for AI organization and Chat.

No OCR or Whisper server, downloaded OCR model, Python environment, Homebrew
package, `yt-dlp`, Deno, ffmpeg, or transcription API key is required at
runtime. Orion ships its Vision-backed OCR helper, offline Whisper model, and
all YouTube executables inside the macOS application bundle. Vision itself is a
system framework supplied by macOS rather than an embedded or downloaded model.
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

This browser-preview path stores the vault in browser `localStorage`, keeps
provider keys in memory only for the current tab, and calls the selected
provider from the browser. It is a development convenience, not Orion's desktop
security model.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked JavaScript dependencies. |
| `npm run dev` | Start the browser-only Vite preview on port `1420`. |
| `npm run build` | Type-check and build the renderer into `dist/`. |
| `npm run build:mcp` | Build, sign, package, and protocol-test the local Claude connector. |
| `npm run build:codex` | Build and contract-test the staged Codex plugin; pass `-- --use-existing` immediately after `build:mcp` to reuse its MCP binary. |
| `npm run build:desktop` | Build native helpers, renderer, Claude connector, and Codex plugin in release dependency order. |
| `npm run preview` | Serve the built renderer locally. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run check` | Run renderer tests, type-check, and production build. |
| `./script/build_ocr_sidecar.sh` | Build and smoke-test the Apple Silicon `orion-ocr` Vision helper. |
| `npm run tauri dev` | Run the complete desktop app in development. |
| `npm run tauri build` | Build native bundles for the current platform. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust host tests. |
| `cargo test --manifest-path src-tauri/mcp-server/Cargo.toml` | Run the local Claude connector tests. |

Native bundles are written below `src-tauri/target/release/bundle/`. Local macOS builds are ad-hoc signed; public distribution still requires a Developer ID identity and notarization.

From the repository root, `./script/package_release.sh <release-label>` builds
and stages a DMG through a new file before publishing it in `outputs/`. The
release script also signs every bundled executable—including `orion-ocr`—in
dependency order with an installed Developer ID Application identity and secure
timestamp, re-seals the app, regenerates and signs the image around that
payload, and runs strict signature and disk-image verification. All executable
code retains Hardened Runtime; `yt-dlp` alone receives the narrow
library-validation exception needed
by its extracted PyInstaller runtime. Set `ORION_CODESIGN_IDENTITY` if more than
one Developer ID identity is installed. Set `ORION_NOTARY_PROFILE` to a stored
`notarytool` Keychain profile to submit, staple, and Gatekeeper-check the image.
The release path builds the renderer and Claude connector once, then stages the
Codex plugin with `--use-existing` so the shared Rust MCP server is not compiled
again, before invoking Tauri with its nested pre-build hook disabled. The assets
fingerprinted by the script are therefore the same assets Tauri embeds.
Every fresh release app is stamped with separate fingerprints for its source
tree and production renderer. The release root is also required to be the
canonical parent of Tauri's `frontendDist`; symlinked native trees that would
silently embed another checkout's stale `dist/` are rejected. A later
`--use-existing` pass is accepted only when both fingerprints still match, so
an older app bundle or renderer cannot be republished after source fixes.
The release check also validates the exact Claude connector and Codex plugin
from the finished app and again from an app copied out of the final DMG. It
verifies both nested MCP signatures and versions, checks the Codex marketplace,
plugin, skill, and MCP contracts, and exercises lifecycle, citation, Space
isolation, and persisted-write behavior. A `--use-existing` release rebuilds
and replaces both bundled connector resources before resealing the app, so an
old plugin tree cannot be carried into a new DMG.
Do not copy directly over an installer that may still be mounted: mutating a
mounted DMG's backing file can cause Finder error `-36` and leave a partial app
in Applications.

## Import behavior

Import accepts up to 12 sources per batch, with a 25 MiB limit per document or
image.
One calm intake card opens either the document picker or privacy-preserving
native media picker; a focused Paste text sheet provides an optional title and
large body field. The URL field accepts either a YouTube video or an ordinary
public HTTPS webpage. Every input joins the same removable queue immediately,
so more material can be added while earlier fetches or transcriptions run.
Closing and reopening Import preserves that queue and its progress in the active
Space. Review and AI organization are enabled only after preprocessing has
produced parsed text. If the selected material cannot fit one bounded AI
synthesis, Orion partitions it locally into deterministic source-order batches,
runs each through the same validated pipeline, and combines the results. It
does not trim a source out of the queue merely to satisfy a batch limit.

| Input | Behavior |
| --- | --- |
| `.txt` | Imported as plain text. |
| `.md`, `.markdown` | Preserves Markdown and uses the first level-one heading as the title when present. |
| `.json` | Validates and pretty-prints JSON; `title`, `name`, or `subject` can supply the source title. |
| `.csv`, `.tsv` | Detects comma, tab, or semicolon delimiters and converts quoted rows to a Markdown table. |
| `.html`, `.htm` | Extracts readable headings and text while removing scripts, styles, and other non-content elements. |
| `.pdf` | Extracts selectable text page by page with pdf.js, sends only textless or materially damaged physical pages through on-device Apple Vision, conservatively merges improved text, then removes repeated running heads/page numerals and line-break hyphenation while retaining every exact page marker. |
| `.docx` | Extracts document text with Mammoth; layout, comments, and embedded media are not retained. |
| `.png`, `.jpg`, `.jpeg`, `.heic`, `.heif` | Recognizes text on-device with Apple Vision for screenshots, scans, and whiteboard photographs. |
| `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac` | Decodes locally with AVFoundation and transcribes with Orion's bundled model. |
| `.mp4`, `.webm`, `.mpeg`, `.mpga` | Extracts the audio track on-device and transcribes it with bundled Whisper. |
| Public HTTPS webpage | Fetches one HTML, XHTML, or plain-text page through the bounded native reader, then extracts readable text locally. |
| YouTube URL | Uses bundled `yt-dlp` and Deno to download one best-audio source, transcribes it offline, and deletes the temporary media. |

Media can be up to 2 GiB. The native picker accepts up to eight media files at
once. Transcripts enter the same Review → Organize → Results flow as documents,
so manual mode keeps one verbatim note while AI mode can split a recording
into focused notes and generate reusable concepts and links.

The full extracted source text is always retained locally in its source record.
A genuinely short batch can still finish through the legacy direct organizer,
which retains its three-minute product boundary. Longer material follows an
adaptive two-plan pipeline: Orion first takes a local orientation from the
current root Space blueprint (or the bounded **Across this Space** fallback),
plans what each part of the source needs to answer, reads those parts through a
dynamic parallel queue, contracts and routes only the existing-note candidates
made relevant by those readings, plans which connected notes actually belong,
writes the planned notes in parallel, and finishes with local source/link
checks. The long path has no
shared 120- or 180-second cutoff. Each provider request instead has its own
300-second emergency transport-safety ceiling, and the user can cancel the run
throughout. This per-request ceiling is a stalled-transport safeguard, not a
shared stage or product countdown.
The orientation and last assembly step make no AI request; the assembler does
not rewrite completed prose.

A source with four or more stable pages uses page-aware ranges through the
adaptive parallel reading path; unpaged text keeps the direct path until it
exceeds the long-text threshold. If one source makes a batch long, shorter
sources in that same batch still receive one complete reading so they cannot
disappear from the shared plan. Initial ranges are derived from source density
using soft targets of roughly 72 KiB and 12,000 estimated tokens, under hard
per-packet ceilings of 100,000 UTF-8 bytes and roughly 25,000 tokens. A
Hegel-sized, page-aware book is therefore expected to begin with about nine
logical ranges. Logical range count is independent of physical concurrency:
the initial canonical plan can contain up to twelve ranges, but twelve is not
the final logical reading cap. A dense, incomplete, or range-local failed
branch can be divided into narrower exact child ranges while successful
siblings remain accepted. At most six provider calls run concurrently, so
wider logical plans flow through more than one physical wave.

Orion reassembles every successful child branch locally into one canonical
evidence reading for its original source range. Claim identities are kept
distinct, child support is mapped back to the canonical range, and the writing
plan starts only after exact full coverage has been re-established. A branch
that is already too small to divide receives one compact repair reading.
Provider timeouts and provider-wide authentication, availability, or schema
failures are not multiplied into recursive child work. With provider failover
off they are terminal for that run; with failover explicitly enabled, an
eligible timeout, availability/network, or rate-limit failure may retry that
one assignment once through the other configured provider. If any branch
remains invalid, Orion applies no partial synthesis and preserves the complete
source. Orion automatically partitions a multi-source selection around the
1,800,000-byte synthesis boundary; one source that individually exceeds it is
preserved and lands visibly for a smaller follow-up import rather than being
silently clipped.

The first plan is deliberately Space-aware: it uses the existing project to ask
better questions of the source. Readers still keep the boundary visible. Claims
about the source carry exact range support; interpretations made through the
Space carry their own claim and note references. Each reading separately judges
source importance, Space relevance, and novelty, so unfamiliar useful evidence
is not discarded merely because it does not match existing notes. The second
plan may omit low-value repetition or tangential detail instead of mechanically
forcing every passage into the notes, while the complete source remains locally
available.

For existing Space knowledge, Orion first uses its persisted root blueprint
and a bounded set of relevance-ranked cluster blueprints. Those are derived
from deterministic compact note digests and maintained outside the Import run,
so Import performs no provider-powered whole-Space prepass. If the hierarchy is
missing or stale, Orion falls back to the saved **Across this Space** title and
summary plus bounded excerpts from at most eight valid same-Space notes listed
or visibly linked by it. A missing overview uses the same keyless Home-card
fallback; a saved overview without valid links remains summary-only. Deleted,
invalid, duplicate, and cross-Space references are ignored.

After source reading, Orion uses the grounded readings to contract one small
hybrid candidate directory. A typed router classifies every exact candidate
note/version before the writing plan, and only authorized relevant or uncertain
notes may be opened exactly. Root/cluster blueprints, overview text, and linked
excerpts are untrusted context for asking better questions, never evidence for
a claim about the imported source. Turning off existing-note context sends no
overview, hierarchy, digest, route, collision title, concept, relationship, or
note body to the provider. When context is enabled, the writing planner also
receives a title-only duplicate check capped at 500 titles and 48 KiB; it cannot
authorize an existing-note revision.

### Typed semantic routing boundary

The short direct import path, fixed long import after source reading, and
targeted enrichment can use a hybrid semantic router. Orion first selects
explicit anchors and positive metadata/digest
matches locally—even in a small Space—and caps that frozen universe at 71
notes behind one virtual range. It does not send the complete Space merely
because it would fit. A fixed long import does not route before reading; its
grounded readings and persistent hierarchy contract the candidate range
afterward, before the writing plan. This remains one bounded hybrid pass, never
a whole-Space routing crawl.

The host—not a model coordinator—creates router assignments from compact note
digests. Every exact note ID and immutable version in the contracted universe
must be classified once as `unrelated`, `duplicate`, `extends`, `contradicts`,
or `uncertain`; missing, duplicate, extra, stale, substituted, or cross-Space
coverage rejects the whole result. A separate consumer that genuinely needs a
complete larger directory can use deterministic 24–32-note ranges, subject to
the 100-range/3,200-note and identifier-size ceilings, but Import and enrichment
do not use that form.

The root sees only bounded routed metadata, never a full note body. A later
assignment may open an `extends`, `contradicts`, or `uncertain` note only by
citing its exact frozen note/version and the router artifact that classified
it. A `duplicate` body can be opened only by the exclusive destination owner
for that same note and base version; `unrelated` never opens. Routing therefore
adds read eligibility, not write authority or source evidence, and ownership is
still checked independently before one atomic revision. Turning off existing
note context removes the overview, linked excerpts, compact digests, routing,
collision titles, concepts, relationships, and other note-derived signals from
provider requests.

Compatibility organizer paths no longer send an arbitrary fixed-count payload
of note-body slices. They share a deterministic, bodyless compact digest
directory capped at 56 KiB; small Spaces may fit their metadata directory,
while larger ones are filtered locally to graph anchors and positive semantic
matches. These records support orientation, title reuse, and deduplication, but
cannot authorize an existing-note rewrite.

Validated source-range readings and router results may be reused from the
installed app's bounded local fingerprint cache. Keys include the frozen Space,
model, effort, assignment material, and exact note versions; every hit is
rehydrated and revalidated, so a stale, corrupt, or incomplete entry behaves as
an ordinary miss and correctness never depends on the cache.

The reading plan, each source reading, the writing plan, and each writer receive
independent transport windows rather than sharing a shrinking long-import
clock. Typed plan and draft shape errors receive an immediate corrective pass.
If the AI writing plan remains invalid after the source readings succeed, Orion
automatically builds a safe create-only plan from those validated readings,
groups the readers' compatible semantic synthesis seeds into durable knowledge
objects, and fans those groups into at most six bounded note-writing calls.
Seeds carry a semantic title, thesis, importance, exact claim IDs, and typed
Space contribution. Readers write atomic claims, partition every claim into
exactly one seed, and may combine at most four mutually supporting claims in a
seed; seed titles and theses are unique within that reading. The writing plan
must account for every seed as an output,
justified merge, or low-importance omission. It combines compatible ideas
across distant ranges and splits distinct ideas even when their evidence is
adjacent. Evidence-rich books often support ten or more notes or exact
revisions, without turning that expectation into a quota or adding filler. A
malformed optional routing
result safely falls back to new notes and never grants an existing-note rewrite.
If one multi-note writing call remains contract-invalid, Orion retains its
successful siblings and recursively narrows only that call. A final single-note
contract failure is completed transparently from its planned thesis, exact
selected claims, and selected Space interpretations—never a Part-N title,
range-summary copy, or source-heading bullet dump. Provider outages,
authentication failures, timeouts, and
cancellation never cause this subdivision or multiply doomed requests. Bounded
reader and writer recovery circuits prevent persistent malformed responses from
turning adaptive width into an unbounded request tree.
The user is not asked to click Resume for these recoverable failures.

A missing, stale, invalid, or transport-failed final branch is never partially
applied. A failed installed-app orchestration does not trigger a second network
organizer: Orion preserves the complete source and creates an editable preview
note instead. The full extracted text remains on its Source record. For long
imports, canonical readings, validated adaptive child readings and their exact
pending frontier, accepted routing, and completed per-note drafts are kept in a
versioned session recovery checkpoint. Eligible transient, checkpoint-safe failures resume
automatically at most twice with short bounded backoff; cancellation, a changed
Space, and unsafe checkpoints always remain visible stops. Only after automatic
recovery is genuinely exhausted does Results name the exact stopped stage, show
the safe provider or validation detail and retained counts, and offer **Resume
import** without repeating accepted work. A changed source, Space, model, or
instruction invalidates that checkpoint and offers a clean **Retry import**
instead. API keys and user-specific path components are redacted from visible
diagnostics. Import presents these phases as Preparing
the reading, Reading in parallel, Planning the notes, Writing in parallel, and
Final checks. Reading totals may grow when one section needs a closer pass;
progress remains indeterminate, reports real completed counts, and retains
Cancel throughout. Each writer has room for up to 12,000 output tokens.

Every existing article revision still names that exact note and its frozen base
version; no two writing slots can own the same destination. Project notes, wiki
revisions, links, and provenance are validated before one atomic Space update.
AI output remains bounded to 30 returned project notes and canonical articles
per batch; existing article revisions retain their independent version checks.
Manual mode creates one note per source using at most 200,000 characters for the
editable preview while preserving the full extracted text on its Source record.
The Review step includes one
optional **Guide this import** field for telling Orion what to emphasize,
preserve, connect, or turn into to-dos across the selected batch; the same field
applies to documents, pasted text, webpages, media transcripts, and YouTube
transcripts.

AI mode distinguishes faithful notes about imported material from durable, Space-scoped definitional wiki articles. A returned wiki body is a complete ready-to-read article: Orion integrates project relevance, source-grounded detail, and uncertainty into the sections where they naturally belong instead of appending provenance headings or change logs. Stable general knowledge may support the definition; citations, dates, statistics, contested specifics, and current claims must remain grounded in supplied material. Explicit actions in imported material can be retained as editable `- [ ]` tasks, but Orion does not invent work.

Canonical articles are upserted rather than duplicated. Orion normalizes exact titles within the active Space, coalesces repeated articles in the same import, and reuses a uniquely matching existing canonical article or note instead of creating a suffixed copy. A new article is immediately part of the evolving Space rather than entering a visible review lifecycle. Updating an existing article preserves its identity, merges aliases, tags, and source provenance, and replaces the body only with the model’s complete integrated revision. Subsequent sources in a batch see the preceding revision so knowledge cross-pollinates instead of being stacked into programmed “Context from…” sections. Unrelated articles and lexical-only matches are excluded.

If an AI call fails, Orion keeps the complete Source record and prepares an
editable preview note rather than discarding the import. Long-import Results
also retain completed work for Resume when its recovery checkpoint still
matches the current Space and source.

## Local Vision text recognition

Orion's installed macOS app runs `VNRecognizeTextRequest` through its bundled
native OCR helper. Recognition is performed on-device using the Vision
framework already supplied by macOS; Orion does not download an OCR model or
send the original image or PDF to a recognition service. The imported source
retains the recognized text, filename, MIME type, byte size, and resulting note
provenance in `vault.json`, not a copy of the original image or PDF bytes.

Healthy PDF pages stay on the pdf.js fast path. Orion selects only physical
pages whose embedded layer is textless or materially damaged, sends their exact
one-based page numbers and the original PDF to one local Vision invocation, and
merges recognized text back onto those same page numbers. A damaged page is
replaced only when recognition reduces broken glyphs while retaining plausible
length and vocabulary overlap; otherwise Orion preserves its embedded text and
warns. ClearScan-era books are then normalized locally by removing marginal
page numerals, subsequent exact running-head copies, and soft line-wrap
hyphenation while retaining every physical page boundary, including blank
pages. Recognition quality depends
on image sharpness, contrast, orientation, handwriting, layout, and the
languages supported by the installed macOS version; review important names and
numbers before relying on them. Images and PDFs share the 25 MiB per-file and
12-source queue limits. Whole-PDF OCR remains limited to 50 pages; selective OCR
may inspect at most 512 exact pages from a larger PDF and renders only those
pages. OCR rejects source images over 100 megapixels and bounds image decoding
to a 4,096-pixel longest edge, PDF page rendering to 2,600 pixels, recognized
text to 100,000 characters per page, and one million characters per invocation.

Browser preview has no native Vision helper. It reports that image and
scanned-PDF recognition requires the installed Orion desktop app rather than
pretending that extraction succeeded.

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

## AI provider configuration

Open **Settings → Intelligence** for OpenAI or **Settings → Claude** for
Anthropic. Orion stores one key per provider; the Anthropic key works across
Fable 5, Opus 5, and Sonnet 5 when the account has access. In the Tauri app the
credentials use:

- service: `app.orion.knowledge`
- accounts: `openai-api-key` and `anthropic-api-key`

The underlying credential store is macOS Keychain, Windows Credential Manager,
or the persistent keyutils/Secret Service store on Linux. A Linux desktop
session therefore needs a working Secret Service-compatible keyring. The keys
are not read during normal launch and are not written to `vault.json`, included
in exports, returned to the renderer, or intentionally logged. **Test
connection** makes the selected provider's authenticated `GET /v1/models`
request.

OpenAI organization uses `POST /v1/responses` with `store: false`; Anthropic
organization uses `POST /v1/messages`. Both use strict JSON-schema output and a
12,000-token response ceiling. Inline AI writing uses a writing-specific system
boundary and the same 12,000-token ceiling. Chat uses its own conversational
instructions. An ordinary request is reply-only with a 6,000-token ceiling and
no write capability; only a host-verified explicit creation request enables the
strict reply-plus-note-actions schema and 12,000-token ceiling. The default
settings are:

- Model: `gpt-5.6-sol`
- Reasoning depth: `low`
- Existing-note context: enabled
- Provider failover: disabled

The model choices exposed by the UI are:

| Model ID | UI intent |
| --- | --- |
| `gpt-5.6-sol` | Best quality; the default. |
| `gpt-5.6-terra` | Balanced quality, speed, and cost. |
| `gpt-5.6-luna` | Efficient for straightforward collections. |
| `claude-fable-5` | Highest-capability long-running synthesis and research. |
| `claude-opus-5` | Deep reasoning for complex projects and difficult material. |
| `claude-sonnet-5` | Fast frontier intelligence with balanced cost. |

Reasoning choices are `none`, `low`, `medium`, `high`, and `xhigh`. Model access
and billing depend on the account behind the selected provider key. Orion does
not silently substitute a different model or provider. If the user explicitly
enables **Fall back to your other provider** and has configured both keys, one
knowledge assignment that fails for an eligible timeout, network/availability,
or rate-limit reason may retry once with the other provider's default model.
Authentication/billing failures and cancellation never fail over.

Organization guidance in Settings is appended to Orion's built-in knowledge-architect instructions. Source content is treated as untrusted data, and the built-in prompt explicitly tells the model not to follow instructions found inside imported material.

## Chat

Open **Chat** from the main navigation to continue the conversation belonging to
the active Space. Orion sends the current prompt, up to 12 recent conversation
turns, and bounded context from that Space: up to 80 notes, 30 sources, and 120
concepts. Switching Spaces changes both the history and context completely.
Orion treats supplied note, source, concept, and conversation text as untrusted
knowledge data rather than instructions. This 80-note projection is specific to
Chat; Import and enrichment do not reuse it as an organizer fallback.

Orion derives write intent only from the current user prompt, sends that
authorization as a host field, and independently recomputes it at the native
boundary and again before applying a result. A negated request, a question about
whether or how to make notes, or ordinary conversation stays reply-only—even if
a source, existing note, prior message, or model output asks for a write. These
normal replies use a 6,000-token output ceiling and cannot create notes.

Only when the user explicitly asks Chat to create, capture, or save notes may
the provider return up to three complete creation-only actions alongside its
reply, using a 12,000-token transport ceiling. Each action body is capped at
6,000 Unicode characters; the combined titles, summaries, bodies, tags, and
aliases of all accepted actions are capped at 24,000 characters. Actions cannot
name another Space, update or delete an existing note, or create a proposal.

Orion validates actions independently in both the renderer and native host. It
drops an action with malformed or unknown fields, oversized content, invalid
labels, disallowed control characters, hidden `<!-- orion-… -->` control
comments, or the reserved tags `ai-draft`, `wiki-article`,
`orion-link-draft`, and `orion-link-pending`. A rejected action does not discard
the valid conversational reply or other safe actions. Accepted notes become
permanent, editable notes only in the captured active Space, and each
created-note chip opens the real note.

Every assistant response that did not create a surviving note also offers
**Keep as note**. This ordinary explicit UI action remains available for
reply-only conversation: it strips Orion control comments and disallowed control
characters, saves the reply as one ordinary note, and becomes an Open-note
destination. Activating it repeatedly cannot duplicate the note. Both creation
paths reconcile Orion's link vocabulary and refresh the Space overview just like
other permanent note changes.

Chat is intentionally one conversation surface. It does not create or curate
cards and has no proposal, selection, promotion, dialectic, or canvas workflow.
For existing vaults, Chat history continues to use the legacy
`studio.messages` field. Older card, selection, focus, view, zoom, and
panel-layout fields remain dormant and are accepted solely for vault
compatibility; Chat does not display them or send them to either provider.
The optional created-note IDs stored on assistant messages are backward
compatible with older vaults.

## Links, concepts, and navigation

Each Space owns an independent canonical link vocabulary. A concept label and its deliberate aliases identify one primary wiki article or note in that Space; the concept's canonical title must match that destination's title. Contextual project notes can support or relate to the article without becoming alternate link destinations. Tags remain useful for organization, filtering, and export, but Orion does not turn tags into automatic hyperlinks. Markdown remains a portable storage and export format behind the editor, but users never need to write it.

- Click **Edit** to write directly on the note; the compact word-processing toolbar animates into place without swapping to a separate editor.
- Select a short phrase and click **Link** to make those exact words the reusable link without an AI request. For a whole passage or code block, enter a separate page title or leave it blank for the configured AI provider to name from the selection and the Space. Orion keeps contextual selections untouched, adds only the title as a link above them, and gives the selected passage special weight when writing the page. Choose **Write with AI**—optionally telling Orion what the page should explain—or **Blank page**. Orion creates or reuses the named Space article, and future title occurrences become hyperlinks automatically. The destination picker remains available only when deliberately preserving a multi-note legacy branch.
- Select linked words and click **Unlink** to keep the prose and destination article while stopping that concept from linking automatically across the Space. Teaching the phrase again re-enables it.
- With **Write with AI**, a newly created link article is populated from the originating note, its direct imported sources, bounded Space context, and the optional page instruction. A compact sidebar card reports the real workflow phases—gathering sources, reading the Space, writing, and connecting—and opens the article when clicked. Progress spans a 90-second response budget instead of appearing to freeze early. Failed or timed-out generation leaves the unfinished page visible with **Restart** and **Delete** actions, and Restart retains the page-specific instruction. **Blank page** creates the canonical article without queuing AI.
- When **Done** is clicked after writing a substantive non-wiki note, Orion checks that note against the active Space and rewrites every meaningfully affected canonical article as a coherent integrated revision. It does not append note-labelled context sections. This automatic refresh requires the key for the selected provider and never crosses Space boundaries.
- A canonical concept link opens its article directly in the main note view. Orion does not interrupt reading with reference-hover popovers.
- The right-hand connections canvas appears only when an older unresolved concept still has several destinations and no valid canonical article. Choosing a destination opens it in the main note view while retaining the originating note as a trail.
- H2 and H3 headings automatically form a scrollable outline beside the left
  edge of the note. Selecting an entry scrolls to it, and the current section is
  emphasized as the user reads—even when the final short section cannot reach
  the top of the viewport. Notes without headings keep the full reading width.
- The right-hand control opens backlinks, related notes, and clickable sources
  in an on-demand connections overlay, keeping the reading canvas full width
  when it is closed.
- **Find** or `Cmd/Ctrl+F` searches the current note in both reading and editing
  modes. Back and Forward remember whether navigation began on Home, Notes, or
  another route; history restores prior scroll positions while a newly opened
  destination starts at the top.

During import, Orion asks the model for precise canonical vocabulary inferred from meaning, roles, relationships, and aliases—not frequency alone. Every returned concept names an exact returned or existing canonical article; related project-note titles become relationships, not alternate destinations. The importer deduplicates normalized article titles across the batch, reuses an exact article already present in the active Space, and applies a complete cross-pollinated revision. Existing and manually written notes receive local title and alias concepts without an AI call.

## Keyboard shortcuts

Use `⌘` on macOS and `Ctrl` on Windows/Linux.

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl F` | Find text within the current note. |
| `⌘/Ctrl K` | Open search globally; while editing a note, teach Orion a reusable link. |
| `⌘/Ctrl N` | Create a note. |
| `⌘/Ctrl Shift I` | Open Import Studio. |
| `⌘/Ctrl [` | Navigate back through opened notes. |
| `⌘/Ctrl ]` | Navigate forward through opened notes. |
| `Esc` | Close the command palette, export sheet, connections canvas, or Import Studio. |
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

With no existing vault, Orion opens as a clean slate with direct paths to import documents, paste notes, or start writing. No example notes or sources are bundled. **Open data location** reveals the application data folder. **Erase local vault** requires confirmation and replaces the saved snapshot with a fresh empty atlas; it does not remove the separately stored provider keys.

The top-bar **Share or export** action offers two formats and three explicit
scopes. **Interactive web article** produces one self-contained `.html` file
that opens offline in a modern browser. It retains Orion's article typography,
H2/H3 table of contents, GFM tables and tasks, explicit links, automatically
recognized concept links, numbered citations, and navigation between every
included page. The scopes are the open note, that note plus one deliberate hop
through its visible links, or the entire active Space. A whole-Space export
opens on a compact Space cover and includes a filterable page list when useful.

The web file contains only the selected notes. Citation titles, source kinds,
and original public URLs are retained as attribution, but raw imported source
text, source filenames, Chat, settings, provider keys, import queue state, and
other Spaces are excluded. Destinations outside the selected scope remain
readable but inert. User-authored HTML is not executed, the export loads no
remote scripts, styles, fonts, or images, and a restrictive content-security
policy keeps the snapshot offline. Its derived colors inherit the active
preset, accent, canvas, surface, text warmth, contrast, and safe custom colors;
explicit light or dark stays fixed while System remains adaptive. Desktop saves
through a native file picker using a flushed temporary file plus atomic
replacement; browser preview uses a normal download.

**Markdown files** uses the same scope selection. Desktop export asks for a
folder and writes one UTF-8 file per selected note with YAML `title` and `tags`
frontmatter. Existing files are never overwritten; Orion adds a numeric suffix.
Browser preview downloads the selected notes as one combined Markdown file.

## Privacy and data behavior

- Notes, relationships, concepts, settings, and extracted source text are plaintext on local disk. Orion does not currently encrypt the vault.
- The optional Claude Desktop connector reads that same plaintext vault locally
  and returns only requested, bounded data through its MCP tools. With the
  user's Claude tool permissions, it can also create, edit, and delete notes in
  an explicitly selected Space. It does not contact Orion, OpenAI, Anthropic,
  or another network service itself; material returned to Claude is then
  subject to the user's Claude product and account settings.
- The optional Codex plugin has the same local read and explicit-Space write
  boundary. It can create, fully edit, and delete notes when the user asks Codex
  to use those tools, but it cannot inspect provider keys, call Orion's AI
  providers, or access another Space implicitly. The plugin itself makes no
  network request; Orion text returned through a tool is then subject to the
  user's Codex product and account settings.
- AI mode sends the selected source text or bounded source-range material,
  source identity, Space name and description, import-scoped guidance/rules,
  and the general Space preference to the selected OpenAI or Anthropic model.
  When existing-note context is enabled, planning stages may receive the
  current persisted root Space blueprint and bounded relevant cluster
  blueprints, or the saved **Across this Space** overview and excerpts from at
  most eight valid same-Space notes as a fallback. Orion selects that packet
  locally with zero Import-time provider calls. After long-source reading, one
  bounded hybrid router may classify a contracted candidate directory so later
  assignments can open only authorized exact versions. None of these paths
  sends every note body or performs a provider-powered whole-Space prepass.
  Blueprint, overview, route, and note material is untrusted orientation only,
  never imported-source evidence.
  When context is disabled, no overview, linked-note excerpt, compact digest,
  route, collision title, concept, relationship, prior-source association, or
  other note-derived signal is sent. Later assignments receive only their
  declared exact references and never inherit parent transcripts or unrelated
  Spaces. With context enabled, the long-path writing planner has one narrow
  extra disclosure: up to 500 note titles within a 48-KiB collision directory,
  without bodies or summaries and without revision authority. At most six
  calls run at once. The adaptive long path has no shared wall-clock
  deadline: its reading plan, source readings, writing plan, and writers each
  have an independent 300-second emergency transport-safety ceiling, and
  cancellation stops the run. This is not a shared stage or product countdown.
  A failed installed-app run starts no second network workflow; Orion keeps the
  full extracted text in Sources and creates a bounded editable preview note.
  The genuinely short direct organizer retains its legacy 180-second bounded
  runtime.
- Finishing a substantive note with AI configured enters the same knowledge-orchestration boundary. The origin note and its direct sources are frozen evidence; an existing canonical article can change only through an exclusive owner proposal against its exact base version. Orion rechecks the origin and every owned destination before applying one coherent set of revisions to that Space.
- Inline AI writing sends the exact selected Markdown or bounded material around
  the caret, the active note title and summary, and the optional one-request
  instruction to the selected provider. Rewrite, Clarify, Tighten, Simplify,
  Expand, and Continue receive no unrelated Space records. Enrich may also send
  a relevance-ranked, bounded set of notes, concepts, and source passages from
  the active Space only so it can integrate grounded context and citations.
  Proposals stay outside the saved note until the user accepts one.
- Selected-passage image generation is OpenAI-only and uses `gpt-image-2` through
  the Image API. It sends the exact highlighted passage, optional one-request
  visual direction, and—only when existing-note context is enabled—the bounded
  **Across this Space** overview plus excerpts from at most six notes visibly
  linked or mentioned there. It does not scan the Space or send source bodies.
  Orion requests one medium-quality landscape JPEG; returned bytes remain
  transient until Accept, and Cancel invalidates the native request and any late
  result. Accept stores the pixels in Orion's private image directory and adds
  one portable Markdown image after the unchanged selection as a single Undo
  step.
- A Chat message sends only bounded material from the active Space: the prompt,
  up to 12 recent turns, and context for up to 80 notes, 30 sources, and 120
  concepts. It sends no legacy card or layout state. The host enables the note
  action schema only when the current prompt independently matches an explicit
  creation request; untrusted context and model output cannot grant that
  authority. Up to three creation-only actions then pass the local field,
  content, aggregate-size, control-marker, and reserved-tag firewall before they
  can apply to the captured active Space. Switching Spaces changes the history
  and context completely.
- OpenAI requests set `store: false`; each provider's account-level data controls
  and applicable retention policies still apply.
- API use can incur charges. A valid key does not guarantee access to every model.
- AI-generated notes are immediately editable and evolve with the Space. Orion constrains the response shape but does not independently fact-check the content; review important claims and links before relying on them.
- Manual imports and editing remain local and can work offline. AI organization and connection testing require network access.
- PDF, image, and DOCX extraction and media transcription happen locally.
  Vision recognition receives image or scanned-PDF bytes only inside the
  desktop app; only recognized text and source metadata are retained in the
  vault. If the user chooses AI organization, that recognized text is then
  handled like any other selected source text and may be sent to the configured
  provider. Ordinary webpage import reads only one explicitly supplied HTTPS
  page, rejects local,
  private, link-local, reserved, and IP-literal targets across redirects and DNS
  resolution, accepts only HTML/XHTML/plain text, and stops at 5 MiB; it is not
  a crawler. Orion has no sync service, collaboration server, OCR or
  transcription server, or telemetry integration.
- A YouTube import briefly writes downloaded media to an OS temporary folder;
  it is deleted once offline Whisper finishes, including when
  download or transcription fails. The finished transcript and source URL
  remain in the vault as provenance.
- Web and Markdown exports are unencrypted snapshots and may contain sensitive
  source-derived material from the selected notes. Web export deliberately
  excludes raw source bodies and internal vault state; Markdown exports retain
  the selected notes' portable source-citation links.
- In browser-only development, the snapshot (`orion:vault:v2`) is stored in that origin's `localStorage`; entered provider keys are held in memory only and clear on reload. Use the Tauri app for persistent OS-keychain storage.

## Tests

The renderer suite covers import detection and parsing, PNG/JPEG/HEIC source
classification, scanned-PDF fallback, browser OCR boundaries, unified queue
lifecycle, late-result deletion safety, URL classification, transcription-source
mapping, canonical destination and legacy-ambiguity resolution, automatic-link
safety, backlinks/search, Space-scoped Chat request bounds and history,
dormant legacy Studio-state compatibility, and browser persistence without leaking the key
into the snapshot. Rust tests cover Vision-request validation and bounded
native-helper execution, bundled-runtime validation, YouTube and public-webpage
URL validation, temporary-media deletion, `yt-dlp` metadata, Responses API output
extraction, portable export names, bounded self-contained HTML generation,
one-hop link scope, citation privacy, atomic web-file replacement, atomic vault
round-trips, MCP protocol shape,
bounded source reads, and Space isolation. The Codex plugin contract harness
also validates its local marketplace metadata, manifest paths, skill, MCP
configuration, shared binary version, Orion citations, and persisted writes.
Release QA also
uses only the executables inside the finished app to download and transcribe a
real short YouTube source, and runs the MCP harness against the connector
extracted from the packaged application.

Before handing off a change:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/mcp-server/Cargo.toml
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
  lib/tasks.ts      Space task extraction, concept attribution, and toggling
  lib/wiki.ts       linking, backlinks, references, and search helpers
  types.ts          schema-versioned application model
src-tauri/
  mcp-server/       independent read-write Claude MCP binary
  native/           Swift Vision OCR and AVFoundation/Whisper sidecars
  binaries/         bundled OCR/Whisper runners, yt-dlp, and Deno executables
  resources/        Whisper model, hashes, notices, and third-party licenses
  vendor/           official whisper.cpp macOS framework
  src/lib.rs        vault, keychain, AI providers, offline media, export, and Tauri commands
  tauri.conf.json   window, bundled runtime files, identity, and CSP configuration
codex/orion/         canonical zero-config Codex plugin source
src-tauri/resources/Orion-Codex-Plugin/
                    generated marketplace/plugin tree embedded in Orion.app
script/
  build_codex_plugin.sh  stage and validate the bundled Codex plugin
  test_codex_plugin.mjs  plugin contract and read-write MCP harness
```
