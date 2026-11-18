# Live voice constellation

The production `VoiceConstellation` is a bounded Canvas 2D presence derived from
the separate gravity study. Its central orb and completed worker conversations
share the live transport's input/output activity. It has no simulated audio,
phrase timer, provider calls, note writes, or microphone ownership.

## Audio contract

`LiveVoiceConnection.onActivity` retains `inputActive`, `outputActive`, and
`measured`, and supplies `inputLevel`, `outputLevel`, `inputMeasured`,
`outputMeasured`, and `inputMuted`. Levels are 0–1 smoothed local PCM energy,
sampled at approximately 30 Hz. The existing brief boolean activity hold remains
for conversational delivery timing; visual expression uses the continuous
levels, so a pause visibly settles even during that hold.

Input uses the existing microphone track. Output observes the existing remote
track and is additionally gated by the playing, audible HTML audio element.
Received text, work findings, and context acknowledgements cannot animate speech.
This measures local playback activity, not proof the person heard or understood
an answer. Unavailable measurement yields zero rather than invented speech.

Mute immediately gates the input track and clears its envelope. It preserves
remote playback, the connection, and independent work. A mute chosen during
permission or network negotiation also applies when that call starts. Suspension,
playback waiting/pause, ended tracks, close, and disconnection clear affected
activity; disposal releases the analyser graph and sampling interval.
If every microphone track ends permanently, disconnect with an actionable
capture-loss message and clear both animation envelopes. Keep admitted research
available and require an explicit reconnect; never recapture the microphone
automatically. A temporary track mute can recover in the existing call and does
not stop remote playback. Remove capture listeners before deliberate disposal.

## Motion and interaction

- Both full Chat and its compact panel show the orb identity in their welcome
  state. An active call replaces that welcome with the interactive live scene
  with a quiet readiness cue below it. Mute and Voice options share the composer
  pill; its primary action becomes Send for a draft and a square Stop when empty.
  There is no fixed call overlay while Chat is visible. Existing messages retain
  their scrollable thread without shrinking the constellation when the first reply arrives. Collapsing Chat restores the
  bottom-right pill and expandable scene without restarting audio or work.
  `SpaceVoice` stays mounted outside the hidden Chat panel; presentation portals
  target stable scene/control slots. Its retained motion model survives portal
  moves and clearing Chat. Portal controls handle Escape and restore focus to the
  visible call control when the compact panel closes.

- The currently focused conversation reacts to listening and output energy.
  Selecting a completed worker moves both poses to that worker; the main orb
  retains its separate receiving reaction when findings arrive.
- The approved gravity study supplies the asymmetric worker angles, working/ready
  orbit radii and depth. Expanded Chat uses a central body about 2.2 times its
  previous diameter (roughly 195 px at the full 360 px body reference), keeping the
  Jelly glass material. Expanded fields have up to 1.5 times the previous width
  and height, with the old body size measured separately so the main orb stays
  the same size. Short conversation layouts use a wider rectangular field within
  their existing row, with independent horizontal/vertical projection. Worker
  bodies are 14% larger and background/reserve beads 18% larger. Satellite contact
  and viewport fitting keep the main body fixed; dense groups may reduce satellite
  sizes instead. Sidebar and pill proportions
  remain compact. Expanded positions preserve the original asymmetric angles and
  varied inner/outer distances through a bounded radial map, rather than packing
  inner bodies onto the enlarged rim. Drag coordinates use the inverse map, with
  continuous centre crossings and outward dismissal. Four inactive reserves and 23
  mixed-size ambient circles form the resting field. Jobs promote those existing
  circles; further workers promote ambient positions, then add their own stable
  bodies. Larger groups use denser, smaller separated orbits while preserving the
  approved first six. Small copies simplify the visible field for legibility;
  the conversation retains all findings, with cancellation available by voice
  or Stop research in Voice options.
- Stable worker identities survive routing, clarification and dispatch. Real increases in
  `updates[].sequence` emit a filled bead toward the centre. Its arrival gives a
  finite dip, squash and rebound after the same 1.2-second flight used by the
  renderer. Completion has a separate settling bloom.
