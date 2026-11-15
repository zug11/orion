# Desktop workflows over MCP

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the optional workflows a connector runs through the open app: research, import, generation, editor context, editor actions, edit review and voice work orders.

Read it before changing `src-tauri/shared/`, `src-tauri/src/assistant_*.rs`, `src/lib/assistant/` and `src-tauri/mcp-server/src/workflows.rs`.

Related: [Claude connector and Codex plugin](mcp-connector.md), [Space voice and working views](voice.md), [Vault storage and windows](vault-storage.md).

## Optional native desktop workflows

The shared connector now exposes 64 tools: 39 local library tools, 14 desktop
workflow/capability/job tools, three native edit-review tools and one read-only
active-editor-context tool, plus three finite voice work-order tools and four
captured-editor-generation tools. The optional workflows are
`orion_get_capabilities`, `orion_get_context`, `orion_research`,
`orion_search_space`, `orion_export_word`, `orion_import`,
`orion_reprocess_sources`, `orion_generate`, `orion_develop_concept`,
`orion_enrich_knowledge`, `orion_refresh_overview`, `orion_get_job`,
`orion_list_jobs`, and `orion_cancel_job`.

`orion_list_voice_work_orders`, `orion_get_voice_work_order` and
`orion_control_voice_work_order` address existing voice workers through an exact
`orion_get_capabilities.voiceTargets` identity. These are separate from ordinary
workflow jobs. The owning library window advertises its current Space even while
audio is idle; note/Chat navigation and Stop preserve that identity, while a Space
change, window close, retired renderer session or expired 30-second lease removes
it. Writing windows cannot register. Native registration trusts the library
renderer to report its current Space, then binds that exact Space/window/session
to an opaque target; it never silently chooses another window.

`src-tauri/shared/voice_work_orders_protocol.rs` owns strict request and bounded
response validation. `assistant_voice_work_orders.rs` owns a separate authenticated
socket mailbox: immediate request/receipt handling, eight pending requests, 32
retained receipts, 64 owners and at most 128 active external revision grants.
The MCP caller polls within three seconds. Controls require a unique idempotency
key, exact worker revision and opaque control version. A native decision claim
precedes mutation; recheck the renderer's version after that asynchronous claim.
Cancel is a no-op on terminal jobs, preserving findings. Read/cancel need enabled
desktop access to the exact Space but no AI or write grant; retry/steer additionally
need AI permission and a ready selected provider. Neither path grants note writes.

`src/lib/assistant/voiceWorkOrders.ts` sends only identity/readiness heartbeats.
`voiceWorkOrderHost.ts` merges admitted workers and pending reservations without
cloning their captured context. Stable inventory versions guard subsequent pages;
reservation generations guard revisions still numbered 1. Steering a waiting
worker admits that same ID with its original note/selection, consumes only that
member and invalidates dependent clarification routes. Admitted retry/steer uses
the existing reader with host-enforced search-only authority. Every provider
stage and result publication rechecks the exact native grant under a fresh vault
lock; revocation, owner loss and mailbox failure cancel only external revisions.
Terminal/superseded grants are released. No MCP operation controls the microphone,
playback, call connection, conversational focus, selection, navigation or saving;
external findings remain inspectable without unsolicited spoken commentary.
Reject external retry/steer of the currently focused worker before and after the
native claim; ask the user to return to the main conversation first. This prevents
the existing stale-focus handoff from reconnecting audio as a control side effect.

Public details expose bounded exact findings, evidence ranges, coverage and public
checkpoint decisions/open questions/finite next operations, never raw transcripts,
captured selections, discovery dumps, queries or private provider reasoning.
Working reads withhold all history-derived freeform content, including paraphrases;
explicit history is required to inspect it or continue/retry its scope. A new
working scope drops historical memory. Stale evidence also withholds content.
Return exact UTF-16 fragments, Unicode-scalar omissions and one shared max_chars
budget up to 12,000. This source/fixture contract is separate from installing the
updated connector or validating real voice/provider behavior.

`orion_get_editor_context` reads one exact native-issued
`orion_get_capabilities.editorTargets` entry. It requires enabled desktop
workflows and the exact allowed Space, independently of AI/write grants or a
voice call. `src-tauri/shared/editor_context_protocol.rs` owns its finite schema;
`src-tauri/src/assistant_editor_context.rs` owns a separate read mailbox. The
authenticated socket handles request/get immediately; the MCP tool polls within
a three-second bound, so waiting for a renderer cannot block research control.
Keep at most eight pending reads, 64 targets and a 30-second target lease.
Responses are consumed once; do not retain selected text as job history.

