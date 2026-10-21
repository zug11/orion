# Orion for Claude

This local Claude Desktop extension gives Claude direct access to Orion.

- It reads `vault.json` directly and rereads it for every tool call.
- Browse, search, note lookup, source lookup, and the living Space overview
  default only to Orion's active Space when no Space ID is supplied.
- Listing Spaces discovers exact IDs; all create, update, and delete operations
  require one explicitly.
- The living overview is for orientation. Claude can search and open the
  underlying notes or sources when an answer needs evidence, citations,
  detailed facts, recent changes, or comprehensive coverage.
- Note detail and successful write results include citations plus bounded
  `linksTo` and `linkedFrom` note identities derived inside the same Space.
  Connected note bodies are never duplicated into those relationship arrays.
- It can create, edit, and delete ordinary notes in an explicit Space.
- Direct local writes are immediate and carry no Claude attribution or proposal state.
- The MCP executable makes no provider request and never reads API keys. Its
  existing local read/write tools need no Orion API key.

## Additional local tools

The connector also exposes 23 additional local library tools (57 tools total:
32 local library tools, 14 desktop workflows, three edit-review tools, one
active-editor-context reader, three voice work-order tools and four selected-editor-action tools):
exact source passages and note sections, batch reads, concepts, link resolution
and paths, provenance, tags, Markdown tasks, duplicate detection, integrity,
recent changes, guarded text edits, and atomic metadata batches. These work
with Orion closed. Every new write requires an exact Space and current note
version; conflicts stop before saving. Source offsets count Unicode scalar
values. Coverage flags distinguish bounded discovery from exhaustive reads.

The separate `orion_get_editor_context` tool requires Orion to be open, desktop
workflows enabled and the exact Space allowed. Choose a current `editorTargets`
entry from capabilities. It returns selected text or a cursor from that window,
including unsaved text, without AI or write permission. The displayed document
version and DOM/ProseMirror coordinates are reference-only, not persisted write
authority. Working reads hide completed tasks; history is explicit.

