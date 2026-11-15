# Dictation and transcription

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: note dictation and its cleanup, bundled Whisper, media import transcription and the YouTube workflow.

Read it before changing `src/components/VoiceMemoButton.tsx`, `src/components/editor/voiceDictation.ts`, `src/lib/dictationCleanup.ts`, `src/lib/dictationOutcome.ts`, `src/lib/transcription.ts`, `src-tauri/src/local_transcription.rs`, `src-tauri/src/media_jobs.rs`, `src-tauri/src/dictation_cleanup.rs` and `src-tauri/native/OrionWhisper/`.

Related: [Notes and the editor](notes-and-editor.md), [Import pipeline](import-pipeline.md), [Builds, updates and releases](build-and-release.md).

## Product decisions

- The sticky rich-text toolbar can record dictation at the current body cursor.
  The renderer preserves and tracks that insertion point while rotating the
  live microphone into bounded M4A segments. The Small edition uses independent
  two-minute requests. The Medium edition loads one persistent Whisper worker
  when recording starts and processes 30-second windows with two seconds of
  acoustic overlap; local assembly removes repeated boundary words. Completed
  segments are transcribed sequentially while recording continues, so the
  session has no fixed duration cap, but their generated text stays buffered
  and is not shown in the note until the user stops the whole session. The
  native host bounds and temporarily stages each part, bundled Whisper
  transcribes it entirely on-device. After Stop, save the combined original as
  an attached ordinary audio Source (`source-dictation-<session>`), flush it
  through the shared vault save queue, then optionally clean up that transcript
  with the selected configured AI provider before insertion. Cleanup receives
  only the transcript and the local calendar date captured at recording start,
  never note/Space context, and preserves meaning, voice,
  uncertainty and intentional emphasis. It can remove nonsemantic hesitation,
  accidental repetition and clear self-corrections, add punctuation, and return
  literal paragraphs, bullets or explicit unchecked tasks. In that same request,
  the provider can structure concrete spoken material as new tickets, new kanban
  boards with tickets, and literal editable tables, interleaved with prose and
  ordinary checklists. These insert automatically at the mapped original cursor,
  with no approval or review step, as one Undo group. Explicit commands are not
  required when the structure clearly fits: concrete project work may form a board,
  comparable stated attributes a table, and simple errands an ordinary checklist.
  Use a board for an identifiable project with several independently completable
  work items; a project description is sufficient without a formal name. Keep
  each separate work item or errand as its own ticket or checkbox,
  including when they share one spoken sentence; preserve genuinely single actions.
  Preserve tentative, quoted, cancelled and hypothetical content as prose; never
  invent commitments, facts, dates or urgency. Never mutate existing work or run
  research. The host generates all identities; nested tickets belong to their new
  board. Resolve spoken existing-board names only against unique boards in the
  originating Space at insertion; missing or ambiguous names remain unassigned.
  An optional Use original dictation toolbar action replaces the insertion with
  its local transcript while the inserted document remains unchanged. Subsequent
  document edits, navigation and external replacement invalidate that immediate
  replacement so it cannot overwrite later work. Original recovery remains in
  Sources. New structures use ordinary note Markdown, board/ticket metadata and
  tables, never a separate action store or persisted review state. Literal pipes inside table cells must be
  escaped before GFM row delimiters are emitted, preserving adjacent values and
  literal markup across Markdown reloads, including repeated round trips.
  Original dictations at the note's footer
  opens preserved text in Sources, including after reopening. Missing keys,
  offline/failed responses, invalid faithful cleanup, a 45-second deadline,
  oversize input, failed recovery save, or Use original keep the complete local
  transcript instead. Validate faithful cleanup independently of optional
  structures: malformed ticket/board/table output discards the proposal and
  preserves validated cleaned blocks, without another provider request. Strict
  envelope, literal text and loss/inflation guards still apply. If transcription
  loses a segment, preserve and insert recovered segments through the same source
  archival path, skip AI interpretation, and keep an actionable incomplete-recording
  error visible; never present partial recovered speech as a complete original.
  Navigating/unmounting or an external document replacement cancels cleanup and
  prevents a late insertion into another/replaced note. The completed original
  remains in its originating Space. Each audio recording is discarded after its
  transcription command finishes; cleanup never sends audio to a provider.
  After Stop, show processing only in the existing microphone button; do not
  display transcription, recovery-saving, cleanup or success status bubbles.
  Keep the recording timer and actionable errors visible. During AI cleanup the
  busy microphone button remains operable as Use original (accessible name and
  tooltip), aborting cleanup and inserting the local transcript. Completion
  immediately restores the ordinary microphone button without a notice timer.
  With no configured connection (API key or ChatGPT plan) for the selected provider, skip AI cleanup entirely and insert
  only the local Whisper transcript; keep the original recovery copy local.

