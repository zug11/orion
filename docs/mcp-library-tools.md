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
`image`. Supply the command's structured fields from its tool schema. For example,
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

`placement` defaults to `append`; `prepend` is also available. `before`, `after`,
and `replace` require an exact, unique `anchor`. Read again after a conflict;
never replace the version and blindly retry. Content and validation are bounded,
and a successful receipt includes the updated version and note citation.

Links and excerpts resolve only inside the requested Space. Excerpts also need
the source note's `target_expected_version` and an exact, unique passage. Their
text-only locator preserves excerpt styling and navigation without inventing
editor offsets; Orion highlights only a unique exact match in the current
visible text. Images reuse a managed attachment already referenced in that
Space. Importing a new image remains a native attachment operation.

These commands write ordinary Markdown and Orion's portable block/excerpt
metadata. Existing create, update, exact-edit, append, and Markdown import paths
preserve it. Literal `/block` text is ordinary prose when written through MCP;
use the command tool to create the actual structure. Contextual table deletion
uses `orion_edit_note_text` with the exact selected table Markdown and a current
version; no implicit cursor or global slash-text execution is assumed.

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
