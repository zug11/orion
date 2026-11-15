# Search and linking

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: ordinary local search, AI search, concepts, automatic and explicit links, linked articles and canonical wiki articles.

Read it before changing `src/lib/localSearch.ts`, `src/lib/wiki.ts`, `src/lib/concepts.ts`, `src/lib/linkedArticle.ts`, `src/lib/wikiEnrichment.ts`, `src/lib/externalLinks.ts`, `src/lib/noteExcerpts.ts`, `src/components/editor/AutoConceptLinks.ts` and the command palette.

Related: [Persistent Space knowledge](space-knowledge.md), [Import pipeline](import-pipeline.md), [Notes and the editor](notes-and-editor.md).

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
the underlying prose merely to render a link. Its cost must not grow with the
vocabulary: `decorateAutoLinks` in `src/lib/wiki.ts` walks a trie of folded word
tokens from each word start and verifies only the phrases that trie proposes,
longest first, with each phrase's own sticky pattern. Never return to testing
every concept against every text node. The editor plugin answers a caret move
from its last pass (same document and vocabulary objects) and remembers results
per text, so a keystroke matches only the text that changed. Do not merge project notes merely
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