- Researching workers cannot enter a conversation. Only a completed job with a
  result can be opened. Delete or an outward drag delegates dismissal to the
  host. `dismissedJobIds` shrinks the same body into a small companion without
  removing the job or its findings. Focusing that completed job restores it.
  Switching recipients preserves queued sibling findings until the main voice
  is active again. A stale or evicted focused result returns an ongoing call to
  the centre; after Stop or disconnection it only clears focus, without opening
  another microphone connection. Dismissing a focused orb follows the same rule.
- An interim result in the conversation offers a closed Latest finding disclosure using
  the normal cited reply renderer and exact coverage. Opening it only displays
  that evidence; arriving findings cannot open Chat or move the writing
  cursor. Cancellation outcomes remain actionable through explicit Retry research,
  using the retained validated checkpoint. A saved receipt that won a cancellation
  race remains navigable and does not offer a duplicate-save retry.
- The small companions share a slow orbital current with radial damping, gradual
  attraction/pressure near workers, 450 ms force inertia, and contact resolution.
  Stable full-gesture collision envelopes prevent speech syllables or receipt
  reactions from kicking surrounding bodies. They contain no
  random impulses, speech bounces, or independently oscillating drift.
- Sidebar (20 px), pill (46 px), and expanded views retain distinct minimum
  circle sizes and resolve contact after pixel projection. There are no labels,
  arrows, mesh lines, or trails within the canvas. Expanded hit targets provide
  accessible names and keyboard focus; small copies can be noninteractive.
- Live palette changes preserve the motion instance. Pass `resolveIconPalette`
  output for the exact adaptive-icon palette. App supplies its memoized resolved
  palette through both the sidebar and Chat dock to every production presence.
  One SpaceVoice-owned motion model feeds the sidebar, pill and expanded scene.
  `advanceAt` shares one snapshot per animation timestamp, so rendering multiple
  sizes never advances the simulation twice. Palette changes recolour the next
  frame without rebuilding it.
  The fallback reads the current
  room accent. Reduced motion uses stable poses, and offscreen/document-hidden
  previews pause without advancing a backlog of elapsed motion. DPR is capped
  at two and rendering at 30 frames per second.

## Multiple workers and clarification

Ordinary substantive research questions reach the host scope planner without
requiring a delegation tool call or worker wording. The planner chooses a direct
conversation, one reader or usually two to four complementary independent readers;
simple definitions and conversation retain their direct path. Whole-Space reading
can select one to four readers from note count and text workload locally, partitioning
note IDs exactly once without a planning-provider call. Explicit counts remain exact.
Scope decisions use low reasoning effort; actual research retains the saved model
and effort. Generated scopes never grant permission to save or edit.

OpenAI and ElevenLabs share this host admission. Their voice policies ask for the
whole original request once and let the host choose a useful team. ElevenLabs keeps
its asynchronous, nonblocking delegation tool and refreshes the verified policy at
the next explicit call startup. Late tool events cannot duplicate admitted workers.
Within each shared Chat/voice reader, independent web requests overlap in bounded
pairs and merge evidence in request order. Dependent follow-ups stay sequential.

An explicit request for several orbs creates distinct work orders rather than one
worker with a plural prompt. Each pending orb stays present while Orion asks for
missing topics; unrelated conversation does not consume that question. A reply
uses the original note and selected passage even if the user has navigated.
Short reference answers such as “this note” or “what I highlighted” can supply
the missing topic. They still require a validated scope for every reserved
worker, and do not grant permission to save or edit. Ordinary comments and mixed
new instructions must not be mistaken for one of these reference-only answers.
The scope planner receives the original note's exact ID, bounded title and
current content version as reference metadata. It receives no note body or
summary; the research reader opens evidence later. A missing or ambiguous
original note identity keeps the group waiting for clarification rather than
substituting another note.
Cancelling a waiting orb invalidates in-flight answers that referenced its former
group. Late responses cannot revive it or duplicate a sibling's identity.

The old six-worker admission limit is removed. Up to ten workers research at once,
with additional named assignments queued internally and individually cancellable.
Queue counts and worker lists are not shown in the interface. Planning pages of
24 scopes are automatic; all pages must validate before the batch begins.
A 1,000-worker per-request allocation guard rejects excessive counts explicitly,
without imposing a cumulative six-orb cap. Queued time does not consume the
research deadline, and active/queued identities are never evicted by terminal
history retention. Child scopes are read-only: generated scope text cannot grant
permission to edit or save notes.