`src/lib/assistant/editorContext.ts` advertises only exact note/Space identity and
readiness. It sends text only for an explicit read. NoteView supplies the current
authored document ahead of parent/save debounce, with no forced flush; Flow,
unaccepted Chat review and generated writing previews are unavailable. A
selection drag becomes pending before the 180 ms settling period. Preserve
captures when other controls take focus, but invalidate them on navigation or
authored changes and recheck after an asynchronous poll.

`src/lib/editorSelectionContext.ts` projects the local capture before IPC. Working
view omits completed-task text; explicit history may include it. Return bounded
exact fragments and original DOM UTF-16 offsets, with scalar-count omissions and
truncation. Rich-editor carets use real ProseMirror positions; reading carets use
DOM UTF-16. A cursor supplies no surrounding prose and never becomes voice
context. Bounds are 12,000 Unicode characters and 128 fragments. The prefixed
`documentVersion` is a displayed-document fingerprint, not a native persisted
`expected_version`; it cannot authorize a direct write or edit-review proposal.
Readiness changes retain the target ID; changing its note, Space or renderer
session invalidates the old target. Native caller window ownership is implicit,
including immutable writing-window routes. Never silently pick another window.

`orion_capture_editor_action`, `orion_start_editor_action`,
`orion_get_editor_action` and `orion_cancel_editor_action` use the separate
`editorActionTargets` capability and native mailbox in
`assistant_editor_actions.rs`, with the strict shared
`editor_actions_protocol.rs` contract. Capture binds one finite Write amount,
Rewrite preset or Image quality/context choice plus bounded instructions to the
actual ready rich editor. It performs no generation, navigation or editing.
Never use the read-only context tool's DOM offsets as edit authority. The native
capture ID binds window/session/Space/note, actual ProseMirror selection and
effective target, displayed-document and selection versions, and an exact
persisted-note baseline. Original rich data stays local; the native mailbox
receives bounded private baseline/captured bodies only to verify freshness.
Public receipts expose no note body, generated prose or image bytes.

Start consumes that capture with an idempotent request ID; changed arguments or
a changed document/selection require a new capture. Do not revive an old capture
after moving the selection away and back or undoing a document change. A normal
autosave of the exact captured draft may advance only its body and update time;
other persisted edits invalidate it. The mailbox retains at most eight pending
actions, 32 receipts and 64 owners, with a 30-second owner/capture lease, three
seconds to answer a capture, 20-minute operation limit and bounded private text.
It is independent of the research executor. Flow, dictation, local composers,
uploads and existing reviews make new captures unavailable.

External generation requires enabled workflows, the exact allowed Space, AI and
workflow-write grants. Every actual native text/image provider dispatch and
publication checks its exact action/window/session grant and current settings.
Image research uses the existing low-effort reader stages and configured effort
for composition. External Enrich and Related Space image requests require the
saved existing-note context preference; they cannot substitute for the local
UI's explicit per-action consent. Authority travels as a separate native invoke argument,
never in model context; browser provider fallbacks reject it.

`src/lib/assistant/editorActions.ts` coordinates the owning App's mailbox with
the real rich editor via `editorActionHost.ts`. Local Accept must await a native
claim, then recheck the captured rich document before the existing one-Undo
transaction. Image bytes are persisted only after that claim. Discard or
cancellation before acceptance cannot mutate authored text. A physical text
provider request may finish after cancellation; keep its scheduler slot until
settlement and suppress its late result. External generation Retry requires a
fresh capture rather than silently repeating paid work.

Record the actual serialized body after acceptance and flush through the normal
revision-guarded save queue. Only fresh disk equality yields a `saved` receipt
and note citation; an accepted editor edit and a saved note are distinct states.
Save failure preserves the local edit without replaying insertion. An already
accepted transaction may finish saving after navigation in its owning session.
These implementation and fixture contracts do not establish installed-client,
live-provider or native interaction acceptance.

`orion_propose_note_edit`, `orion_get_edit_review`, and
`orion_cancel_edit_review` use a separate transient review lane. They do not
occupy the ordinary executor while a person considers a proposal. Discover
native-issued targets through `orion_get_capabilities.reviewTargets`; each is
bound to an actual window, renderer session, active Space and open note.
Submissions require an exact target, note and current opaque version. Never
navigate another window or switch its Space to satisfy a submission. Writing
windows additionally retain their immutable native note route.

