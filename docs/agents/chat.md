# Chat

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: Chat threads, adaptive reading, citations, web research, note edits and creation from Chat, and passage-anchored discussions.

Read it before changing `src/components/ChatView.tsx`, `src/components/ChatDock.tsx`, `src/lib/chat*.ts`, `src/lib/chatReadingProtocol.json`, `src/lib/chatEditsProtocol.json`, `src/lib/webResearch*`, `src-tauri/src/chat_reading.rs`, `src-tauri/src/openai_web.rs`, `src-tauri/src/perplexity.rs` and the passage thread components.

Related: [Space voice and working views](voice.md), [AI providers and accounts](ai-providers.md), [Notes and the editor](notes-and-editor.md).

## Product decisions

- Chat is one Space-scoped surface with separate saved conversations. Full Chat
  offers a collapsible right-hand Chats list; the compact dock keeps its existing
  layout. Each Space has its own list, with New chat, local prompt-derived titles,
  rename and confirmed deletion. New chat preserves earlier conversations.
  Selection, draft text, attached context and sidebar expansion remain local to
  each window, with independent conversation selection per Space. Never send
  another thread's history as context for the selected conversation. It must not expose a card,
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

## Chat contract

The visible route and navigation label are **Chat**. It is one conversation
surface with separate persistent threads scoped to the captured active Space.
A quiet bottom-right circle opens the selected conversation beside the document.
It appears when the selected provider is configured and is hidden during Flow
and on the full Chat route. `ChatDock` keeps one `ChatView` mounted across collapse and expansion, retaining the draft,
pending prompt, cancellation and reply. Thread changes remount the text view
while the dock retains each thread's unsent draft and attachment; Space changes remount transient UI;
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
Suggestion batches also belong to the selected connection and ChatGPT account.
An explicit native ChatGPT connection-change event invalidates that connection's
window-local cache and pending results immediately, including when Chat is
unmounted in Settings and when the same account signs in again. A transient
connection generation fences late results before status hydration completes;
ordinary status reads and unrelated vault updates do not invalidate or retry.
Use the selected connection's availability, including ChatGPT plan access without
an API key, rather than gating suggestions on an OpenAI key alone.

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

### Web research connections

`Settings.webResearchProvider` is an optional `auto | openai | perplexity`
preference (legacy absence means Auto). Auto retains Perplexity when configured,
otherwise uses the selected OpenAI connection. Explicit OpenAI uses the selected
OpenAI model and its API-key or `chatgpt:` sign-in route; an Anthropic model does
not silently select another model or credential. Explicit Perplexity requires
its key. Settings shows the active route and allows switching without deleting
credentials. `src/lib/webResearchProvider.ts` owns capability selection for typed
Chat, voice workers and live voice context. Capture the route at submission;
never switch provider or billing connection after an error. Provider preference,
model and account changes invalidate retained research contexts.

`src-tauri/src/openai_web.rs` sends foreground Responses requests with the hosted
`web_search` tool using the existing OpenAI API key or ChatGPT sign-in. It reuses
`chatgpt::text_request` and the strict completed-response reader, including the
SIWC missing-Content-Type stream handling. Retain bounded finalized
`response.output_item.done` items and reconcile them with the terminal output:
the real plan route may send an empty terminal output list after completed
search/message events. Publish only after `response.completed`; deltas, added
items, interruption or failed/incomplete terminal events never establish success.
Conflicting identities or positions fail closed. No other tools or note material are
sent. Query bounds, depth deadlines and window-scoped cancellation match the
shared research capability. API requests can bound tool calls/output; SIWC
omits unsupported background/output/tool-count parameters, so its depth is
reasoning/search-context guidance plus a host deadline, not a guaranteed remote
step cap. Model/account/workspace web restrictions return an explicit error.
Never automatically retry an ambiguous paid POST or fall back to another key.

`src-tauri/src/perplexity.rs` owns the separate `perplexity-api-key` Keychain
entry and fixed Perplexity Agent API transport. It inherits `KEYCHAIN_SERVICE`
from the host, including the Preview identity rewrite. Settings → Web research
offers Save, Test connection (authenticated model listing, no research), and
Remove. Optional `Settings.perplexityApiKeyConfigured` stores connection status;
older vaults hydrate to false. Never read the credential at startup or persist it in
the vault, browser storage, exports, or logs. Browser previews can inspect the UI
but real web research and credential storage require the desktop host.