## Native module ownership

`src-tauri/src/local_transcription.rs` owns offline media imports, persistent
dictation workers, YouTube acquisition, bundled Whisper runtime validation and
local alignment of generated speech. `media_jobs.rs` continues to own cancellation,
window scope and subprocess lifetime. Tauri command names/arguments remain stable;
the application manages `VoiceMemoWorkers` once and the assistant bridge calls
the same controlled transcription helpers. Provider speech generation, credentials
and the Preview Keychain-service rewrite remain in `lib.rs`. Keep temporary-media
cleanup, partial batch results, deadlines and on-device-only transcription intact
when changing this module.

## Offline transcription contract

The installed Orion app is self-contained on Apple Silicon macOS 13.3 or later. It bundles:

- `whisper.cpp` 1.9.1 as `Contents/Frameworks/whisper.framework`;
- the custom `Contents/MacOS/orion-whisper` sidecar;
- exactly one multilingual model, Small in the ordinary edition or Medium in
  the `.m` edition, as `Contents/Resources/models/ggml-model.bin`;
- official standalone `yt-dlp_macos` as `Contents/MacOS/yt-dlp`;
- Deno as `Contents/MacOS/deno`.

Settings retain only `whisperLanguage`, blank for automatic detection. Legacy
`whisperUrl`, `whisperModel`, and `ytDlpPath` properties remain accepted by the
snapshot validator for migration but are ignored and are not shown in the UI.

`orion-whisper` uses AVFoundation to decode a selected audio or video track
directly to 16 kHz mono Float32 samples and calls the whisper C API. It writes
only the finished transcript to stdout and diagnostic detail to stderr. Rust
passes exact model and media paths as structured process arguments and captures
the result. Imported media remains path-based and never crosses renderer IPC or
HTTP. Note voice memos are the narrow exception: the renderer records a
continuous session as bounded M4A segments and sends each one through a
sequential native command while the microphone continues recording. The Small
edition uses independent two-minute invocations. The Medium edition starts one
persistent sidecar per dictation, loads the model once, and processes 30-second
windows with the prior two seconds of decoded audio prepended for boundary
continuity. The host validates the name, MIME type, MP4 signature,
encoded/decoded sizes, and temporary-file lifetime before invoking the sidecar.
Segment transcripts stay buffered until recording stops; the renderer removes
overlap duplicates and then preserves the combined ordered original before the
optional cleanup/insertion step. Silent intermediate windows are valid. The
overall dictation session has no fixed duration limit.

`dictationCleanup.ts` archives the exact combined transcript using the existing
Source schema and defines cleanup fallback/deadline behavior. Sessions capture
their exact Space, note, language, local reference date, selected model and reasoning settings at
recording start. `src-tauri/src/dictation_cleanup.rs` owns the narrow
`cleanup_dictation` command, using the existing provider scheduler and knowledge
request cancellation registry. It accepts at most 24,000 Unicode characters,
never truncates, and returns at most 256 typed blocks / 32,000 characters per
alternative, with at most 32 tickets (including nested board tickets), four new
boards and four tables. Each table has at most 12 columns, 20 data rows plus its
header, and 500 Unicode characters per literal cell. The provider emits faithful
cleaned blocks once; optional structured content references unchanged blocks and
replaces consecutive blocks with ticket, board or table data. Validate complete,
ordered, single coverage before expanding for IPC. Evidence must be an exact
excerpt of the transcript; dates, urgency, title lengths, rectangular tables,
nested ticket counts and every supported field are strictly bounded. No second
AI request or Space-context read is added to this path.
Validate faithful blocks independently from the optional proposal. Invalid
proposal fields, evidence or source coverage discard the entire proposal while
preserving valid faithful cleanup; do not repair guessed values or add a second
provider call. Invalid JSON/envelopes, invalid faithful text, bounded response
read failures and obvious size-loss/inflation failures retain original fallback.
Structural checks do not prove semantic correctness. Model output
has no markup, target-note or tool authority. `voiceDictation.ts` validates the
whole insertion before creating literal ProseMirror text/list/task/board/table
nodes in one Undo group. It never interprets provider HTML or Markdown. New
boards and tickets receive fresh host IDs and use the existing note-backed schema.
The renderer revalidates structures at insertion; unavailable schema support
falls back to the faithful cleaned blocks. Navigation and external replacement
cancel pending cleanup. An optional post-insertion recovery action is guarded by
exact before/after documents and disappears on subsequent document edits; it is
not an approval step. It restores the original in one separately undoable action.
Oversized dictation retains ordinary complete local insertion. A saved original
is available via Sources and the note footer even if cleanup or insertion is
cancelled; no raw audio is retained and no provider credentials enter recovery.