The four selected-editor-action tools discover `editorActionTargets`, then
capture an exact Write/Rewrite/image action without a provider call. Both capture
and start need API and write grants for that exact Space. Explicit
start uses that capture and document version through Orion's actual inline
pipeline, requiring AI and write grants for the Space. External Enrich and related-Space images also
respect the saved existing-note context preference. The user reviews the
ordinary unsaved preview and alone controls Accept/Discard. Status distinguishes
capture, generation, review, acceptance in the editor and verified disk saving;
cancellation cannot undo an already accepted edit. No caller supplies source
text/ranges, chooses a model or accepts a proposal. These are separate from
read-only context, edit-review receipts and ordinary jobs. See the
[selected-editor contract](../../docs/mcp-intelligence.md#selected-editor-generation).

The three voice work-order tools discover existing work through
`orion_get_capabilities.voiceTargets`, then list a versioned inventory, read one
exact worker revision, or cancel/retry/steer it with an exact control version.
They are separate from ordinary workflow jobs. Read/cancel needs exact-Space
desktop access; retry/steer additionally needs AI permission and always runs as
read-only research. No tool starts a call, microphone, focus change or note save.
Working views withhold history-derived prose. Reuse the same control request ID
and input after uncertain delivery; a control receipt is not completed research.

`orion_apply_note_command` adds version-guarded editor structures: movable
blocks, headings, tasks, lists, dividers, quotes, code, tables, web/note links,
excerpts, and existing managed images. Use its structured arguments instead of
writing literal slash text. `append`/`prepend` insert at note boundaries;
`before`/`after`/`replace` require a unique exact anchor. Excerpts validate the
source note's version as well as the destination. Note targets stay in one Space.
For a web link, use `url` instead of `target_note_id`: HTTP/HTTPS addresses and
recognizable bare domains are normalized without fetching them. Unsafe schemes,
credentials and malformed addresses are rejected; the same destination version
guard protects both link variants.

The same command tool exposes `paragraph_format`, `document_margins` and
`image_layout` for existing portable layout. Paragraphs/headings and standalone
managed images require exact unique anchors. Margins and image coordinates use
bounded schema values; omitted fields are preserved. These commands update
metadata under the existing version guard, not an editor cursor, and cannot
import a new asset. See [the layout contract](../../docs/mcp-library-tools.md#existing-portable-layout).

`table_layout` and `table_edit` operate on exact complete tables, including
adjacent metadata. They support width, measured columns, header/banding, cell
text, row/column insertion and deletion, and bounded dimension changes. Logical
indices exclude a headerless table's synthetic Markdown header; shrinking over
occupied cells requires explicit content-removal authority. See
[the table contract](../../docs/mcp-library-tools.md#existing-tables).

`inline_format` applies or removes bold, italic, strike or inline code using an
exact Markdown anchor and explicit `enabled` boolean. It preserves other marks
and text; removal needs complete delimiters. `unlink` removes a whole explicit
web/note/concept link and preserves its formatted label. Both operate inside one
ordinary paragraph or ATX heading under the same Space/version guard. Source
citations, excerpt links and automatic concept vocabulary are separate. See
[the inline contract](../../docs/mcp-library-tools.md#existing-inline-formatting-and-explicit-links).

`source_citation` inserts or removes numbered source references. Insertion
requires current note and same-Space source versions and attaches both
provenance edges atomically. Removal retains those edges. The recognized
References footer is rebuilt while authored prose is preserved. See
[the citation contract](../../docs/mcp-library-tools.md#source-citations-and-provenance).

## Optional Orion workflows

Keep Orion open and enable **Settings → Connections → Orion workflows** for the
Spaces you choose. Separately allow AI use and import/generation writes.
Orion runs the work using its configured model and provider account. Its
existing-note AI-context preference still applies. Context and results returned
to Claude are also governed by the user's Claude account settings.

The connector exposes local context packets, evidence-based research (answer,
compare, gaps, review, brief), full source imports, preserved-source reprocessing,
note/podcast/deck generation, canonical article development, enrichment, and
Space-overview refresh. Call `orion_get_capabilities` to check availability.

Every workflow requires an exact Space ID and a unique `request_id`. It returns
a job immediately; use `orion_get_job`, `orion_list_jobs`, and `orion_cancel_job`
to follow or stop work. Retry uncertain submissions with identical input and the
same request ID. Deduplication and results last up to one hour, 32 retained jobs,
or app restart. Avoid rapid polling. Results distinguish partial evidence,
staleness, AI interpretation, recovery output, and unknown token usage.

Import accepts text, supported absolute local file paths, and public HTTPS
webpage/YouTube URLs. Local mode preserves source notes without AI. AI mode uses
Orion's existing synthesis and canonical-reuse pipeline. Reprocessing keeps
original source IDs. Generation creates editable notes and scripts; playback
uses Orion's ordinary controls. Research and context never save notes or Chat.

The running app owns the private per-user Unix socket, validates permissions and
Space revisions, and commits through Orion's lock-safe atomic vault writer. No
separate service starts. These workflow grants do not change the installed
connector's existing direct read/write access.

There is no vault-path setup during installation. The connector automatically
uses Orion's per-user macOS library at
`~/Library/Application Support/app.orion.knowledge/vault.json`. Open Orion once
before first use so that local library exists.

Advanced command-line integrations that deliberately keep Orion data somewhere
else can set `ORION_VAULT_PATH` or launch `orion-mcp --vault /path/to/vault.json`.
These overrides are not required for the bundled Claude Desktop extension.

The running-app workflows also provide `orion_search_space` for an explicit AI
question with exact cited passages, and `orion_export_word` for a note, linked
notes, or a whole Space. Word export is local and opens the native Save As dialog;
no caller path is accepted. DOCX imports preserve semantic formatting and retain
embedded pictures as descriptive alt text.

## Review an edit in Orion

When you want to review changes before saving, the connector can submit them to
the note already open in an Orion window. It uses Orion's existing highlighted
replacements, gray additions and **Accept changes / Discard** controls. The
assistant cannot press Accept, choose a different note or silently save the edit.

Enable Orion workflows and note-write access for that Space. No Orion provider
key or AI permission is needed for this review path. `orion_get_capabilities`
returns available `reviewTargets`; `orion_propose_note_edit` requires one exact
target, its note version and a request ID. It supports bounded focused edits and
whole-note rewrites. Rewriting a note containing hidden completed tasks requires
explicit history access so the assistant cannot erase content it did not read.

`orion_get_edit_review` reports progress separately from background research.
Acceptance in the editor is distinct from a confirmed save: only `saved`
returns the verified version and note citation. `save_failed` leaves the accepted
local edit available for the user to resolve. `orion_cancel_edit_review` cancels
a proposal still awaiting a decision; it cannot undo an accepted edit. Retry an
uncertain submission with identical input and the same request ID. Direct MCP
write tools retain their existing immediate-write behavior.

See the [review contract](../../docs/mcp-intelligence.md#edits-reviewed-in-the-open-note)
for bounds, lifecycle and window ownership.