Review access requires enabled workflows, the exact allowed Space and write
permission, but no AI permission or provider call. Reuse the existing in-note
focused/full-rewrite validation, decorations, Accept/Discard and one Undo.
Submitting or discarding a proposal does not mutate the note. A native decision
claim must precede acceptance; cancellation cannot pretend to undo a claim or
accepted edit. Receipt states distinguish editor acceptance from verified disk
persistence. Save failures retain the accepted local text and existing conflict
UI; never replay the transaction or report a saved citation before checking the
persisted body. The review is transient and independent of Chat history.
Completed-task working views cannot become whole-note replacements; explicit
history is required for a rewrite when the original has hidden completed tasks.
Keep source bodies and proposal base bodies out of external receipt/target data.

`src-tauri/shared/assistant_review_protocol.rs` owns the finite external review
schema. `src-tauri/src/assistant_review.rs` keeps its separate bounded native
mailbox and receipts; it never writes the vault or calls a provider. Review
commands receive the real Tauri caller window implicitly. Writing-window targets
must match their immutable launch route. `src-tauri/shared/note_version.rs`
preserves the independent MCP crate's existing opaque v1 projection for native
version checks. Do not substitute renderer timestamps or body-only hashes.

`src/lib/assistant/editReviews.ts` registers a window-local mailbox independently
from the single research executor. The App supplies its existing serialized save
queue and the real note surface supplies readiness. A proposal may enter review
in the same note's reading surface but must never navigate to a different note.
The rich editor awaits a native acceptance claim, then rechecks its document and
review identity before the existing single Undo transaction. Capture the actual
serialized body after normal React updates settle; only native verification of
that body on fresh disk can report `saved`. A failed receipt or save must never
replay the editor transaction. Keep local accepted text available to resolve a
save conflict. An admitted transaction may complete after navigation while its
window/session remains alive. Revoked grants prevent new proposals/claims.

Review targets have a 30-second lease; at most 64 live sessions, eight pending
reviews and 32 retained receipts are allowed. Limit individual base/accepted
bodies to 2,000,000 bytes, retained body/edit memory to 16 MiB and encoded
deliveries to 2 MiB. Pending reviews expire after 20 minutes; terminal receipts
after one hour. There is one pending review per target. Unknown fields and
caller-supplied acceptance, model, title and base-body arguments are rejected.
Keep a stable renderer session across ordinary navigation and grant changes;
when idle with no permitted target, it need not poll native storage.
The workflow, editor context/action/review, and voice work-order heartbeat
commands are asynchronous and run their blocking mailbox work on Tauri's
blocking worker pool. Shared vault locks and fresh permission/version checks
remain inside those workers. Never put periodic vault parsing or lock waits on
the AppKit input thread; a small active note still shares a larger library.

- `src-tauri/shared/assistant_protocol.rs` defines the strict, bounded request
  contract. `src-tauri/src/assistant_bridge.rs` owns the per-user Unix socket,
  private descriptor/token, opt-in grants, queue, renderer lease, and commit.
  `src-tauri/mcp-server/src/workflows.rs` is a credential-free local transport.
  No separate daemon or TCP endpoint starts. The running app alone accesses
  Keychain and providers through existing native commands and scheduling.
- Optional `Settings.assistantAccess` hydrates to disabled for older vaults.
  Connections independently enables workflows, API use, workflow writes, and
  exact allowed Space IDs. These grants do not replace the installed connector's
  existing direct read/write access. Never let tool input override a grant,
  selected model, or existing-note AI-context preference.
- Every workflow requires explicit `space_id` and `request_id`. Jobs deduplicate
  identical retries while retained: at most 32 jobs or one hour, lost at app exit.
  Cap queued/active jobs at eight, retained input at 16 MiB, MCP messages at 8 MiB,
  and each result at 2 MiB. The renderer executes one job at a time, with a
  20-minute cancellation deadline and the existing provider scheduler bounds.
  Cancellation prevents new stages and late note commits; an atomic commit that
  already started finishes. Never release a physical provider slot early.
- `src/lib/assistant` reuses the existing import, generation, linked-article,
  enrichment, and hierarchical-overview engines. Context/research return exact
  versioned excerpts, host-built citations, partial coverage, and explicit AI
  interpretation. Research never writes notes or Chat. Follow-ups reject stale
  prior Space versions. Unknown usage is not zero or a dollar estimate.
