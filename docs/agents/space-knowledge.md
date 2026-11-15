# Persistent Space knowledge

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: note digests, cluster and root blueprints, the Across this Space overview and how import consumes the hierarchy.

Read it before changing `src/lib/spaceKnowledge*.ts`, `src/lib/spaceOverview*.ts` and overview maintenance in `src/App.tsx`.

Related: [Import pipeline](import-pipeline.md), [Generation and AI actions in the editor](generation-and-inline-ai.md), [Chat](chat.md).

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

Automatic overview maintenance waits for three seconds without a note edit in
its window before validating or preparing the hierarchy. Provider responses
also wait for this quiet period before validation, publication, or a follow-on
request. Explicit refresh remains immediate. This gate is independent of the
800 ms / five-second autosave policy. Recheck freshness when the delayed work
actually runs so a completed refresh cannot be repeated by an older timer.
Reserve a renderer request before awaiting the native per-Space lease, and
acquire that lease before preparing provider work. Each window keeps a weak
cache of digests for immutable note objects; changes to derived concept labels
or relationship hints invalidate the affected entries. Reuse the same digests
for freshness checks and preparation. Keep full content checks at the quiet
boundary and preserve the stale-result guard and the last valid overview.

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
