# Space voice and working views

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: live voice conversations, voice workers and findings, voice selection, completed-task working views and the Chat composer's voice controls.

Read it before changing `src/components/SpaceVoice.tsx`, `src/lib/liveVoice.ts`, `src/lib/elevenLabsLiveVoice.ts`, `src/lib/voice*.ts`, `src/lib/taskWorkingView.ts`, `src-tauri/src/live_voice.rs`, `src-tauri/src/elevenlabs_live.rs`, `src-tauri/src/voice_synthesis.rs` and `src-tauri/mcp-server/src/working_view.rs`.

Related: [Chat](chat.md), [Desktop workflows over MCP](desktop-workflows.md), [AI providers and accounts](ai-providers.md).

## Space voice and completed-task working views

`SpaceVoice.tsx`, `liveVoice.ts`, `elevenLabsLiveVoice.ts`, `voiceResearch.ts` and
native `live_voice.rs` / `elevenlabs_live.rs` own optional conversations within the
current Space and window. `Settings.liveVoiceProvider` chooses `openai` or
`elevenlabs`; missing settings retain OpenAI. This choice is independent of note
narration and of the selected Intelligence connection used by research workers.
Note/deck playback respects the explicit `speechVoice` selection, including
System when an ElevenLabs key exists; missing cloud credentials produce the
existing configuration error rather than silently choosing another provider.
Settings loads the connected ElevenLabs account's paginated voice catalog after
key save/test and on opening with a configured connection. Keep that catalog
transient, preserve saved custom labels, and persist only chosen voice preferences.
Key replacement/removal invalidates pending catalog and Voice Studio responses.
Only a complete catalog may establish that an unchanged selection is unavailable;
failed or partial reads preserve it. Verification-required voices are disabled.
Never start the microphone or reconnect automatically. Authenticate OpenAI's
fixed-endpoint native SDP handshake with its Keychain entry, never a renderer key.
ElevenLabs uses a private Orion-managed ElevenAgent and a native-issued signed
conversation URL; the long-lived ElevenLabs key never crosses IPC. Its generic
agent record pins the provider's generated client-tool identity. Resolve and
verify that tool's exact configuration before use; subsequent agent updates
reference the verified ID instead of creating another inline tool. Accept the
provider's documented numeric/system-tool normalization and inert default
workflow layout, while rejecting additional tools or executable workflows.
The generic
agent policy contains no Space notes. Each call attaches compact context quietly
and uses the saved ElevenLabs voice. Before ElevenLabs startup, App flushes the
selected provider/voice through the existing vault save queue, awaits its real
save result, and rechecks the originating window's Space and persisted settings.
Stop, a failed save or a changed selection prevents the native handshake. Keep
this outside typing/autosave effects; never replace it with a fixed delay.
A provider switch stops the departing audio
without starting a new microphone or discarding admitted research, even if the
destination provider has no configured key. Require a fresh explicit call.
The SDK loads only when an ElevenLabs call is explicitly started. Its worklets
and sample-rate converter are bundled locally. Renderer CSP allows only the
fixed ElevenLabs conversation WebSocket path plus local IPC; WebAssembly support
is limited to the bundled converter, with no general JavaScript eval permission,
remote scripts or CDN audio worklets. Configure the managed agent with recording
disabled and zero-day scheduled transcript/audio deletion; this is not a claim
of enterprise zero-retention processing. Provider-side agent setup is generic,
and each call uses the existing Space-scoped research coordinator and authority
checks. A client-tool request never substitutes for the human transcript.
Only completed ElevenLabs user transcriptions enter that coordinator, once per
utterance. Capture the note, selected passage and focused worker at speech onset;
use that same target when its transcript arrives, rejecting an unmatched target.
Late transcription must not retarget a spoken edit to a newly opened note.
Keep audio storage off, input/output lifecycle bounded, and the selected Intelligence model
for research. Voice receives compact context and cited assignment results, not an
entire Space. Calls start silently and wait for the user to speak. Do not schedule
an opening instruction, synthetic user turn, greeting or introduction. A quiet
Listening label beneath the voice scene indicates readiness; Connecting and Mic
muted reflect the actual call state. Reconnect, navigation, worker switches and
Clear cannot trigger an unsolicited opening. The native policy also forbids
startup speech; context cannot initiate a topic. Natural pauses and unfinished thoughts remain listening
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
An explicit request for assigned workers to write notes uses host-owned saving of
their finished findings. Assigned providers remain read-only and cannot supply
note actions. The host validates the original human request and exact worker
IDs/revisions, waits for supported final results, then saves one note per worker
through the ordinary receipt-backed persistence path, up to three notes per
request. Do not silently reduce a larger group or change its requested output
count; continue research and explain the saving limit. While this save is pending,
readers should write useful finished content without save/refusal boilerplate or
unverified success claims. Serialize sibling saves, recheck supporting evidence
and capture the current write version immediately before each commit. A failed
save cannot block unrelated findings or produce a confirmed receipt. Preserve
per-worker save identity across retries so a failed flush cannot duplicate notes.
Saving runs in the background and never blocks the ongoing voice conversation.
A focused finished worker can respond to an explicit deictic request such as
Turn this into a note by saving that captured revision without repeating research.
A request for a different topic must retain its ordinary writing route. Generated
scopes, old conversation and external/MCP work orders cannot grant this authority.

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
strips model-supplied writes. Explicit host-authorized saving of finished findings
uses the bounded persistence path above. Existing single-worker explicit save/edit
requests retain their normal authority and review flow.
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
once; additional jobs queue internally and remain cancellable through voice,
orb dismissal or Stop research. Execution deadlines begin only on dispatch. Retention bounds 24 terminal records,
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
Retained findings, cancellation outcomes and actionable failures appear in the
conversation. Do not expose worker queues, counts or delivery-state badges.
Internal delivery states distinguish prepared, waiting, failed and locally sent;
sent never proves provider acceptance or audible playback. A failed synthesis
preserves research and exposes Retry voice summary without a continuous retry loop.
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
commentary cannot be retracted or treated as heard. Keep result controls alongside their findings in
the conversation. End voice immediately releases capture and closes
the connection while already requested work can finish. ChatDock owns the
mounted call outside its hidden Chat panel. Collapsing Chat and note or
view navigation preserve it. Creating or switching conversation threads waits
until live voice ends; stopped findings retain their original thread. Flow,
Space changes and window teardown close
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