- `assistant/research.ts` runs desktop MCP research through `runChatReading` in
  read-only search mode, followed by one structured findings-synthesis call.
  The bounded reader can use up to six calls; synthesis adds one. Explicit
  note/source IDs are priority references, not an exclusive corpus. The full
  supported question and comparison material remain reference context, without
  Chat history, active editor selection or write authority. Findings may cite
  only retained exact evidence; directories and prior interpretations are not
  evidence. `researchCheckpoint.ts` validates host-produced task memory from a
  succeeded prior job in the same Space, snapshot and working/history view.
  Retain at most 1,000,000 UTF-8 bytes with explicit continuity omissions inside
  the existing 2 MiB job-result contract. Missing older checkpoints start fresh;
  malformed or stale checkpoints fail. This does not retain hidden reasoning.
- `orion_search_space` explicitly runs the same adaptive exact-passage AI search
  as the app, with a 600-character query bound, no Chat history or note actions,
  immutable Space context, configured-provider policy, and partial coverage.
  MCP answers convert transient renderer anchors to stable Space-scoped note
  citations; source evidence retains its exact source ID/range and bounded
  related-note navigation. Never invent a native source route.
- `orion_export_word` accepts only `scope` (note/linked/space) and an exact
  `note_id` for note/linked scopes. It makes no provider call and changes no
  vault state. The running app prepares an editable DOCX and asks the user for
  its destination through Save As. No caller path is accepted. The native
  Word exporter checks the job lease, operation, grant, cancellation, and
  persisted Space freshness before the dialog and just before atomic replace.
  Native export enters the shared `committing` state for the atomic replace and
  records its own terminal result so cancellation or subsequent content changes
  cannot relabel a saved file or lose its chosen path.
  Existing enabled-Space workflow access is required; the note-write/API grants
  remain independent. A cancelled dialog returns `cancelled: true`.
- Import preserves all extracted source text up to its explicit 1.8 MB total
  bound. File inputs are exact paths from the captured request: native code
  validates regular files, extensions, and document/media bounds before using
  existing parsers, Vision OCR, Whisper, or HTTPS/YouTube fetching. Reprocessing
  passes original source IDs into `buildImportPayload`, preserving original
  timestamps and citation targets. Local recovery must be reported as recovery,
  never completed AI synthesis.
- Flush and freeze context before dispatch; reject changed knowledge, permissions,
  or settings. Commit through the existing advisory lock, expected revision,
  and atomic writer. Native scope validation prevents deletions, settings changes,
  or changes to another Space. Renderer saves coalesce against the latest live
  vault so a queued autosave cannot undo a workflow commit. Edits made during the
  commit window are merged as subsequent user edits, without resurrecting deleted
  records. Return saved citations only after atomic persistence succeeds.
- Workflow commits suppress automatic overview calls for that content version in
  the running app; explicit overview refresh or the next independent knowledge
  edit resumes normal maintenance. Local import must not trigger a hidden paid
  refresh immediately after completion.
- Private descriptor mode is 0600. The MCP transport verifies exact canonical
  vault identity, socket directory, and protocol before connecting, including
  advanced vault overrides. This is same-user OS authority, not verified identity
  of a particular assistant client. Never expose the token through MCP results.
- Include `src-tauri/shared` in release fingerprints. Test the exact packaged
  executable, not only source-level tool definitions. See
  `docs/mcp-intelligence.md` for the scope and verification contract.

`npm run build:mcp` compiles and ad-hoc-signs the binary, packages the manifest,
icon, documentation, and server into `.mcpb`, extracts the exact package, checks
its signature, and runs the protocol harness. It publishes a standalone package
under `outputs/` and the copy bundled by Tauri under
`src-tauri/resources/Orion-Claude-Connector.mcpb`.

Release builds stamp `Orion.app` with a deterministic fingerprint of the UI,
native host, MCP server, manifests, locks, and release scripts. The packaging
script must reject `--use-existing` when that stamp is absent or differs from the
current source. This prevents an older app bundle from being shipped under a
newer version after source-level UI or Keychain fixes.

The release script builds the renderer in an isolated `/private/tmp` staging
root from the exact `package-lock.json`, then atomically stages `dist` before
Tauri runs. Keep this path: recursive Rollup reads can deadlock when the working
copy lives on an indexed macOS Documents volume. Never weaken the source and
renderer fingerprint checks to work around that filesystem behavior.

Release-script `mktemp` templates must end in `X` placeholders on macOS; do not
append a filename suffix after the placeholder run.

Keep the MCP server in its independent `src-tauri/mcp-server` crate. Adding it
as a second binary target to Orion's Tauri crate makes the Tauri CLI liable to
select `orion-mcp` as the application executable.
