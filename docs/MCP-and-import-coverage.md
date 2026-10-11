# MCP and import coverage

Source audit: 11 October 2026. This describes the current working tree, including
unreleased voice work. It is not verification of an installed connector or live
provider session.

The broad backlog item **“All new features should have MCP and import flow able
to use” remains partially complete**. Most portable writing commands are already
callable. Import preserves supported content; it does not execute editor commands.
Finite voice work-order access and selected-editor Write/Rewrite/image generation now have source implementations. Selected generation uses the actual rich capture and preview lifecycle; installed-client, native UI and provider acceptance remain separate.
The editor-generation prerequisite audit also found raw completed-task context
in the existing local writing, illustration and link-generation paths. Those
paths now use a separate working projection and guard protected rich selections.
This closes a local provider-context gap; it does not add an MCP editor-action
endpoint or establish live-provider acceptance.

## Coverage map

“Direct MCP” means the local, provider-free library tools. “Desktop workflow”
means the separately enabled bridge to the running app, subject to its Space,
AI and write grants. Both retain their existing version and commit guards.

| Feature | Callable support | Import support and limits |
| --- | --- | --- |
| Text, headings 1–6, writing blocks, lists/tasks, dividers, quotes, code, tables | Direct `orion_apply_note_command` has a finite structured command set. Unique anchors and current note versions guard placement/replacement. Task completion and exact text edits have their own tools. Structured table operations now cover cells, row/column insertion/removal, guarded resizing and complete-table deletion. | Markdown carries portable content and block markers. Local import preserves full parsed source text. Its editable excerpt ends at a complete structure within 200,000 UTF-16 units; oversized individual structures are omitted. A generated title and visible truncation notice are additional. AI import may synthesize different note structure. Literal slash text remains text. |
| Note links and excerpts | Structured `link` and `excerpt` commands validate same-Space ownership; excerpts additionally require the source version and exact unique passage. | Existing Markdown references survive as content, but importing a reference does not import its target or remap IDs into another Space. |
| Source citations | Structured `source_citation` inserts or removes numbered markers. Insertion validates both note and same-Space source versions and attaches both provenance edges under the vault lock. Removal retains provenance; only a recognized generated References footer is rebuilt. | Guarded local/assistant import reconciles real citation links to sources already present exactly once in the same Space. It updates both provenance arrays without importing/fetching the cited target. Code, images, raw HTML, metadata and footer-only examples do not create edges. |
| External URL links | Structured `link` accepts exactly one of `url` or `target_note_id`. HTTP(S) and recognizable bare domains are normalized locally, bounded and validated without fetching. Replacing an exact anchor preserves its wording when no label is supplied. All normal Space/version checks apply. | Markdown links and safe public DOCX links are supported. DOCX local/unsafe links retain their labels without the destination. |
| Formatting, alignment, margins and image layout | Structured `paragraph_format` updates left/justify alignment and paragraph margins; `document_margins` changes the document inset; `image_layout` updates placement, alignment, size, position, gap and caption on an existing managed image; `table_layout` changes width, measured columns, header and banding. Exact whole anchors, finite bounds and current versions protect edits. `inline_format` adds guarded bold/italic/strike/code changes within ordinary paragraphs/headings; `unlink` removes whole explicit web/note/concept links. Both preserve non-target semantics and reject unsupported syntax, citations, automatic links and generated References. | Markdown preserves metadata for the renderer. DOCX extraction preserves semantic content, not Orion frames, paragraph indents or free image placement. HTML extraction preserves bounded semantic Markdown, with explicit fallbacks for unsupported structures; it does not preserve page styling, remote assets or arbitrary HTML layout. |
| Image insertion and generation | `image` inserts an existing managed image already referenced in the same Space. It cannot import bytes, use a filesystem/network URL or choose a crop. A separate native capture/start/get/cancel lane runs selection/Space image generation in the actual rich editor, with a transient image preview awaiting user acceptance. | Image-file import is OCR. DOCX embedded pictures become descriptive alt text; their bytes are not imported as note attachments. Managed URLs require an already available local asset. |
| `/write`, selected-text rewrite, Chat edit proposals | Three desktop review tools submit bounded focused edits or a rewrite to an exact native-issued open-note target, then report the user's Accept/Discard decision separately from verified saving. They share the real in-note decorations and one Undo without occupying the research executor. The separate read-only editor endpoint only exposes selected text or the cursor. Four editor-action tools independently capture and start finite Write/Rewrite/image generation in a ready rich editor, retaining exact capture/version guards, completed-task filtering, the ordinary user preview and native-verified save receipts. Direct local writers remain immediate writes. | Imported text is content, never permission to run AI or accept an edit. No proposal/cursor state is imported. |
| Source ingestion and reprocessing | Desktop `orion_import` shares the real Import Studio assembler and parsers for text/file/URL inputs. Local mode bypasses AI; AI mode uses the shared knowledge-import pipeline. `orion_reprocess_sources` reuses preserved sources and provenance. | Local parsing supports text/Markdown, JSON, CSV/TSV, HTML, PDF, DOCX and image OCR; native media/URL paths add transcription or extraction. Original extracted source text is preserved. This does not imply all original document layout survives. |
| Search, evidence reading and completed-task blindness | Direct search, note sections, source passages and task tools provide bounded exact evidence. Working views omit completed tasks; explicit history remains available. Desktop context/search/research are also callable. | Task checkboxes remain ordinary Markdown. Import does not make completed tasks a second schema or execute them. |
| Adaptive Chat/voice research and retained checkpoints | Desktop `orion_research` now shares the read-only adaptive `runChatReading` path, then formats retained exact evidence into its existing structured research result. The reader uses at most six calls, with one synthesis call. Explicit note/source IDs seed discovery without restricting the corpus. `previous_job_id` resumes validated host task memory only for a succeeded Research job in the same Space, snapshot and working/history view. Retained checkpoints are bounded to 1,000,000 UTF-8 bytes with explicit omissions. | Worker checkpoints are transient session state, not imported note data. Public checkpoint state is not a claim to retain provider-private reasoning. This source change still needs an updated native app and live workflow acceptance. |
| Voice work orders, updates, completed-worker conversations | Three finite tools list, inspect and cancel/retry/steer existing workers at an exact native-issued window/Space target. Bounded public findings/checkpoints and working/history privacy are independent of audio. Controls require current revision and control version; retry/steer additionally require an AI grant, force read-only research and recheck permission before each provider stage. Waiting reservations retain their identity and original reference. The currently focused worker cannot be externally restarted. `orion_get_job`/`orion_list_jobs`/`orion_cancel_job` remain a separate desktop workflow system. | Work-order/call state is not imported or stored as note content. Explicit saved results become ordinary notes. These tools cannot start/stop/mute voice, choose a conversation, create new workers or save/edit results. Source and isolated validation do not prove an installed-client/live-provider run. |
| Active selection and cursor | `orion_get_editor_context` reads an exact native-issued window/Space/note target without voice, AI or write permission. It returns bounded settled selection fragments or the actual cursor, including unsaved text with a local document version. Dragging, Flow and unaccepted previews withhold text. Working reads filter completed tasks before IPC; history is explicit. Voice retains its separate selected-passage binding. | Selection is temporary reference material, not permission to edit. DOM UTF-16 selection ranges and ProseMirror cursor positions are explicitly identified; neither is a persisted Markdown offset or a native write version. Nothing is imported or saved by this endpoint. |

