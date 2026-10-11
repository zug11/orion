# Orion local library tools

The shared Codex and Claude Desktop server now has **44 tools**: 30 local
library tools, including these 21 additions, plus 14 native workflow and job
tools. These additions work with Orion closed and never call an AI provider.

| Tool | Capability |
| --- | --- |
| `orion_list_sources` | Page through sources by title, URL, or kind. |
| `orion_search_sources` | Find literal, case-sensitive evidence in preserved source text. |
| `orion_get_source_passage` | Read exact source ranges beyond the initial preview. |
| `orion_get_note_section` | Read a named heading and its subsections; disambiguate repeated headings. |
| `orion_get_notes` | Retrieve up to 12 notes from one consistent snapshot. |
| `orion_list_concepts` | Browse existing canonical vocabulary and aliases. |
| `orion_get_concept` | Inspect a concept, its canonical article, and related notes. |
| `orion_resolve_link` | Resolve a title or alias, reporting ambiguous destinations explicitly. |
| `orion_get_related_notes` | Rank connections with stored-link, concept, and provenance reasons. |
| `orion_get_provenance` | Trace a note to preserved sources and other derived notes. |
| `orion_list_tags` | Retrieve tag facets and exact note counts. |
| `orion_list_tasks` | Retrieve Markdown checkboxes, source notes, versions, and line positions. |
| `orion_set_task_completion` | Change one exact checkbox without changing surrounding prose. |
| `orion_edit_note_text` | Replace one unique selection while preserving the rest of the note. |
| `orion_apply_note_command` | Insert portable writing blocks and slash-command content with a version guard. |
| `orion_append_to_note` | Append exact text with a version guard against duplicate retries. |
| `orion_batch_update_metadata` | Atomically set tags and/or pinned state on up to 20 notes. |
| `orion_find_duplicate_notes` | Identify exact body duplicates or normalized title matches. |
| `orion_check_space_integrity` | Diagnose dangling references, duplicate IDs, and broken Orion links. |
| `orion_get_recent_changes` | Retrieve current notes changed since a timestamp. |
| `orion_get_link_path` | Find a bounded shortest directed connection path with cited steps. |

## Read, then make a guarded edit

First discover exact Space IDs with `orion_list_spaces`. Read the target with
`orion_get_notes`, `orion_get_note_section`, or `orion_list_tasks`; retain the
returned note `version`. A write must pass the exact `space_id`, `note_id`, and
`expected_version`. Version validation and persistence share the same exclusive
advisory vault lock. A changed note rejects the operation before anything saves.

For a task, also pass its zero-based `lineIndex` as `line_index`, and its exact
`rawText` as `expected_text`. For replacement, `old_text` must occur exactly
once, including overlapping matches. Append inserts precisely the supplied
`text`, so callers include any desired blank lines. Reusing the pre-append
version fails safely after a successful append.

Metadata batches validate every note before applying any changes. Tags affect
overview freshness; pin-only updates do not. Writes preserve unrelated fields,
all other Spaces, existing provenance, and ordinary permanent-note behavior.
Successful receipts contain updated versions and exact Orion citations.

## Writing blocks and slash-command content

`orion_apply_note_command` applies the content produced by editor commands while
Orion is open or closed. It takes an exact `space_id`, `note_id`, and current
`expected_version`, plus a finite `command`; it does not type into the editor.

Supported commands are `text`, `block`, `heading`, `h1` through `h6`, `todo`,
`bullet`, `numbered`, `divider`, `quote`, `code`, `table`, `link`, `excerpt`, and
`image`, `paragraph_format`, `document_margins`, `image_layout`, `table_layout`,
`table_edit`, `inline_format`, `unlink`, and `source_citation`. Supply the
command's structured fields from its tool schema. For example,
wrap rich Markdown in a movable writing block:

```json
{
  "space_id": "<exact Space ID>",
  "note_id": "<exact note ID>",
  "expected_version": "<version from current read>",
  "command": "block",
  "text": "## Next steps\n\n- [ ] Review the draft",
  "placement": "append"
}
```