## Verification boundary

The November 16 automatic-worker update was checked with the real host router and
simulated OpenAI/ElevenLabs transports: ordinary comparison questions admit separate
workers, original reservations survive, and late delegation cannot restart either
the initial plan or its continued transcript. Existing-result questions keep their
original worker. Shared-reader deferred-request tests prove paired overlap and
ordered evidence publication, including failure, cancellation and deduplication.
These checks do not measure live provider latency or exercise a microphone call.

The enlarged production component was rendered in the real Chat layout at
1416×900 and 640×720 with isolated fixture jobs. Settled workers remained visible,
clickable and keyboard-focusable; geometry tests cover 0, 3, 10 and 24 workers.
Captures and the fixture are under `output/playwright/automatic-workers/`; the
scoped visual review is `.impeccable/review/automatic-workers/orb-review.md`.

Focused automated checks cover PCM envelope behavior and cleanup, startup mute,
playback gating, stale activity, live level-driven motion, worker identity,
finding and completion transitions, visible shrink/restore, retained results,
small-size collision projection, reduced motion, and bounded frame gaps.

Mocked PCM, browser UI, and native packaging checks do not prove microphone,
provider audio delivery, output-device latency, or that a spoken result was heard.
Those require a separate explicit live voice acceptance run in the native app.

An additional isolated browser check uses two local WebRTC peers, generated PCM,
and the production `LiveVoiceConnection`, `AudioContext` analysers and canvas.
It runs in headless Chromium with device output suppressed, uses no real
microphone, and rejects external requests. Input/output onset, emphasis, mute,
playback gating, settling, transcript-only silence, three-worker receipt cues
and disposal passed. The run observed input/output onset within 77/114 ms and
settling within 979 ms; these are local harness observations, not provider or
device latency guarantees. It requested one generated input stream and observed
no external request or page error. Reports and screenshots are retained under
`outputs/voice-constellation-qa/local-audio/`; `audio-smoke.mjs` reproduces the
check against that isolated fixture server. This strengthens the local audio
plumbing evidence without closing native live-voice acceptance.

The 11 October capture-loss regression also passes with actual local WebRTC and
analysers: ending the generated input track and explicitly dispatching a simulated
hardware `ended` event disconnects the call, clears both envelopes, retains three
worker orbs and makes no second capture request. This is simulated device loss,
not a physical microphone-removal test. The report and screenshots are in
`outputs/voice-constellation-qa/local-audio/20261011-capture-loss/`.
Reproduce with `ORION_AUDIO_QA_OUTPUT='./local-audio/20261011-capture-loss/' node
outputs/voice-constellation-qa/audio-smoke.mjs` while the isolated fixture server
is running.

The separate clarification browser regression drives the real sidebar and spoken
request form through three waiting workers, unrelated conversation, navigation,
“this note”, three incremental findings and one completion. The same three IDs
and original note survive throughout; the actual scope-planning packet contains
only the original note's bounded reference metadata. It uses a deterministic
provider and simulated voice, with no external requests or page errors. Evidence:
`outputs/voice-constellation-qa/multiple-workers/20261011-clarification/`;
runner: `outputs/voice-constellation-qa/multiple-workers/clarification-smoke.mjs`.

### Expanded glass materials

Expanded Chat scenes and the idle Chat welcome offer Jelly or Mirage clear for
the main orb, with simple Cellular echo workers. Their colours resolve from the
existing Home shader tone, custom colours and active theme. Light mode gently
lifts colour and transmits 12% more of the background. Sidebar and pill icons
retain the lightweight 2D renderer, also used for unavailable/lost WebGL and
increased contrast.

Horizontal mouse movement turns the main material, vertical movement tips it,
and diagonal sweeps combine both. The shell and the slower interior turn in
opposite directions around the same view-space axis and coast as the mouse
stops or leaves the scene. The rotations apply to material shading. Reduced
motion freezes material animation. Each expanded scene owns one low-power offscreen
WebGL context, released on unmount; offscreen/hidden scenes skip rendering.
