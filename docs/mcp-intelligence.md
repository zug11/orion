# Orion desktop intelligence through MCP

Implementation scope for the Codex and Claude Desktop connectors. See also the
[21 additional local library tools](mcp-library-tools.md), bringing the shared
connector to 55 tools. This extends
the existing local vault tools with the running app's context engine and native
AI execution. The MCP executable never receives provider credentials or calls a
provider itself. There is no hosted endpoint or background daemon.

## Capabilities

- Discover app availability, configured capabilities, permissions, and jobs.
- Retrieve task-specific, versioned context locally with exact evidence and
  explicitly bounded coverage.
- Research, compare supplied material, identify research gaps, review an
  argument, and prepare a working brief through one evidence-bearing research
  contract. `orion_research` uses the same adaptive exact-passage reader as Chat
  and voice, followed by one structured synthesis over its cited evidence.
  It can search again, follow connections, open original sources, and continue
  through long documents. At most six reading calls and one formatting call run
  per request; bounded reading may still leave coverage incomplete.
  Explicit `note_ids`/`source_ids` remain priority references, not an exclusive
  corpus: standard depth accepts eight/four; deep accepts sixteen/eight. The
  complete question (8,000 characters) and supplied material (24,000 characters)
  are preserved in bounded context records, independent of the shorter initial
  search query. Neither those records nor model output grants write authority.
  Follow-ups may reference a succeeded job through `previous_job_id`, with the
  exact Space, snapshot and working/history view rechecked. New results retain
  a host-produced `readerCheckpoint` with exact evidence versions, completed
  reads, public findings, decisions and open questions, so follow-ups can reuse
  the completed work. This is transient job memory, not vault persistence or a
  hidden reasoning transcript. Checkpoints are capped at 1,000,000 UTF-8 bytes;
  `continuityOmissions` declares compacted entries that a follow-up may reread.
  Prior jobs without a checkpoint retain their earlier interpretation-only
  follow-up behavior. Unsupported or stale checkpoint evidence is rejected.
- Search one Space adaptively with `orion_search_space`, returning exact cited
  passages and coverage without writing notes or Chat. Queries are bounded to
  600 characters and use the configured provider and context policy.
- Export a note, one visible link hop, or an entire Space as Word with
  `orion_export_word`. The app opens Save As; caller paths are not accepted.
  This is keyless and does not require note-write access. Cancelled or stale jobs
  cannot replace the destination after the dialog. Check `cancelled` in results.
- Import text, supported local documents/images/media, public webpages, and
  YouTube sources through the existing extraction and knowledge-import flow.
  Preserve sources, provenance, canonical reuse, recovery diagnostics, and the
  atomic apply boundary. Local mode remains keyless.
- Reprocess exact preserved sources under new guidance without duplicating
  their provenance records or overwriting later edits.
- Generate ordinary notes, podcast scripts, slide decks, and narrated decks
  through the existing generation pipeline and configured image capabilities.
- Develop a canonical concept article, enrich affected knowledge, and refresh
  the persistent Space overview using the existing scoped workflows.
- Inspect, cancel, and retrieve bounded jobs without blocking the stdio loop.
- Propose focused changes or a whole-note rewrite for review in the note already
  open in an explicitly identified Orion window. These proposals use the ordinary
  in-note highlights and Accept changes/Discard controls, with one editor Undo.
- Read a current selection or cursor from an exact open-note window, including
  authored unsaved selected text, without starting voice or enabling AI/writes.

## Existing voice work orders

Three separate tools reach work already owned by one Orion window and Space:
`orion_list_voice_work_orders`, `orion_get_voice_work_order` and
`orion_control_voice_work_order`. Discover a native-issued `voiceTargets` entry
through capabilities and supply its exact `voice_target_id` and `space_id`.
These identities are independent of the ordinary workflow executor and its jobs.
No tool starts a microphone, a voice call, a focus switch or unrelated research.

List defaults to 20 entries, up to 50, with an `inventoryVersion`. A positive
`offset` requires that same `inventory_version`; changed inventories fail instead
of mixing pages. Each record identifies the worker revision and `controlVersion`,
and distinguishes waiting/routing reservations, queued research, findings and
terminal results. The public inventory contains no transcript or evidence body.

Get requires `work_order_id` and `expected_revision`. `max_chars` defaults to
4,000 and is bounded to 1–12,000 Unicode characters across its prose/evidence
projection. Exact passages preserve their declared UTF-16 coordinates and
versions; retained answer fragments explicitly report omitted portions. Public
decisions, open questions, next steps and operation kinds are task memory, not
hidden reasoning. Internal prompts, captured selections, model messages and
complete checkpoint internals are excluded. Freshness and coverage remain
separate from whether a job is running, failed or complete.