The Chat composer begins as a thin, single-line pill and grows with wrapped or
multiline text, bounded to keep long drafts scrollable. Re-measure only draft or
width changes, never audio frames. Its primary action is Send for a nonempty
draft, a square Stop response while text generation can be cancelled, a square
Stop voice for an empty active call, and the audio-wave start button while idle.
Sending/cancelling text does not end or restart voice. During a call, standard
Mic/MicOff and Voice options controls sit inside the same pill. End voice call
also remains in Voice options when Send or Stop response occupies the primary
position. No duplicate Talk to Space strip or second stop button appears above
the composer. Starting voice from the sidebar leaves the current note open;
ordinary Chat navigation still opens Chat. The collapsed bottom-right glass pill
retains mute/end, Chat and Voice options.
Retained research, errors and clarification keep ownership of that dock after audio
ends: hide the ordinary Chat circle and native circle glass whenever voice controls
remain visible. Report only visibility transitions to ChatDock, never audio frames.
In compact Chat, Voice options contains View conversation, Stop research and Clear voice chat, plus
Return to Space conversation for a focused finding. Its popover keeps the pill's
width and does not change the Chat layout; closing it or Escape returns focus to
the options button. Research findings, citations, saved-note links and actionable
errors appear in compact Chat's conversation through a stable results portal. There is no
worker list, queue count or delivery-state badge. Interim findings use a closed
Latest finding disclosure, completed findings show their answer directly, and
Retry research, Retry voice summary, Read aloud, Discuss by voice and Keep as note
retain their existing authority and revision checks. Clearing voice work restores
the ordinary Chat launcher. No result opens Chat or captures the writer's cursor.

The full main Chat screen presents voice workers through their orbs and spoken
responses only. `ChatDock` passes `hideConversationText` to its retained
`SpaceVoice`: do not mount worker Markdown, progress, receipts or View conversation,
and do not publish worker content as a reason to reveal or expand the text pane.
Ordinary typed Chat history remains visible. Research, routing, spoken summaries,
captured ownership and retained findings continue unchanged. Keep actionable
disconnect/clarification notices with voice controls, and preserve Cancel note
changes in Voice options during edit preparation. Switching between full and
compact layouts changes presentation only, never restarts the call or research.

When either full or compact Chat is open, the same call renders its orb scene
inside Chat and integrates controls into the composer; no fixed pill overlays Chat.
The idle welcome also uses the orb identity. Stable presentation portals keep
the call owner outside the hidden/remounted Chat view and retain its motion model.
Keep transcripts transiently for delegation, without elapsed-time or provider
copy in the composer.

Compact Chat with an active call opens on voice alone, with no empty text section.
Submitting a typed prompt reveals only that prompt's measured height and normal
padding, bounded by the window for long prompts. Replies do not enlarge the panel
automatically; a New reply cue gives explicit access. Scrolling down grows the
whole panel upward, keeping its bottom, controls and composer anchored, as the
voice scene yields to messages. Once expanded, ordinary message scrolling takes
over. Upward scrolling must reach the first message before a further upward
gesture shrinks the panel back to voice. Conversation/New reply and Voice buttons,
plus focused Home/End/Page/arrow keys, offer alternatives to scrolling. Respect
reduced motion, nested scrollable content and composer input. This mode is local
presentation, never persisted: `useVoiceChatScroll.ts` owns bounded geometry,
observers and event cleanup, updating CSS per frame without rerendering the whole
conversation. Preserve the mounted call and draft through collapse, navigation
and full Chat. Passage Chat keeps its own reading layout.

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

The Voice options menu's Clear voice chat action requires an inline confirmation and
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
