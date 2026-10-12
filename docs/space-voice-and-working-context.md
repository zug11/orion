# Space voice and agent working context

Talk to Space is an optional control beside Chat in the sidebar and inside the Chat composer. Starting
it requests microphone access and connects GPT-Live (`gpt-live-1`) over WebRTC.
The native host authenticates the SDP handshake using the OpenAI Keychain entry;
the renderer never receives the provider credential. `store: false` disables
optional session recording storage. This is online voice, separate from local
Whisper dictation. Research uses the selected Intelligence provider/model and its
normal scheduler. Starting from the sidebar leaves the current note open. The
current Space and window own the call, independently of the visible Chat panel.
A bottom-right glass pill provides mute, end, Open Chat and an expandable work
summary. The composer's audio-wave button becomes a square Stop button while
connected or connecting; transcripts, elapsed time and provider/usage text stay
out of the composer. Local Whisper dictation retains its existing insertion and
transcription behavior.

A fresh main conversation waits two connected seconds before offering one
neutral welcome: “Hey, where would you like to start?” Input stays live, and
any arriving user/assistant transcript, input/output activity, delegation,
spoken finding, mute or teardown cancels the pending greeting. Reconnect,
navigation and worker switches do not greet again. Existing work suppresses it;
Clear voice chat restores eligibility for the next explicit fresh call. The
offer is one trusted `instructions` append after session startup, following
[OpenAI's greeting sequence](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks),
with no automatic retry. The native prompt never treats the open note or restored
context as a request to start a subject. This timing and cancellation are local
guarantees; natural wording and yielding mid-greeting still need live listening.

The central orb represents the main conversation; visible worker orbs are tied
to actual work-order IDs. Useful checkpoint sequences send a small filled bead
to the centre, while completion has its own settled cue. Workers cannot open
their own conversation until they finish with a current result. Selecting one
stops the previous audio connection before opening a new connection grounded
in that worker's retained evidence and conversation. An automatic return caused
by stale or revised evidence waits until playback and arriving speech settle. Returning to the centre
restores the main conversation. A further research request uses the same worker
identity, relocks its conversation and hands audio back to the centre. Switching
recipients never cancels admitted unrelated work. These explicit switches may
involve connection latency and a new billable voice session.

The work summary offers **Clear voice chat…** with an inline confirmation. It
ends the transport, cancels pending routing/research/preparation, replaces the
Space's transient coordinator and clears retained voice conversations/results.
Late events from the old recipient or coordinator cannot repopulate the cleared
view. Saved notes and typed Chat are not deleted; a save already admitted to the
atomic writer may finish. The user explicitly starts the next call.

Undecided ordinary conversation routing remains cancellable in the work summary
but does not flash a provisional research orb. Explicit worker reservations stay
visible. Actual routing/research and direct edit preparation drive circular
indicators, independently of measured audio. Reduced motion uses static rings.
The router receives a bounded reference to the captured finished finding so a
question about existing evidence can stay conversational.

Throwing a running worker back into the small swarm cancels only that job.
Throwing a completed worker shrinks its visible orb while retaining the result,
references and conversation in the work list. An explicit return restores it.
Only measured microphone and locally playing output energy animate listening
and speaking. Update receipts and text do not impersonate audio. See
[the constellation contract](voice-constellation.md) for motion and accessibility.

The voice model starts with compact conversation and navigation context: the
Space's note/source counts, up to twelve note titles, and bounded exact working
passages from the open note. No unrelated note bodies or cached summaries are
loaded at startup. Initial context is capped below the native handshake's byte
limit, including JSON escaping. A note switch sends only the new note context;
typing within that note, renaming it or refreshing the directory never resends
its passages. Startup/navigation passages are a snapshot, so detailed questions
retrieve current evidence. Deleting the focused note clears its context. Questions about whether Orion can see notes resolve
locally, without waiting for a planning model. Explicit assignments can start
from the exact transcript before a provider delegation arrives. Reading requests
use the ordered intent router to choose one worker or several useful independent
investigations; the user need not name the workers or say “in parallel”. Explicit
writing requests retain their direct path. Once
admitted, each work order passes the exact user prompt to `runChatReading`, using
the same automatic intent, reading and edit-review path as typed Chat. There is
no per-worker research planning call or rewritten search-only prompt. Recent spoken
context is reference data inside the existing bounded Chat history budget; it
retains the newest correction without hiding the preceding Chat reply's evidence.
Parallelism comes from independently controlled work orders.

Research can return useful intermediate findings before its final answer. The
shared Chat transport carries a bounded nullable `checkpoint` beside further
read requests. It contains a concise cited finding, public task decisions and
unresolved questions. Native and browser transports validate its shape and
limits; the local reader resolves citations against exact passages already
supplied, rejects unsupported/unknown references, and suppresses duplicate
findings. A finding remains a supported model interpretation, not independent
verification of its source. Ordinary prose and write payloads attached to reads
are discarded. These updates never save a note, apply an edit or report a save.

Each worker retains a transient checkpoint after completed local reads. It
includes exact evidence versions/ranges, discovered IDs, completed operations,
public findings and decisions, unresolved questions, and planned next reads.
Further provider invocations receive that bounded task memory. A correction
keeps the work-order identity, advances its revision, aborts the superseded run,
and resumes the last completed read boundary. Current evidence is reused;
changed evidence and decisions relying on it are removed. An explicit Retry
resumes a failed work order, while a duplicate delegation cannot restart it.
Evicted exact ranges remain coverage gaps and may be opened again. No checkpoint
is persisted in the vault or placed wholesale into the live voice session.

The work order exposes up to six intermediate updates and a sequence for each
new useful finding. They use the same revision-aware commentary delivery as
final answers. Superseded checkpoints cannot announce results or commit notes;
the existing per-identity save reservation still prevents duplicate saves.
Completed workers can supply a bounded conversation packet with the assignment,
final answer, supporting passages and public task memory. Coverage and explicit
omission fields identify partial answers/passages. Same-scope continuation and
retry also retain a separate public completed-answer reference, bounded to 3 KB:
exact opening/conclusion fragments, original source identities, coverage and
omissions. The ordinary reader checkpoint contains intermediate findings, not
that final conclusion. Revalidate evidence, focus, settings and task-view before
reusing the reference, and drop it on a changed scope or selection. It grants
neither writes nor current citation authority. This is continuity of
the worker's task and evidence across calls, not retention of hidden reasoning or
a permanently running model process. Local fixtures exercise checkpoint/resume,
stale evidence, cancellation, duplicate delivery and native/browser schema gates;
audible live-provider quality remains a separate acceptance check.

Finding delivery separates quiet reference metadata from conversational prose.
`voiceFindingDelivery.ts` sends the job identity, revision, sequence, intermediate
or complete state, coverage, and any confirmed save receipt or unapplied proposal
through `session.thinking.append`. Exact source titles/identities and ranges are
bounded separately with explicit omissions; local evidence IDs are scoped to
one worker/revision/update. Each queued commentary carries that exact packet and
re-sends it immediately before its prose, so interleaved workers cannot inherit
each other's source mapping. A rejected reference send holds commentary; a
rejected commentary retries both together. Current-call delegation IDs are
resolved at delivery rather than carried blindly across audio connections.
Complete bounded findings are available there immediately, including final
answers. The same reading calls can return a validated `voice` object with a
short assignment label (80 Unicode characters) and a final spoken summary
(360 Unicode characters). The label changes presentation only; the original
prompt, identity, scope and write authority stay fixed. Final summary citations
resolve against retained exact evidence, and coverage qualifications survive.
The automatic summary has a separate 1,600-byte transport budget, including its
qualification. A legacy response without this field may offer a complete finding
up to 480 UTF-8 bytes; a longer response is never clipped into a false summary.
A reading step cannot publish its voice summary as a completed answer. Explicitly
asking for a result can still offer its full bounded prose. A newer quiet-only
answer invalidates queued older speech through the worker delivery sequence;
there is no repeated research-status or unsaved-status narration. Complete bounded
replies retain ending caveats, citation transport stays on screen, and proposals
still explain review and Accept/Discard. Explicit Keep receives a brief save
acknowledgement only after a persistence receipt. Superseded/cancelled deliveries
retain their existing guards. Channel tests prove this separation at the local
transport boundary; neither an append nor its acknowledgement proves that the
provider spoke naturally or that the user heard it.

Whole-document note/source reads retain up to 192 KB of exact text in one batch,
within a 320 KB, 96-passage transient workspace. Per-document coverage reflects
retained ranges, not merely previously opened material. Answers retain at most
twelve citations. Oversized reads disclose their missing ranges; these larger
packets never enter the live voice session. Each assignment searches and opens exact passages through the existing
Chat reader, with citations and partial-coverage metadata. No note text grants
write authority. The current user's transcript authorizes creation through the
same bounded Chat policy; edit proposals target only the captured attached note
and require the existing review, Accept changes, Discard and Undo workflow.

Work orders have independent IDs, subjects, revisions, captured note context,
cancellation and results. Ordinary speech does not invalidate research. The
coordinator interprets buffered turns in conversational order; research workers
run independently, with at most ten researching workers and additional
assignments queued. The old six-work-order admission cap is removed; a single
request may allocate up to 1,000 workers, planned in validated pages of 24.
Queueing does not consume a worker's execution deadline. At most 24 terminal
records are retained; active and queued jobs are never evicted by that retention
limit. Requested orb identities remain visible through routing and clarification,
and a clarification answer retains the original note and selected passage.
An explicit request such as “spawn 4 workers to read across all the notes” already
defines its scope. When each worker can receive 1–24 notes, the host partitions
the current Space's note IDs into four disjoint groups without a provider planning
call. Those IDs enter the existing reader as explicit references, with no editing
authority or unrelated open-note priority. Larger directories or more workers
than notes use contextual scope planning. Each result still reports its actual
coverage; admission is not proof every assigned word was read. All admitted orbs
are visible, including queued work beyond the ten concurrently executing jobs. The shared physical provider budget
is also ten requests per renderer, shared fairly with other AI work; a busy
provider pool can delay a worker’s next request.
For contextual requests, the router chooses complementary angles itself. It
repairs incomplete worker counts and unnecessary topic questions once internally.
Repeated malformed plans report an error instead of asking the user to design the
team or claiming workers started. A genuinely missing subject or ambiguous
control target can still require clarification.
Explicit local cancellation bypasses routing and can cancel
an assignment still being understood. A named correction replaces only that
assignment; ambiguous references receive one short question. Its answer resolves
the pending control, which is cleared when voice stops or reconnects.

`voiceReservations.ts` is the single owner of pending groups, turn-to-worker
aliases, cancelled turns and clarification state. It retains the first captured
note and selection through navigation and later transcript updates. Group
revisions prevent an obsolete answer from reviving a cancelled worker; call
epochs reject answers arriving after reconnect. Admission consumes a valid group
and reuses its surviving IDs. The provider router, admitted research execution,
audio transport and React/timer boundaries remain separate responsibilities.

The remaining lifecycle coordination has three typed owners.
`VoiceTurnRouter` owns debounce, ordered routing, route controllers and deadlines;
cancellation or expiry releases a route without waiting for an uncooperative
provider. Its epoch and active identity reject late results and cleanup.
`VoiceCallLifecycle` owns one audio transport, mute, current-call delegation IDs
and callback fencing. Ending a call stops accepting input immediately, while
its close handshake finishes; reconnect and completed-worker conversation
switches dispose the old recipient before creating the new one.
`VoiceFindingScheduler` owns buffered findings and delivery timing, with
revision checks supplied by the research engine. `SpaceVoice` keeps semantic
decisions, admitted research, captured references and React publication rather
than independently managing those timers and controllers. Its mutable refs are
reduced from 21 to eight. These are transient owners, not new persisted state.
An exact correction holds only that work order's finding. Delivery selects the
oldest eligible finding, so unrelated results do not wait behind it. Once the
correction resolves, the held finding is rechecked against the current revision;
obsolete evidence is dropped, and accepted sends retain normal pacing.
Switching to a finished worker pauses commentary offers while preserving current
admitted findings. Returning to the centre resumes that queue with fresh audio
timing; it does not discard findings that arrived while talking to the worker.
Explicit Stop/reconnect still clears old speech offers. A focused result is bound
to its entry revision. If it becomes stale, advances revision (even synchronously
from completed to completed), or leaves retention, an ongoing call returns to the
centre. The same background change after Stop or disconnection clears focus without
reacquiring the microphone. Retired worker conversation records are released.

The transcript assembler groups same-speaker fragments across assistant
backchannels, preserves the originally open note, and matches delegation timeline
offsets to that utterance instead of the latest speech. Early delegations wait
for their transcript. After dispatch, a new explicit assignment or a gap of at
least 900 ms starts a new turn; short continuations can still revise that turn.
An obviously dangling phrase uses a 3.2-second settling window and cannot admit
research or edits even when the provider delegates it. A continuation within
eight seconds retains its original note, selection and worker reference; a new
explicit assignment remains separate. These conservative assembly hints do not
claim general semantic endpoint detection or override the provider's turn-taking.
An unchanged turn with a late delegation cannot restart its existing work.
Inside a finished worker's conversation, the opening transcript fragment captures
its exact ID and revision along with the note and selection. “Follow that
distinction”, a deictic result request or “stop that” uses this captured recipient,
even with another worker running. Explicitly named siblings can still be targeted.
Changing focus later cannot redirect the utterance; missing/revised targets
clarify, and stale evidence blocks a deictic continuation. The main conversation
still asks when several workers could match.
Supported continuation phrases share one local classification grammar, including
“explore that further” and “follow that please”; they do not need a second provider
delegation. Ambiguous “keep going” and speculative/quoted examples remain conversation.

A follow-up retains that worker's original selected passage and read-only child
scope. Omitting the scope cannot restore note-writing authority. Continuations
reuse validated evidence and completed reads; explicit scope changes use the
user's exact direction as the new focus and start a fresh plan. A new research
request returns the call to the preserved main conversation while that worker
runs. Named corrections can deliberately refresh stale evidence.
A new revision-guarded continuation may reuse the same phrase after Keep; the
existing save receipt still prevents saving the work-order identity twice.
Application-started work uses null delegation IDs for its context appends. Oversized utterances require clarification and preserve
their opening qualifications. Provider-generated routing text never grants write
authority. Cancelled or superseded router responses cannot start later work.

Read-only research tracks all opened evidence and provider/context settings;
unrelated note edits do not invalidate it. Creation, existing-note edit proposals
and ordinary Chat retain strict snapshot guards. Any edit intent discovered during
a voice read restores strict checking against the original full snapshot before
preparing a proposal. Clarification can complete without creation actions or a
save. Native provider errors preserve their returned message on the work order;
a generic failure does not establish that a note was missing. Each work-order identity has
one shared save reservation across revisions and Keep. Its stable receipt key
prevents late fuller transcripts, reconnects or concurrent Keep clicks from
creating a second note. A save is announced only after
the normal serialized vault writer confirms the note exists on disk. A failed
save keeps local edits and the usual conflict/error recovery available.

Mute gates microphone input while playback and admitted work continue. End call
immediately releases microphone tracks, silences playback and closes voice,
but allows already requested research to finish on screen. Collapsing or clearing
Chat and navigating within the current Space preserve the call. Starting Flow,
switching Spaces or closing the owning window ends capture and cancels its work.
Disconnected calls never restart the microphone automatically; Reconnect uses
bounded text context, quoted decisions/corrections and a current job/receipt
summary. It never reruns restored assignments or automatically replays their
announcements. Audio is not saved by Orion. Text stays transient unless
kept through a note creation action. A save also creates the ordinary Chat receipt.

Research state updates send changed fields for the affected job, including its
original ID and revision, rather than the complete job list. Confirmed receipts
send once, including receipts from an atomic save that finished after its job was
superseded. Findings use their separate stamped delivery path. Full bounded
snapshots are reserved for initial connection and manual reconnect.

The provider's validated `context_window.usage_ratio` on `session.usage.updated`
drives context pressure; missing/invalid values stay unknown or retain the last
valid value. At 80%, optional note excerpts and progress updates are suppressed.
At 85%, one reference-only checkpoint of at most 6,000 UTF-8 bytes carries current
navigation, quoted decisions/corrections, recent conversation, active IDs/revisions,
useful current findings and confirmed receipts. It rearms only below 75%. This
does not reconnect, rerun work or announce the checkpoint, and does not claim an
engine handover occurred. Jobs and detailed evidence remain in the application.

Complete spoken findings are
buffered separately and checked against their work-order revision immediately
before sending. Local energy monitoring uses the existing mic and playback
streams without another capture or duplicate playback; transcript activity is a
primary speech signal. A 1.5-second transcript quiet interval normally gates
offering a finding. Actual playback holds new speech offers until it ends and
a 1.5-second quiet interval passes. Arriving assistant transcripts keep that guard
active even when the local output meter reports silence. Input noise has a
twelve-second cap; arriving user or assistant transcripts and audible output
always retain their quiet guard. An overdue finding cannot override a person
still speaking, even when the input meter reports silence.
Interim findings get at most one unsolicited offer after user speech, at least
twelve seconds apart. Assistant transcripts, noise, silence and orb handoffs do
not renew it. A completed assignment's concise answer bypasses this interim
allowance and remains paced behind existing speech. Revision/sequence guards
prevent duplicate final announcements. Explicit requests and confirmed actions
also remain eligible independently. Detailed results remain in quiet context
and the work summary; opening a worker is never required to receive its finding.
The speech queue now follows research retention rather than dropping updates
after twelve, and the work list exposes every retained result rather than six.
At an eligible pause, automatic completions collect for 1.2 seconds, then up to
four enter a bounded reference packet with exact complete summaries, original
questions and worker-local sources. A fixed trusted instruction asks for one
brief contribution connected to the current conversation, preserving overlap,
disagreement and limited coverage. It is one transport chunk; worker prose is
never interpolated into instructions. Groups have an eight-second spacing and
never wait for the entire team. Explicit result/save responses take precedence.
Waiting for a pause and Shared with voice describe the local queue/send states,
not provider acknowledgments, completed playback or hearing. Read aloud remains
available on each finished job. Stop clears offers; internal orb handoffs retain
them and their grouping budget. Revised/evicted findings cannot be replayed.
Scope routing receives the validated short summary and coverage of retained
completed work so it can reuse known findings, without another planning hop or
copying detailed answers into routing context. Live conversational quality is a
separate acceptance requirement from these deterministic coordination checks.
Unrelated routing does not block eligible findings. Pending corrections still resolve first
under their bounded routing timeout, preventing obsolete findings from being
offered. GPT-Live has no explicit turn-end/audio-done event, so this remains an
approximation, not forced playback. Provider append ACKs
do not prove audible delivery, and already-sent commentary cannot be withdrawn.
Cancelled/stale queued findings are removed; an atomic save already in progress
may finish and retain its receipt even after cancellation.

Append chunks prefer complete sentences, then word and grapheme boundaries.
The current ceiling remains 480 UTF-8 bytes as a conservative bound on the
API's 500 tokens: a reliable GPT-Live tokenizer mapping has not been established,
so increasing it using a characters-per-token guess would break the limit for
some languages or content. Exceptionally long single words/graphemes fall back
to Unicode code points while preserving the complete text.

Playback failures release capture and offer a manual reconnect; late playback
errors cannot resurrect a stopped call. A graceful-close timeout confirms local
capture/playback stopped but reports that final service usage is unconfirmed.

## Selected text as priority context

Highlighting in either note reading or editing captures a local reference after
180 ms of settled selection. It shows a quiet **Selected text** cue in the call
pill without sending a selection update to the provider. Only an actual user
transcript publishes the passage bound to that utterance, through quiet reference
context. The voice uses it when the user refers to it, never acknowledging or
discussing a highlight merely because it exists. Unrelated speech continues its
own topic. Starting a call with text already highlighted also waits for speech.
Dictation remains independent. Voice controls preserve the capture; replacing the
highlight replaces it, while deselecting in the note, editing its contents or
navigating away clears the current selection.

The capture retains exact text, Space/note identity, the authored note version
and UTF-16 offsets within the displayed body. These offsets are never used as
Markdown citation or edit offsets. The first incoming user transcript fragment
binds the selection to that spoken turn. Later highlighting or navigation cannot
redirect the resulting worker. Research checks the captured version before
starting and reports a changed-passage error instead of silently using a newer
passage. Stale packets carry identity/version only, withholding text even from
the intent router. Ranges crossing unaccepted Chat or AI proposal widgets are
excluded because they do not belong to the authored note. Exact selection content stays local; voice packets have a 3.6 KB bound
and mark truncation. The shared Chat reader retrieves additional source passages
for a large selection. Only the raw current request can authorize creation or an
edit proposal; selected text is supplied separately as reference data. Checked
tasks and their continuation text remain masked unless that request explicitly
asks for completed-work history.

Source fixtures cover real NoteView read/edit selections, drag settling, keyboard
selection, control focus, replacement, deselection and navigation; transcript
binding across later highlights, bounded Unicode and 18,000-word selections;
and unchanged edit/write authority. These checks do not establish live speech
quality or provider compliance, which still need a microphone session.

## Completed tasks

MCP local reads and desktop context/research/search default to `task_view:
"working"`. Chat and voice use the same view, broadening only for an explicit
completed-work history request. The working projection masks completed Markdown
task lines and their continuation text before ranking, excerpting or provider
input. It suppresses cached overviews, note summaries, concept descriptions and
relationship context that could reintroduce completed work. Standalone decisions,
requirements and verification prose remain readable. Fenced code and frontmatter
are examples/data, not actionable task items.

The stored Markdown is unchanged. Working reads preserve original line positions;
MCP offsets count Unicode scalars, renderer evidence uses UTF-16. Evidence passages
are verbatim segments of the original text with original versions. MCP masked
bodies explicitly identify their projection and must not be used as replacement
bodies. Exact guarded edits, appends and checkbox changes operate on the original
vault under its normal lock. Legacy whole-body replacement of a note containing
completed tasks requires `task_view: "history"` and `expected_version` from a
fresh original read.

Use `task_view: "history"` on a scoped note/source/context read for a completed-work
audit or regression investigation. `orion_list_tasks` still defaults to `state:
"open"`; its explicit `completed` / `all` states are history access. Listing every
Space does not permit history mode. Prior completed content already present in an
agent's conversation cannot be erased; use a fresh conversation to verify the
working-view boundary.

## MCP access to existing workers

The native-issued `voiceTargets` inventory identifies one mounted window/session
and Space independently of its microphone or call state. Discover it through
`orion_get_capabilities`, then use `orion_list_voice_work_orders`,
`orion_get_voice_work_order` or `orion_control_voice_work_order` with the exact
Space and target. These are separate from ordinary desktop workflow jobs and do
not start calls, create unrelated workers, switch focus or navigate.

List exposes bounded metadata and a versioned inventory; further pages require
the same `inventory_version`. Detail requires the exact worker revision and
returns only a bounded public projection: supported findings, exact evidence,
public task decisions/questions and operation kinds. It excludes transcripts,
captured selections, internal model messages and hidden reasoning. Working view
withholds free prose from historical work because a paraphrase cannot be made
safe by masking checkboxes; explicit history remains a deliberate caller choice.
Stale support is separately withheld. Text budgets and omitted material remain
visible, and no result claims that a finding was spoken or heard.

Cancel, retry and steer require an exact revision plus `expected_control_version`
so a reservation's changing group cannot be mistaken for the same controllable
state. Caller-chosen request IDs deduplicate identical retained controls. Retry
and steer additionally require current AI permission and an eligible configured
provider. The new externally admitted revision is always read-only research:
quoted prior save/edit requests do not renew write authority. Cancelling reaches
one reservation or admitted worker without stopping voice or touching siblings.
A control receipt confirms admission/cancellation, not research completion.
Retry applies only to failed/cancelled admitted work; a waiting reservation needs
an explicit steer direction. Cancelling terminal work preserves its result.
Steering or retrying the currently focused worker is rejected until the user
returns to the main conversation, preventing indirect audio reconnection.

The finite shared protocol validates both requests and returned projections.
Native mailbox calls return immediately; the connector polls within a bounded
three-second dispatch wait. Exact window/session/Space ownership, permissions,
revision and request identity protect late responses. Public target heartbeats
contain no job prose or transcript. See [MCP intelligence](mcp-intelligence.md#existing-voice-work-orders)
for schemas, grants, pagination and retry semantics.

## Verification boundary

Automated fixtures cover filtered retrieval, original versions and line coordinates,
read-only storage, completion followed by fresh retrieval, explicit history,
bounded plans, parallel reference identities, spoken correction, stale/foreign
Space rejection, failed saves, replayed saves, edit review, transport cancellation,
and stopping capture independently of research. Browser/native UI and compilation
checks are separate from a live account/microphone/audio test. A real call still
needs verification of spoken correction during research, persisted creation and
its audible confirmation, reconnect, and Space-switch cleanup on the target Mac.

API references: [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc),
[client delegation](https://developers.openai.com/api/docs/guides/live-delegation),
and [session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations).

## Direct voice note edits

Explicit requests such as “make this tighter” bypass the research planner and
worker reservations. `VoiceNoteEdits` binds the captured note/selection, uses the
shared reader and validators with `purpose: edit`, and passes its proposal into
the real editor review. The first local read targets the note; the model chooses
focused edits or the full-rewrite handshake. A chat-only draft gets an internal
correction instead of being passed off as a completed edit. Creation is disabled,
strict snapshot freshness remains in force, and this lane cannot persist.

Delayed delegation cannot duplicate an edit. A new editing direction supersedes
pending preparation; unrelated conversation, workers and note navigation do not
retarget it. Cancellation and Space teardown discard stale replies. Ending voice
only closes audio. A preparing label and cancel control expose ongoing editing
without creating an orb. Review errors are surfaced, and applying still requires
Accept changes with the existing undo and autosave behavior.

## Response diagnostics

OpenAI progress commentary and a final structured message are extracted separately;
SDK aggregate text cannot corrupt the final JSON. Missing finals, invalid JSON,
reading instructions, checkpoints, replies and edits have distinct static error
codes, with no raw provider/note content in the diagnostic. Native read offsets
accept bounded integral JSON spellings such as `0.0` and `1e3`, matching browser
validation. These regressions cover known failure cases, not the exact unretained
payloads from the three failures reported on 12 October.

### Bounded answer recovery

A structured-reading parse failure (`CHAT_JSON`, `CHAT_STRUCTURE`,
`CHAT_FINAL_MISSING` or `CHAT_VOICE`) gets one format-only retry within the same
reading run and deadline. Completed reads, checkpoints and exact permissions
remain unchanged; rejected text is never repaired into a write action.
A second failure remains actionable. The separate general knowledge orchestrator
reserves its last allowed assignment turn for final synthesis before its safety
fuse, disables further coordination on that turn, and reports the final validation
failure without an extra loop. This change does not establish which live request
produced the user's earlier fuse error.