List and get default to `task_view: "working"`. A history-derived result may
paraphrase completed tasks, so its free prose is withheld rather than merely
removing checked lines or citations. Explicit `history` is deliberate historical
access. Stale supporting material is withheld conservatively. A result does not
prove that the voice offered or audibly delivered a finding.

Control requires the exact worker revision, `expected_control_version` and a
caller-chosen `request_id`. `action` is only `cancel`, `retry` or `steer`;
`direction` is required only for steer, at most 2,000 Unicode characters.
Revision/generation checks happen before changing the selected worker. Identical
retained requests replay their bounded receipt; a reused ID with different input
fails. Retry the same ID and input after uncertain delivery. Receipts are transient
and do not survive app restart. A successful control confirms admission or
cancellation, not completed research.

Retry resumes only a failed or cancelled admitted worker. A waiting reservation
needs an explicit steer direction; it retains its original captured note/selection
and ID while the remaining reservations keep their own identities. Cancelling a
terminal worker is a no-op and preserves its findings. External retry/steer of the
currently focused worker is rejected until the user returns to the main voice
conversation in Orion, so a control cannot indirectly reconnect or switch audio.

List/get/cancel require enabled desktop access for the exact Space. Retry/steer
also require AI permission and a configured provider. They always create a
**read-only research revision**, irrespective of an earlier spoken save/edit
request, and do not require note-write permission. Ordinary local voice work
keeps its own authority. Permission revocation invalidates externally admitted
work without cancelling unrelated local work. Saves, edits, Keep, review
acceptance, audio and navigation remain outside this finite command surface.

The native mailbox returns immediately. The connector polls its receipt at a
modest interval within a three-second dispatch bound, leaving the private socket
listener free for unrelated requests. Target/session/Space, grants and revisions
are rechecked; late replies cannot substitute another target. A provider job
already admitted can continue independently of the polling client.

## Selected editor generation

Four tools expose Orion's existing rich-editor generation flow independently of
ordinary workflow jobs, edit-review proposals and read-only editor context:
`orion_capture_editor_action`, `orion_start_editor_action`,
`orion_get_editor_action`, and `orion_cancel_editor_action`.

Discover an exact ready `editorActionTargets` entry through capabilities. Capture
and start require enabled desktop access plus AI and write grants for that exact
Space, even though capturing makes no provider call. Capture requires its `space_id`, `note_id`, `editor_target_id`, a unique `request_id`, and
one complete finite action:

- `kind: "write"` and `amount: "sentence" | "paragraph" | "section"`.
- `kind: "rewrite"` and `preset: "rewrite" | "clarify" | "tighten" | "simplify" | "expand" | "enrich"`.
- `kind: "image"`, `quality: "fast" | "detailed"`, and `context: "selection" | "space"`.

Every action may include `instruction` of at most 1,250 Unicode characters. The
capture returns no selected text or source body and makes no provider call. The
native mailbox waits at most three seconds for the actual editor's capture, then
returns the action receipt with `captureId`, `documentVersion`, `selection` and
`effectiveTarget`. The two ranges explicitly use ProseMirror positions: the
original selection and the exact insertion/replacement target may differ. They
are descriptive metadata, never caller-supplied edit offsets. No window is
navigated or changed to satisfy a request. Ordinary read-only editor target IDs
are not interchangeable with these action target IDs.

Only an explicit start can request generation. Supply the same exact Space, note
and target, the returned `capture_id` and `expected_document_version`, and a new
start `request_id`. The action cannot be changed at start. Unsaved document and
Space/target freshness, provider readiness and current grants are rechecked.
Later highlighting cannot silently replace the captured target. Start requires
enabled workflow access for that Space, AI permission and workflow write
permission. Orion's selected provider/context settings remain authoritative;
image generation additionally needs its configured rendering provider. External
Enrich and related-Space images require the saved existing-note AI-context
preference; the external action cannot override it.

The ordinary Write/Rewrite/image drivers produce the real transient in-note
preview. Every paid stage and publication retains native grant/freshness checks.
Completed tasks stay filtered before provider context; only the action's explicit
instruction can request history. A checked rich selection without that authority
is rejected before provider use. Original authored text remains intact for
Accept/Discard and one Undo. Neither capturing nor starting grants acceptance.
Only the user can accept in Orion. Callers cannot provide a body, selection range,
provider, model, microphone command or automatic acceptance flag.

