# Generation and AI actions in the editor

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: Generate from New note, Write, Rewrite, Enrich, image generation and their preview and acceptance rules.

Read it before changing `src/lib/generate*.ts`, `src/lib/aiWriting.ts`, `src/lib/aiImages.ts`, `src/lib/imageContextSearch.ts`, `src/lib/editorAI*.ts`, `src/lib/aiImagePlanningProtocol.json` and `src-tauri/src/image_planning.rs`.

Related: [Notes and the editor](notes-and-editor.md), [Persistent Space knowledge](space-knowledge.md), [Chat](chat.md).

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
slide is then a complete `gpt-image-2.6-sunburst` 16:9 image
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
`gpt-image-2.6-flare`; Detailed uses `gpt-image-2.6-sunburst`. Both use the one-shot
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

Request one `1536x1024`, lossless PNG at `quality: "max"` and
`complexity: "high"` from the explicitly chosen GPT Image 2.6 model. Fast means Flare, not a `service_tier` parameter;
never send Responses-only Fast mode settings to the Image API. See
[OpenAI's image guide](https://developers.openai.com/api/docs/guides/image-prompting).
Returned base64 bytes are transient proposal state, bounded to the existing
12-MiB note-image limit, and must pass renderer and Rust PNG signature validation.
Retain validation and acceptance of existing transient JPEG proposals; filename,
MIME type and signature must agree. No lossy conversion or silent quality downgrade. They
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