For content insertion, `placement` defaults to `append`; `prepend` is also available. `before`, `after`,
and `replace` require an exact, unique `anchor`. Read again after a conflict;
never replace the version and blindly retry. Content and validation are bounded,
and a successful receipt includes the updated version and note citation.

`link` takes exactly one destination: `target_note_id` for an existing note in
the requested Space, or `url` for an HTTP/HTTPS web address. Recognizable bare
domains normalize to HTTPS; addresses are capped at 2,048 UTF-16 characters before
and after URL normalization. Unsupported schemes, credentials, control characters,
spaces and backslashes are rejected. This operation only writes the link and
never fetches or opens its destination. `text` is an optional literal label;
without it, a web-link replacement keeps its exact `anchor` wording, while other
web-link placements use the normalized address. Note links still default to the
target note's title. For example:

```json
{
  "space_id": "<exact Space ID>",
  "note_id": "<exact note ID>",
  "expected_version": "<version from current read>",
  "command": "link",
  "url": "example.com/research",
  "placement": "replace",
  "anchor": "supporting research"
}
```

Excerpts resolve only inside the requested Space. They also need
the source note's `target_expected_version` and an exact, unique passage. Their
text-only locator preserves excerpt styling and navigation without inventing
editor offsets; Orion highlights only a unique exact match in the current
visible text. Images reuse a managed attachment already referenced in that
Space. Importing a new image remains a native attachment operation.

These commands write ordinary Markdown and Orion's portable block/excerpt
metadata. Existing create, update, exact-edit, append, and Markdown import paths
preserve it. Literal `/block` text is ordinary prose when written through MCP;
use the command tool to create the actual structure. Table operations use an
exact complete-table anchor and current version; no implicit cursor or global
slash-text execution is assumed.

### Existing portable layout

Layout commands modify existing metadata under the same Space/version lock.
They accept only their documented fields, never insertion `placement` or
replacement `text`. Omitted values remain unchanged; explicit zero/false resets
that field where supported. Unknown existing image metadata is preserved.

- `paragraph_format` takes a unique exact whole paragraph or ATX-heading
  `anchor`, including existing formatting suffixes. It supports `alignment:
  "left" | "justify"` and independent integer `margin_left`/`margin_right`
  percentages from 0–25. Lists require a complete item line and quoted prose a
  complete paragraph. Partial paragraphs, ambiguous matches, tables, code,
  frontmatter and structural ranges are rejected. It preserves the prose and
  writes the renderer's portable suffixes.
- `document_margins` takes either or both integer margins from 0–25. It updates
  the leading document metadata while preserving frontmatter and content.
- `image_layout` takes an exact standalone managed-image `anchor` already in
  the target note and a nonempty partial `layout`. Supported fields are
  `placement: "inline" | "break" | "wrap"`, `alignment: "left" | "center" |
  "right"`, integer `widthPercent` (15–100), `xPercent` (null or 0–85, at most
  two decimal places and no more than 100 minus width), integer `offsetY`
  (0–10,000), integer `gap` (8–40), `caption` (at most 500 UTF-16 units) and
  `showCaption` (boolean). A vertical offset requires numeric `xPercent`.
  Setting `xPercent` to null resets its offset unless an explicit zero is
  supplied. The original image, alt text and title remain. No new image bytes,
  URLs or filesystem paths are imported, and invalid values are rejected
  rather than silently clamped.

The combined import/editor regression consumes captured executable output from
these commands. It is not a claim that DOCX/HTML extraction preserves arbitrary
layout or that MCP can manipulate the current editor cursor.

### Existing tables

`table_layout` and `table_edit` require a unique exact `anchor` containing the
complete unindented standalone GFM table and any adjacent `orion-table:v1` metadata. They update that
table under the existing Space/version lock, preserving surrounding content.
Partial, malformed, nonrectangular or fenced/example tables are rejected.
They do not take insertion placement or unrelated replacement fields.