## Boundaries to preserve

- Keep direct MCP local and credential-free. Provider calls stay behind the
  separately granted desktop workflow boundary; never expose keys in tool data.
- Microphone permissions, actual audio playback, dictation insertion, Flow,
  call controls, native pickers/window glass and drag gestures are interactive
  app behavior. Import should preserve their resulting content where applicable,
  not invoke those controls. Any future automation needs an explicit narrow
  contract, rather than arbitrary slash-command dispatch.
- Retain exact Space, target and version checks. The editor-context endpoint identifies
  the exact window target and coordinate system; a passage reference cannot grant
  write authority. Existing direct MCP writes and UI reviewable proposals have
  different approval semantics and should not silently substitute for each other.

## Concrete follow-up work

1. Verify the shared adaptive MCP reader in the updated native app with a real
   provider, including an exact source, a long-note follow-up and cancellation.
   Local transport fixtures establish the contract, not provider acceptance.
2. Validate the finite voice-worker tools in the updated app and client after
   installation is authorized. Exercise exact-window discovery, reservations,
   history withholding, steering/retry, permission revocation and terminal result
   retention. Keep audio, conversation focus and new-worker creation outside this
   contract; ordinary workflow job tools must not be presented as voice controls.
3. Keep structured layout scoped to the supported paragraph/document/image/table
   fields. Inline formatting and explicit unlinking operate only on their bounded
   supported source spans. The separate source-citation command and import
   reconciliation must continue to preserve two-sided provenance, authored
   References prose and literal examples. Do not expand its finite contract to
   source editing/deletion, cross-Space remapping or fetched evidence.
