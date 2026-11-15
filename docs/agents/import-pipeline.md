# Import pipeline

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the import queue, local parsing, Vision OCR, webpage fetching, provider scheduling, knowledge orchestration, routing, recovery and landing.

Read it before changing `src/components/ImportStudio.tsx`, `src/lib/files.ts`, `src/lib/htmlImport.ts`, `src/lib/docxImport.ts`, `src/lib/import*.ts`, `src/lib/providerScheduler.ts`, `src/lib/knowledgeOrchestration/`, `src-tauri/src/knowledge_schemas.rs`, `src-tauri/native/OrionOCR/` and the `fetch_webpage` command.

Related: [Persistent Space knowledge](space-knowledge.md), [Dictation and transcription](dictation-and-transcription.md), [Portable export](export.md).

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

## Markdown import subtitles

Plain Markdown imports leave the note summary empty. Preserve frontmatter and
body text in the source and note; do not turn their first characters into a
subtitle. `importSummary.ts` hides legacy mechanical Markdown excerpts only
when they exactly match their linked original source. Authored summaries and
explicit AI-organized summaries remain supported; no vault migration is needed.
