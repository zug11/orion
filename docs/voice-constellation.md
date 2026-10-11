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
  and docks mute/end and work controls above the composer in normal layout flow.
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
  orbit radii, depth, and central proportion. Four inactive reserves and 23
  mixed-size ambient circles form the resting field. Jobs promote those existing
  circles; further workers promote ambient positions, then add their own stable
  bodies. Larger groups use denser, smaller separated orbits while preserving the
  approved first six. Small copies simplify the visible field for legibility;
  the work summary retains access to every admitted or queued worker.
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
- A running work-summary row offers a collapsed Latest finding disclosure using
  the normal cited reply renderer and exact coverage. Opening it only displays
  that evidence; arriving findings cannot open the work panel or move the writing
  cursor. Cancelled rows remain available and resume only through explicit Retry,
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

The old six-worker admission limit is removed. Three workers research at once,
with additional named assignments queued and individually cancellable. The UI
separates researching, queued and waiting-for-details counts. Planning pages of
24 scopes are automatic; all pages must validate before the batch begins.
A 1,000-worker per-request allocation guard rejects excessive counts explicitly,
without imposing a cumulative six-orb cap. Queued time does not consume the
research deadline, and active/queued identities are never evicted by terminal
history retention. Child scopes are read-only: generated scope text cannot grant
permission to edit or save notes.

## Verification boundary

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