4. Keep the combined portable-content regression current when formats change.
   It covers captured MCP blocks, tables, links/excerpts and structured
   margins/alignment/image/table-layout output through local Markdown import and
   three editor reopen cycles. It consumes captured MCP output, rather than starting a
   fresh connector process on each run; not every layout field has a command.
5. Keep explicit limitations for DOCX pictures/indents, HTML structure and
   cross-Space reference/asset portability. Do not call those full-fidelity import.
   The local excerpt now stops at a complete structure and labels truncation;
   an oversized first paragraph or frame can leave only the title and notice in
   the note. Its complete parsed text remains available in Sources.
6. Keep serializer tests at the actual save/reopen boundary. Dynamic inline and
   fenced code, edge whitespace and ordinary/code table backslash-pipes now use
   a per-call literal-preservation layer. The exact table-only code join comment
   has paired editor, reading and export support; it must never consume literal
   examples or become a general raw-HTML processing mechanism. Inline line
   endings retain CommonMark's normalization; a code block preserves newlines.
7. Verify the external review path in an updated native app and fresh installed
   client. Its separate mailbox now has exact native window/Space/note ownership,
   opaque versions, deduplicated requests and bounded pending reviews. Local
   editor acceptance and saved-to-disk receipts are separate. Maintain tests at
   the actual editor/autosave boundary; simulated MCP receipts alone cannot prove
   native UI acceptance. Direct local writers remain immediate writes and must
   not silently substitute for a requested review.
8. Verify the read-only active-editor endpoint in an updated native app and fresh
   installed client, including two windows, unsaved text, completed-task filtering
   and navigation during a request. Local DOM, mailbox and authenticated socket
   checks establish separate parts of this path; they do not prove an installed
   client has loaded the new tool.

## Completed parity slices, 11 October 2026

- Active editor context now has a separate bounded read mailbox. One tool reads
  an exact native-issued window/Space/note target, returning settled selection
  fragments or a cursor with a local displayed version. Voice, provider and write
  grants are not required. Identity-only heartbeats carry no body text, and
  working projections remove completed tasks before IPC. Flow and unaccepted
  previews withhold text; navigation and draft changes invalidate stale reads.
  The native socket stays responsive while the renderer answers. Native tests
  pass 165 cases (one existing ignored system-voice test); the independent MCP
  suite passes 100 tests, and the executable harness verifies 48 schemas. The
  full renderer check passes 2,493 tests (one skipped), with TypeScript/Vite
  passing. Eleven actual Chromium checks cover exact Unicode ranges, unsaved
  text, task filtering, cursor state and two-way navigation. The browser found
  a sticky initialization state; the reader now returns a cached empty state
  after real readiness without reviving old text. Packaged artifact results are
  recorded separately in `outputs/validation/20261011-editor-context`.
  Installed-client/native UI acceptance remains open.
- External MCP edits now have a separate, bounded review mailbox. Three tools
  submit, inspect or cancel a proposal for an exact open-note/window target.
  Shared opaque versions, native decision claims and the real editor transaction
  protect the note; one Undo remains available. Awaiting review does not occupy
  research. Native receipts distinguish local acceptance from exact-body
  verification on disk, and rejected saves preserve local text. Working-view
  rewrites cannot omit hidden completed tasks. Old-session polls cannot withdraw
  a newer target, and ordinary navigation retains the window's current session.
  The full renderer check passes 2,436 tests (one skipped), with TypeScript/Vite
  passing; 152 native tests pass (one ignored), including the real authenticated
  review socket, and 95 independent MCP tests pass. App/editor tests use mocked
  IPC/persistence; the packaged MCP transport harness simulates native receipts.
  Neither substitutes for installed-client/native UI acceptance. All 47 schemas
  pass the extracted connector/plugin harnesses. Evidence is in
  `outputs/validation/20261011-external-edit-review`. The exact-body receipt can
  remain unconfirmed if subsequent typing/Undo is coalesced before verification;
  current user text is preserved, never overwritten to satisfy a receipt.
- DOCX now shares the bounded inert HTML extractor and literal-code serializer.
  Headerless/blank data rows, authored entity/tilde text and code whitespace
  survive the real browser Mammoth path, import payload and three editor reopens.
  Its Word profile retains leading glyph/form-checkbox tasks and safe mailto
  links without changing ordinary HTML behavior. Nested/later/code/table task
  lookalikes remain reference text. Omitted pictures retain descriptions with
  one warning, complex tables retain readable text with a warning, and multiple
  Word header rows retain all content with one header. Image-byte readers are
  not called. Word export now omits false header flags, so actual exported
  headerless and true-header tables return with their intended structure.
  This slice changes source and the renderer build only; it is not included in
  the previously built WcbTjC native Preview or a new DMG. Evidence is in
  `outputs/validation/20261011-docx-semantic`.