Get and cancel require only the exact `space_id` and returned `action_id`. Receipts
contain finite state/stage and capture metadata, no generated text, image bytes,
provider prompts or hidden reasoning. `captured` means no generation has started;
`submitted`/`generating` mean work is in progress; `awaiting_review` means the
proposal has not been accepted. `accepting` and `accepted_in_editor` are distinct
from `saved`, which requires native verification of the ordinary editor save.
Only `saved` includes the note version and citation. `save_failed` retains the
person's accepted local changes and must not cause the transaction to replay.

Cancellation withdraws pre-decision captures/work/previews and suppresses later
stages/output. It explicitly refuses an already claimed acceptance or saved edit;
provider requests already in flight can still consume usage. Identical capture
or start retries use the same request ID and input. A new start ID cannot consume
the same capture twice. Target expiry, navigation, document changes or permission
revocation must not retarget a receipt or silently fall back to a direct writer.

Source, isolated mailbox tests and packaged-connector checks prove their specific
contracts only. They do not establish that an installed client has the new tools,
that a real provider completed an action, or that the user accepted and saved a
native preview. Those remain separate acceptance steps.

## Read the current selection or cursor

Choose an exact native-issued `editorTargets` entry from
`orion_get_capabilities`, then call `orion_get_editor_context` with its
`editor_target_id` and explicit `space_id`. The optional `task_view` defaults to
`working`; `history` deliberately includes completed tasks. `max_chars` defaults
to 4,000 and is bounded to 1–12,000 Unicode characters. This uses the existing
desktop-workflow enablement and allowed-Space grant, independently of AI and
note-write permissions. It never starts a call, navigates, saves or changes text.

The result is a reference to the currently displayed document. `documentVersion`
is a local displayed-document fingerprint, **not** the opaque persisted
`expected_version` used by direct writers or edit reviews. Unsaved authored text
may differ from the saved note. Read the saved note separately before proposing
or applying an edit; a selection read grants no write authority.

States distinguish `selected`, `cursor`, `none`, `pending` and `unavailable`.
Selections carry their exact original DOM UTF-16 range and bounded verbatim
`fragments` with offsets in that same displayed body. A rich-editor caret uses
`prosemirror-position`; a reading-surface caret uses `dom-text-utf16`. Neither is
a portable Markdown offset. No surrounding prose is included for a cursor.
Working reads remove completed-task text before renderer-to-native IPC, report
omissions and retain the positions of the remaining fragments. Scalar budgets,
fragment limits and truncation are explicit, including large Unicode selections.

A new drag is pending immediately, and settles before replacing the captured
reference. Interacting with other controls preserves a settled selection.
Navigation or authored changes invalidate an earlier capture; an in-flight read
cannot substitute a later note or passage. Flow, unaccepted edit reviews and
generated writing previews are unavailable as authored reference material.

The independent mailbox sends only target identity/readiness in its heartbeat.
Selected text crosses IPC only for an explicit read. Native requests and polls
return promptly so waiting for a renderer does not block research cancellation
or capability checks. The connector's bounded wait either returns the reference
or an actionable unavailable/expired error; it does not start a research job.

## Edits reviewed in the open note

`orion_get_capabilities` advertises `reviewTargets` with native-issued IDs, exact
Space/note IDs and opaque note versions. A target exists only while that window
is connected and its note surface is ready. Select the returned target, then call
`orion_propose_note_edit` with `space_id`, `request_id`, `review_target_id`,
`note_id`, `expected_version` and an `edit`. No tool changes navigation or accepts
the proposal. A reading surface can enter its existing editor review in place.

`edit` is either `{kind: "focused", edits: [{before, after}]}` or
`{kind: "rewrite", body}`. Focused changes allow one to eight exact replacements,
6,000 Unicode characters per string and 24,000 in total. A rewrite is bounded to
24,000 characters. Unknown fields and protected control text are rejected.
Whole-note rewrites of notes with hidden completed tasks require explicit
`task_view: "history"`; an ordinary working view is not a complete rewrite base.

This independent review mailbox requires enabled Orion workflows, note-write
permission and the exact allowed Space. It needs no AI permission and makes no
provider call. Waiting for a person's decision does not occupy the ordinary
research executor. Direct local MCP writers keep their existing immediate-write
contract; callers must choose the review tools when the user asks for review.

Poll `orion_get_edit_review`, or cancel a pending proposal with
`orion_cancel_edit_review`. Receipts distinguish `submitted`, `awaiting_review`,
`accepting`, `accepted_in_editor` and `saved`, plus `discarded`, `cancelled`,
`stale`, `failed` and `save_failed`. Only `saved` carries a verified note version
and citation. Native acceptance claims recheck the original version under the
vault lock. The renderer then applies the ordinary undoable editor transaction
and serialized autosave; the native host confirms its actual serialized body
against fresh disk data. Save failure leaves the local edit available and never
replays the edit. Cancellation cannot undo a change already accepted.