Text Chat's Web pill grants the shared reader a capability captured for that
submission. It defaults off and resets across Spaces or research-connection changes. A voice
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
default to standard. For Perplexity, `src/lib/webResearchProfiles.json` fixes model,
reasoning, tools and budgets: quick uses GPT-6 Luna/minimal with 5 steps and
110 seconds; standard uses Luna/medium with 12 steps and 240 seconds; deep uses
GPT-6.1 Sol/high with 24 steps and 480 seconds. These are ceilings, not required
work. All profiles permit only web search and URL fetch; no dynamic preset may
silently add tools. There is no extra classifier call or user depth selector.
There is no fixed paid-lookup quota or total web-research turn/time ceiling.
The reader continues with specific evidence gaps in the current user question
and is instructed to finish when adequately supported. Two consecutive lookups
that fail or add no new source evidence require final synthesis with remaining
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

Web evidence uses `kind: web` with validated HTTP(S) URL, retrieval date,
optional publication date and optional `evidenceType`. Absent or `source_excerpt`
means a retained provider search excerpt. `cited_summary` means exact retained
provider-generated text associated with an official URL citation, never a quote
from the remote page. OpenAI must return a completed web search and valid source
annotations; URLs mentioned only in generated prose cannot become citations.
Its generated answer IDs are not presumed to be Perplexity numeric markers.
The reader, realtime handoff, native/MCP validators, saved citation footer and
export preserve this distinction. UI labels summaries before their text; readers
may paraphrase supported findings but cannot claim verbatim page text or a full
page read. Reworded summaries of the same URL do not count as new evidence.
UTF-16 ranges address only the retained text. Perplexity citation numbers map by
provider source ID, not array order. Uncited synthesis alone is not evidence.
Saved replies/notes retain evidence and ordinary web links through the existing
portable citation footer; local source arrays remain unchanged.
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
target, and changing conversations revokes pending edit preparation.
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
Recognize ordinary explicit human wording such as Create a new note, Write new
notes, spoken note counts, and requests for workers to write notes. Quoted/code
examples, capability questions and tentative descriptions never grant authority.
The canonical Create a note prefix for generated Chat suggestions is a separate
strict suggestion-format contract, not a restriction on human phrasing.
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
The additive thread migration uses optional `StudioMessage.threadId` and
`studio.threads` metadata (`id`, `title`, `createdAt`, `updatedAt`). Untagged
messages belong to the implicit `chat-legacy` conversation without being copied
or rewritten. Missing metadata remains valid in older vaults; new nonlegacy
message references must resolve within that Space. Empty metadata titles become
the first prompt's local title, with no title-generation API request.
New chat first materializes the selected implicit conversation, even if it only
has an unsent draft or retained voice work, so its identity stays navigable.
`chatThreads.ts` derives the list and projects one thread for display/provider
requests; never persist a projected snapshot. Append responses and note-save
receipts to the full canonical Space with the captured conversation identity.
Switching cancels text generation and pending reply-edit preparation; captured
history revisions guard changes independently of the Space knowledge version.
Old completions cannot clear a newer request's progress or write into its thread.
Three-way merging handles concurrent first thread additions and reconciles
deletion against concurrent replies as one conversation conflict. A conflict
choice must not leave orphan messages or discard unrelated thread edits.
The right rail defaults to collapsed. Its last explicit open/closed choice is
stored locally under `orion:chat-history-expanded:v1` and restored on launch,
independent of Space and without a vault save. Missing or unavailable storage
defaults to collapsed; storage failure must not prevent toggling.
The right rail spans the full Chat section, including its header. One persistent
toggle remains at the same top-right coordinates when open or closed, independent
of voice header height. Only the history list scrolls inside the rail. Its narrow
overlay makes both the Chat header and stage inert and retains its keyboard focus
loop and Escape restoration. The rail does not remount the conversation or voice when collapsed. Live
voice prevents changing chats; after the call ends, browsing other threads
preserves findings in their originating conversation. Resuming voice elsewhere
returns to that origin, and saved voice receipts retain its thread ID. Explicit
deletion of that conversation disposes its transient voice work. Passage
discussions remain separate note metadata, with no duplicate ordinary Chat
history. Their Back to the note and Space chat routes retain their semantics.
Existing `studio.cards`, `selectedCardIds`, `activeConceptId`, `view`, `zoom`,
`chatCollapsed`, and `canvasCollapsed` fields must continue to validate and
round-trip, but they are dormant compatibility data. Do not render them, mutate
them as a workflow, include them in Chat requests, or use them to reactivate
card proposals, selection, promotion, dialectic, or canvas UI. Do not add a
parallel Chat persistence field without an explicit schema migration.
`StudioMessage.createdNoteIds` is optional so older vaults continue to validate.

## Passage-anchored Chat discussions

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
source; never clone the exchange into `studio.messages` or list passage discussions
as ordinary Space chats. Replies in either surface commit to the same thread with the same approval,
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