Imported media uses a separate bounded path: decode five-minute windows with
two seconds of overlap and reuse one loaded Whisper context. Check allocation
limits before extending decoded buffers; cap a file at 12 hours of decoded
audio and the finished transcript at 2 MiB. Keep the edition's selected model.
`src-tauri/src/media_jobs.rs` owns each import request, exact window identity,
cancellation, and subprocess lifetime. At most eight requests may queue; one
physical media subprocess runs across windows. Bound download/transcription
stages to 20/60 minutes and a request to 90 minutes, including slot wait time.
Drain bounded stdout/stderr pipes, terminate the owned process group before
reaping its leader, and finish cleanup before dropping temporary media. Removing
an input, changing Space, or closing its window cancels the owned request;
application Quit drains these jobs after the successful vault-save handshake.
Batch results return completed transcripts and per-file failures so a later
failure or deadline does not discard earlier successes. Cancellation prevents
late queue commits. Desktop workflow imports share this ownership boundary.

The upstream framework is built for macOS 13.3, which defines Orion's current
minimum system version. The model must be at least 400 MiB or setup validation
treats it as incomplete. `THIRD_PARTY_NOTICES.md` records artifact versions,
hashes, origins, and licenses. `ORION_WHISPER_MODEL=small|medium` selects the
edition for the transcription helper, renderer timings, Tauri resource map,
release fingerprint, and final bundle verification. Each build verifies the
selected model's exact byte count and SHA-256, and the release source
fingerprint covers that model. Do not replace a bundled artifact without
updating and verifying those records.

Run `../script/build_transcription_sidecar.sh` after changing the Swift source.
Both the workspace Run action and release packaging script do this
automatically. Browser preview has no native sidecars and must report that
transcription is desktop-only.

## YouTube-to-notes workflow

The native `transcribe_youtube` command is deliberately narrow:

1. Accept only a specific HTTPS URL on `youtube.com` or `youtu.be`.
2. Verify the bundled Whisper runner/model, `yt-dlp`, and Deno are complete
   before downloading anything.
3. Invoke the exact bundled `yt-dlp` executable with structured arguments,
   never through a shell and never through PATH.
4. Pass the exact bundled Deno path through `--js-runtimes`; official
   `yt-dlp_macos` already includes the matching EJS challenge scripts.
5. Disable playlists and download at most one best-audio source into a new
   `tempfile::TempDir`.
6. Locate the supported downloaded media and pass it to bundled Whisper.
7. Return the transcript and original URL as source provenance.
8. Drop the temporary directory after offline transcription has finished.

The `TempDir` must remain owned by the command for the whole download and
transcription. Rust RAII deletion is a security/privacy invariant: success,
download failure, transcription failure, and early return all delete temporary
media. Do not replace it with a persistent cache. Never pass the video URL or an
executable string through a shell. Keep playlists disabled unless the product
gets an explicit bounded batch design.

Homebrew, Python, ffmpeg, an external `yt-dlp`, and a Whisper server are not
runtime prerequisites. Browser preview cannot run the YouTube workflow.

The pinned downloader is yt-dlp 2026.08.19. The native build verifies its
upstream byte hash and version before use. Release fingerprints include the
actual downloader and Deno executables and their license records, and final
bundle verification checks the downloader version. Apply a 2 GiB encoded-file
ceiling to the downloader, including the inherited Unix file-size resource
limit, so an absent remote Content-Length cannot bypass it.