The save receipt proves an exact body, not an edit's ancestry: if the user types
again or uses Undo before verification and autosave coalesces that newer text,
the accepted version can remain unconfirmed even though the current draft saves.
Orion preserves the newer text, reports this conservatively and does not retry
the accepted transaction. A current direct note read provides the latest version.

Targets are bound to the real caller window and renderer session. Navigation,
changed text, revoked permission or a disconnected owner invalidates a proposal
before acceptance. An admitted editor transaction may finish saving after note
navigation; a lost window/session cannot claim an unconfirmed save. There is at
most one pending proposal per target, eight pending proposals and 32 retained
receipts, with a 20-minute review deadline and one-hour terminal retention.
Local body snapshots are bounded to 2,000,000 bytes and all retained proposal
bodies to 16 MiB; external receipts never include them. Retry an uncertain
submission with identical input and the same request ID while its receipt is
retained. Do not silently fall back to an immediate write.

## Boundaries

- A per-user authenticated Unix-domain connection joins the bundled MCP server
  to the running Orion app. Advanced vault overrides must match that app's
  exact vault; they cannot redirect a workflow to a different library.
- Connections settings explicitly allow Spaces and independently enable API
  use and workflow writes. Older vaults default to disabled. Existing local
  read/write MCP tools retain their existing contract.
- Every new workflow captures an explicit exact Space, configured model,
  reasoning effort, and immutable context. The existing-note privacy preference
  remains authoritative; a tool argument cannot enable it.
- All network requests and Keychain reads remain in the native app. Source
  fetching, OCR, and transcription retain their existing native validation.
- Jobs share the renderer's provider scheduler. Requests, queues, results,
  retained evidence, elapsed work, and retries are bounded. Cancellation stops
  queued stages and prevents late mutation; physical calls retain their slots
  until they actually finish.
- Research/context/search/export jobs never write notes or Chat history. Creation/revision
  workflows persist ordinary notes, without agent attribution or a new lifecycle.
- Writes use the existing advisory lock, revision check, and atomic replacement.
  Recheck both the live renderer and persisted Space before committing. Results
  advertise saved notes only after persistence succeeds.
- Evidence distinguishes exact text from orientation and model interpretation.
  Returned citations use exact IDs. Coverage and stale results are explicit;
  no historical body is inferred from a timestamp or fingerprint.

## Verification

- Protocol and native tests for validation, permissions, vault identity,
  cancellation, idempotency, queue bounds, stale writes, and Space isolation.
- Renderer tests for evidence selection/validation, preference-off payloads,
  import/reprocessing provenance, generation, canonical reuse, and live edits.
- MCP harness against the exact packaged binary, including the local bridge.
- Renderer checks, native/MCP tests and formatting, and Tauri integration build.
- Actual UI verification for connection settings and job activity at normal and
  narrow desktop sizes. Runtime verification uses isolated fixture libraries.

Verified on 5 September 2026:

- `npm run check`: 879 renderer tests passed, one pre-existing test skipped;
  TypeScript and the production renderer build passed.
- All 65 native tests and 45 independent MCP tests passed. They cover the real local socket,
  authentication, revoked access, cancellation, atomic revision writes,
  idempotency, and Space boundaries. Packaged connector harnesses run against
  the exact extracted Claude extension and Codex plugin executables.
- The Connections UI was inspected in the isolated browser preview at 1280 and
  960 pixels wide, with no console errors or horizontal overflow. Native-only
  controls remain disabled in browser preview; interaction and job execution
  are covered by component, executor, and native tests.
- `npm run tauri build` produces the app and DMG. The native release profile
  avoids the documented Rust 1.96/macOS 27 debug-stripping defect; dependencies
  and release signature checks are unchanged.
- The existing Deno input had an invalid signature. Its copy in the generated
  app was signed ad hoc, the app resealed, and strict verification passed for
  all nested code. Deno's version command also passed. The development DMG is
  repacked from that verified app on APFS, following the release script's
  metadata-safe staging layout. The canonical production release script already
  signs every helper before sealing the app.

No real library was changed, and no paid provider request was made during
verification. Live provider quality, billing, and an end-to-end run in an
installed Codex or Claude Desktop client remain unverified. That initial pass
used local development bundles. Current distribution and signing status are
recorded in the [Orion 0.4.5 release notes](../releases/0.4.5.md).

The numerical phrase “100x” expresses the requested breadth; no performance or
quality multiplier is claimed without measurement.