`table_layout` takes a nonempty partial `table_layout` object. Its fields are
integer `width` (35–100), boolean `header` and `banded`, and `columns` with one
entry per column (integer 48–2000 or `null`). Omitted fields and unknown valid
metadata are preserved. The exception is a width-only change: existing measured
columns scale proportionally, bounded to 64–2000, matching the editor's width
control. Explicit `columns` take precedence. Metadata remains within the
renderer's 1,600-character and 100-column bounds.

`table_edit` takes a finite `operation`:

| Operation | Arguments and meaning |
| --- | --- |
| `insert_row` | `row_index` and optional `values`, one literal value per column |
| `delete_row` | `row_index`; explicitly removes that logical row |
| `insert_column` | `column_index` and optional `values`, one literal value per logical row |
| `delete_column` | `column_index`; explicitly removes that column |
| `set_cell` | `row_index`, `column_index` and literal `text` (empty clears the cell) |
| `resize` | `row_count` and/or `column_count`; occupied removed cells require `allow_content_removal: true` |
| `delete` | Explicitly removes the complete anchored table and its metadata |

Indices are zero-based logical editor rows/columns. A headerless table's empty
synthetic Markdown header never counts as a real row. Toggling the header keeps
the first real row, including its content. New cells use literal text with
Markdown escaping and line-break handling; untouched cells retain links, marks,
code and escaped pipes. Column insertion/removal shifts measured widths with
their columns. Deleting the last row or column removes the table, matching the
editor; `delete` removes it directly. Resize requires at least one row and column.
New growth is bounded to the editor's 20 rows and 12
columns; existing imported dimensions above those limits can remain unchanged
while another axis is edited.
Bare-edge GFM rows gain outer pipes when mutated so a reduction to one column,
or an exposed heading/list marker, cannot turn cell contents into another block.
Unknown metadata remains JSON data; angle brackets are escaped to prevent it
from closing its own HTML comment. Both changes preserve displayed content.

## Existing inline formatting and explicit links

`inline_format` requires an exact unique `anchor`, a `mark` of `bold`, `italic`,
`strike` or `code`, and an explicit boolean `enabled`. It applies or removes the
specified mark rather than toggling it. The anchor is original Markdown, capped
at 20,000 characters, within one ordinary paragraph or ATX heading of at most
50,000 characters. Paragraphs inside Orion writing blocks are supported. A
selection can include complete balanced marks or an unambiguous plain-text
substring; it cannot cut through escapes, entities or inline delimiters.

```json
{
  "space_id": "<exact Space ID>",
  "note_id": "<exact note ID>",
  "expected_version": "<version from current read>",
  "command": "inline_format",
  "anchor": "the words to emphasize",
  "mark": "bold",
  "enabled": true
}
```

Removal requires the complete marked span, including its delimiters. Removing
bold from `***both marks***`, for example, retains the italic mark. Applying
inline code initially supports unformatted, single-line text; removing a code
span preserves its literal words with Markdown escaping. Literal backticks use
dynamic delimiters, and edge spaces retain their exact code content. Already satisfied
formatting is a no-op. Lists, tables, quotes, setext headings, code blocks,
frontmatter, embedded HTML and reference-style links are outside this initial
slice. Paragraphs containing bare URL/email autolinks are conservatively rejected
because the renderer's automatic-link grammar differs from the source parser.
Generated References content and portable empty-paragraph markers are protected.
Neither command accepts insertion placement or replacement text.

`unlink` requires an exact anchor containing one whole explicit inline web,
Orion note or Orion concept link, including its destination. It removes that
link while retaining the label and its other formatting. Images, source
citations, excerpt/passage metadata, reference-style links and autolinks are
excluded. It neither changes Orion's concept vocabulary nor suppresses any
automatic concept decoration or future bare-URL linking in the editor.

Both commands use parsed source spans and verify the resulting visible text,
unrelated marks, link attributes and metadata before saving. Unrelated source
bytes remain unchanged. The normal exact-Space, current-version and atomic
vault-lock rules apply; unsupported or ambiguous edits fail without saving.

## Source citations and provenance