- `source_citation` now performs guarded insertion/removal with atomic two-sided
  provenance, fresh source-version receipts, preserved authored labels and
  renderer-compatible numbering. Local/assistant import reconciles real prose
  citations to unique existing same-Space sources. Commit rebasing preserves
  newer source fields and respects deletion, collisions and removed attachments.
  Frontmatter placement, CRLF fence handling and escaped descriptive-label
  removal have regression coverage. All 89 MCP tests and the executable's
  21-tool harness pass. Its exact fixture includes ten citation states and
  21 inline states; 73 final citation/import tests verify repeated editor
  reopening, including Unicode IDs and unusual title whitespace.
- Literal code now survives actual saving: dynamic inline/fenced delimiters,
  edge/all-space content, tabs, NBSP/BOM and ordinary/code table backslash-pipes.
  The serializer works on a transient copy and does not change editor state or
  persisted schema. The exact table join marker is consumed only between code
  spans inside a table. Fifty-one dedicated cases compare three editor reopens,
  reading and export, including literal marker examples and other marks/links.
  HTML import now uses these helpers without its earlier code-formatting
  fallbacks. A local 18,000-word mixed-content probe measured median serialization
  at 0.935 ms versus 0.814 ms before the wrapper; this is not voice latency or a
  device-wide performance guarantee.
- Structured `inline_format` and `unlink` operate on bounded exact source spans
  within ordinary paragraphs and ATX headings. Explicit apply/remove preserves
  words, other marks and link attributes; whole-link removal retains its label.
  Source citations, excerpts, generated References, bare/reference autolinks,
  partial syntax and unsupported containers are guarded. Dynamic code delimiters
  now support literal backticks and edge whitespace through actual saving and
  reopening. The executable fixture includes those newly supported cases;
  integration totals for this revision are recorded below.
- HTML extraction now uses bounded inert template parsing and preserves headings,
  paragraphs, inline marks, ordinary code, safe absolute HTTP(S) links,
  lists/tasks, quotes and simple tables. Unknown containers retain readable
  descendants; headerless tables retain their first data row. Active content,
  page styling and external assets are not imported. Unsupported structures
  retain readable text with bounded warnings.
  Input and generated output are limited to 16 Mi UTF-16 units, 100,000 nodes and
  128 nesting levels, with indentation-amplification checks. The complete
  semantic source remains available even when the editable note is shortened.
  All 42 tests across four HTML/file/DOCX suites pass, including production-editor
  reopening and a source longer than 200,000 units. The separate Chromium browser
  probe checks a positive-control request, zero imported-resource requests,
  inactive scripts/events and zero imported custom-element construction. This
  is not a native WebKit acceptance check or raw-HTML/layout preservation.
- Structured `table_layout` and `table_edit` now cover geometry, header/banding,
  literal cell replacement, row/column insertion and deletion, resizing and
  complete-table removal. Exact standalone anchors preserve raw untouched cells,
  CRLF and valid metadata; occupied dimension reductions require explicit
  authority. Parser guards prevent headings/lists, malformed metadata and partial
  tables from being rewritten. All 78 MCP Rust tests and the actual executable's
  21-tool harness pass. Captured table output, including a headerless table with a
  blank real first row, survives local import and three editor reopen cycles.
  All 55 tests across five import/editor suites pass; no manual layout overlay
  remains in the combined fixture.
- Structured paragraph/document/image layout commands retain omitted values,
  preserve unknown image metadata and reject ambiguous or structural anchors.
  Their real executable output now supplies margins, alignment and image layout
  to the combined import/editor fixture. All 67 MCP Rust tests and the 21-tool
  protocol harness passed; the updated fixture passes local import and three
  editor reopen cycles. Code/HTML containers and reference definitions cannot
  be mistaken for editable prose. No asset is fetched or imported.
- Adaptive MCP research uses the shared exact-passage reader and host-validated
  evidence/checkpoint contracts. Full supported questions and comparison material
  travel inside the bounded reading packet; the provider does not receive Chat
  history or an active editor selection. Findings cite only retained exact
  passages, and follow-ups recheck Space, snapshot and working/history scope.
  Returned model extras cannot create notes, propose edits or forge checkpoints.
- Structured external links use the renderer's HTTP(S), bare-domain,
  credential, control-character and UTF-16 length policy. The independent MCP
  crate uses the app's existing `url` version, 2.5.8. Markdown-sensitive URL
  parentheses and literal labels are escaped. All 60 MCP Rust tests and the
  real 21-tool library protocol harness passed against an isolated vault;
  MCP-generated URL labels/destinations survived editor serialization/reopening.
- `importNoteExcerpt.ts` replaces raw note-copy slicing. Bounded lexing retains
  complete Markdown units, balanced Orion frames and table metadata with its
  table. Source offsets remain correct for CRLF and surrogate pairs.
- `importPortableRoundTrip.test.ts` combines captured MCP content/layout output
  and exercises `parseTextImport`, `buildImportPayload`, the
  production content extensions and three editor serialize/reopen cycles.
  It checks blocks, tasks, table geometry, local/external links, exact v2
  excerpts, paragraph/document margins, alignment and managed-image metadata.
  All 55 tests across five import/editor suites passed, including full-source
  retention at the real import-payload boundary. This does not fetch/import
  image bytes or remap references into another Space.

These are source and isolated executable checks. The installed connector has
not been updated or reloaded by this work. The broad parity item remains open.

The integrated renderer suite now passes 2,404 tests across 208 files, with one
existing skipped test file, and the production renderer build passes. This
includes the new provenance and serializer coverage alongside earlier table,
research and voice work. The final executable-capture refresh also passes the
73-test citation/import batch. The previous native app suite passed 132 tests
with one existing ignored system-voice test; native Rust app code did not change
in this slice. The running ui4 Preview has not been replaced.
These checks do not validate live providers or audible microphone/playback behavior.

A separate 0.4.8 native Preview at
`~/Applications/Orion Previews/orion-desktop-preview.WcbTjC/Orion Preview.app`
now contains this renderer/import/serializer revision. Its copied-out app passed
deep/strict signature verification and 554 renderer/MCP source files matched
the captured build manifest. It was built without launching or replacing the
running ui4 Preview. The exact native artifact and temporary-stage cleanup are
recorded in `outputs/validation/20261011-citations-code/native-verification.json`.

## Implementation and validation evidence

- Command allowlist and locked validation:
  [`library/editor.rs`](../src-tauri/mcp-server/src/library/editor.rs),
  [`library/mod.rs`](../src-tauri/mcp-server/src/library/mod.rs),
  [`library/tests.rs`](../src-tauri/mcp-server/src/library/tests.rs).
  [`test_mcp_library.mjs`](../script/test_mcp_library.mjs) exercises the real
  connector protocol, portable commands, stale/invalid writes and Space isolation.
- Workflow schemas and implementation:
  [`workflows.rs`](../src-tauri/mcp-server/src/workflows.rs),
  [`assistant/types.ts`](../src/lib/assistant/types.ts),
  [`assistant/workflows.ts`](../src/lib/assistant/workflows.ts),
  [`assistant/context.ts`](../src/lib/assistant/context.ts),
  [`assistant/research.ts`](../src/lib/assistant/research.ts),
  [`assistant/researchCheckpoint.ts`](../src/lib/assistant/researchCheckpoint.ts),
  [`assistant/executor.ts`](../src/lib/assistant/executor.ts).
- Content and import:
  [`slashCommands.ts`](../src/components/editor/slashCommands.ts),
  [`ImportStudio.tsx`](../src/components/ImportStudio.tsx),
  [`importNoteExcerpt.ts`](../src/lib/importNoteExcerpt.ts),
  [`importPortableRoundTrip.test.ts`](../src/lib/importPortableRoundTrip.test.ts),
  [`files.ts`](../src/lib/files.ts),
  [`docxImport.ts`](../src/lib/docxImport.ts),
  [`sourceCitations.ts`](../src/lib/sourceCitations.ts),
  [`sourceDeletion.ts`](../src/lib/sourceDeletion.ts),
  [`noteCodeSerialization.ts`](../src/lib/noteCodeSerialization.ts),
  [`markdown.ts`](../src/lib/markdown.ts).
- Voice boundaries:
  [`voiceResearch.ts`](../src/lib/voiceResearch.ts),
  [`chatReadingCheckpoint.ts`](../src/lib/chatReadingCheckpoint.ts),
  [`voiceSelection.ts`](../src/lib/voiceSelection.ts).

The latest integration evidence is recorded in
`outputs/validation/20261011-citations-code`, with the earlier inert-resource
probe in `outputs/validation/20261011-html-import`. The standalone MCP suite and
actual executable harness use isolated fixture vaults; renderer research and
audio checks use local or controlled dependencies. Installed-client deployment,
live provider behavior, real microphone/voice acceptance and arbitrary imported
documents remain outside this evidence.