`source_citation` takes `citation_action: "insert" | "remove"` and an exact
`source_id`, in addition to the normal explicit Space, note and current note
version. It handles source attribution separately from ordinary links.

Insertion also requires `source_expected_version` from a current read of that
source in this Space. Use `placement: "append" | "prepend" | "before" | "after"`;
the first is the default, and before/after require a unique plain-prose anchor.
The command inserts a numbered marker, rebuilds the recognized trailing
References list, and attaches both `note.sourceIds` and `source.noteIds` in one
locked write. Repeated source citations reuse a number. An optional
`sourceAttachments` receipt reports the source's resulting opaque version and
bounded metadata, so a subsequent insertion can use the fresh version.

Removal requires an exact unique `anchor` containing one complete matching
citation. It accepts neither placement nor a source version, and can remove a
marker whose source is no longer available. Generated numeric markers disappear;
authored labels remain as text. Remaining citations are renumbered. Removing a
marker does not detach provenance or delete the source.

The operation does not accept caller-supplied citation numbers, titles or
replacement text. Ambiguous or foreign sources, stale versions, partial links,
unsupported citation syntax and unsafe code/metadata anchors fail without
saving. Authored References prose remains intact; only a recognized managed
footer is rebuilt. Citation insertion attributes a source; it does not claim
that a particular passage was read or that the source proves the claim.

## Evidence and coverage

Source offsets are zero-based **Unicode scalar values**, with an exclusive end.
They are not UTF-8 byte offsets or JavaScript string indices. Optional
`expected_version` prevents a passage or section request from using stale text.
Versions are opaque equality tokens for current content, not archived versions
or cryptographic proof. No historical body can be retrieved from a version.

Paged tools accept `offset` and `limit` (up to 100); carry the returned
`vaultRevision` as `expected_revision` to reject changes between pages.
Multi-note bodies total at most 60,000 characters; source and section reads
return at most 20,000 characters. Every new response is bounded to 2 MiB.

Whole-body discovery scans stop at 2,000 notes/sources or 8 MiB and advertise
coverage. Source matches, task rows, and integrity examples have a 5,000-item
cap. Link-path traversal allows up to eight hops, 500 expanded notes, and
10,000 edges, within the same text budget. A missing result under these limits
is not proof of absence. Narrow the request or use direct versioned reads.

Task listing ignores frontmatter and fenced code. Optional collapse combines
matching visible task text only when source provenance or a canonical wiki
derivation establishes a copy, preferring an ordinary note. Unrelated recurring
tasks remain distinct; completion changes only the explicitly selected copy.
Use `collapse_derived: false` to inspect every stored task occurrence.

Link paths establish navigation, not logical agreement. Provenance establishes
recorded derivation, not support for every claim. Title duplicates are
candidates for inspection. Integrity checks never repair or delete content.
Recent changes are current metadata; deletion history and previous bodies are
not available. All reads stay in one exact Space, defaulting only to the active
Space when omitted. Writes always require an explicit Space.

## Verification

The Rust suite covers schemas, Unicode ranges, fenced Markdown, repeated
headings, provenance-aware tasks, guarded edits, atomic batches, stale pages,
duplicate detection, connection paths, diagnostics, and Space isolation.
`script/test_mcp_library.mjs` exercises all 21 tools against an isolated fixture
through stdio. Claude and Codex package builds run it against their exact
extracted executables. No real vault or API account is used by these tests.

Verification on 5 September 2026 passed: 45 MCP tests, 65 native tests, and
879 renderer tests (one existing renderer test skipped), plus TypeScript,
production renderer compilation, Rust formatting, and shell syntax checks.
Both the Claude extension and Codex ZIP passed the 20-tool harness after
extraction. The desktop integration build passed. Both connectors also passed
the harness after extraction from the final development DMG; its checksum and
the copied application's strict nested signatures verified successfully.
That initial verification used locally signed development artifacts. Current
distribution and signing status are recorded in the
[Orion 0.4.5 release notes](../releases/0.4.5.md).
